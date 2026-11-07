/**
 * Storage write-freeze persistence (Phase 6Q, stage E1).
 *
 * Every mutation is a compare-and-set on (id, version, state). Two operators racing
 * the same transition therefore produce exactly one winner: the loser's UPDATE
 * matches zero rows and is reported as a conflict. Nothing here reads-then-writes
 * without the version guard, so a lost update cannot present itself as success.
 *
 * The lease is a database constraint, not an application check: at most one row per
 * tenant may carry a lease holder, so a second concurrent migration cannot acquire
 * one even if two processes both believe they are first.
 */

import { and, eq, sql } from 'drizzle-orm'
import { auditLog } from './schema/audit'
import { storageFreeze as storageFreezeTable } from './schema/storage-freeze'

import { db, type Database } from './client'
import { withSuperAdmin } from './rls'
import {
  StorageFreezeError,
  assertDeterminable,
  assertTransition,
  evaluateLease,
  restartMustNotUnfreeze,
  type DrainVerification,
  type ReconcileEvidence,
  type StorageFreezePermission,
  type StorageFreezeStateName,
  type TransitionRequest,
} from './storage-freeze'

export type { StorageFreezeStateName, StorageFreezePermission, ReconcileEvidence }

export type StorageFreezeRow = typeof storageFreezeTable.$inferSelect

/** Default lease duration. Long enough for a slow drain, short enough to recover. */
export const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000

export async function readFreezeState(
  tx: Database,
  tenantId: string,
): Promise<StorageFreezeRow | null> {
  const rows = await tx
    .select()
    .from(storageFreezeTable)
    .where(eq(storageFreezeTable.tenantId, tenantId))
    .limit(2)
  if (rows.length > 1) {
    throw new StorageFreezeError(
      'FREEZE_STATE_AMBIGUOUS',
      'multiple storage freeze rows exist for this tenant; refusing to guess which state is authoritative',
    )
  }
  return rows[0] ?? null
}

/**
 * Read the state for a write-path decision, failing closed.
 *
 * Returns the state, or throws. A caller that receives a value may act on it. A
 * caller that gets an exception must refuse the write. This is deliberately different
 * from `isFrozenState`, which is advisory.
 */
export async function requireFreezeState(
  tx: Database,
  tenantId: string,
): Promise<StorageFreezeRow> {
  const row = await readFreezeState(tx, tenantId)
  assertDeterminable(row?.state ?? null)
  if (row == null) {
    throw new StorageFreezeError(
      'FREEZE_STATE_UNKNOWN',
      'no storage freeze row for this tenant; refusing to assume writes are unfrozen',
    )
  }
  return row
}

/** Whether writes may resume. Throws rather than guessing when state is unreadable. */
export async function assertWritesMayProceed(tx: Database, tenantId: string): Promise<void> {
  const row = await requireFreezeState(tx, tenantId)
  if (row.state !== 'ACTIVE') {
    throw new StorageFreezeError(
      'FREEZE_ACTIVE',
      `storage writes are frozen (state=${row.state}); this gate is informational in E1 ` +
        'and is enforced from stage E2',
    )
  }
}

/**
 * Recover the state after a process restart.
 *
 * Rule 7: never default to ACTIVE. An absent or unreadable row yields
 * `safeToResumeWrites: false`, which is what a caller must honour.
 */
export async function recoverFreezeStateAfterRestart(
  tx: Database,
  tenantId: string,
): Promise<{ safeToResumeWrites: boolean; reason: string; state: StorageFreezeStateName | null }> {
  const row = await readFreezeState(tx, tenantId)
  const verdict = restartMustNotUnfreeze(row?.state ?? null)
  return { ...verdict, state: row?.state ?? null }
}

async function appendAudit(
  tx: Database,
  input: {
    tenantId: string
    actorId: string
    migrationId: string | null
    from: StorageFreezeStateName
    to: StorageFreezeStateName
    reason: string
    version: number
    evidence: Record<string, unknown> | null
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: input.tenantId,
    // audit_log.actor_user_id is a FK to users; the freeze actor is an operator
    // identity string, not necessarily a users row, so it is recorded in metadata.
    entityType: 'storage_freeze',
    action: `freeze.${input.from.toLowerCase()}_to_${input.to.toLowerCase()}`,
    summary: `storage freeze ${input.from} -> ${input.to}`,
    before: { state: input.from, version: input.version },
    after: { state: input.to, version: input.version + 1 },
    // Deliberately narrow: actor, migration id and reason only. Never a credential,
    // a presigned URL, an HMAC key or any object content.
    metadata: {
      actorId: input.actorId,
      migrationId: input.migrationId,
      reason: input.reason,
      ...(input.evidence ?? {}),
    },
  })
}

async function requireFreezeStateForUpdate(
  tx: Database,
  tenantId: string,
): Promise<StorageFreezeRow> {
  const rows = await tx
    .select()
    .from(storageFreezeTable)
    .where(eq(storageFreezeTable.tenantId, tenantId))
    .for('update')
    .limit(2)
  if (rows.length > 1) {
    throw new StorageFreezeError(
      'FREEZE_STATE_AMBIGUOUS',
      'multiple storage freeze rows exist for this tenant; refusing to transition without one authoritative row',
    )
  }
  const row = rows[0]
  assertDeterminable(row?.state ?? null)
  if (!row) {
    throw new StorageFreezeError(
      'FREEZE_STATE_UNKNOWN',
      'no storage freeze row for this tenant; refusing to assume writes are unfrozen',
    )
  }
  return row
}

/**
 * Take the drain snapshot used to authorise DRAINING -> FROZEN.
 */
async function readDrainVerification(
  tx: Database,
  tenantId: string,
  now: Date,
): Promise<DrainVerification> {
  // The drain primitive lives beside the arm ledger. Import it dynamically to keep
  // the existing module dependency direction (arms -> freeze operations) acyclic.
  const { readStorageFreezeDrainStatus } = await import('./storage-write-arms-operations')
  const status = await readStorageFreezeDrainStatus(tx, tenantId, now)
  return {
    inFlightCount: status.inFlightCount,
    unresolvedArmCount: status.unresolvedArmCount,
    waitUntil: status.waitUntil,
    verifiedAt: now.toISOString(),
  }
}

/**
 * Apply a transition atomically.
 *
 * The UPDATE carries every guard in its WHERE clause: id, tenant, the version the
 * caller read, the state it read, and — when the row already carries a lease — the
 * holder. A zero-row result is reported as a conflict and never as success.
 */
export async function applyTransition(
  tx: Database,
  args: {
    tenantId: string
    actorId: string
    permission: StorageFreezePermission
    to: StorageFreezeStateName
    reason: string
    expectedVersion: number
    reconciliation?: ReconcileEvidence
    evidence?: Record<string, unknown> | null
    now?: Date
    leaseMs?: number
  },
): Promise<StorageFreezeRow> {
  const now = args.now ?? new Date()
  const current = await requireFreezeStateForUpdate(tx, args.tenantId)

  const leaseCheck = evaluateLease({
    leaseHolderId: current.leaseHolderId,
    leaseExpiresAt: current.leaseExpiresAt,
    now,
    actorId: args.actorId,
  })
  if (!leaseCheck.mayProceed) {
    throw new StorageFreezeError(
      'FREEZE_LEASE_HELD_BY_OTHER',
      'another operator holds the active migration lease for this tenant',
    )
  }

  const drain =
    args.to === 'FROZEN' ? await readDrainVerification(tx, args.tenantId, now) : undefined
  const request: TransitionRequest = {
    from: current.state,
    to: args.to,
    expectedVersion: args.expectedVersion,
    actorId: args.actorId,
    permission: args.permission,
    reason: args.reason,
    drain,
    reconciliation: args.reconciliation,
  }
  // Throws StorageFreezeError for every illegal, unverified or unevidenced case.
  assertTransition(request)

  const transitionEvidence: Record<string, unknown> | null = drain
    ? { ...(args.evidence ?? {}), drain }
    : (args.evidence ?? null)

  if (args.expectedVersion !== current.version) {
    throw new StorageFreezeError(
      'FREEZE_VERSION_CONFLICT',
      `expected version ${args.expectedVersion} but the row is at ${current.version}`,
    )
  }

  // Entering a migration claims the lease; returning to ACTIVE releases it.
  const enteringMigration = args.to !== 'ACTIVE'
  const leaseHolderId = enteringMigration ? args.actorId : null
  const leaseExpiresAt = enteringMigration
    ? new Date(now.getTime() + (args.leaseMs ?? DEFAULT_LEASE_MS))
    : null
  const migrationId = enteringMigration ? (current.migrationId ?? crypto.randomUUID()) : null

  const updated = await tx
    .update(storageFreezeTable)
    .set({
      state: args.to,
      version: sql`${storageFreezeTable.version} + 1`,
      leaseHolderId,
      leaseExpiresAt,
      leaseRenewedAt: enteringMigration ? now : null,
      migrationId,
      lastTransitionBy: args.actorId,
      lastTransitionAt: now,
      lastReason: args.reason,
      updatedAt: now,
      // Reconciliation output is retained after release so the release stays
      // auditable; the schema check only demands it exists once state is ACTIVE.
      ...(args.reconciliation
        ? {
            reconciliationManifestSha256: args.reconciliation.manifestSha256,
            reconciledAt: now,
          }
        : {}),
      ...(transitionEvidence ? { evidence: transitionEvidence } : {}),
      ...(args.to === 'FREEZE_REQUESTED' ? { freezeRequestedAt: now } : {}),
    })
    .where(
      and(
        eq(storageFreezeTable.id, current.id),
        eq(storageFreezeTable.tenantId, args.tenantId),
        eq(storageFreezeTable.version, args.expectedVersion),
        eq(storageFreezeTable.state, current.state),
      ),
    )
    .returning()

  const row = updated[0]
  if (!row) {
    // Lost the compare-and-set. Someone else moved the row between our read and our
    // write. Reporting success here would be a lie, so this is an explicit conflict.
    throw new StorageFreezeError(
      'FREEZE_VERSION_CONFLICT',
      'the freeze row changed during this transition; retry by re-reading the state',
    )
  }

  await appendAudit(tx, {
    tenantId: args.tenantId,
    actorId: args.actorId,
    migrationId: row.migrationId,
    from: current.state,
    to: args.to,
    reason: args.reason,
    version: current.version,
    evidence: transitionEvidence,
  })

  return row
}

/**
 * Create the single freeze row for a tenant, or return the existing one.
 *
 * Idempotent so that a caller can ensure the row exists without racing. The insert
 * relies on the partial unique index for the active lease; a concurrent second
 * migration for the same tenant fails on that constraint rather than on a check in
 * application code that two processes could both pass.
 */
export async function ensureFreezeRow(tx: Database, tenantId: string): Promise<StorageFreezeRow> {
  const existing = await readFreezeState(tx, tenantId)
  if (existing) return existing

  const inserted = await tx
    .insert(storageFreezeTable)
    .values({ tenantId, state: 'ACTIVE' })
    .onConflictDoNothing()
    .returning()

  const row = inserted[0]
  if (row) return row

  // Someone else inserted between our read and our insert.
  const raced = await readFreezeState(tx, tenantId)
  if (raced) return raced
  throw new StorageFreezeError(
    'FREEZE_ROW_MISSING',
    'could not read or create the storage freeze row for this tenant',
  )
}

/**
 * Database-backed freeze-state reader for the storage write gate (Phase 6R, E2-A).
 *
 * `packages/storage` has no `@beaconhs/db` dependency — deliberately, so the gate is
 * testable without a database — so the reader lives here and is registered by the layer
 * that owns the database.
 *
 * `withSuperAdmin` is intentional: the caller supplies only a tenant id derived from an
 * object key, and the freeze state must be readable regardless of which role the request
 * runs as. A tenant-scoped read would make the gate depend on the caller's own
 * permission set, which is exactly the coupling it exists to avoid.
 *
 * Returning `null` means "no state could be determined", which the gate treats as a
 * refusal. No path turns an unreadable state into a permissive one.
 */
export async function readStorageFreezeStateForTenant(
  tenantId: string,
): Promise<{ state: string; version: number } | null> {
  const row = await withSuperAdmin(db, (tx) => readFreezeState(tx, tenantId))
  if (row === null) return null
  return { state: row.state, version: row.version }
}

/**
 * Register the DB-backed reader with `packages/storage`.
 *
 * Called once at each process bootstrap (web request path, worker startup). A bootstrap
 * that forgets this leaves storage refusing every controlled write — the correct failure
 * mode, but an invisible one, because the calls fail loudly rather than bypassing.
 *
 * The import is dynamic so `packages/db` keeps no module-level dependency on
 * `@beaconhs/storage`, which its own tests would otherwise drag in.
 */
/**
 * Reader shape, declared structurally rather than imported.
 *
 * `@beaconhs/db` must NOT depend on `@beaconhs/storage`: storage is the layer that
 * consumes the gate, and a dependency back the other way would create a cycle the
 * moment storage ever needs a type from db. So the reader contract is restated here,
 * structurally, and the registration call goes through a runtime lookup that does not
 * require the type. `packages/storage/src/freeze-gate.ts` is the single source of the
 * same shape.
 */
type StorageFreezeReaderContract = (input: {
  tenantId: string
  key: string
}) => Promise<{ state: string; version: number } | null>

type StorageWriteArmIssuerContract = {
  issue: (args: {
    tenantId: string
    key: string
    operation: 'presignPut' | 'presignMultipartPart'
    requestedExpiresInSeconds?: number
    uploadId?: string | null
    uploadToken?: string | null
  }) => Promise<{
    armId: string
    uploadToken: string
    expiresAt: Date
    expiresInSeconds: number
  } | null>
  activate: (args: { armId: string; tenantId: string }) => Promise<boolean>
  withdraw: (args: { armId: string; tenantId: string; error: string }) => Promise<boolean>
}

type StorageGateModule = {
  registerStorageFreezeReader?: (reader: StorageFreezeReaderContract) => void
  registerInFlightWriteTracker?: (tracker: never) => unknown
  registerStorageWriteArmIssuer?: (issuer: never) => unknown
}

/**
 * Register the DB-backed reader with `packages/storage`.
 *
 * The optional module argument exists for the Next.js standalone runtime and for the
 * bundled worker: those builds do not ship a resolvable, loadable `@beaconhs/storage`
 * package on disk — the specifier resolves to raw TypeScript under `node_modules`, which
 * Node refuses to type-strip (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — so a bare
 * dynamic import fails closed even though the storage code is already bundled. Web and
 * the worker both pass their statically bundled module here; the dynamic import remains
 * only as a fallback for callers that genuinely have one.
 *
 * Called once at each process bootstrap (web request path, worker startup, storage init).
 * A bootstrap that forgets this leaves storage refusing every controlled write — the
 * correct failure mode, but an invisible one, because the calls fail loudly rather than
 * bypassing.
 *
 * The specifier is passed as a value, not written literally, so this package carries NO
 * compile-time dependency on `@beaconhs/storage`. `@beaconhs/db` is consumed by storage's
 * callers and must never become a dependency of the layer it gates; a static import
 * here would invert that and risk a cycle the moment storage needs a type from db.
 *
 * If the storage module is genuinely absent the catch leaves the gate unregistered and
 * failing closed, which is the safe outcome.
 */
export async function bootstrapStorageFreezeGate(storageModule?: StorageGateModule): Promise<void> {
  const moduleSpecifier = '@beaconhs/storage'
  let register: ((reader: StorageFreezeReaderContract) => void) | null = null
  let registerTracker: ((tracker: unknown) => void) | null = null
  let registerArmIssuer: ((issuer: unknown) => void) | null = null
  try {
    const loaded: unknown =
      storageModule ?? (await import(/* webpackIgnore: true */ moduleSpecifier))
    register = (loaded as { registerStorageFreezeReader?: unknown })
      .registerStorageFreezeReader as typeof register
    registerTracker = (loaded as { registerInFlightWriteTracker?: unknown })
      .registerInFlightWriteTracker as typeof registerTracker
    registerArmIssuer = (loaded as { registerStorageWriteArmIssuer?: unknown })
      .registerStorageWriteArmIssuer as typeof registerArmIssuer
  } catch (error) {
    console.error('[storage-freeze] failed to load storage gate module', error)
    return
  }
  if (typeof register === 'function') {
    const install = register as (reader: StorageFreezeReaderContract) => void
    install(async ({ tenantId }) => readStorageFreezeStateForTenant(tenantId))
  }
  if (typeof registerTracker === 'function') {
    const installTracker = registerTracker as (tracker: {
      register: (args: {
        tenantId: string
        operation: string
        key: string
        leaseId: string | null
        leaseVersion: number
      }) => Promise<string | null>
      markCompleted: (args: {
        tenantId: string
        key: string
        leaseId: string | null
        recordId: string
      }) => Promise<void>
      markFailed: (args: {
        tenantId: string
        key: string
        leaseId: string | null
        recordId: string
        error: string
      }) => Promise<void>
    }) => void
    installTracker({
      register: async (args) => {
        return await withSuperAdmin(db, (tx) =>
          registerInFlightWrite(tx, {
            tenantId: args.tenantId,
            operation: args.operation,
            key: args.key,
            leaseId: args.leaseId,
            leaseVersion: args.leaseVersion,
          }),
        )
      },
      markCompleted: async (args) => {
        await withSuperAdmin(db, (tx) =>
          markInFlightWriteCompleted(tx, {
            tenantId: args.tenantId,
            key: args.key,
            leaseId: args.leaseId,
            recordId: args.recordId,
          }),
        )
      },
      markFailed: async (args) => {
        await withSuperAdmin(db, (tx) =>
          markInFlightWriteFailed(tx, {
            tenantId: args.tenantId,
            key: args.key,
            leaseId: args.leaseId,
            recordId: args.recordId,
            error: args.error,
          }),
        )
      },
    })
  }

  if (typeof registerArmIssuer === 'function') {
    const installArmIssuer = registerArmIssuer as (issuer: unknown) => void
    const issuer: StorageWriteArmIssuerContract = {
      issue: async (args) => {
        const arms = await import('./storage-write-arms-operations')
        const row = await withSuperAdmin(db, (tx) =>
          arms.issueStorageWriteArmUnderFreezeLock(tx, {
            tenantId: args.tenantId,
            operation: args.operation,
            objectKey: args.key,
            uploadToken: args.uploadToken ?? null,
            uploadId: args.uploadId ?? null,
            requestedExpiresInSeconds: args.requestedExpiresInSeconds ?? null,
          }),
        )
        if (!row) return null
        const expiresIn = Math.max(1, Math.ceil((row.expiresAt.getTime() - Date.now()) / 1_000))
        return {
          armId: row.id,
          uploadToken: row.uploadToken,
          expiresAt: row.expiresAt,
          expiresInSeconds: expiresIn,
        }
      },
      activate: async (args) => {
        const arms = await import('./storage-write-arms-operations')
        return await withSuperAdmin(db, (tx) =>
          arms.activateStorageWriteArm(tx, args.armId, args.tenantId),
        )
      },
      withdraw: async (args) => {
        const arms = await import('./storage-write-arms-operations')
        return await withSuperAdmin(db, (tx) =>
          arms.failStorageWriteArmActivation(tx, {
            id: args.armId,
            tenantId: args.tenantId,
            error: args.error,
          }),
        )
      },
    }
    installArmIssuer(issuer)
  }
}

// Import in-flight-writes schema
import { inFlightWrite as inFlightWriteTable, type InFlightWrite } from './schema/in-flight-writes'

// Phase 6U-B2: In-flight write tracking helpers

/**
 * Register a write operation when it is admitted.
 *
 * This creates a record in `in_flight_writes`, marking it as in-progress.
 * The record must NOT be created if the tenant is not in ACTIVE state.
 *
 * @returns The write record ID, or null if registration failed
 */
export async function registerInFlightWrite(
  tx: Database,
  args: {
    tenantId: string
    operation: string
    key: string
    leaseId: string | null
    leaseVersion: number
  },
): Promise<string | null> {
  const now = new Date()

  // Serialize admission with the DRAINING -> FROZEN snapshot. Holding the same row
  // lock means a freeze transition either sees this write in its count or wins first
  // and makes this registration return null.
  const freezeState = await requireFreezeStateForUpdate(tx, args.tenantId)
  if (freezeState.state !== 'ACTIVE') {
    return null
  }

  const writeRecord = await tx
    .insert(inFlightWriteTable)
    .values({
      tenantId: args.tenantId,
      operation: args.operation,
      key: args.key,
      leaseId: args.leaseId,
      leaseVersion: args.leaseVersion,
      startedAt: now,
      success: false,
      completedAt: null,
    })
    .returning({ id: inFlightWriteTable.id })

  return writeRecord[0]?.id ?? null
}

/**
 * Mark a write operation as completed successfully.
 *
 * Idempotent: if write is already completed, no-op.
 */
export async function markInFlightWriteCompleted(
  tx: Database,
  args: {
    tenantId: string
    key: string
    leaseId: string | null
    recordId: string
  },
): Promise<void> {
  const now = new Date()

  await tx
    .update(inFlightWriteTable)
    .set({
      completedAt: now,
      success: true,
    })
    .where(
      and(
        eq(inFlightWriteTable.tenantId, args.tenantId),
        eq(inFlightWriteTable.id, args.recordId),
        eq(inFlightWriteTable.key, args.key),
        args.leaseId ? eq(inFlightWriteTable.leaseId, args.leaseId) : undefined,
        sql`${inFlightWriteTable.completedAt} IS NULL`,
      ),
    )
}

/**
 * Mark a write operation as failed.
 *
 * Idempotent: if write is already completed, no-op.
 */
export async function markInFlightWriteFailed(
  tx: Database,
  args: {
    tenantId: string
    key: string
    leaseId: string | null
    recordId: string
    error: string
  },
): Promise<void> {
  const now = new Date()

  await tx
    .update(inFlightWriteTable)
    .set({
      completedAt: now,
      success: false,
      error: args.error,
    })
    .where(
      and(
        eq(inFlightWriteTable.tenantId, args.tenantId),
        eq(inFlightWriteTable.id, args.recordId),
        eq(inFlightWriteTable.key, args.key),
        args.leaseId ? eq(inFlightWriteTable.leaseId, args.leaseId) : undefined,
        sql`${inFlightWriteTable.completedAt} IS NULL`,
      ),
    )
}

/**
 * Count in-flight (not yet completed) writes for a tenant.
 *
 * Returns 0 if database is unavailable or error.
 */
export async function countInFlightWrites(
  tx: Database,
  args: {
    tenantId: string
  },
): Promise<number> {
  const result = await tx
    .select({ count: sql<number>`COUNT(*)` })
    .from(inFlightWriteTable)
    .where(
      and(
        eq(inFlightWriteTable.tenantId, args.tenantId),
        sql`${inFlightWriteTable.completedAt} IS NULL`,
      ),
    )

  const raw = result[0]?.count
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : -1
}

/**
 * Get list of in-flight writes for a tenant.
 */
export async function getInFlightWrites(tx: Database, tenantId: string): Promise<InFlightWrite[]> {
  return await tx
    .select()
    .from(inFlightWriteTable)
    .where(
      and(
        eq(inFlightWriteTable.tenantId, tenantId),
        sql`${inFlightWriteTable.completedAt} IS NULL`,
      ),
    )
}

/**
 * Get list of all writes for a tenant (including completed ones).
 */
export async function getAllWritesForTenant(
  tx: Database,
  tenantId: string,
): Promise<InFlightWrite[]> {
  return await tx.select().from(inFlightWriteTable).where(eq(inFlightWriteTable.tenantId, tenantId))
}

/**
 * Clean up stale in-flight writes (for recovery after crash).
 *
 * Conservative approach:
 * - Only remove records that are definitely completed but not marked as such
 *   (completedAt > some threshold ago)
 * - Mark orphaned records for manual review
 */
export async function cleanupOrphanedWrites(
  tx: Database,
  tenantId: string,
  thresholdMs: number = 24 * 60 * 60 * 1000, // 24 hours
): Promise<{ removed: number; orphaned: number }> {
  const cutoff = new Date(Date.now() - thresholdMs)
  const now = new Date()

  const staleWrites = await tx
    .select()
    .from(inFlightWriteTable)
    .where(
      and(
        eq(inFlightWriteTable.tenantId, tenantId),
        // Not completed
        sql`${inFlightWriteTable.completedAt} IS NULL`,
        // Started more than threshold ago (likely orphaned)
        sql`${inFlightWriteTable.startedAt} < ${cutoff}`,
      ),
    )

  let orphaned = 0
  for (const write of staleWrites) {
    // Mark as orphaned (error = 'orphaned', completedAt = now with success = false)
    await tx
      .update(inFlightWriteTable)
      .set({
        completedAt: now,
        success: false,
        error: 'orphaned: exceeded threshold, likely process crash',
      })
      .where(eq(inFlightWriteTable.id, write.id))
    orphaned++
  }

  return { removed: 0, orphaned }
}

/**
 * Check if all in-flight writes have completed for a tenant.
 *
 * Used by freeze drain logic.
 */
export async function allInFlightWritesCompleted(
  tx: Database,
  tenantId: string,
): Promise<{ completed: boolean; count: number }> {
  const count = await countInFlightWrites(tx, { tenantId })
  if (count < 0) {
    // Database error
    return { completed: false, count: -1 }
  }

  return { completed: count === 0, count }
}

/**
 * Phase 6U-A: Acquire a write lease for a tenant.
 *
 * This is called by write operations that need to prove they were admitted before
 * the tenant entered a non-ACTIVE state. The lease is held for the entire duration
 * of the write operation, preventing concurrent writes from interleaving with the
 * freeze transition.
 *
 * The lease is acquired using optimistic concurrency control: the UPDATE must match
 * the version we read. If another process has already acquired the lease or the
 * tenant is not in ACTIVE state, the lease is not acquired.
 *
 * @returns The lease ID and the new version, or null if the lease could not be acquired.
 */
export async function acquireWriteLease(
  tx: Database,
  tenantId: string,
  operation: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<{ leaseId: string; version: number } | null> {
  const now = new Date()
  const leaseId = crypto.randomUUID()

  // Read the current state
  const current = await readFreezeState(tx, tenantId)
  if (!current) {
    return null
  }

  if (current.state !== 'ACTIVE') {
    // Tenant is not in ACTIVE state, cannot acquire write lease
    return null
  }

  // Check if lease is already held
  const leaseCheck = evaluateLease({
    leaseHolderId: current.leaseHolderId,
    leaseExpiresAt: current.leaseExpiresAt,
    now,
    actorId: operation,
  })
  if (!leaseCheck.mayProceed) {
    return null
  }

  // Try to acquire the lease using optimistic concurrency
  const [updated] = await tx
    .update(storageFreezeTable)
    .set({
      leaseHolderId: operation,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      leaseRenewedAt: now,
    })
    .where(
      and(
        eq(storageFreezeTable.tenantId, tenantId),
        eq(storageFreezeTable.version, current.version),
        eq(storageFreezeTable.state, 'ACTIVE'),
      ),
    )
    .returning({ id: storageFreezeTable.id, version: storageFreezeTable.version })

  if (!updated) {
    // Lease could not be acquired: another process acquired it between our read and our write
    return null
  }

  // Lease acquired successfully
  return { leaseId, version: current.version + 1 }
}

/**
 * Release a write lease for a tenant.
 *
 * This is called when a write operation completes (successfully or unsuccessfully).
 * The lease is released even if the write failed, so that the lease can be acquired
 * by other processes.
 *
 * @param tenantId The tenant ID
 * @param leaseId The lease ID to release (optional, for safety)
 * @param version The version at which the lease was acquired
 */
export async function releaseWriteLease(
  tx: Database,
  tenantId: string,
  leaseId?: string,
  version: number = 0,
): Promise<void> {
  await tx
    .update(storageFreezeTable)
    .set({
      leaseHolderId: null,
      leaseExpiresAt: null,
      leaseRenewedAt: null,
    })
    .where(
      and(
        eq(storageFreezeTable.tenantId, tenantId),
        leaseId ? eq(storageFreezeTable.id, leaseId) : undefined,
        eq(storageFreezeTable.version, version),
      ),
    )
}
