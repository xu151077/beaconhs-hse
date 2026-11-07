import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveAuthBaseUrl } from './public-url'

describe('resolveAuthBaseUrl', () => {
  it('uses BETTER_AUTH_URL for the authentication origin', () => {
    expect(
      resolveAuthBaseUrl({
        BETTER_AUTH_URL: 'https://hse.example.test/',
      }),
    ).toBe('https://hse.example.test')
  })

  it('supports a second authentication domain through runtime configuration', () => {
    expect(
      resolveAuthBaseUrl({
        BETTER_AUTH_URL: 'https://beacon.example.test',
      }),
    ).toBe('https://beacon.example.test')
  })

  it('does not widen the auth boundary from link-generation variables', () => {
    expect(
      resolveAuthBaseUrl({
        BETTER_AUTH_URL: 'https://auth.example.test',
        PUBLIC_APP_URL: 'https://public.example.test',
        APP_URL: 'https://app.example.test',
      }),
    ).toBe('https://auth.example.test')
  })

  it('rejects invalid auth origin configuration', () => {
    expect(() => resolveAuthBaseUrl({ BETTER_AUTH_URL: 'ftp://bad.example.test' })).toThrow(
      /origin-only HTTP\(S\)/,
    )
  })

  it('does not let a stale build-time browser URL override the live origin', () => {
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')
    expect(source.indexOf('originFromGlobal ??')).toBeLessThan(
      source.indexOf('process.env.NEXT_PUBLIC_APP_URL'),
    )
  })
})
