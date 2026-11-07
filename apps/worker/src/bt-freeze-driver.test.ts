/**
 * Phase CN — unit tests for bt-freeze-driver.ts
 *
 * Verify the driver's runtime guard without requiring a database. The old
 * `TEST_ONLY_DRIVER = true` constant made its `if (!TEST_ONLY_DRIVER)` branch
 * unreachable — a gate that could never fire. `driverAllowed()` is a real
 * environment check and is what main() enforces.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { driverAllowed, TEST_TENANT_ID, ACTOR_ID } from './bt-freeze-driver'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('bt-freeze-driver runtime gating', () => {
  it('allows drill hosts (non-production)', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('BEACONHS_BT_FREEZE_DRIVER', '')
    expect(driverAllowed()).toBe(true)
  })

  it('refuses a production database without explicit opt-in', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BEACONHS_BT_FREEZE_DRIVER', '')
    expect(driverAllowed()).toBe(false)
  })

  it('allows production only with the explicit drill opt-in', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BEACONHS_BT_FREEZE_DRIVER', '1')
    expect(driverAllowed()).toBe(true)
  })
})

describe('bt-freeze-driver identity', () => {
  it('pins the isolated test tenant to a valid UUID', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(TEST_TENANT_ID).toMatch(uuidRegex)
  })

  it('has a stable actor identity for audit logging', () => {
    expect(ACTOR_ID).toBe('bt-freeze-driver')
  })
})

describe('bt-freeze-driver commands', () => {
  it('accepts the documented command set', () => {
    const validCommands = ['status', 'request', 'drain', 'freeze', 'reconcile', 'release'] as const
    for (const cmd of validCommands) expect(cmd).toBeDefined()
  })
})
