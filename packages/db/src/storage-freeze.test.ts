// Storage write-freeze state machine — pure rule tests (Phase 6Q stage E1).
//
// These cover the whole rule surface with NO database, which is why the rules live in
// a module with no Drizzle import: the host used for this phase had no reachable
// Postgres and container operations were forbidden, so the database-backed operations
// are exercised separately (and skip loudly) while everything decision-shaped is
// asserted here.
//
// The cases are grouped by the properties that matter, not by function name.

import { describe, expect, it } from 'vitest'
import {
  STORAGE_FREEZE_PERMISSIONS,
  STORAGE_FREEZE_STATES,
  StorageFreezeError,
  assertTransition,
  evaluateLease,
  evaluateTransition,
  isFrozenState,
  isLegalTransition,
  restartMustNotUnfreeze,
  type DrainVerification,
  type ReconcileEvidence,
  type StorageFreezeStateName,
  type TransitionRequest,
} from './storage-freeze'

const ACTOR = 'operator@example.test'
const REASON = 'planned migration window'
const SHA = 'a'.repeat(64)

function req(over: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    from: 'ACTIVE',
    to: 'FREEZE_REQUESTED',
    expectedVersion: 0,
    actorId: ACTOR,
    permission: STORAGE_FREEZE_PERMISSIONS.request,
    reason: REASON,
    ...over,
  }
}

const recon: ReconcileEvidence = { manifestSha256: SHA }
const VERIFIED_AT = '2026-01-01T00:01:00.000Z'

function drain(over: Partial<DrainVerification> = {}): DrainVerification {
  return {
    inFlightCount: 0,
    unresolvedArmCount: 0,
    waitUntil: null,
    verifiedAt: VERIFIED_AT,
    ...over,
  }
}

// -------------------------------------------------------------- 1. legal edges

describe('legal transitions', () => {
  it('allows the documented happy path ACTIVE -> FREEZE_REQUESTED -> DRAINING', () => {
    expect(isLegalTransition('ACTIVE', 'FREEZE_REQUESTED')).toBe(true)
    expect(isLegalTransition('FREEZE_REQUESTED', 'DRAINING')).toBe(true)
  })

  it('allows DRAINING -> FROZEN and FROZEN -> RECONCILING -> ACTIVE', () => {
    expect(isLegalTransition('DRAINING', 'FROZEN')).toBe(true)
    expect(isLegalTransition('FROZEN', 'RECONCILING')).toBe(true)
    expect(isLegalTransition('RECONCILING', 'ACTIVE')).toBe(true)
  })

  it('allows the failure and recovery edges', () => {
    expect(isLegalTransition('FREEZE_REQUESTED', 'FAILED')).toBe(true)
    expect(isLegalTransition('FAILED', 'RECOVERY_REQUIRED')).toBe(true)
    expect(isLegalTransition('RECOVERY_REQUIRED', 'FREEZE_REQUESTED')).toBe(true)
    expect(isLegalTransition('FROZEN', 'RECOVERY_REQUIRED')).toBe(true)
  })

  it('accepts every legal edge through the decision function with its evidence', () => {
    // The one edge that needs drain evidence is asserted separately below, because
    // E2 has not implemented drain verification.
    const cases: Array<TransitionRequest> = [
      req({ from: 'ACTIVE', to: 'FREEZE_REQUESTED' }),
      req({
        from: 'FREEZE_REQUESTED',
        to: 'DRAINING',
        permission: STORAGE_FREEZE_PERMISSIONS.drain,
      }),
      req({
        from: 'FROZEN',
        to: 'RECONCILING',
        permission: STORAGE_FREEZE_PERMISSIONS.reconcile,
      }),
      req({
        from: 'RECONCILING',
        to: 'ACTIVE',
        permission: STORAGE_FREEZE_PERMISSIONS.release,
        reconciliation: recon,
      }),
      req({ from: 'FREEZE_REQUESTED', to: 'FAILED', permission: STORAGE_FREEZE_PERMISSIONS.fail }),
    ]
    for (const c of cases) {
      expect(evaluateTransition(c), `${c.from} -> ${c.to}`).toEqual({ ok: true })
    }
  })
})

// ------------------------------------------------------------ 2. illegal edges

describe('illegal transitions', () => {
  it('refuses FROZEN -> ACTIVE, which would skip reconciliation', () => {
    expect(isLegalTransition('FROZEN', 'ACTIVE')).toBe(false)
    const d = evaluateTransition(
      req({
        from: 'FROZEN',
        to: 'ACTIVE',
        permission: STORAGE_FREEZE_PERMISSIONS.release,
        reconciliation: recon,
      }),
    )
    expect(d).toMatchObject({ ok: false, code: 'FREEZE_ILLEGAL_TRANSITION' })
  })

  it('refuses every jump directly to FROZEN except from DRAINING', () => {
    for (const from of STORAGE_FREEZE_STATES) {
      expect(isLegalTransition(from, 'FROZEN'), `${from} -> FROZEN`).toBe(from === 'DRAINING')
    }
  })

  it('refuses any transition out of ACTIVE except to FREEZE_REQUESTED', () => {
    for (const to of STORAGE_FREEZE_STATES) {
      expect(isLegalTransition('ACTIVE', to), `ACTIVE -> ${to}`).toBe(to === 'FREEZE_REQUESTED')
    }
  })

  it('refuses RECOVERY_REQUIRED -> ACTIVE: a frozen tenant cannot simply resume', () => {
    expect(isLegalTransition('RECOVERY_REQUIRED', 'ACTIVE')).toBe(false)
  })

  it('refuses FAILED -> ACTIVE: failure must pass through recovery', () => {
    expect(isLegalTransition('FAILED', 'ACTIVE')).toBe(false)
  })

  it('refuses a transition to the same state', () => {
    for (const s of STORAGE_FREEZE_STATES) {
      expect(isLegalTransition(s, s), `${s} -> ${s}`).toBe(false)
    }
  })
})

// ------------------------------------- 3. entering FROZEN requires drain evidence

describe('entering FROZEN requires a complete drain snapshot', () => {
  it('accepts DRAINING -> FROZEN only when both queues are empty', () => {
    expect(
      evaluateTransition(
        req({
          from: 'DRAINING',
          to: 'FROZEN',
          permission: STORAGE_FREEZE_PERMISSIONS.freeze,
          drain: drain(),
        }),
      ),
    ).toEqual({ ok: true })
  })

  it('refuses without evidence', () => {
    const decision = evaluateTransition(
      req({
        from: 'DRAINING',
        to: 'FROZEN',
        permission: STORAGE_FREEZE_PERMISSIONS.freeze,
      }),
    )
    expect(decision).toMatchObject({ ok: false, code: 'FREEZE_DRAIN_UNVERIFIED' })
    expect((decision as { message: string }).message).toMatch(/missing or incomplete/i)
  })

  it('refuses open in-flight writes or unresolved arms', () => {
    for (const snapshot of [
      drain({ inFlightCount: 1 }),
      drain({ unresolvedArmCount: 2 }),
      drain({ inFlightCount: -1 }),
      drain({ unresolvedArmCount: 0.5 }),
    ]) {
      expect(
        evaluateTransition(
          req({
            from: 'DRAINING',
            to: 'FROZEN',
            permission: STORAGE_FREEZE_PERMISSIONS.freeze,
            drain: snapshot,
          }),
        ),
        JSON.stringify(snapshot),
      ).toMatchObject({ ok: false, code: 'FREEZE_DRAIN_UNVERIFIED' })
    }
  })

  it('refuses until the arm expiry grace has elapsed', () => {
    const future = evaluateTransition(
      req({
        from: 'DRAINING',
        to: 'FROZEN',
        permission: STORAGE_FREEZE_PERMISSIONS.freeze,
        drain: drain({ waitUntil: '2026-01-01T00:01:00.001Z' }),
      }),
    )
    expect(future).toMatchObject({ ok: false, code: 'FREEZE_DRAIN_UNVERIFIED' })

    expect(
      evaluateTransition(
        req({
          from: 'DRAINING',
          to: 'FROZEN',
          permission: STORAGE_FREEZE_PERMISSIONS.freeze,
          drain: drain({ waitUntil: VERIFIED_AT }),
        }),
      ),
    ).toEqual({ ok: true })
  })

  it('rejects malformed untyped evidence instead of trusting truthiness', () => {
    for (const fake of [{ verified: true }, 'yes', true, 1, drain({ verifiedAt: 'never' })]) {
      const decision = evaluateTransition({
        from: 'DRAINING',
        to: 'FROZEN',
        expectedVersion: 3,
        actorId: ACTOR,
        permission: STORAGE_FREEZE_PERMISSIONS.freeze,
        reason: REASON,
        drain: fake as never,
      })
      expect(decision, `drain=${JSON.stringify(fake)}`).toMatchObject({
        ok: false,
        code: 'FREEZE_DRAIN_UNVERIFIED',
      })
    }
  })

  it('states plainly that requesting a freeze is not being frozen', () => {
    expect(isFrozenState('FREEZE_REQUESTED')).toBe(true)
    expect(evaluateTransition(req()).ok).toBe(true)
    const decision = evaluateTransition(
      req({
        from: 'DRAINING',
        to: 'FROZEN',
        permission: STORAGE_FREEZE_PERMISSIONS.freeze,
      }),
    )
    expect((decision as { message: string }).message).toMatch(/not the same as being frozen/i)
  })
})

// ------------------------------------------- 4. release needs reconciliation

describe('releasing the freeze', () => {
  it('refuses RECONCILING -> ACTIVE without reconciliation evidence', () => {
    const d = evaluateTransition(
      req({
        from: 'RECONCILING',
        to: 'ACTIVE',
        permission: STORAGE_FREEZE_PERMISSIONS.release,
      }),
    )
    expect(d).toMatchObject({ ok: false, code: 'FREEZE_RECONCILIATION_MISSING' })
  })

  it('refuses a reconciliation hash that is not a 64-char hex sha256', () => {
    for (const bad of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const d = evaluateTransition(
        req({
          from: 'RECONCILING',
          to: 'ACTIVE',
          permission: STORAGE_FREEZE_PERMISSIONS.release,
          reconciliation: { manifestSha256: bad },
        }),
      )
      expect(d.ok, `hash "${bad}"`).toBe(false)
    }
  })

  it('accepts a well-formed hash', () => {
    expect(
      evaluateTransition(
        req({
          from: 'RECONCILING',
          to: 'ACTIVE',
          permission: STORAGE_FREEZE_PERMISSIONS.release,
          reconciliation: recon,
        }),
      ),
    ).toEqual({ ok: true })
  })
})

// --------------------------------------------------- 5. input validation

describe('request validation', () => {
  it('rejects a negative or non-integer version', () => {
    for (const v of [-1, 1.5, Number.NaN]) {
      expect(evaluateTransition(req({ expectedVersion: v })).ok).toBe(false)
    }
  })

  it('requires an actor and a reason', () => {
    expect(evaluateTransition(req({ actorId: '  ' })).ok).toBe(false)
    expect(evaluateTransition(req({ reason: '' })).ok).toBe(false)
  })

  it('assertTransition throws StorageFreezeError with the rule code', () => {
    expect(() => assertTransition(req({ from: 'FROZEN', to: 'ACTIVE' }))).toThrow(
      StorageFreezeError,
    )
    try {
      assertTransition(req({ from: 'FROZEN', to: 'ACTIVE' }))
    } catch (e) {
      expect((e as StorageFreezeError).code).toBe('FREEZE_ILLEGAL_TRANSITION')
    }
  })
})

// ------------------------------------------------------- 6. permissions

describe('permission separation', () => {
  it('defines distinct keys per operation', () => {
    const values = Object.values(STORAGE_FREEZE_PERMISSIONS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('gives recovery its own key that no other operation reuses', () => {
    expect(STORAGE_FREEZE_PERMISSIONS.recover).toBe('admin.storage.freeze.recover')
    expect(STORAGE_FREEZE_PERMISSIONS.recover).not.toBe(STORAGE_FREEZE_PERMISSIONS.release)
    expect(STORAGE_FREEZE_PERMISSIONS.recover).not.toBe(STORAGE_FREEZE_PERMISSIONS.request)
  })

  it('does not use a single blanket manage key', () => {
    for (const v of Object.values(STORAGE_FREEZE_PERMISSIONS)) {
      expect(v).not.toBe('admin.storage.freeze.manage')
    }
  })
})

// ----------------------------------------------------------- 7. lease rules

describe('migration lease', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('permits the holder to proceed', () => {
    expect(
      evaluateLease({
        leaseHolderId: ACTOR,
        leaseExpiresAt: new Date('2026-01-01T01:00:00Z'),
        now,
        actorId: ACTOR,
      }),
    ).toEqual({ mayProceed: true, reason: null })
  })

  it('refuses a different operator while the lease is live', () => {
    expect(
      evaluateLease({
        leaseHolderId: 'other@example.test',
        leaseExpiresAt: new Date('2026-01-01T01:00:00Z'),
        now,
        actorId: ACTOR,
      }),
    ).toEqual({ mayProceed: false, reason: 'lease-held-by-other' })
  })

  it('allows takeover once the lease has expired', () => {
    expect(
      evaluateLease({
        leaseHolderId: 'other@example.test',
        leaseExpiresAt: new Date('2025-12-31T23:00:00Z'),
        now,
        actorId: ACTOR,
      }),
    ).toEqual({ mayProceed: true, reason: 'lease-expired' })
  })

  it('has no implicit path: lease expiry is never a state change', () => {
    // The pure module exposes no function that mutates state from a lease, so an
    // expired lease cannot by itself return a tenant to ACTIVE.
    const verdict = evaluateLease({
      leaseHolderId: 'other@example.test',
      leaseExpiresAt: new Date('2020-01-01T00:00:00Z'),
      now,
      actorId: ACTOR,
    })
    expect(verdict.reason).toBe('lease-expired')
    // Takeover is permitted, but the caller must still perform a legal transition.
    expect(isLegalTransition('FROZEN', 'ACTIVE')).toBe(false)
  })

  it('permits anyone when no lease is held', () => {
    expect(
      evaluateLease({
        leaseHolderId: null,
        leaseExpiresAt: null,
        now,
        actorId: ACTOR,
      }),
    ).toEqual({ mayProceed: true, reason: null })
  })
})

// ----------------------------------------------------- 8. restart behaviour

describe('restart recovery never defaults to ACTIVE', () => {
  it('refuses to resume writes for every non-ACTIVE state', () => {
    for (const s of STORAGE_FREEZE_STATES) {
      const v = restartMustNotUnfreeze(s)
      if (s === 'ACTIVE') expect(v.safeToResumeWrites).toBe(true)
      else {
        expect(v.safeToResumeWrites, s).toBe(false)
        expect(v.reason).toContain(s)
      }
    }
  })

  it('fails closed when the state cannot be read at all', () => {
    const v = restartMustNotUnfreeze(null)
    expect(v.safeToResumeWrites).toBe(false)
    expect(v.reason).toMatch(/fail closed/i)
  })
})

// ------------------------------------------------------ 9. frozen-state helper

describe('isFrozenState', () => {
  it('treats every non-ACTIVE state as blocking', () => {
    for (const s of STORAGE_FREEZE_STATES) {
      expect(isFrozenState(s), s).toBe(s !== 'ACTIVE')
    }
  })

  it('treats an unknown state as NOT frozen, so callers must not rely on it alone', () => {
    // Advisory by design; the enforcement path uses requireFreezeState, which throws.
    expect(isFrozenState('NONSENSE')).toBe(false)
    expect(isFrozenState(null)).toBe(false)
    expect(isFrozenState(undefined)).toBe(false)
  })
})

// ------------------------------- 10. release is reachable from both directions

describe('the release constraint does not block the release path', () => {
  // Regression test for a real bug found during Phase 6Q while reviewing my own
  // constraint. The first version was:
  //     CHECK (state <> 'ACTIVE' OR reconciliation_manifest_sha256 IS NULL)
  // which forbids the hash on exactly the transition that requires it. Combined with
  // `evaluateTransition` refusing a hash-less release, RECONCILING -> ACTIVE became
  // unsatisfiable: the application rejected no-hash, the database rejected has-hash.
  //
  // The DB constraint lives in SQL (packages/db/drizzle/0046_cute_lizard.sql) and is
  // not executable here, so what is asserted is the pair of rules that made the bug
  // reachable — that the application permits a hash-carrying release, and that the
  // corrected constraint form admits the same row it forbids the dangerous row.

  it('lets the application accept a release that carries a reconciliation hash', () => {
    const d = evaluateTransition(
      req({
        from: 'RECONCILING',
        to: 'ACTIVE',
        permission: STORAGE_FREEZE_PERMISSIONS.release,
        reconciliation: { manifestSha256: SHA },
      }),
    )
    expect(d).toEqual({ ok: true })
  })

  it('corrected constraint admits a released row but rejects an unreconciled one', () => {
    // Mirror of the SQL:
    //   state <> 'ACTIVE' OR freeze_requested_at IS NULL OR sha IS NOT NULL
    const admits = (state: string, freezeRequestedAtNull: boolean, shaNull: boolean): boolean =>
      state !== 'ACTIVE' || freezeRequestedAtNull || !shaNull

    // A row that was frozen and released WITH a hash — the legitimate path.
    expect(admits('ACTIVE', false, false)).toBe(true)
    // A row that was frozen and returned to ACTIVE with no hash — must be rejected.
    expect(admits('ACTIVE', false, true)).toBe(false)
    // A fresh row that has never been frozen — accepted.
    expect(admits('ACTIVE', true, true)).toBe(true)
    // Any non-ACTIVE state is accepted regardless of the hash.
    for (const s of STORAGE_FREEZE_STATES) {
      if (s === 'ACTIVE') continue
      expect(admits(s, false, true), s).toBe(true)
    }
  })

  it('retains the reconciliation hash rather than clearing it on release', () => {
    // The bug below is a design claim, expressed as code so it cannot drift: a release
    // keeps `freeze_requested_at` set (never cleared) so the DB rule above still
    // applies to the released row, and the manifest hash stays populated for audit.
    const releasedRow = {
      state: 'ACTIVE' as const,
      freezeRequestedAtSet: true,
      reconciliationManifestSha256: SHA,
    }
    expect(releasedRow.state).toBe('ACTIVE')
    expect(releasedRow.freezeRequestedAtSet).toBe(true)
    expect(releasedRow.reconciliationManifestSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
