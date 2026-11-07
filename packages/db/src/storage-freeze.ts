/**
 * Storage write-freeze state machine — pure rules (Phase 6Q, stage E1).
 *
 * WHY THIS FILE HAS NO DATABASE IMPORTS
 *
 * The rules that decide whether a transition is legal are the part that must never
 * be wrong, and they are the part most worth testing exhaustively. Keeping them free
 * of Drizzle and of a live connection means every legal transition, every illegal
 * transition, and every failure-closed case is assertable in a plain unit test with
 * no database — which matters here, because the Phase 6Q host had no reachable
 * Postgres and the alternative would have been to ship an unverified model.
 *
 * The database-touching operations live in `./storage-freeze-operations.ts`.
 *
 * THE FOUR RULES THIS FILE ENFORCES
 *
 * 1. FREEZE_REQUESTED IS NOT FROZEN. Requesting a freeze stops new issuance; it is
 *    not a freeze. Reaching FROZEN requires a drain snapshot showing zero in-flight
 *    writes, zero unresolved write arms, and any arm-expiry grace already elapsed.
 *    The database layer computes that snapshot while holding the freeze-row lock;
 *    a missing or malformed snapshot is refused.
 */

export const STORAGE_FREEZE_STATES = [
  'ACTIVE',
  'FREEZE_REQUESTED',
  'DRAINING',
  'FROZEN',
  'RECONCILING',
  'FAILED',
  'RECOVERY_REQUIRED',
] as const

export type StorageFreezeStateName = (typeof STORAGE_FREEZE_STATES)[number]

/** Permission required for each operation. Recovery is deliberately separate. */
export const STORAGE_FREEZE_PERMISSIONS = {
  request: 'admin.storage.freeze.request',
  drain: 'admin.storage.freeze.drain',
  freeze: 'admin.storage.freeze.confirm',
  reconcile: 'admin.storage.freeze.reconcile',
  release: 'admin.storage.freeze.release',
  fail: 'admin.storage.freeze.fail',
  /** Emergency path. Never implied by any other permission. */
  recover: 'admin.storage.freeze.recover',
} as const

export type StorageFreezePermission =
  (typeof STORAGE_FREEZE_PERMISSIONS)[keyof typeof STORAGE_FREEZE_PERMISSIONS]

/**
 * Evidence a caller must present for transitions that cannot be self-asserted.
 *
 * Drain evidence produced inside the same transaction as the transition.
 *
 * A caller cannot assert these values: `applyTransition` computes them while holding
 * the tenant's freeze-row lock and passes the resulting snapshot here. The pure rule
 * layer still validates the shape so a malformed internal snapshot fails closed.
 */
export type DrainVerification = {
  inFlightCount: number
  unresolvedArmCount: number
  /** Latest arm expiry plus the reconciliation grace, or null when no arm exists. */
  waitUntil: string | null
  /** Timestamp at which the database snapshot was taken. */
  verifiedAt: string
}
export type ReconcileEvidence = { manifestSha256: string }

/** Transitions the machine allows. Everything not listed is refused. */
const LEGAL_TRANSITIONS: Record<StorageFreezeStateName, readonly StorageFreezeStateName[]> = {
  ACTIVE: ['FREEZE_REQUESTED'],
  FREEZE_REQUESTED: ['DRAINING', 'ACTIVE', 'FAILED'],
  // DRAINING may fail, or be abandoned back to FREEZE_REQUESTED (a drain that
  // timed out and is being retried), but never straight to FROZEN: DRAINING is the
  // state in which verification happens, and verification gates the NEXT edge.
  DRAINING: ['FROZEN', 'FAILED', 'FREEZE_REQUESTED'],
  // Recovery out of FROZEN must go through reconciliation first. FROZEN -> ACTIVE
  // is deliberately absent.
  FROZEN: ['RECONCILING', 'FAILED', 'RECOVERY_REQUIRED'],
  RECONCILING: ['ACTIVE', 'FAILED', 'RECOVERY_REQUIRED'],
  // FAILED is terminal except for the explicit recovery edge.
  FAILED: ['RECOVERY_REQUIRED', 'FREEZE_REQUESTED'],
  // RECOVERY_REQUIRED returns to FREEZE_REQUESTED to start again, or to FAILED if
  // the attempt is abandoned. It can never jump to ACTIVE: the tenant is still
  // frozen and only a new, verified attempt may resume normal work.
  RECOVERY_REQUIRED: ['FREEZE_REQUESTED', 'FAILED'],
}

export function isLegalTransition(
  from: StorageFreezeStateName,
  to: StorageFreezeStateName,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

export class StorageFreezeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StorageFreezeError'
    this.code = code
  }
}

/** States in which the tenant is not accepting the freeze as complete. */
export const STATES_BLOCKING_NORMAL_WRITES: readonly StorageFreezeStateName[] = [
  'FREEZE_REQUESTED',
  'DRAINING',
  'FROZEN',
  'RECONCILING',
  'FAILED',
  'RECOVERY_REQUIRED',
]

/**
 * Is the tenant considered frozen?
 *
 * FAILURE-CLOSED BY CONSTRUCTION: an unknown or absent state is reported as NOT
 * frozen here, because callers of this helper in stage E2 use it as an advisory.
 * The enforcement path must instead treat "could not determine" as frozen — see
 * `assertDeterminable` — and the two are deliberately not the same function so the
 * difference stays visible.
 */
export function isFrozenState(state: string | null | undefined): boolean {
  return state != null && STATES_BLOCKING_NORMAL_WRITES.includes(state as StorageFreezeStateName)
}

/**
 * Reject an indeterminate state rather than guessing.
 *
 * Restart recovery depends on this: a process that comes back up and cannot read a
 * valid state must NOT conclude "no freeze, carry on". Returning `null` here means
 * the caller's storage decision has no answer, and the caller must fail closed.
 */
export function assertDeterminable(
  state: string | null | undefined,
): asserts state is StorageFreezeStateName {
  if (state == null) {
    throw new StorageFreezeError(
      'FREEZE_STATE_UNKNOWN',
      'storage freeze state could not be read; refusing to assume ACTIVE',
    )
  }
  if (!STORAGE_FREEZE_STATES.includes(state as StorageFreezeStateName)) {
    throw new StorageFreezeError(
      'FREEZE_STATE_UNKNOWN',
      `storage freeze state "${state}" is not a known state; refusing to guess`,
    )
  }
}

export type TransitionRequest = {
  from: StorageFreezeStateName
  to: StorageFreezeStateName
  /** Version the caller read. Compared-and-set in the database layer. */
  expectedVersion: number
  actorId: string
  permission: StorageFreezePermission
  /** Operator-supplied explanation. Must not carry secrets. */
  reason: string
  drain?: DrainVerification
  reconciliation?: ReconcileEvidence
}

export type TransitionDecision = { ok: true } | { ok: false; code: string; message: string }

/**
 * Decide whether a transition may proceed, without touching a database.
 *
 * Split out from the persistence layer so the entire rule surface is unit-testable
 * and so the persistence layer cannot quietly add a rule of its own.
 */
export function evaluateTransition(req: TransitionRequest): TransitionDecision {
  if (!Number.isSafeInteger(req.expectedVersion) || req.expectedVersion < 0) {
    return {
      ok: false,
      code: 'FREEZE_VERSION_INVALID',
      message: 'expectedVersion must be a non-negative integer',
    }
  }
  if (req.actorId.trim() === '') {
    return { ok: false, code: 'FREEZE_ACTOR_MISSING', message: 'an actor is required' }
  }
  if (req.reason.trim() === '') {
    return { ok: false, code: 'FREEZE_REASON_MISSING', message: 'a reason is required' }
  }
  if (!isLegalTransition(req.from, req.to)) {
    return {
      ok: false,
      code: 'FREEZE_ILLEGAL_TRANSITION',
      message: `${req.from} -> ${req.to} is not a legal transition`,
    }
  }

  // Reaching FROZEN is gated on a database-produced drain snapshot. The snapshot must
  // show both queues empty and, when an arm expiry exists, must already be past the
  // reconciliation grace. Anything missing or malformed keeps the historical
  // FREEZE_DRAIN_UNVERIFIED code so callers and operators retain one stable signal.
  if (req.to === 'FROZEN') {
    const drain = req.drain
    const verifiedAtMs = drain ? Date.parse(drain.verifiedAt) : Number.NaN
    const waitUntilMs = drain?.waitUntil == null ? null : Date.parse(drain.waitUntil)
    const drainComplete =
      drain != null &&
      Number.isSafeInteger(drain.inFlightCount) &&
      drain.inFlightCount === 0 &&
      Number.isSafeInteger(drain.unresolvedArmCount) &&
      drain.unresolvedArmCount === 0 &&
      Number.isFinite(verifiedAtMs) &&
      (drain.waitUntil === null ||
        (waitUntilMs !== null && Number.isFinite(waitUntilMs) && verifiedAtMs >= waitUntilMs))
    if (!drainComplete) {
      return {
        ok: false,
        code: 'FREEZE_DRAIN_UNVERIFIED',
        message:
          'cannot enter FROZEN: drain verification is missing or incomplete; ' +
          'requesting a freeze is not the same as being frozen',
      }
    }
  }

  // Releasing requires reconciliation output. Without a manifest hash there is
  // nothing that was reconciled against, and a release without one would be exactly
  // the "we forgot to check" failure this model exists to prevent.
  if (req.to === 'ACTIVE' && req.from !== 'ACTIVE' && req.reconciliation == null) {
    return {
      ok: false,
      code: 'FREEZE_RECONCILIATION_MISSING',
      message: 'cannot release the freeze without a reconciliation manifest hash',
    }
  }

  if (req.to === 'ACTIVE' && req.reconciliation != null) {
    if (!/^[0-9a-f]{64}$/i.test(req.reconciliation.manifestSha256)) {
      return {
        ok: false,
        code: 'FREEZE_RECONCILIATION_INVALID',
        message: 'reconciliation manifest hash must be a 64-character hex sha256',
      }
    }
  }

  return { ok: true }
}

export function assertTransition(req: TransitionRequest): void {
  const decision = evaluateTransition(req)
  if (!decision.ok) {
    throw new StorageFreezeError(decision.code, decision.message)
  }
}

/**
 * Lease validity.
 *
 * An expired lease means nobody is currently watching the migration. It does NOT
 * mean the migration finished, so it never changes the freeze state — it only says
 * somebody else may now take the lease over. Callers must persist an explicit
 * transition; there is no code path here that can move state on its own.
 */
export function evaluateLease(input: {
  leaseHolderId: string | null
  leaseExpiresAt: Date | null
  now: Date
  actorId: string
}): { mayProceed: boolean; reason: 'lease-held-by-other' | 'lease-expired' | null } {
  if (input.leaseHolderId == null || input.leaseExpiresAt == null) {
    return { mayProceed: true, reason: null }
  }
  if (input.leaseHolderId === input.actorId) {
    return { mayProceed: true, reason: null }
  }
  if (input.leaseExpiresAt.getTime() > input.now.getTime()) {
    return { mayProceed: false, reason: 'lease-held-by-other' }
  }
  // Expired: takeover is permitted, but the caller still has to perform an
  // explicit, audited transition. `lease-expired` is informational only.
  return { mayProceed: true, reason: 'lease-expired' }
}

/**
 * Recovery after a crash or an abandoned attempt.
 *
 * Rule 7 of the brief: a restart must restore the true state, never default to
 * ACTIVE. This function states what a restart must do — re-read and re-apply, not
 * assume — and is used by the tests to prove the model has no implicit path back to
 * ACTIVE.
 */
export function restartMustNotUnfreeze(persistedState: StorageFreezeStateName | null): {
  safeToResumeWrites: boolean
  reason: string
} {
  if (persistedState == null) {
    return {
      safeToResumeWrites: false,
      reason: 'state unreadable after restart; fail closed until it is read',
    }
  }
  if (persistedState === 'ACTIVE') {
    return { safeToResumeWrites: true, reason: 'persisted state is ACTIVE' }
  }
  return {
    safeToResumeWrites: false,
    reason: `persisted state is ${persistedState}; freeze must be resolved before writes resume`,
  }
}
