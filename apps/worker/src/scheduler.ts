import './instrument'
import { inspectScheduledRegistration, registerSchedules } from '@beaconhs/jobs'
import { captureWorkerFailure, flushObservability } from './instrument'

async function main() {
  if (process.argv.includes('--check')) {
    const status = await inspectScheduledRegistration()
    console.log(JSON.stringify({ event: 'scheduler.repeat_schedules.check', ...status }, null, 0))
    process.exit(status.ok ? 0 : 1)
  }

  console.log('[scheduler] registering repeatable jobs…')
  await registerSchedules()

  // Registration is only complete when Redis contains the exact registry.
  // Without this read-back a partial failure could still exit 0 and leave the
  // worker silently missing ticks until someone notices downstream.
  const status = await inspectScheduledRegistration()
  if (!status.ok) {
    throw new Error(`Repeat schedule verification failed: ${JSON.stringify(status)}`)
  }
  console.log(
    `[scheduler] verified ${status.actualCount}/${status.expectedCount} repeat schedules.`,
  )
  console.log('[scheduler] done. Repeat schedules are persisted in Redis — exiting.')
  process.exit(0)
}

main().catch((err) => {
  captureWorkerFailure(err, { queue: 'scheduler', jobName: 'register-schedules' })
  console.error(err)
  void flushObservability().finally(() => process.exit(1))
})
