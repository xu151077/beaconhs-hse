import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  runtimeDb: vi.fn(),
  superDb: vi.fn(),
  redis: vi.fn(),
}))

vi.mock('@beaconhs/auth', () => ({ getAuth: mocks.getAuth }))
vi.mock('@beaconhs/db', () => ({
  db: { execute: mocks.runtimeDb },
  superDb: { execute: mocks.superDb },
}))
vi.mock('@beaconhs/jobs/health', () => ({ assertRedisReady: mocks.redis }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.getAuth.mockReturnValue({})
  mocks.runtimeDb.mockResolvedValue([])
  // superDb answers TWO queries now: the connectivity probe and the migration
  // ledger read that Phase EA-9 added. A ledger row list is returned so the
  // schema check has something to classify.
  mocks.superDb.mockResolvedValue([{ hash: 'a'.repeat(64), created_at: 1000 }])
  mocks.redis.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('web readiness', () => {
  it(
    'requires auth, runtime DB, super-admin DB, and Redis',
    // The 5s default is not enough on a loaded host: the first test pays the
    // dynamic-import + transform cost of the route module under parallel CI
    // load (all dependencies are mocked; nothing here touches a live store).
    { timeout: 30_000 },
    async () => {
      const { GET } = await import('./route')
      const response = await GET()

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: 'ready' })
      expect(mocks.getAuth).toHaveBeenCalledOnce()
      expect(mocks.runtimeDb).toHaveBeenCalledOnce()
      // Once for connectivity, once for the migration ledger (Phase EA-9).
      expect(mocks.superDb).toHaveBeenCalledTimes(2)
      expect(mocks.redis).toHaveBeenCalledOnce()
    },
  )

  it('fails readiness before accepting traffic when auth is misconfigured', async () => {
    mocks.getAuth.mockImplementation(() => {
      throw new Error('missing secret')
    })
    const { GET } = await import('./route')
    const response = await GET()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ status: 'unavailable' })
    expect(mocks.runtimeDb).not.toHaveBeenCalled()
    expect(mocks.superDb).not.toHaveBeenCalled()
    expect(mocks.redis).not.toHaveBeenCalled()
  })

  it('fails readiness when the Server Action key override is present but invalid', async () => {
    vi.stubEnv('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', 'not-a-valid-key')
    const { GET } = await import('./route')
    const response = await GET()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ status: 'unavailable' })
    expect(mocks.getAuth).not.toHaveBeenCalled()
    expect(mocks.runtimeDb).not.toHaveBeenCalled()
    expect(mocks.superDb).not.toHaveBeenCalled()
    expect(mocks.redis).not.toHaveBeenCalled()
  })

  it('stays ready when the Server Action key override is valid', async () => {
    vi.stubEnv('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', Buffer.alloc(32, 5).toString('base64'))
    const { GET } = await import('./route')
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ready' })
  })

  it('stays ready without a Server Action key override, because the build-time key applies', async () => {
    vi.stubEnv('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', '')
    const { GET } = await import('./route')
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ready' })
  })

  it('is not ready on a database that is ahead of this build', async () => {
    // A NEWER migration than the journal in this image: the build cannot know
    // about the schema it would be querying (Phase EA-9).
    mocks.superDb.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      // The ledger query is issued after the connectivity probe.
      return query && String(query).includes('__drizzle_migrations')
        ? [{ hash: 'b'.repeat(64), created_at: Number.MAX_SAFE_INTEGER - 1 }]
        : []
    })
    // Production semantics: a deployment image always ships the journal, so an
    // absent one means the image is malformed.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BEACONHS_MIGRATIONS_DIR', '/nonexistent-journal-dir')
    const { GET } = await import('./route')
    const response = await GET()

    // Without a journal this build cannot prove compatibility, and a proof that
    // could not be made is not a pass outside `next dev`.
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ status: 'unavailable' })
  })
})
