import type { InFlightWriteTracker, StorageFreezeReader } from './freeze-gate'
import type { StorageWriteArmIssuer } from './write-arms'

/**
 * Process-wide storage gate wiring.
 *
 * Next.js can load the same workspace package into more than one server chunk. A
 * module-local variable would then give instrumentation and a route different gate
 * instances, which is exactly the failure where the app refuses every write with
 * `STORAGE_FREEZE_STATE_UNKNOWN`. A Symbol.for registry is shared by duplicate copies
 * in one Node process while remaining isolated between processes.
 */
export type StorageGateRegistry = {
  reader: StorageFreezeReader | null
  tracker: InFlightWriteTracker | null
  issuer: StorageWriteArmIssuer | null
}

const REGISTRY_KEY = Symbol.for('beaconhs.storage.gate.registry')

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: StorageGateRegistry | undefined
}

export function getStorageGateRegistry(): StorageGateRegistry {
  const globalObject = globalThis as GlobalWithRegistry
  const existing = Reflect.get(globalObject, REGISTRY_KEY) as StorageGateRegistry | undefined
  if (existing) return existing
  const created: StorageGateRegistry = { reader: null, tracker: null, issuer: null }
  Reflect.set(globalObject, REGISTRY_KEY, created)
  return created
}
