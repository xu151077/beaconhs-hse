import { execFileSync } from 'node:child_process'

/**
 * Phase BT — test-only control of the REAL storage-freeze state machine for the
 * isolated test tenant.
 *
 * This does not write freeze state directly and it does not emulate the gate. It
 * invokes the production state machine (`applyTransition` / `ensureFreezeRow` /
 * `readFreezeState`) through `bt-freeze-driver.ts`, which runs inside the test
 * environment's own worker container so the driver and the app share one
 * database. Every call returns the driver's own output, so the resulting state is
 * auditable and a transition that did not happen fails the test loudly.
 *
 * `applyTransition` refuses FROZEN unless the database itself reports a completed
 * drain. That is correct product behaviour, and it means a scenario that parks an
 * upload mid-flight cannot be frozen to FROZEN. `blockWrites` therefore prefers
 * FROZEN and settles at DRAINING when the drain cannot be verified: the gate
 * refuses new writes in every blocking state, so both are honest preconditions.
 * The state actually reached is returned so scenarios and the report can name it.
 */
const SSH_HOST = process.env.E2E_FREEZE_SSH ?? 'beaconhs-drill'
const CONTAINER = process.env.E2E_FREEZE_CONTAINER ?? 'beaconhs-phase-aj-worker-1'
const DRIVER = process.env.E2E_FREEZE_DRIVER ?? '/app/apps/worker/src/bt-freeze-driver.ts'
const TSX = process.env.E2E_FREEZE_TSX ?? '/app/apps/worker/node_modules/.bin/tsx'

export type FreezeState =
  | 'ACTIVE'
  | 'FREEZE_REQUESTED'
  | 'DRAINING'
  | 'FROZEN'
  | 'RECONCILING'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'

type FreezeCommand = 'status' | 'request' | 'drain' | 'freeze' | 'reconcile' | 'release'

const BLOCKING_STATES: readonly FreezeState[] = [
  'FREEZE_REQUESTED',
  'DRAINING',
  'FROZEN',
  'RECONCILING',
  'FAILED',
  'RECOVERY_REQUIRED',
]

function runDriver(command: FreezeCommand): string {
  try {
    return execFileSync('ssh', [SSH_HOST, `docker exec ${CONTAINER} ${TSX} ${DRIVER} ${command}`], {
      encoding: 'utf8',
      timeout: 180_000,
    }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.toString().trim() ?? ''
    throw new Error(`freeze driver "${command}" failed: ${stderr || String(error)}`)
  }
}

function readFreezeState(): FreezeState {
  const output = runDriver('status')
  const match = output.match(/state=([A-Z_]+)/)
  if (!match?.[1]) throw new Error(`Could not read the freeze state from: ${output}`)
  return match[1] as FreezeState
}

/**
 * Put the tenant into a state where the storage gate refuses new writes.
 *
 * Returns the state reached: `FROZEN` when the database could verify a completed
 * drain, otherwise `DRAINING` (the state an operator passes through while
 * in-flight writes are still draining).
 */
export function blockWrites(): FreezeState {
  const current = readFreezeState()
  // Already blocking: the gate refuses new writes in every one of these states.
  if (BLOCKING_STATES.includes(current)) return current
  if (current !== 'ACTIVE') throw new Error(`cannot block writes from freeze state ${current}`)

  runDriver('request')
  runDriver('drain')
  try {
    runDriver('freeze')
  } catch {
    // FROZEN needs a database-verified drain (zero in-flight writes, zero
    // unresolved arms). An in-flight or un-reconciled write legitimately blocks
    // it, and DRAINING — the state the operator passes through while those
    // writes finish — already refuses new writes.
    const settled = readFreezeState()
    if (!BLOCKING_STATES.includes(settled)) {
      throw new Error(`freeze failed and left an unexpected state ${settled}`)
    }
    return settled
  }
  return readFreezeState()
}

/** Return the tenant to ACTIVE from any state, via legal transitions only. */
export function releaseWrites(): FreezeState {
  const current = readFreezeState()
  // If we're in FROZEN, we need to reconcile first, then release
  if (current === 'FROZEN') {
    runDriver('reconcile')
  }
  runDriver('release')
  const state = readFreezeState()
  if (state !== 'ACTIVE') throw new Error(`release did not reach ACTIVE (state=${state})`)
  return state
}

/** Release the tenant if (and only if) it is not already ACTIVE. */
export function ensureActive(): void {
  if (readFreezeState() !== 'ACTIVE') releaseWrites()
}
