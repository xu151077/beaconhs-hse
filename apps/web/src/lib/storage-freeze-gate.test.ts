// The process-wide storage write gate over a freshly provisioned tenant (live database).
//
// WHY THIS FILE EXISTS
//
// `provisionTenant` used to create a tenant with no `storage_freeze` row. The gate in
// `packages/storage` fails closed when its reader cannot resolve one, so every tenant
// created through the UI or the CLI was refused EVERY controlled storage write with
// `STORAGE_FREEZE_STATE_UNKNOWN`: uploads and document saves simply did not work.
//
// The fix creates the row inside the provisioning transaction. This suite pins the
// whole chain that makes it matter, wired the way production wires it:
// `provisionTenant` (the `/platform/tenants/new` path), `bootstrapStorageFreezeGate`
// exactly as `apps/web/src/instrumentation.ts` calls it at process startup, and the
// real `assertStorageWriteAllowed` that `presignPut` / `putObject` call. This is the
// only layer that can run all three: `packages/db` deliberately does not depend on
// `@beaconhs/storage`, and `packages/storage` deliberately does not depend on a
// database.
//
// Scenarios are SKIPPED, loudly, without the scratch-database variables — and when they
// run, the connection variables are FORCED to the scratch values. This file provisions
// and deletes a tenant; `??=` could leave a pre-set `SUPERADMIN_DATABASE_URL` in place
// and provision that tenant somewhere real.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import * as storage from '@beaconhs/storage'
import {
  STORAGE_FREEZE_PERMISSIONS,
  applyTransition,
  bootstrapStorageFreezeGate,
  db,
  ensureFreezeRow,
  readFreezeState,
  withSuperAdmin,
} from '@beaconhs/db'
import { provisionTenant, type ProvisionedTenant } from '@beaconhs/db/tenant-provisioning'
import { storageFreeze, tenants } from '@beaconhs/db/schema'

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL
const SCRATCH_SUPERADMIN_URL = process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL
const canRun = Boolean(SCRATCH_URL && SCRATCH_SUPERADMIN_URL)

if (canRun) {
  process.env.DATABASE_URL = SCRATCH_URL as string
  process.env.SUPERADMIN_DATABASE_URL = SCRATCH_SUPERADMIN_URL as string
}

const describeDb = canRun ? describe : describe.skip

if (!canRun) {
  console.warn(
    '[storage-freeze-gate] SEED_TEST_SCRATCH_DATABASE_URL / _SUPERADMIN_URL are not set — ' +
      'the provisioned-tenant gate scenarios are SKIPPED, not passed.' +
      (SCRATCH_URL
        ? ' The superadmin URL is required too: the provisioner and the gate reader run as BYPASSRLS.'
        : ''),
  )
}

/** The key shape every storage write must have: `t/<tenant>/<...>`. */
const probeKey = (tenantId: string) => `t/${tenantId}/attachments/gate-probe.bin`

describeDb('the storage write gate over a provisioned tenant (live database)', () => {
  let tenant: ProvisionedTenant | undefined

  beforeAll(async () => {
    // Exactly the production startup call — the real module, so the registered reader
    // is the real DB-backed one.
    await bootstrapStorageFreezeGate(storage)
    tenant = await provisionTenant({
      name: 'Gate Provisioning Ltd',
      defaultLanguage: 'en',
      enabledLanguages: ['en'],
      actorUserId: null,
    })
  }, 120_000)

  afterAll(async () => {
    if (!tenant) return
    const id = tenant.id
    // `storage_freeze` references `tenants` with NO ACTION on purpose (migration 0046:
    // a hard tenant delete must not silently erase the record that the tenant was
    // frozen), so this teardown removes the record FIRST, explicitly — the same order
    // an operator would use. Everything else hangs off the tenant by cascade.
    await withSuperAdmin(db, async (tx) => {
      await tx.delete(storageFreeze).where(eq(storageFreeze.tenantId, id))
      await tx.delete(tenants).where(eq(tenants.id, id))
    })
  }, 60_000)

  it('admits a controlled write for a freshly provisioned tenant', async () => {
    if (!tenant) throw new Error('the provisioner did not run')
    await expect(
      storage.assertStorageWriteAllowed({ operation: 'putObject', key: probeKey(tenant.id) }),
    ).resolves.toBeUndefined()
  }, 30_000)

  it('fails closed without the row, and the initializer repairs it', async () => {
    if (!tenant) throw new Error('the provisioner did not run')
    const id = tenant.id

    // Recreate the pre-fix world: the tenant exists, its freeze row does not.
    await withSuperAdmin(db, (tx) => tx.delete(storageFreeze).where(eq(storageFreeze.tenantId, id)))
    const refusal = await storage
      .assertStorageWriteAllowed({ operation: 'putObject', key: probeKey(id) })
      .then(
        () => null,
        (error: unknown) => error as { code?: string },
      )
    expect(refusal?.code).toBe('STORAGE_FREEZE_STATE_UNKNOWN')

    // The same primitive the provisioner now runs brings the tenant back — this is
    // the repair path an operator has for tenants created before the fix.
    await withSuperAdmin(db, (tx) => ensureFreezeRow(tx, id))
    await expect(
      storage.assertStorageWriteAllowed({ operation: 'putObject', key: probeKey(id) }),
    ).resolves.toBeUndefined()
  }, 30_000)

  it('refuses once a freeze has been requested, and passes the state through', async () => {
    if (!tenant) throw new Error('the provisioner did not run')
    const id = tenant.id

    await withSuperAdmin(db, async (tx) => {
      const row = await readFreezeState(tx, id)
      if (!row) throw new Error('the freeze row disappeared before the transition')
      await applyTransition(tx, {
        tenantId: id,
        actorId: 'test:storage-freeze-gate',
        permission: STORAGE_FREEZE_PERMISSIONS.request,
        to: 'FREEZE_REQUESTED',
        reason: 'storage-freeze-gate scenario',
        expectedVersion: row.version,
      })
    })

    const refusal = await storage
      .assertStorageWriteAllowed({ operation: 'putObject', key: probeKey(id) })
      .then(
        () => null,
        (error: unknown) => error as { code?: string; freezeState?: string },
      )
    expect(refusal?.code).toBe('STORAGE_FROZEN')
    expect(refusal?.freezeState).toBe('FREEZE_REQUESTED')
  }, 30_000)
})
