import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Every authenticated route handler that can refuse an action must cross the
// `withRouteErrors` boundary. Without it, `assertCan` throws `ForbiddenError`
// and Next.js renders an opaque 500 — indistinguishable from a real server
// fault. The Phase CX matrix had encoded that 500 as the expected refusal.
//
// This is a source contract rather than a list of file names: a new export or
// PDF route is covered the moment it calls `assertCan` or `requireExportContext`.

const APP_DIR = fileURLToPath(new URL('../../app', import.meta.url))

function routeFiles(): string[] {
  return readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('route.ts'))
    .sort()
}

describe('authorization refusal boundary', () => {
  it('wraps every route handler that asserts a permission', () => {
    const offenders = routeFiles().filter((entry) => {
      const source = readFileSync(join(APP_DIR, entry), 'utf8')
      const assertsPermission =
        source.includes('assertCan(') || source.includes('requireExportContext(')
      return assertsPermission && !source.includes('withRouteErrors(')
    })
    expect(offenders).toEqual([])
  })

  it('finds the routes this contract is intended to cover', () => {
    const guarded = routeFiles().filter((entry) => {
      const source = readFileSync(join(APP_DIR, entry), 'utf8')
      return source.includes('withRouteErrors(')
    })
    expect(guarded.length).toBeGreaterThanOrEqual(30)
  })
})
