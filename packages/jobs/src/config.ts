// In docker-compose the service is published on 127.0.0.1:6380 (container
// port 6379); host-side processes must use the published port. Inside the
// compose network the same service listens on 6379, covered by REDIS_URL.
const LOCAL_REDIS_URL = 'redis://localhost:6380'

/** Resolve Redis only when a queue/probe is actually used. */
export function getRedisUrl(): string {
  const value = process.env.REDIS_URL
  if (value) return value
  if (process.env.NODE_ENV !== 'production') return LOCAL_REDIS_URL
  throw new Error('[jobs] REDIS_URL is required.')
}
