import { bootstrapStorageFreezeGate } from '@beaconhs/db'
import * as storage from '@beaconhs/storage'

async function main(): Promise<void> {
  // The statically-imported module is passed explicitly: a bare dynamic
  // `import('@beaconhs/storage')` resolves to raw TypeScript inside the
  // production image, which Node refuses to type-strip from `node_modules`
  // (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) and would leave the gate
  // unregistered.
  await bootstrapStorageFreezeGate(storage)
  await storage.ensureBucket()
  console.log('[storage-init] private bucket policy, lifecycle, and anonymous-read probe passed')
}

main().catch((error: unknown) => {
  console.error('[storage-init] failed:', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
})
