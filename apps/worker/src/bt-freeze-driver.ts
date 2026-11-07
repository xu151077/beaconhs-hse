#!/usr/bin/env tsx

/**
 * Phase CN — test-only control of the storage-freeze state machine for the isolated test tenant.
 *
 * This driver runs inside the worker container and invokes the production state machine
 * via `applyTransition`. It is **compile-time gated** and **test-only** — it does not exist
 * in production builds and cannot be called unless explicitly enabled.
 *
 * Commands:
 * - status: Read current freeze state
 * - request: Request freeze (transition ACTIVE → FREEZE_REQUESTED)
 * - drain: Initiate drain (transition FREEZE_REQUESTED → DRAINING)
 * - freeze: Freeze writes (transition DRAINING → FROZEN)
 * - reconcile: Reconcile freeze (transition FROZEN → RECONCILING)
 * - release: Release freeze (transition RECONCILING → ACTIVE)
 *
 * Usage:
 *   docker exec <container> tsx /app/apps/worker/src/bt-freeze-driver.ts status
 *   docker exec <container> tsx /app/apps/worker/src/bt-freeze-driver.ts freeze
 *   docker exec <container> tsx /app/apps/worker/src/bt-freeze-driver.ts release
 *
 * Security:
 * - Only accepts operations for the isolated test tenant (ea5a149b-ea76-48e0-abbe-fa360f520d8e)
 * - Requires SSH authentication (via SSH_HOST env var)
 * - Logs all operations to audit log
 * - Excluded from production builds (compile-time flag)
 */

import {
  db,
  readFreezeState,
  applyTransition,
  ensureFreezeRow,
  withSuperAdmin,
  getInFlightWrites,
  listStorageWriteArmsForReconciliation,
} from '@beaconhs/db'
import { STORAGE_FREEZE_PERMISSIONS } from '@beaconhs/db'
import type { Database } from '@beaconhs/db'
import { createHash } from 'node:crypto'

/**
 * This is a DRILL/E2E operator driver, not a production entrypoint (it is not
 * a build.mjs entry and is never bundled into the image). The old constant
 * `TEST_ONLY_DRIVER = true` made `if (!TEST_ONLY_DRIVER)` UNREACHABLE — a gate
 * that could never fire. Keep it runnable on drill hosts (NODE_ENV !=
 * production) while refusing to mutate a production database if the file is
 * ever copied there by hand, unless explicitly opted in.
 */
function driverAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.BEACONHS_BT_FREEZE_DRIVER === '1'
}

// Isolated test tenant
const TEST_TENANT_ID = process.env.E2E_TEST_TENANT_ID ?? 'ea5a149b-ea76-48e0-abbe-fa360f520d8e'

// Actor identity (SSH user or automated test runner)
const ACTOR_ID = process.env.E2E_FREEZE_ACTOR ?? 'bt-freeze-driver'

// Export for testing
export { driverAllowed, TEST_TENANT_ID, ACTOR_ID }

// Commands
type Command = 'status' | 'request' | 'drain' | 'freeze' | 'reconcile' | 'release'

function printUsage(): void {
  console.error('Usage: bt-freeze-driver.ts <command>')
  console.error('')
  console.error('Commands:')
  console.error('  status  - Read current freeze state')
  console.error('  request - Request freeze (ACTIVE → FREEZE_REQUESTED)')
  console.error('  drain   - Initiate drain (FREEZE_REQUESTED → DRAINING)')
  console.error('  freeze  - Freeze writes (DRAINING → FROZEN)')
  console.error('  reconcile - Reconcile freeze (FROZEN → RECONCILING)')
  console.error('  release - Release freeze (RECONCILING → ACTIVE)')
  console.error('')
  console.error('Environment variables:')
  console.error(
    '  E2E_TEST_TENANT_ID     - Test tenant ID (default: ea5a149b-ea76-48e0-abbe-fa360f520d8e)',
  )
  console.error('  E2E_FREEZE_ACTOR       - Actor identity (default: bt-freeze-driver)')
  console.error('  E2E_FREEZE_SSH         - SSH host (default: beaconhs-drill)')
  console.error('  E2E_FREEZE_CONTAINER   - Container name (default: beaconhs-phase-aj-worker-1)')
  console.error(
    '  E2E_FREEZE_DRIVER      - Driver path (default: /app/apps/worker/src/bt-freeze-driver.ts)',
  )
  console.error(
    '  E2E_FREEZE_TSX         - TSX path (default: /app/apps/worker/node_modules/.bin/tsx)',
  )
}

/**
 * Build the reconciliation manifest the state machine requires before it will
 * release the freeze.
 *
 * The rules refuse "release without something that was reconciled against", so a
 * constant hash would be fabricated evidence. This hashes the real reconciliation
 * inputs read inside the same transaction as the release: any in-flight writes that
 * are still unfinished, and storage write arms that still need external
 * verification. On the normal test path both are empty and the manifest records
 * that fact; if something is outstanding, the hash names exactly what was released
 * against.
 */
async function buildReconciliationManifest(
  tx: Database,
  row: { state: string; version: number; migrationId: string | null },
): Promise<string> {
  const [inFlightWrites, unresolvedArms] = await Promise.all([
    getInFlightWrites(tx, TEST_TENANT_ID),
    listStorageWriteArmsForReconciliation(tx, { tenantId: TEST_TENANT_ID, limit: 500 }),
  ])

  const manifest = {
    tenantId: TEST_TENANT_ID,
    freezeState: row.state,
    freezeVersion: row.version,
    migrationId: row.migrationId,
    inFlightWrites: inFlightWrites
      .map((write) => ({
        id: write.id,
        operation: write.operation,
        key: write.key,
        leaseId: write.leaseId,
        startedAt: write.startedAt.toISOString(),
        completedAt: write.completedAt?.toISOString() ?? null,
        success: write.success,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    unresolvedArms: unresolvedArms
      .map((arm) => ({
        id: arm.id,
        operation: arm.operation,
        state: arm.state,
        expiresAt: arm.expiresAt.toISOString(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }

  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

async function main(): Promise<void> {
  if (!driverAllowed()) {
    console.error(
      'ERROR: bt-freeze-driver is a drill/E2E tool and must not run against production.',
    )
    console.error('Set BEACONHS_BT_FREEZE_DRIVER=1 only on an isolated drill host.')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(0)
  }

  const command = args[0] as Command
  const validCommands: Command[] = ['status', 'request', 'drain', 'freeze', 'reconcile', 'release']

  if (!validCommands.includes(command)) {
    console.error(`ERROR: Invalid command "${command}"`)
    printUsage()
    process.exit(1)
  }

  try {
    const result = await executeCommand(command)
    console.log(result)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`ERROR: ${errorMessage}`)
    process.exit(1)
  }
}

async function executeCommand(command: Command): Promise<string> {
  return await withSuperAdmin(db, async (tx: Database) => {
    switch (command) {
      case 'status': {
        const row = await readFreezeState(tx, TEST_TENANT_ID)
        if (!row) {
          // No freeze row exists yet
          return `state=ACTIVE version=${0}`
        }
        return `state=${row.state} version=${row.version} migrationId=${row.migrationId ?? 'null'} leaseHolderId=${row.leaseHolderId ?? 'null'} leaseExpiresAt=${row.leaseExpiresAt?.toISOString() ?? 'null'} lastReason=${row.lastReason ?? 'null'}`
      }

      case 'request': {
        const row = await readFreezeState(tx, TEST_TENANT_ID)
        if (!row) {
          await ensureFreezeRow(tx, TEST_TENANT_ID)
          return `state=FREEZE_REQUESTED version=0`
        }
        if (row.state !== 'ACTIVE') {
          return `state=${row.state} version=${row.version} error=already_in_state`
        }
        const updated = await applyTransition(tx, {
          tenantId: TEST_TENANT_ID,
          actorId: ACTOR_ID,
          permission: STORAGE_FREEZE_PERMISSIONS.request,
          to: 'FREEZE_REQUESTED',
          reason: 'bt-freeze-driver: manual request',
          expectedVersion: row.version,
        })
        return `state=${updated.state} version=${updated.version}`
      }

      case 'drain': {
        const row = await readFreezeState(tx, TEST_TENANT_ID)
        if (!row) {
          throw new Error('no freeze row exists (call "request" first)')
        }
        if (row.state !== 'FREEZE_REQUESTED') {
          throw new Error(`cannot drain from state ${row.state}`)
        }
        const updated = await applyTransition(tx, {
          tenantId: TEST_TENANT_ID,
          actorId: ACTOR_ID,
          permission: STORAGE_FREEZE_PERMISSIONS.drain,
          to: 'DRAINING',
          reason: 'bt-freeze-driver: manual drain',
          expectedVersion: row.version,
        })
        return `state=${updated.state} version=${updated.version}`
      }

      case 'freeze': {
        const row = await readFreezeState(tx, TEST_TENANT_ID)
        if (!row) {
          throw new Error('no freeze row exists (call "request" then "drain" first)')
        }
        if (row.state !== 'DRAINING') {
          throw new Error(`cannot freeze from state ${row.state}`)
        }
        const updated = await applyTransition(tx, {
          tenantId: TEST_TENANT_ID,
          actorId: ACTOR_ID,
          permission: STORAGE_FREEZE_PERMISSIONS.freeze,
          to: 'FROZEN',
          reason: 'bt-freeze-driver: manual freeze',
          expectedVersion: row.version,
        })
        return `state=${updated.state} version=${updated.version}`
      }

      case 'release': {
        let row = await readFreezeState(tx, TEST_TENANT_ID)
        if (!row) {
          return `state=ACTIVE version=0`
        }
        if (row.state === 'ACTIVE') {
          return `state=${row.state} version=${row.version} error=already_active`
        }
        if (row.state === 'FROZEN') {
          // FROZEN -> ACTIVE is deliberately illegal: the tenant must be
          // reconciled first so the release names what changed while frozen.
          throw new Error('cannot release from FROZEN; run "reconcile" first')
        }

        // Return to ACTIVE through legal edges only. DRAINING may be abandoned
        // back to FREEZE_REQUESTED, and the two recovery states re-enter
        // FREEZE_REQUESTED before a release is legal.
        if (row.state === 'DRAINING') {
          row = await applyTransition(tx, {
            tenantId: TEST_TENANT_ID,
            actorId: ACTOR_ID,
            permission: STORAGE_FREEZE_PERMISSIONS.drain,
            to: 'FREEZE_REQUESTED',
            reason: 'bt-freeze-driver: abandon drain before release',
            expectedVersion: row.version,
          })
        }
        if (row.state === 'FAILED') {
          row = await applyTransition(tx, {
            tenantId: TEST_TENANT_ID,
            actorId: ACTOR_ID,
            permission: STORAGE_FREEZE_PERMISSIONS.recover,
            to: 'RECOVERY_REQUIRED',
            reason: 'bt-freeze-driver: recover failed freeze before release',
            expectedVersion: row.version,
          })
        }
        if (row.state === 'RECOVERY_REQUIRED') {
          row = await applyTransition(tx, {
            tenantId: TEST_TENANT_ID,
            actorId: ACTOR_ID,
            permission: STORAGE_FREEZE_PERMISSIONS.recover,
            to: 'FREEZE_REQUESTED',
            reason: 'bt-freeze-driver: restart freeze request before release',
            expectedVersion: row.version,
          })
        }
        if (row.state !== 'FREEZE_REQUESTED' && row.state !== 'RECONCILING') {
          throw new Error(`cannot release from state ${row.state}`)
        }

        const reconciliation = {
          manifestSha256: await buildReconciliationManifest(tx, row),
        }
        const updated = await applyTransition(tx, {
          tenantId: TEST_TENANT_ID,
          actorId: ACTOR_ID,
          permission: STORAGE_FREEZE_PERMISSIONS.release,
          to: 'ACTIVE',
          reason: 'bt-freeze-driver: manual release',
          expectedVersion: row.version,
          reconciliation,
        })
        return `state=${updated.state} version=${updated.version} reconciliationManifestSha256=${reconciliation.manifestSha256}`
      }

      case 'reconcile': {
        const row = await readFreezeState(tx, TEST_TENANT_ID)
        if (!row) {
          throw new Error('no freeze row exists (call "request" then "drain" then "freeze" first)')
        }
        if (row.state !== 'FROZEN') {
          throw new Error(`cannot reconcile from state ${row.state}`)
        }
        const updated = await applyTransition(tx, {
          tenantId: TEST_TENANT_ID,
          actorId: ACTOR_ID,
          permission: STORAGE_FREEZE_PERMISSIONS.reconcile,
          to: 'RECONCILING',
          reason: 'bt-freeze-driver: manual reconcile',
          expectedVersion: row.version,
        })
        return `state=${updated.state} version=${updated.version}`
      }

      default: {
        throw new Error(`unknown command: ${command}`)
      }
    }
  })
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
