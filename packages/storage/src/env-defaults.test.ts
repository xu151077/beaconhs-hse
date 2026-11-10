// `.env.example` ships the R2_* keys EMPTY. `??` treats "" as configured, so a
// developer who copies the example verbatim ended up with an empty access key and
// secret: every S3 call failed with a signature error that pointed nowhere near
// the real cause. These tests pin the corrected behaviour — an empty (or
// whitespace) value must fall back exactly like an absent one, while a real value
// is still honoured.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const R2_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
  'R2_INTERNAL_ENDPOINT',
  'PUBLIC_APP_URL',
  'APP_URL',
  'NEXT_PUBLIC_APP_URL',
] as const

describe('storage env defaults', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('treats empty R2_* values as unset and resolves the dev defaults', async () => {
    for (const key of R2_KEYS) vi.stubEnv(key, '')
    const mod = await import('./index')
    expect(mod.BUCKET).toBe('beaconhs-dev')
    // accountId falls back to "local", which selects the loopback MinIO endpoint
    // instead of https://<empty>.r2.cloudflarestorage.com.
    expect(mod.ENDPOINTS.public).toBe('http://localhost:9000')
  })

  it('treats whitespace-only R2_* values as unset', async () => {
    for (const key of R2_KEYS) vi.stubEnv(key, '   ')
    const mod = await import('./index')
    expect(mod.BUCKET).toBe('beaconhs-dev')
    expect(mod.ENDPOINTS.public).toBe('http://localhost:9000')
  })

  it('keeps explicit R2_* values', async () => {
    vi.stubEnv('R2_ACCOUNT_ID', 'abc123')
    vi.stubEnv('R2_ACCESS_KEY_ID', 'explicit-key')
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'explicit-secret')
    vi.stubEnv('R2_BUCKET', 'my-bucket')
    vi.stubEnv('R2_ENDPOINT', 'https://abc123.r2.cloudflarestorage.com')
    vi.stubEnv('R2_INTERNAL_ENDPOINT', 'https://abc123.r2.cloudflarestorage.com')
    const mod = await import('./index')
    expect(mod.BUCKET).toBe('my-bucket')
    expect(mod.ENDPOINTS.public).toBe('https://abc123.r2.cloudflarestorage.com')
    expect(mod.ENDPOINTS.internal).toBe('https://abc123.r2.cloudflarestorage.com')
  })
})
