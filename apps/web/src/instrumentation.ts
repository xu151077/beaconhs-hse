import * as Sentry from '@sentry/nextjs'
import { bootstrapStorageFreezeGate } from '@beaconhs/db'
import * as storage from '@beaconhs/storage'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config')
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config')

  // Phase 6R (E2-A): install the DB-backed freeze-state reader so `packages/storage`
  // can gate controlled writes for every request in this process. Storage refuses all
  // mutations while no reader is registered — the safe failure — so this must run
  // before the first storage call, and it must run in the nodejs runtime only: the
  // edge runtime has no database access, and attempting this there would throw.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await bootstrapStorageFreezeGate(storage)
  }
}

export const onRequestError = Sentry.captureRequestError
