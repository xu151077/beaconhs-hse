import { afterEach, describe, expect, it } from 'vitest'
import { appBaseUrl } from './app-base-url'

describe('appBaseUrl runtime configuration', () => {
  const saved = {
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('follows the configured domain without rebuilding', () => {
    process.env.PUBLIC_APP_URL = 'https://hse.example.test/'
    process.env.APP_URL = 'https://hse.example.test'
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(appBaseUrl()).toBe('https://hse.example.test')
  })

  it('supports a second domain through the same runtime variable', () => {
    process.env.PUBLIC_APP_URL = 'https://beacon.example.test'
    delete process.env.APP_URL
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(appBaseUrl()).toBe('https://beacon.example.test')
  })

  it('rejects invalid and conflicting origin configuration', () => {
    process.env.PUBLIC_APP_URL = 'not a url'
    expect(() => appBaseUrl()).toThrow(/absolute HTTP\(S\) URL/)

    process.env.PUBLIC_APP_URL = 'https://one.example.test'
    process.env.APP_URL = 'https://two.example.test'
    expect(() => appBaseUrl()).toThrow(/Conflicting public origin/)
  })
})
