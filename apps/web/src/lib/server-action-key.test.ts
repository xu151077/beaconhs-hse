import { describe, expect, it } from 'vitest'
import {
  assertServerActionKeyUsable,
  inspectServerActionKey,
  isValidServerActionKey,
  serverActionKeyFingerprint,
  SERVER_ACTION_KEY_ENV,
} from './server-action-key'

// A well-formed key is 32 raw bytes, base64-encoded. The literal below is a
// test fixture, not a deployment secret, and is never used outside this file.
const VALID_KEY = Buffer.alloc(32, 7).toString('base64')

describe('server action key inspection', () => {
  it('accepts a base64-encoded 32-byte key', () => {
    expect(isValidServerActionKey(VALID_KEY)).toBe(true)
    expect(inspectServerActionKey(VALID_KEY)).toEqual({
      state: 'valid',
      source: 'runtime-override',
    })
  })

  it('treats an absent or blank override as missing, which Next.js fills from the build-time key', () => {
    expect(inspectServerActionKey(undefined)).toEqual({
      state: 'missing',
      source: 'build-time-key',
    })
    expect(inspectServerActionKey(null)).toEqual({ state: 'missing', source: 'build-time-key' })
    expect(inspectServerActionKey('   ')).toEqual({ state: 'missing', source: 'build-time-key' })
  })

  it('rejects a value that is not base64', () => {
    expect(isValidServerActionKey('not-base64!!')).toBe(false)
    expect(inspectServerActionKey('not-base64!!').state).toBe('invalid')
  })

  it('rejects base64 that does not decode to a valid AES key length', () => {
    expect(isValidServerActionKey(Buffer.alloc(15, 1).toString('base64'))).toBe(false)
    expect(isValidServerActionKey(Buffer.alloc(64, 1).toString('base64'))).toBe(false)
  })

  it('accepts every AES key length Next.js documents (16, 24, 32 bytes)', () => {
    for (const bytes of [16, 24, 32]) {
      expect(isValidServerActionKey(Buffer.alloc(bytes, 3).toString('base64'))).toBe(true)
    }
  })
})

describe('assertServerActionKeyUsable', () => {
  it('passes for a valid key and for a missing key', () => {
    expect(() => assertServerActionKeyUsable(VALID_KEY)).not.toThrow()
    expect(() => assertServerActionKeyUsable(undefined)).not.toThrow()
  })

  it('throws for an invalid key without revealing the value', () => {
    const invalid = 'not-a-valid-key'
    let thrown: Error | undefined
    try {
      assertServerActionKeyUsable(invalid)
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).toContain(SERVER_ACTION_KEY_ENV)
    expect(thrown?.message).toContain('16, 24, or 32 bytes')
    expect(thrown?.message).not.toContain(invalid)
  })
})

/**
 * The import Next.js performs on the resolved key
 * (next/dist/server/app-render/encryption-utils.js): `atob` the value and
 * import the raw bytes as an AES-GCM key. Reproducing it here shows that the
 * formats this module rejects are exactly the ones the framework cannot use,
 * so a rejected value really does break the Server Action encryption path.
 */
async function importLikeNext(value: string): Promise<CryptoKey> {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', true, ['encrypt', 'decrypt'])
}

describe('the rejected formats are unusable for Next.js as well', () => {
  it('imports an accepted key and refuses the rejected ones', async () => {
    await expect(importLikeNext(VALID_KEY)).resolves.toBeDefined()
    await expect(importLikeNext('not-a-valid-key')).rejects.toThrow()
    await expect(importLikeNext(Buffer.alloc(8, 1).toString('base64'))).rejects.toThrow()
  })
})

describe('serverActionKeyFingerprint', () => {
  it('is stable for one key and unrelated for another', async () => {
    const other = Buffer.alloc(32, 9).toString('base64')
    const first = await serverActionKeyFingerprint(VALID_KEY)
    const second = await serverActionKeyFingerprint(VALID_KEY)
    const different = await serverActionKeyFingerprint(other)

    expect(first).toBe(second)
    expect(different).not.toBe(first)
  })

  it('never contains the key material', async () => {
    const fingerprint = await serverActionKeyFingerprint(VALID_KEY)
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprint).not.toContain(VALID_KEY)
    expect(fingerprint).not.toContain(atob(VALID_KEY))
  })

  it('is unavailable when the effective key is the embedded build-time key', async () => {
    expect(await serverActionKeyFingerprint(undefined)).toBeNull()
    expect(await serverActionKeyFingerprint('')).toBeNull()
    expect(await serverActionKeyFingerprint('not-a-valid-key')).toBeNull()
  })
})
