import { describe, expect, it } from 'vitest'
import {
  FIRST_RUN_PASSWORD_MIN_LENGTH,
  FIRST_RUN_RATE_LIMIT,
  FIRST_RUN_RATE_LIMIT_WINDOW_SECONDS,
  firstRunPasswordProblems,
} from './first-run-setup'

describe('first-run password policy', () => {
  it('accepts a strong password', () => {
    expect(firstRunPasswordProblems('Beacon-HS-Setup-2026')).toEqual([])
  })

  it('rejects a password shorter than the first-run floor', () => {
    const problems = firstRunPasswordProblems('Ab1!')
    expect(problems).toContain(`Use at least ${FIRST_RUN_PASSWORD_MIN_LENGTH} characters.`)
  })

  it('rejects a password with fewer than three character classes', () => {
    // Lowercase + digits only: two classes.
    expect(firstRunPasswordProblems('beaconhsetup2026')).toContain(
      'Mix at least three of: lowercase, uppercase, digits, symbols.',
    )
  })

  it('rejects whitespace', () => {
    expect(firstRunPasswordProblems('Beacon HS Setup 2026')).toContain('Do not use spaces.')
  })

  it('rejects a single repeated character', () => {
    expect(firstRunPasswordProblems('aaaaaaaaaaaaaaaa')).toContain(
      'Do not repeat a single character.',
    )
  })

  it('is stricter than the sign-in floor', () => {
    // Better Auth accepts 8 characters; the first administrator must not.
    expect(FIRST_RUN_PASSWORD_MIN_LENGTH).toBeGreaterThan(8)
  })
})

describe('first-run rate limit', () => {
  it('is bounded and windowed', () => {
    expect(FIRST_RUN_RATE_LIMIT).toBeGreaterThan(0)
    expect(FIRST_RUN_RATE_LIMIT_WINDOW_SECONDS).toBeGreaterThanOrEqual(60)
  })
})
