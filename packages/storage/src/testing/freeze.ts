// Test fixtures for the storage write-freeze gate (Phase 6R, stage E2-A).
//
// The gate refuses every write when no reader is registered, so any test that
// exercises a mutating storage operation must install an explicit fixture. Making
// that fixture an explicit, named helper — rather than a silent default — is what
// keeps "the gate is off" from becoming an ambient assumption.

import { registerStorageFreezeReader } from '../freeze-gate'

export type FreezeFixtureState =
  | 'ACTIVE'
  | 'FREEZE_REQUESTED'
  | 'DRAINING'
  | 'FROZEN'
  | 'RECONCILING'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'

/** Install a reader that reports `state` forever. */
export function freezeReaderReturning(state: FreezeFixtureState | null): {
  calls: Array<{ tenantId: string; key: string }>
} {
  const calls: Array<{ tenantId: string; key: string }> = []
  registerStorageFreezeReader(async ({ tenantId, key }) => {
    calls.push({ tenantId, key })
    return state === null ? null : { state, version: 0 }
  })
  return { calls }
}

/** Install a reader that throws, standing in for an unreachable database. */
export function freezeReaderThrowing(message = 'database unavailable'): void {
  registerStorageFreezeReader(async () => {
    throw new Error(message)
  })
}

/** Remove the reader, restoring the fail-closed default. */
export function clearFreezeReader(): void {
  registerStorageFreezeReader(null)
}
