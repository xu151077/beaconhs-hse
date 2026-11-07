import { describe, expect, it } from 'vitest'
import { normalizeOpenSourceUrl, sanitizeOpenSourceInput } from './open-source-config'

describe('normalizeOpenSourceUrl', () => {
  it('accepts a public repository URL and canonicalizes it', () => {
    expect(normalizeOpenSourceUrl('https://github.com/example/app')).toBe(
      'https://github.com/example/app',
    )
    expect(normalizeOpenSourceUrl('  https://gitlab.com/org/repo  ')).toBe(
      'https://gitlab.com/org/repo',
    )
    expect(normalizeOpenSourceUrl('http://10.0.0.1:3000/git/app.git')).toBe(
      'http://10.0.0.1:3000/git/app.git',
    )
  })

  it('treats a blank field as "hidden"', () => {
    expect(normalizeOpenSourceUrl('')).toBe('')
    expect(normalizeOpenSourceUrl('   ')).toBe('')
  })

  it('rejects non-http(s) schemes a link must never use', () => {
    expect(() => normalizeOpenSourceUrl('javascript:alert(1)')).toThrow()
    expect(() => normalizeOpenSourceUrl('data:text/html;base64,PHNjcmlwdD4=')).toThrow()
    expect(() => normalizeOpenSourceUrl('ftp://example.com/repo')).toThrow()
    expect(() => normalizeOpenSourceUrl('//example.com/repo')).toThrow()
    expect(() => normalizeOpenSourceUrl('not a url')).toThrow()
    expect(() => normalizeOpenSourceUrl('example.com/repo')).toThrow()
  })

  it('rejects embedded credentials and whitespace', () => {
    expect(() => normalizeOpenSourceUrl('https://user:pass@example.com/repo')).toThrow(
      /credentials/,
    )
    expect(() => normalizeOpenSourceUrl('https://example.com/repo with space')).toThrow()
    expect(() => normalizeOpenSourceUrl('https://example.com/\t/repo')).toThrow()
  })

  it('rejects an over-long address', () => {
    expect(() => normalizeOpenSourceUrl(`https://example.com/${'a'.repeat(600)}`)).toThrow(
      /too long/,
    )
  })
})

describe('sanitizeOpenSourceInput', () => {
  it('passes the validated URL through', () => {
    expect(sanitizeOpenSourceInput({ url: 'https://example.com/repo' })).toEqual({
      url: 'https://example.com/repo',
    })
    expect(sanitizeOpenSourceInput({ url: '' })).toEqual({ url: '' })
  })
})
