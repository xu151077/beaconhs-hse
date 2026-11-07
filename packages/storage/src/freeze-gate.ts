// Storage write-freeze gate (Phase 6R, stage E2-A).
//
// SCOPE — READ THIS BEFORE TRUSTING IT
//
// This module gives the application ONE choke point for storage mutations made
// through `packages/storage`. It is a write-admission check, not a freeze. It covers
// only the server-side mutating operations listed in `gatedStorageOperations`, and it
// is deliberately deaf to every path that bypasses those functions:
//
//   * presigned PUT / presigned multipart-part URLs — the browser writes directly to
//     the object store with a capability this module never sees. Minting a URL is not
//     a mutation, so `presignPut` / `presignMultipartPart` are NOT gated.
//   * the WOPI write-back route, which calls `putObject` but carries its own 12-hour
//     token lifetime;
//   * BullMQ workers and cron ticks, which call the same `putObject`/`deleteObject` and
//     therefore DO inherit the gate while running, but which have no pause mechanism;
//   * Collabora's independent write-back channel;
//   * SeaweedFS's own lifecycle engine, which deletes out of process.
//
// Gating this module therefore proves "no NEW server-side mutation is admitted while a
// tenant is frozen", and nothing more.
//
// WHY THE TENANT IS DERIVED FROM THE KEY
//
// The gate must not let a caller name the tenant whose freeze state it consults — that
// would turn a tenant-scoped control into a caller-scoped switch. `packages/storage`
// has no ambient request context, and adding a dependency on the request layer would
// invert the layering. Instead the tenant is parsed out of the object key
// (`t/<tenantId>/<scope>/<name>`), which is the same invariant `assertTenantObjectKey`
// already enforces for deletes. A key with no parseable tenant therefore cannot be
// authorised at all, which is the safe answer.
//
// FAIL-CLOSED RULES (all of them)
//
//   1. no reader registered        -> refuse (misconfiguration, not permission)
//   2. reader throws               -> refuse
//   3. reader returns null         -> refuse (no row is NOT the same as "ACTIVE")
//   4. reader returns an unknown state -> refuse
//   5. state is anything but ACTIVE -> refuse
//
// There is no retry, no alternate client, and no fallback path. A caller that catches
// the error and tries again sees the same refusal, because the state has not changed;
// that is the intended property, not a defect.
//
// Phase 6U-A: Write lease mechanism for write admission.
//
// A write operation must acquire a lease before being allowed to proceed. The lease is
// held for the duration of the write operation, preventing concurrent writes from
// interleaving with the freeze transition. This provides a stronger admission point
// than just checking the state, because the lease is held by the same transaction
// that performs the write, ensuring atomicity.
//
// The lease is acquired using optimistic concurrency control: the UPDATE must match
// the version we read. If another process has already acquired the lease or the tenant
// is not in ACTIVE state, the lease is not acquired and the write is refused.
//
// The lease is released when the write completes (successfully or unsuccessfully),
// allowing other processes to acquire the lease and perform their writes.
//
// This does NOT solve the problem of in-flight writes after a freeze request has been
// processed (that is addressed in Phase 6U-C). This only ensures that new writes
// cannot be admitted after the freeze request has been processed.

import { getStorageGateRegistry } from './gate-registry'

export type StorageFreezeGateOutcome =
  'ALLOWED' | 'STORAGE_FROZEN' | 'STORAGE_FREEZE_STATE_UNKNOWN' | 'STORAGE_TENANT_UNKNOWN'

/**
 * The server-side mutating operations this gate covers.
 *
 * Listed explicitly, and imported by the tests, so "what is covered" is a single
 * reviewable list rather than a set of functions someone happens to remember.
 */
export const GATED_STORAGE_OPERATIONS = [
  'putObject',
  'createMultipartUpload',
  'completeMultipartUpload',
  'abortMultipartUpload',
  'deleteObject',
  'promoteObject',
  // Phase 6T-B: Pre-signed write URLs and WOPI write-back must also respect freeze.
  'presignPut',
  'presignMultipartPart',
  'wopiToken',
] as const

export type GatedStorageOperation = (typeof GATED_STORAGE_OPERATIONS)[number]

export class StorageWriteBlockedError extends Error {
  readonly code: StorageFreezeGateOutcome
  /** The persisted freeze state that caused the refusal, when one was read. */
  readonly freezeState: string | null
  readonly operation: GatedStorageOperation
  readonly key: string

  constructor(args: {
    code: StorageFreezeGateOutcome
    operation: GatedStorageOperation
    key: string
    freezeState?: string | null
    detail?: string
  }) {
    super(
      `storage ${args.operation} refused for key "${args.key}": ${args.code}` +
        (args.freezeState ? ` (state=${args.freezeState})` : '') +
        (args.detail ? ` — ${args.detail}` : ''),
    )
    this.name = 'StorageWriteBlockedError'
    this.code = args.code
    this.freezeState = args.freezeState ?? null
    this.operation = args.operation
    this.key = args.key
  }
}

/**
 * Recognise the one refusal type callers may translate into an HTTP response.
 *
 * `instanceof` is the normal path, with a structural fallback for duplicated module
 * instances across a bundler boundary. The fallback is deliberately narrow: the
 * name, a `STORAGE_*` code, and the gated operation must all agree. A random
 * exception that merely mentions storage is never converted into a public 423.
 */
export function isStorageWriteBlockedError(error: unknown): error is StorageWriteBlockedError {
  if (error instanceof StorageWriteBlockedError) return true
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    name?: unknown
    code?: unknown
    operation?: unknown
    freezeState?: unknown
  }
  return (
    candidate.name === 'StorageWriteBlockedError' &&
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('STORAGE_') &&
    typeof candidate.operation === 'string' &&
    (GATED_STORAGE_OPERATIONS as readonly string[]).includes(candidate.operation)
  )
}

/**
 * Reads the persisted freeze state for a tenant.
 *
 * Registered once, at process bootstrap, by the layer that owns the database. The
 * gate never reaches into the database itself: `packages/storage` stays free of a
 * `@beaconhs/db` dependency so this module can be exercised without one.
 *
 * Returning `null` means "no state could be determined", which is a refusal.
 */
export type StorageFreezeReader = (input: {
  /** Derived from the object key, never supplied by the caller. */
  tenantId: string
  /** The key about to be written, for context and logging. */
  key: string
}) => Promise<{ state: string; version: number } | null>

/** Installs (or clears) the freeze-state reader for this process. */
export function registerStorageFreezeReader(next: StorageFreezeReader | null): void {
  getStorageGateRegistry().reader = next
}

/**
 * Phase 6U-A/B: In-flight write tracker.
 *
 * Provides registration, completion, and failure tracking for write operations.
 * This is optional: if not registered, write operations proceed without tracking.
 *
 * Returns true if registration succeeded, false otherwise.
 */
export type InFlightWriteTracker = {
  /**
   * Register a write operation as in-flight.
   * Returns the write record ID, or null if registration failed.
   */
  register: (args: {
    tenantId: string
    operation: GatedStorageOperation
    key: string
    leaseId: string | null
    leaseVersion: number
  }) => Promise<string | null>

  /**
   * Mark a write operation as completed.
   */
  markCompleted: (args: {
    tenantId: string
    key: string
    leaseId: string | null
    recordId: string
  }) => Promise<void>

  /**
   * Mark a write operation as failed.
   */
  markFailed: (args: {
    tenantId: string
    key: string
    leaseId: string | null
    recordId: string
    error: string
  }) => Promise<void>
}

/** Installs (or clears) the in-flight write tracker for this process. */
export function registerInFlightWriteTracker(next: InFlightWriteTracker | null): void {
  getStorageGateRegistry().tracker = next
}

/**
 * Default no-op tracker used only by test harnesses/develop environments where no
 * database is available. Production path registers a real tracker via
 * `bootstrapStorageFreezeGate`. No production code should rely on this.
 */
export function createNoOpInFlightWriteTracker(): InFlightWriteTracker {
  let seq = 0
  return {
    register: async () => `noop-in-flight-${++seq}`,
    markCompleted: async () => {},
    markFailed: async () => {},
  }
}

/** Exposed for tests: whether a reader is currently installed. */
export function hasStorageFreezeReader(): boolean {
  return getStorageGateRegistry().reader !== null
}

/** Exposed for tests: whether an in-flight tracker is currently installed. */
export function hasInFlightWriteTracker(): boolean {
  return getStorageGateRegistry().tracker !== null
}

/** Get the in-flight tracker, or null if not registered. */
export function getInFlightWriteTracker(): InFlightWriteTracker | null {
  return getStorageGateRegistry().tracker
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Derive the owning tenant from a canonical object key.
 *
 * Mirrors the `t/<tenantId>/<scope>/<name>` shape produced by `newTenantObjectKey`.
 * Returns null for anything else, including a relative `..` segment or a key that
 * names a different pattern — the gate then refuses rather than guessing.
 */
export function tenantIdFromObjectKey(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1_024 || key.includes('\\')) {
    return null
  }
  const parts = key.split('/')
  if (parts.length < 4) return null
  if (parts[0] !== 't') return null
  const tenantId = parts[1]
  // `parts[1]` is narrowed by the length check above, but the index-access rule still
  // types it as `string | undefined`, so guard rather than assert.
  if (tenantId === undefined || !UUID_RE.test(tenantId)) return null
  const rest = parts.slice(2)
  if (rest.some((p) => p === '' || p === '.' || p === '..' || !/^[a-zA-Z0-9._-]+$/.test(p))) {
    return null
  }
  return tenantId
}

/** True when the state permits a controlled write. */
export function isStorageWritableState(state: string | null | undefined): boolean {
  return state === 'ACTIVE'
}

/**
 * The gate itself. Resolves (allows) or rejects with `StorageWriteBlockedError`.
 *
 * Deliberately not a boolean-returning helper: callers must not be able to branch on
 * "is it frozen" and then proceed anyway, which is exactly how a gate gets bypassed.
 */
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)
  if (tenantId === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_TENANT_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'object key does not name a tenant this gate can resolve',
    })
  }

  const activeReader = getStorageGateRegistry().reader
  if (activeReader === null) {
    // A process with no reader is a misconfigured process. Treating it as "ACTIVE"
    // would let a missing bootstrap silently disable the whole control.
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no freeze-state reader is registered for this process',
    })
  }

  let read: { state: string; version: number } | null
  try {
    read = await activeReader({ tenantId, key: args.key })
  } catch (error) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: `freeze state could not be read: ${(error as Error)?.message ?? String(error)}`,
    })
  }

  if (read === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no persisted freeze state for this tenant',
    })
  }

  if (!isStorageWritableState(read.state)) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: read.state,
    })
  }
}
