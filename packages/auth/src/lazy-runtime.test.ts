import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const instance = { api: { getSession: vi.fn() }, handler: vi.fn() }
  const state: {
    options?: {
      trustedOrigins?: string[]
      emailAndPassword?: {
        sendResetPassword?: (args: {
          user: { id: string; email: string }
          url: string
        }) => Promise<void>
      }
      hooks?: { after?: (ctx: unknown) => Promise<unknown> }
    }
    magicLinkOptions?: {
      sendMagicLink?: (args: {
        email: string
        url: string
        metadata?: Record<string, unknown>
      }) => Promise<void>
    }
  } = {}
  return {
    betterAuth: vi.fn((options) => {
      state.options = options
      return instance
    }),
    enqueueEmail: vi.fn(),
    instance,
    magicLink: vi.fn((options) => {
      state.magicLinkOptions = options
      return { id: 'magic-link' }
    }),
    nextCookies: vi.fn(() => ({ id: 'next-cookies' })),
    pool: vi.fn(),
    sendVia: vi.fn(),
    state,
  }
})

vi.mock('better-auth', () => ({ betterAuth: mocks.betterAuth }))
vi.mock('better-auth/plugins', () => ({ magicLink: mocks.magicLink }))
vi.mock('better-auth/next-js', () => ({ nextCookies: mocks.nextCookies }))
vi.mock('@beaconhs/emails', () => ({ sendVia: mocks.sendVia }))
vi.mock('@beaconhs/jobs', () => ({ enqueueEmail: mocks.enqueueEmail }))
vi.mock('pg', () => ({
  Pool: class MockPool {
    constructor(...args: unknown[]) {
      mocks.pool(...args)
    }
  },
}))
vi.mock('./invites', () => ({
  acceptInviteAfterMagicLink: vi.fn(),
  inviteGrantFromCallbackURL: vi.fn(),
  INVITE_LINK_TTL_SECONDS: 900,
}))

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.env = { ...originalEnv }
  mocks.enqueueEmail.mockResolvedValue({ id: 'job-1' })
  mocks.sendVia.mockResolvedValue({ id: 'smtp-1' })
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('lazy auth runtime', () => {
  it('imports without constructing a pool, plugins, or Better Auth', async () => {
    await import('./server')

    expect(mocks.pool).not.toHaveBeenCalled()
    expect(mocks.magicLink).not.toHaveBeenCalled()
    expect(mocks.nextCookies).not.toHaveBeenCalled()
    expect(mocks.betterAuth).not.toHaveBeenCalled()
  })

  it('constructs and reuses one configured auth instance on runtime use', async () => {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.BETTER_AUTH_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    process.env.BETTER_AUTH_URL = 'https://app.example.test'
    process.env.NODE_ENV = 'production'
    const { getAuth } = await import('./server')

    const first = getAuth()
    const second = getAuth()
    expect(first).toBe(mocks.instance)
    expect(second).toBe(first)
    expect(mocks.pool).toHaveBeenCalledTimes(1)
    expect(mocks.pool).toHaveBeenCalledWith({
      connectionString: 'postgresql://app:secret@db.example.test/beaconhs',
    })
    expect(mocks.magicLink).toHaveBeenCalledTimes(1)
    expect(mocks.nextCookies).toHaveBeenCalledTimes(1)
    expect(mocks.betterAuth).toHaveBeenCalledTimes(1)
  })

  it('returns a valid no-op result from the global after hook', async () => {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.BETTER_AUTH_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    process.env.NODE_ENV = 'production'
    const { getAuth } = await import('./server')
    getAuth()

    const after = mocks.state.options?.hooks?.after
    expect(after).toBeTypeOf('function')
    await expect(after?.({ path: '/get-session', context: { newSession: null } })).resolves.toEqual(
      {},
    )
  })

  it('durably enqueues production password-reset email without provider environment state', async () => {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.BETTER_AUTH_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    process.env.NODE_ENV = 'production'
    const { getAuth } = await import('./server')
    getAuth()

    const sendResetPassword = mocks.state.options?.emailAndPassword?.sendResetPassword
    expect(sendResetPassword).toBeTypeOf('function')
    await sendResetPassword?.({
      user: { id: 'user-1', email: 'operator@example.com' },
      url: 'https://app.example.test/reset?token=secret-token',
    })

    expect(mocks.enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'operator@example.com',
        subject: 'Reset your BeaconHS password',
        meta: { category: 'auth', userId: 'user-1' },
      }),
    )
    expect(mocks.sendVia).not.toHaveBeenCalled()
  })

  it('attributes an auth email to the tenant-scoped operation that requested it', async () => {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.BETTER_AUTH_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    process.env.NODE_ENV = 'production'
    const { getAuth, withAuthEmailContext } = await import('./server')
    getAuth()

    const sendResetPassword = mocks.state.options?.emailAndPassword?.sendResetPassword
    await withAuthEmailContext({ tenantId: 'tenant-1', userId: 'user-1' }, () =>
      sendResetPassword!({
        user: { id: 'user-1', email: 'operator@example.com' },
        url: 'https://app.example.test/reset?token=secret-token',
      }),
    )

    expect(mocks.enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { category: 'auth', tenantId: 'tenant-1', userId: 'user-1' },
      }),
    )
  })

  it('uses the explicit loopback-only SMTP transport for local magic links', async () => {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.NODE_ENV = 'development'
    process.env.SMTP_HOST = 'localhost'
    process.env.SMTP_PORT = '1025'
    process.env.SMTP_FROM = 'BeaconHS <noreply@beaconhs.local>'
    const { getAuth } = await import('./server')
    getAuth()

    const sendMagicLink = mocks.state.magicLinkOptions?.sendMagicLink
    expect(sendMagicLink).toBeTypeOf('function')
    await sendMagicLink?.({
      email: 'operator@example.com',
      url: 'http://localhost:3000/api/auth/magic-link/verify?token=secret-token',
    })

    expect(mocks.sendVia).toHaveBeenCalledWith(
      {
        provider: 'smtp',
        mode: 'local-dev',
        host: 'localhost',
        port: 1025,
        secure: false,
        from: 'BeaconHS <noreply@beaconhs.local>',
      },
      expect.objectContaining({
        to: 'operator@example.com',
        subject: 'Sign in to BeaconHS',
      }),
    )
    expect(mocks.enqueueEmail).not.toHaveBeenCalled()
  })

  it('fails closed at runtime when production configuration is missing', async () => {
    delete process.env.DATABASE_URL
    delete process.env.BETTER_AUTH_SECRET
    process.env.NODE_ENV = 'production'
    const { getAuth } = await import('./server')

    expect(() => getAuth()).toThrow('[auth] DATABASE_URL is required.')
    expect(mocks.pool).not.toHaveBeenCalled()
    expect(mocks.betterAuth).not.toHaveBeenCalled()
  })

  it('rejects a weak production signing secret before constructing auth', async () => {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.BETTER_AUTH_SECRET = 'too-short'
    process.env.NODE_ENV = 'production'
    const { getAuth } = await import('./server')

    expect(() => getAuth()).toThrow(
      '[auth] BETTER_AUTH_SECRET must contain at least 32 characters in production.',
    )
    expect(mocks.pool).not.toHaveBeenCalled()
    expect(mocks.betterAuth).not.toHaveBeenCalled()
  })
})

describe('CSRF trusted origins', () => {
  // BETTER_AUTH_TRUSTED_ORIGINS widens Better Auth's origin check so a deployment
  // reachable from another hostname (a tunnel, an alias) can sign in. It must never
  // widen silently: with the variable absent the boundary is exactly `[baseURL]`.
  async function trustedOriginsFor(env: Record<string, string | undefined>) {
    process.env.DATABASE_URL = 'postgresql://app:secret@db.example.test/beaconhs'
    process.env.BETTER_AUTH_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    process.env.NODE_ENV = 'production'
    process.env.BETTER_AUTH_URL = 'http://localhost:3000'
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const { getAuth } = await import('./server')
    getAuth()
    return mocks.state.options?.trustedOrigins
  }

  it('trusts only baseURL when BETTER_AUTH_TRUSTED_ORIGINS is unset', async () => {
    expect(await trustedOriginsFor({ BETTER_AUTH_TRUSTED_ORIGINS: undefined })).toEqual([
      'http://localhost:3000',
    ])
  })

  it('trusts only baseURL when the variable is empty', async () => {
    expect(await trustedOriginsFor({ BETTER_AUTH_TRUSTED_ORIGINS: '' })).toEqual([
      'http://localhost:3000',
    ])
  })

  it('accepts a single additional origin alongside baseURL', async () => {
    expect(
      await trustedOriginsFor({ BETTER_AUTH_TRUSTED_ORIGINS: 'https://hse.example.test' }),
    ).toEqual(['http://localhost:3000', 'https://hse.example.test'])
  })

  it('parses a comma-separated list, trimming whitespace', async () => {
    expect(
      await trustedOriginsFor({
        BETTER_AUTH_TRUSTED_ORIGINS: ' https://hse.example.test , http://127.0.0.1:3000 ',
      }),
    ).toEqual(['http://localhost:3000', 'https://hse.example.test', 'http://127.0.0.1:3000'])
  })

  it('drops empty and whitespace-only entries instead of trusting a blank origin', async () => {
    expect(
      await trustedOriginsFor({
        BETTER_AUTH_TRUSTED_ORIGINS: ' ,https://hse.example.test,,   ,http://127.0.0.1:3000,  ',
      }),
    ).toEqual(['http://localhost:3000', 'https://hse.example.test', 'http://127.0.0.1:3000'])
  })

  it('keeps baseURL first and never lets the list displace it', async () => {
    const origins = await trustedOriginsFor({
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://hse.example.test',
    })
    // baseURL also generates magic-link and callback URLs, so losing it would
    // break sign-in even when an extra origin is configured.
    expect(origins?.[0]).toBe('http://localhost:3000')
  })

  it('does not widen from the link-generation URL variables', async () => {
    // PUBLIC_APP_URL / NEXT_PUBLIC_APP_URL / APP_URL pick the hostname that links
    // are built from. Trusting them would silently widen the CSRF boundary in
    // every environment, so they must not reach trustedOrigins.
    expect(
      await trustedOriginsFor({
        PUBLIC_APP_URL: 'https://public.example.test',
        NEXT_PUBLIC_APP_URL: 'https://next-public.example.test',
        APP_URL: 'https://app.example.test',
      }),
    ).toEqual(['http://localhost:3000'])
  })

  it('drops a wildcard entry instead of letting it match any host', async () => {
    // Better Auth's matchesOriginPattern treats any pattern containing `*` or `?`
    // as a wildcard, so `BETTER_AUTH_TRUSTED_ORIGINS=*` would match EVERY Origin
    // and disable the CSRF check on all auth mutations. It must be dropped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await trustedOriginsFor({ BETTER_AUTH_TRUSTED_ORIGINS: '*' })).toEqual([
      'http://localhost:3000',
    ])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops a host-only wildcard such as *.example.com', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await trustedOriginsFor({ BETTER_AUTH_TRUSTED_ORIGINS: '*.example.com' })).toEqual([
      'http://localhost:3000',
    ])
    warn.mockRestore()
  })

  it('drops a non-absolute entry, which could never match an Origin anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await trustedOriginsFor({ BETTER_AUTH_TRUSTED_ORIGINS: 'hse.example.test' })).toEqual([
      'http://localhost:3000',
    ])
    warn.mockRestore()
  })

  it('keeps valid absolute origins while dropping invalid ones in the same list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      await trustedOriginsFor({
        BETTER_AUTH_TRUSTED_ORIGINS: 'https://hse.example.test,*,http://127.0.0.1:3000',
      }),
    ).toEqual(['http://localhost:3000', 'https://hse.example.test', 'http://127.0.0.1:3000'])
    warn.mockRestore()
  })
})
