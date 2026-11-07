import { Redis } from 'ioredis'
import type { ConnectionOptions } from 'bullmq'
import { getRedisUrl } from './config'

// Producers and blocking consumers require opposite retry semantics. Web
// requests and scheduler publishers must fail in bounded time when Redis is
// unavailable; workers must keep their blocking connections alive indefinitely
// so BullMQ can resume consumption after an outage.
//
// Both clients remain lazy at the module level. Next's production build walks
// this graph without runtime services, so importing a queue must not connect.
// Under TS 6, ioredis 5.11's `Redis` class is no longer nominally assignable to
// BullMQ's `ConnectionOptions` union, so the assertion stays at this boundary.
let producerConnection: Redis | undefined
let blockingConnection: Redis | undefined

export function getConnection(): ConnectionOptions {
  if (!producerConnection) {
    const client = new Redis(getRedisUrl(), {
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      // Fail fast when Redis is unreachable instead of queueing commands
      // offline forever: web requests, scheduler publishers and operator CLIs
      // must observe a bounded enqueue failure, never a silent hang.
      enableOfflineQueue: false,
      // Never reconnect-loop in request/CLI context: a dead broker rejects
      // the in-flight command immediately instead of spraying reconnect
      // errors while the caller waits. (Workers use the blocking connection
      // below, whose infinite retry is deliberate.)
      retryStrategy: () => null,
    })
    // ioredis throws on an 'error' event with no listener. Failures already
    // surface through rejected commands, which every caller handles and logs;
    // this only keeps the shared client from crashing the process.
    client.on('error', () => undefined)
    producerConnection = client
  }
  return producerConnection as unknown as ConnectionOptions
}

export function getBlockingConnection(): ConnectionOptions {
  blockingConnection ??= new Redis(getRedisUrl(), {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  })
  return blockingConnection as unknown as ConnectionOptions
}

/** Close both shared clients after BullMQ workers have finished draining. */
export async function closeJobConnections(): Promise<void> {
  const connections = [producerConnection, blockingConnection].filter(
    (connection): connection is Redis => Boolean(connection),
  )
  producerConnection = undefined
  blockingConnection = undefined
  const results = await Promise.allSettled(
    connections.map(async (connection) => {
      try {
        await connection.quit()
      } catch (error) {
        connection.disconnect(false)
        throw error
      }
    }),
  )
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more Redis connections failed to close cleanly')
  }
}
