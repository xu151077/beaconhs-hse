// Phase 6R (E2-A): prove a DB-style reader drives the real gate.
//
// The gate must not depend on a database, so its tests use a fake reader. What this
// file adds is the opposite direction: that a reader shaped like the one
// `packages/db` installs at bootstrap — an async function returning
// `{ state, version }` or `null` — is accepted and consulted correctly.
//
// It performs NO storage I/O and needs no database. The point is the CONTRACT between
// the two packages, exercised through the real `assertStorageWriteAllowed`.

import { afterEach, describe, expect, it } from 'vitest'
import {
  assertStorageWriteAllowed,
  hasStorageFreezeReader,
  registerStorageFreezeReader,
} from './freeze-gate'

const TENANT = '11111111-2222-4333-8444-555555555555'
const KEY = `t/${TENANT}/documents/probe.bin`

/** The exact shape `readStorageFreezeStateForTenant` returns. */
type DbStyleReader = (input: {
  tenantId: string
  key: string
}) => Promise<{ state: string; version: number } | null>

afterEach(() => {
  registerStorageFreezeReader(null)
})

describe('a DB-shaped reader drives the gate', () => {
  it('accepts a reader returning null, and refuses rather than allowing', async () => {
    const reader: DbStyleReader = async () => null
    registerStorageFreezeReader(reader)
    expect(hasStorageFreezeReader()).toBe(true)
    const error = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    expect(error.code).toBe('STORAGE_FREEZE_STATE_UNKNOWN')
  })

  it('hands the reader the tenant derived from the key, never the reverse', async () => {
    const seen: string[] = []
    const reader: DbStyleReader = async ({ tenantId }) => {
      seen.push(tenantId)
      return null
    }
    registerStorageFreezeReader(reader)
    await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(() => undefined)
    expect(seen).toEqual([TENANT])
  })

  it('allows when the DB-shaped reader reports ACTIVE', async () => {
    const reader: DbStyleReader = async () => ({ state: 'ACTIVE', version: 0 })
    registerStorageFreezeReader(reader)
    await expect(
      assertStorageWriteAllowed({ operation: 'putObject', key: KEY }),
    ).resolves.toBeUndefined()
  })

  it('refuses every frozen state a DB-shaped reader can report', async () => {
    for (const state of [
      'FREEZE_REQUESTED',
      'DRAINING',
      'FROZEN',
      'RECONCILING',
      'FAILED',
      'RECOVERY_REQUIRED',
    ]) {
      const reader: DbStyleReader = async () => ({ state, version: 0 })
      registerStorageFreezeReader(reader)
      await expect(
        assertStorageWriteAllowed({ operation: 'putObject', key: KEY }),
        state,
      ).rejects.toThrow(/STORAGE_FROZEN/)
    }
  })

  it('a reader that throws is a refusal, never an allowance', async () => {
    // Stands in for an unreachable database at bootstrap time.
    registerStorageFreezeReader(async () => {
      throw new Error('database unavailable')
    })
    await expect(assertStorageWriteAllowed({ operation: 'putObject', key: KEY })).rejects.toThrow(
      /STORAGE_FREEZE_STATE_UNKNOWN/,
    )
  })

  it('clearing the reader restores the fail-closed default', async () => {
    registerStorageFreezeReader(async () => ({ state: 'ACTIVE', version: 0 }))
    await expect(
      assertStorageWriteAllowed({ operation: 'putObject', key: KEY }),
    ).resolves.toBeUndefined()
    registerStorageFreezeReader(null)
    expect(hasStorageFreezeReader()).toBe(false)
    await expect(assertStorageWriteAllowed({ operation: 'putObject', key: KEY })).rejects.toThrow(
      /no freeze-state reader is registered/,
    )
  })
})
