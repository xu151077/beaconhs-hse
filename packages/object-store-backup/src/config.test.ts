// Configuration resolution tests.
//
// The properties worth pinning are the REFUSALS. A config layer that accepts an
// empty credential turns every later request into an anonymous one, which is the
// silent-privacy failure this module exists to prevent.

import { describe, expect, it } from 'vitest'
import { ConfigError, redactEndpoint, resolveStoreConfig } from './config'

const BASE = {
  endpoint: 'http://127.0.0.1:9000',
  bucket: 'beaconhs',
  accessKeyId: 'AKIAEXAMPLEKEY00001',
  secretAccessKey: 'secretvalue1234567890abcdef',
  region: 'auto',
}

describe('resolveStoreConfig', () => {
  it('accepts a complete configuration', () => {
    expect(resolveStoreConfig(BASE)).toEqual(BASE)
  })

  it('defaults the region to auto, matching packages/storage', () => {
    const config = resolveStoreConfig({ ...BASE, region: '' })
    expect(config.region).toBe('auto')
  })

  it.each([
    ['missing endpoint', { endpoint: undefined }],
    ['empty endpoint', { endpoint: '' }],
    ['whitespace-only endpoint', { endpoint: '   ' }],
    ['endpoint without a scheme', { endpoint: '127.0.0.1:9000' }],
    ['endpoint with embedded credentials', { endpoint: 'http://user:pass@127.0.0.1:9000' }],
  ])('refuses an %s', (_label, patch) => {
    expect(() => resolveStoreConfig({ ...BASE, ...patch })).toThrow(ConfigError)
  })

  it.each([
    ['bucket', { bucket: '' }],
    ['access key', { accessKeyId: '' }],
    ['secret key', { secretAccessKey: '   ' }],
  ])('refuses an empty %s rather than falling back to an anonymous request', (_label, patch) => {
    expect(() => resolveStoreConfig({ ...BASE, ...patch })).toThrow(
      /is required and must not be empty/,
    )
  })

  it('states the refusal reason for an empty access key explicitly', () => {
    // The message is the operator's only signal that a forwarded-but-unset env var
    // was the cause, so it must name the anonymous fallback it is preventing.
    expect(() => resolveStoreConfig({ ...BASE, accessKeyId: '' })).toThrow(
      /refusing to fall back to an anonymous request/i,
    )
  })
})

describe('redactEndpoint', () => {
  it('keeps scheme, host and port', () => {
    expect(redactEndpoint('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
    expect(redactEndpoint('https://hse.example.com')).toBe('https://hse.example.com')
  })

  it('drops userinfo, which is how a password ends up in a log line', () => {
    expect(redactEndpoint('http://key:secret@127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
  })

  it('drops query parameters, which is how a presigned signature leaks', () => {
    const redacted = redactEndpoint('http://127.0.0.1:9000/bucket?X-Amz-Signature=deadbeef')
    expect(redacted).toBe('http://127.0.0.1:9000')
    expect(redacted).not.toContain('deadbeef')
  })

  it('never throws on an unparseable value', () => {
    expect(redactEndpoint('not a url')).toBe('<unparseable endpoint>')
  })
})
