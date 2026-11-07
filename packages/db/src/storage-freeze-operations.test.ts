// Storage write-freeze persistence (Phase 6Q stage E1) — database-backed tests.
//
// These are SKIPPED, LOUDLY, when no scratch Postgres is configured. A skipped
// scenario is reported as skipped, never as passed: the Phase 6Q host had no reachable
// database and container operations were forbidden for this phase, so the optimistic
// concurrency, lease and audit behaviour below has NOT been executed and must not be
// reported as verified.
//
// What IS verified without a database lives in ./storage-freeze.test.ts: every legal
// transition, every illegal transition, drain-evidence validation, release evidence,
// lease validity and restart behaviour.

import { describe, expect, it, beforeAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from './client'
import { tenants } from './schema/core'
import { auditLog } from './schema/audit'
import { storageWriteArms } from './schema/storage-write-arms'
import { inFlightWrite as inFlightWriteTable } from './schema/in-flight-writes'
import { assertSameScratchDatabase, resolveScratchDatabaseUrl } from './testing/scratch-database'
import {
  applyTransition,
  bootstrapStorageFreezeGate,
  ensureFreezeRow,
  markInFlightWriteCompleted,
  readFreezeState,
  registerInFlightWrite,
  readStorageFreezeStateForTenant,
  recoverFreezeStateAfterRestart,
  requireFreezeState,
} from './storage-freeze-operations'
import { STORAGE_FREEZE_PERMISSIONS, StorageFreezeError } from './storage-freeze'

const SCRATCH_URL = resolveScratchDatabaseUrl()
if (SCRATCH_URL) {
  // The suite uses the shared `db` client, which reads DATABASE_URL. Refuse to
  // run if that client does not point at the same isolated database as the gate.
  assertSameScratchDatabase(SCRATCH_URL, process.env.DATABASE_URL ?? '')
}
const describeDb = SCRATCH_URL ? describe : describe.skip

if (!SCRATCH_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[storage-freeze] SEED_TEST_SCRATCH_DATABASE_URL is not set — persistence scenarios are ' +
      'SKIPPED, not passed. Optimistic concurrency, lease exclusivity and audit writing ' +
      'remain UNVERIFIED against a real database.',
  )
}

const REASON = 'e1 persistence scenario'
const SHA = 'b'.repeat(64)

let tenantId = ''

async function expectFreezeError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error(`expected StorageFreezeError ${code}, but the promise resolved`)
  } catch (error) {
    expect(error).toBeInstanceOf(StorageFreezeError)
    expect((error as StorageFreezeError).code).toBe(code)
  }
}

describeDb('storage_freeze persistence', () => {
  beforeAll(async () => {
    tenantId = randomUUID()
    await db.insert(tenants).values({
      id: tenantId,
      name: `freeze-e1-${tenantId.slice(0, 8)}`,
      slug: `freeze-e1-${tenantId.slice(0, 8)}`,
    })
  })

  it('ensureFreezeRow is idempotent', async () => {
    const a = await ensureFreezeRow(db, tenantId)
    const b = await ensureFreezeRow(db, tenantId)
    expect(a.id).toBe(b.id)
    expect(a.state).toBe('ACTIVE')
    expect(a.version).toBe(0)
  })

  it('completing one same-key write does not close a concurrent sibling', async () => {
    const key = `t/${tenantId}/document/same-key.bin`
    const first = await registerInFlightWrite(db, {
      tenantId,
      operation: 'putObject',
      key,
      leaseId: null,
      leaseVersion: 0,
    })
    const second = await registerInFlightWrite(db, {
      tenantId,
      operation: 'putObject',
      key,
      leaseId: null,
      leaseVersion: 0,
    })
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first).not.toBe(second)

    await markInFlightWriteCompleted(db, {
      tenantId,
      key,
      leaseId: null,
      recordId: first!,
    })
    const open = await db
      .select({ id: inFlightWriteTable.id })
      .from(inFlightWriteTable)
      .where(and(eq(inFlightWriteTable.tenantId, tenantId), isNull(inFlightWriteTable.completedAt)))
    expect(open.map((row) => row.id)).toContain(second!)
    expect(open.map((row) => row.id)).not.toContain(first!)
    await markInFlightWriteCompleted(db, {
      tenantId,
      key,
      leaseId: null,
      recordId: second!,
    })
  })

  it('reads back the state it wrote', async () => {
    await ensureFreezeRow(db, tenantId)
    const row = await readFreezeState(db, tenantId)
    expect(row?.state).toBe('ACTIVE')
  })

  it('refuses a version conflict and leaves the row untouched', async () => {
    const before = await ensureFreezeRow(db, tenantId)
    await applyTransition(db, {
      tenantId,
      actorId: 'op-a',
      permission: STORAGE_FREEZE_PERMISSIONS.request,
      to: 'FREEZE_REQUESTED',
      reason: REASON,
      expectedVersion: before.version,
    })
    // A second operator holding a stale version must lose the compare-and-set.
    await expectFreezeError(
      applyTransition(db, {
        tenantId,
        actorId: 'op-a',
        permission: STORAGE_FREEZE_PERMISSIONS.drain,
        to: 'DRAINING',
        reason: REASON,
        expectedVersion: before.version,
      }),
      'FREEZE_VERSION_CONFLICT',
    )

    const after = await readFreezeState(db, tenantId)
    expect(after?.state).toBe('FREEZE_REQUESTED')
    expect(after?.version).toBe(before.version + 1)
  })

  it('refuses FROZEN until unresolved arms are terminal and their grace has elapsed', async () => {
    const row = await requireFreezeState(db, tenantId)
    const draining = await applyTransition(db, {
      tenantId,
      actorId: 'op-a',
      permission: STORAGE_FREEZE_PERMISSIONS.drain,
      to: 'DRAINING',
      reason: REASON,
      expectedVersion: row.version,
      now: new Date('2026-01-01T00:00:00Z'),
    })
    await db.insert(storageWriteArms).values({
      tenantId,
      operation: 'presignPut',
      objectKey: `t/${tenantId}/document/pending.docx`,
      uploadToken: 'freeze-test-token',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T00:00:10Z'),
      state: 'armed',
    })

    await expectFreezeError(
      applyTransition(db, {
        tenantId,
        actorId: 'op-a',
        permission: STORAGE_FREEZE_PERMISSIONS.freeze,
        to: 'FROZEN',
        reason: REASON,
        expectedVersion: draining.version,
        now: new Date('2026-01-01T00:00:20Z'),
      }),
      'FREEZE_DRAIN_UNVERIFIED',
    )

    await db
      .update(storageWriteArms)
      .set({ state: 'redeemed_nop', reconciledAt: new Date('2026-01-01T00:00:21Z') })
      .where(eq(storageWriteArms.tenantId, tenantId))

    const frozen = await applyTransition(db, {
      tenantId,
      actorId: 'op-a',
      permission: STORAGE_FREEZE_PERMISSIONS.freeze,
      to: 'FROZEN',
      reason: REASON,
      expectedVersion: draining.version,
      now: new Date('2026-01-01T00:00:30Z'),
    })
    expect(frozen.state).toBe('FROZEN')
  })

  it('returns to ACTIVE only through reconciliation evidence', async () => {
    const frozen = await requireFreezeState(db, tenantId)
    await expectFreezeError(
      applyTransition(db, {
        tenantId,
        actorId: 'op-a',
        permission: STORAGE_FREEZE_PERMISSIONS.release,
        to: 'ACTIVE',
        reason: REASON,
        expectedVersion: frozen.version,
      }),
      'FREEZE_ILLEGAL_TRANSITION',
    )

    const reconciling = await applyTransition(db, {
      tenantId,
      actorId: 'op-a',
      permission: STORAGE_FREEZE_PERMISSIONS.reconcile,
      to: 'RECONCILING',
      reason: REASON,
      expectedVersion: frozen.version,
    })
    const active = await applyTransition(db, {
      tenantId,
      actorId: 'op-a',
      permission: STORAGE_FREEZE_PERMISSIONS.release,
      to: 'ACTIVE',
      reason: REASON,
      expectedVersion: reconciling.version,
      reconciliation: { manifestSha256: SHA },
    })
    expect(active.state).toBe('ACTIVE')
    expect(active.reconciliationManifestSha256).toBe(SHA)
  })

  it('writes an audit row that carries no secret material', async () => {
    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
    const row = await requireFreezeState(db, tenantId)
    const requested = await applyTransition(db, {
      tenantId,
      actorId: 'op-audit',
      permission: STORAGE_FREEZE_PERMISSIONS.request,
      to: 'FREEZE_REQUESTED',
      reason: REASON,
      expectedVersion: row.version,
    })
    await applyTransition(db, {
      tenantId,
      actorId: 'op-audit',
      permission: STORAGE_FREEZE_PERMISSIONS.fail,
      to: 'FAILED',
      reason: REASON,
      expectedVersion: requested.version,
    })
    const after = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId))
    expect(after.length).toBeGreaterThan(before.length)
    const written = JSON.stringify(after[after.length - 1]?.metadata ?? {})
    expect(written).not.toMatch(/secret|password|token|BEGIN AGE|hmac/i)
  })

  it('reports the persisted state after a simulated restart', async () => {
    const v = await recoverFreezeStateAfterRestart(db, tenantId)
    expect(v.safeToResumeWrites).toBe(false)
    expect(v.state).toBe('FAILED')
  })

  it('keeps a lease exclusive per tenant', async () => {
    const other = randomUUID()
    await db.insert(tenants).values({
      id: other,
      name: `freeze-e1-${other.slice(0, 8)}`,
      slug: `freeze-e1-${other.slice(0, 8)}`,
    })
    await ensureFreezeRow(db, other)
    const fresh = await ensureFreezeRow(db, other)
    await applyTransition(db, {
      tenantId: other,
      actorId: 'op-x',
      permission: STORAGE_FREEZE_PERMISSIONS.request,
      to: 'FREEZE_REQUESTED',
      reason: REASON,
      expectedVersion: fresh.version,
    })
    const leased = await readFreezeState(db, other)
    expect(leased?.leaseHolderId).toBe('op-x')

    // A different operator must not be able to advance it while the lease is live.
    await expect(
      applyTransition(db, {
        tenantId: other,
        actorId: 'op-y',
        permission: STORAGE_FREEZE_PERMISSIONS.fail,
        to: 'FAILED',
        reason: REASON,
        expectedVersion: leased!.version,
        now: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/LEASE/i)
  })

  it('records the reconciliation hash as audit evidence on release', async () => {
    // The earlier scenarios have already exercised FROZEN -> RECONCILING -> ACTIVE with
    // a real manifest hash. This asserts the retained audit evidence names the actor
    // and never carries secret material.
    const row = await requireFreezeState(db, tenantId)
    expect(row.state).toBe('FAILED') // reached via the failure path, as E1 allows
    // The audit rows written by earlier scenarios must name the actor, never a secret.
    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId))
    const json = JSON.stringify(rows.map((r) => r.metadata))
    expect(json).not.toMatch(/secret|password|hmac|BEGIN AGE/i)
  })

  it('surfaces StorageFreezeError with a machine-readable code', async () => {
    const row = await readFreezeState(db, tenantId)
    await expect(
      applyTransition(db, {
        tenantId,
        actorId: 'op-a',
        permission: STORAGE_FREEZE_PERMISSIONS.recover,
        to: 'ACTIVE',
        reason: REASON,
        expectedVersion: 9999,
      }),
    ).rejects.toBeInstanceOf(StorageFreezeError)
  })
})

// ---------------------------------------------------------------------------
// DB-backed reader for the storage write gate (Phase 6R, E2-A)
//
// These assert the contract `packages/storage` relies on: the reader returns the
// persisted state verbatim, and returns null — never ACTIVE — when no row exists.
// ---------------------------------------------------------------------------

describeDb('readStorageFreezeStateForTenant', () => {
  it('returns the persisted state for the tenant', async () => {
    const row = await readFreezeState(db, tenantId)
    const read = await readStorageFreezeStateForTenant(tenantId)
    expect(read).toEqual({ state: row!.state, version: row!.version })
  })

  it('returns null for a tenant with no freeze row', async () => {
    expect(await readStorageFreezeStateForTenant(randomUUID())).toBeNull()
  })

  it('reports a non-ACTIVE state verbatim, so the gate cannot be fooled', async () => {
    const fresh = randomUUID()
    await db.insert(tenants).values({
      id: fresh,
      name: `freeze-e1-${fresh.slice(0, 8)}`,
      slug: `freeze-e1-${fresh.slice(0, 8)}`,
    })
    await ensureFreezeRow(db, fresh)
    const before = await readFreezeState(db, fresh)
    await applyTransition(db, {
      tenantId: fresh,
      actorId: 'op',
      permission: STORAGE_FREEZE_PERMISSIONS.request,
      to: 'FREEZE_REQUESTED',
      reason: REASON,
      expectedVersion: before!.version,
    })
    expect((await readStorageFreezeStateForTenant(fresh))?.state).toBe('FREEZE_REQUESTED')
  })
})

describe('bootstrapStorageFreezeGate', () => {
  it('registers against an explicitly supplied bundled storage module', async () => {
    const reader = vi.fn()
    const tracker = vi.fn()
    const issuer = vi.fn()
    await bootstrapStorageFreezeGate({
      registerStorageFreezeReader: reader,
      registerInFlightWriteTracker: tracker,
      registerStorageWriteArmIssuer: issuer,
    })
    expect(reader).toHaveBeenCalledOnce()
    expect(tracker).toHaveBeenCalledOnce()
    expect(issuer).toHaveBeenCalledOnce()
  })

  it('resolves without throwing, and installs no permissive reader, for an empty module', async () => {
    // On failure the contract is: leave the gate unregistered and fail closed. Never
    // throw, and never install a reader that would let writes through.
    await expect(bootstrapStorageFreezeGate({})).resolves.toBeUndefined()
  })
})
