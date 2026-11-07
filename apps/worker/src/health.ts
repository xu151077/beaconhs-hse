import { assertDatabaseConfiguration, createClient, createSuperClient } from '@beaconhs/db'
import { closeJobConnections } from '@beaconhs/jobs'
import { assertRedisReady } from '@beaconhs/jobs/health'
import { inspectScheduledRegistration } from '@beaconhs/jobs/scheduled'

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl || !redisUrl) throw new Error('Required dependency URL is not configured')
  const authSecret = process.env.BETTER_AUTH_SECRET
  if (process.env.NODE_ENV === 'production' && (!authSecret || authSecret.length < 32)) {
    throw new Error('BETTER_AUTH_SECRET is not configured securely')
  }

  assertDatabaseConfiguration({ superAdmin: true })
  const { sql } = createClient({ url: databaseUrl, max: 1 })
  const { sql: superSql } = createSuperClient({ max: 1 })
  try {
    await Promise.all([sql`select 1`, superSql`select 1`, assertRedisReady({ url: redisUrl })])

    // The scheduler is a one-shot registrar. If Redis loses the repeat
    // definitions after that process exits, the worker looks healthy while it
    // receives no ticks. Surface the missing/duplicate registry as worker
    // unhealthiness so monitoring can alert and rerun the scheduler.
    const schedules = await inspectScheduledRegistration()
    if (!schedules.ok) {
      console.error('[health] scheduled repeat registry mismatch', JSON.stringify(schedules))
      throw new Error('Scheduled repeat registry is not exact')
    }
  } finally {
    await Promise.all([
      sql.end({ timeout: 1 }),
      superSql.end({ timeout: 1 }),
      closeJobConnections(),
    ])
  }
}

main().catch((error: unknown) => {
  // Surface WHICH dependency failed — DB down, Redis down, an insecure secret
  // or a repeat-registry mismatch are different operator actions. The previous
  // no-arg catch collapsed them all into one unactionable line.
  console.error('[health] worker dependencies are not ready', error)
  process.exitCode = 1
})
