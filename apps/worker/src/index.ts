import { Worker } from 'bullmq'
import './instrument'
import { closeJobConnections, getBlockingConnection } from '@beaconhs/jobs'
import { bootstrapStorageFreezeGate } from '@beaconhs/db'
import * as storage from '@beaconhs/storage'
import { processEmail } from './workers/email'
import { processPdf } from './workers/pdf'
import { processNotification } from './workers/notify'
import { processScheduledTick } from './workers/scheduled'
import { processReportRun } from './workers/reports'
import { processOutboundDispatch } from './workers/outbound'
import { processPush } from './workers/push'
import { processAiJob } from './workers/ai'
import { captureWorkerFailure, flushObservability } from './instrument'

console.log('[worker] starting beaconhs worker…')

// Phase 6R (E2-A): install the DB-backed freeze-state reader so `packages/storage`
// can gate controlled writes. Without this the gate stays unregistered and storage
// refuses every mutation — the safe failure, but a broken worker. Called before any
// Worker is constructed so the gate is armed before the first job can run.
//
// The statically-imported module is passed explicitly. A bare dynamic
// `import('@beaconhs/storage')` resolves to raw TypeScript inside the production
// image, which Node refuses to type-strip from `node_modules`
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), leaving the gate unregistered
// and every worker storage operation failing closed.
await bootstrapStorageFreezeGate(storage)

const connection = getBlockingConnection()
const workers = [
  new Worker('emails', processEmail, { connection, concurrency: 10 }),
  new Worker('pdfs', processPdf, { connection, concurrency: 3 }),
  new Worker('notifications', processNotification, { connection, concurrency: 10 }),
  new Worker('scheduled', processScheduledTick, { connection, concurrency: 5 }),
  new Worker('reports', processReportRun, { connection, concurrency: 2 }),
  new Worker('outbound', processOutboundDispatch, { connection, concurrency: 5 }),
  new Worker('push', processPush, { connection, concurrency: 10 }),
  new Worker('ai', processAiJob, { connection, concurrency: 2, lockDuration: 5 * 60 * 1000 }),
]

for (const w of workers) {
  w.on('completed', (job) => console.log(`✔ ${w.name}#${job.id} ${job.name}`))
  w.on('failed', (job, err) => {
    captureWorkerFailure(err, {
      queue: w.name,
      jobId: job?.id,
      jobName: job?.name,
    })
    console.error(`✗ ${w.name}#${job?.id} ${job?.name}: ${err.message}`)
  })
  w.on('error', (err) => {
    captureWorkerFailure(err, { queue: w.name })
    console.error(`! ${w.name}: ${err.message}`)
  })
}

let shutdownPromise: Promise<void> | null = null

// A job can legitimately run for minutes (AI has a 5-minute lock, PDF books
// render up to 250 MiB of sources, outbound HTTP has a 120 s timeout). Without
// a hard deadline, `worker.close()` can outlive the orchestrator's SIGTERM
// grace period and the process is SIGKILLed mid-transaction. Give the drain a
// bounded window, then exit non-zero so the supervisor sees an unclean stop.
const SHUTDOWN_GRACE_MS = Number(process.env.BEACONHS_WORKER_SHUTDOWN_GRACE_MS ?? 45_000)

const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    const deadline = setTimeout(() => {
      console.error(
        `[worker] shutdown exceeded ${SHUTDOWN_GRACE_MS}ms; forcing exit before the orchestrator kills us mid-transaction`,
      )
      process.exit(1)
    }, SHUTDOWN_GRACE_MS)
    deadline.unref()
    console.log(`[worker] ${signal} received; draining active jobs…`)
    const closeResults = await Promise.allSettled(workers.map((worker) => worker.close()))
    let exitCode = 0
    for (let index = 0; index < closeResults.length; index++) {
      const result = closeResults[index]!
      if (result.status === 'fulfilled') continue
      exitCode = 1
      const worker = workers[index]!
      captureWorkerFailure(result.reason, { queue: worker.name, jobName: 'shutdown' })
      console.error(`[worker] ${worker.name} did not close cleanly:`, result.reason)
    }
    try {
      await closeJobConnections()
    } catch (error) {
      exitCode = 1
      captureWorkerFailure(error, { queue: 'redis', jobName: 'shutdown' })
      console.error('[worker] Redis connections did not close cleanly:', error)
    }
    try {
      await flushObservability()
    } catch (error) {
      exitCode = 1
      console.error('[worker] observability flush failed during shutdown:', error)
    }
    clearTimeout(deadline)
    process.exit(exitCode)
  })()
  return shutdownPromise
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

// A rejection outside a BullMQ worker's `failed` event (a stray promise in a
// handler, an event-emitter callback) must still reach Sentry and drain the
// observability buffer before the runtime terminates.
for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(event, (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    captureWorkerFailure(error, { queue: event })
    console.error(`[worker] ${event}:`, error)
    void flushObservability().then(
      () => process.exit(1),
      () => process.exit(1),
    )
  })
}
