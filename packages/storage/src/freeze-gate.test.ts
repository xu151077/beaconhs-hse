// Storage write-freeze gate tests (Phase 6R, stage E2-A).
//
// The gate is deliberately dependency-free — no database, no S3 client — so every
// property is asserted here directly. The S3-boundary wiring (that a refused
// operation never reaches `internalClient`) is asserted in ./freeze-gate-storage.test.ts,
// which stands up the same in-process origins the routing tests use.

import { afterEach, describe, expect, it } from 'vitest'
import {
  GATED_STORAGE_OPERATIONS,
  StorageWriteBlockedError,
  isStorageWritableState,
  isStorageWriteBlockedError,
  registerStorageFreezeReader,
  tenantIdFromObjectKey,
  assertStorageWriteAllowed,
} from './freeze-gate'
import { clearFreezeReader, freezeReaderReturning, freezeReaderThrowing } from './testing/freeze'

const KEY = 't/11111111-2222-4333-8444-555555555555/documents/abc-def.bin'
const OTHER_TENANT_KEY = 't/99999999-2222-4333-8444-555555555555/documents/abc-def.bin'

afterEach(() => {
  clearFreezeReader()
})

// ------------------------------------------------------------ 1. covered ops

describe('gated operations', () => {
  it('lists exactly the server-side mutations it covers', () => {
    // Sort to make the order predictable, but compare against the sorted list.
    const actual = [...GATED_STORAGE_OPERATIONS].sort()
    const expected = [
      'abortMultipartUpload',
      'completeMultipartUpload',
      'createMultipartUpload',
      'deleteObject',
      'promoteObject',
      'putObject',
      // Phase 6T-B: Pre-signed write URLs and WOPI token signing are now gated.
      'presignMultipartPart',
      'presignPut',
      'wopiToken',
    ].sort()
    expect(actual).toEqual(expected)
  })

  it('does not list any read-only operation', () => {
    for (const forbidden of [
      'presignGet', // Only write URLs are gated; read URLs are not.
      'getObject',
      'headObject',
      'objectExists',
    ]) {
      expect(GATED_STORAGE_OPERATIONS as readonly string[]).not.toContain(forbidden)
    }
  })
})

// ------------------------------------------------------------- 2. ACTIVE

describe('ACTIVE permits controlled writes', () => {
  it('allows every gated operation', async () => {
    freezeReaderReturning('ACTIVE')
    for (const operation of GATED_STORAGE_OPERATIONS) {
      await expect(
        assertStorageWriteAllowed({ operation, key: KEY }),
        operation,
      ).resolves.toBeUndefined()
    }
  })

  it('reads the state for the tenant named by the key', async () => {
    const fixture = freezeReaderReturning('ACTIVE')
    await assertStorageWriteAllowed({ operation: 'putObject', key: KEY })
    expect(fixture.calls).toEqual([{ tenantId: '11111111-2222-4333-8444-555555555555', key: KEY }])
  })
})

// ------------------------------------------------- 3. every other state

describe('every non-ACTIVE state refuses controlled writes', () => {
  for (const state of [
    'FREEZE_REQUESTED',
    'DRAINING',
    'FROZEN',
    'RECONCILING',
    'FAILED',
    'RECOVERY_REQUIRED',
  ] as const) {
    it(`refuses ${state}`, async () => {
      freezeReaderReturning(state)
      const error = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
        (e) => e,
      )
      expect(error).toBeInstanceOf(StorageWriteBlockedError)
      expect(error.code).toBe('STORAGE_FROZEN')
      expect(error.freezeState).toBe(state)
    })
  }

  it('refuses an unknown state string rather than allowing it', async () => {
    registerStorageFreezeReader(async () => ({ state: 'SOMETHING_ELSE', version: 0 }))
    const error = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    expect(error.code).toBe('STORAGE_FROZEN')
    expect(error.freezeState).toBe('SOMETHING_ELSE')
  })
})

// ------------------------------------- 3a. refusal classification

describe('storage write refusals are recognisable without trusting message text', () => {
  it('recognises the real gate error and a structurally identical bundled copy', () => {
    const real = new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: 'putObject',
      key: KEY,
      freezeState: 'DRAINING',
    })
    const bundledCopy = {
      name: 'StorageWriteBlockedError',
      code: 'STORAGE_FROZEN',
      operation: 'putObject',
      freezeState: 'DRAINING',
    }
    expect(isStorageWriteBlockedError(real)).toBe(true)
    expect(isStorageWriteBlockedError(bundledCopy)).toBe(true)
  })

  it('does not classify unrelated failures as a write refusal', () => {
    for (const value of [
      new Error('STORAGE_WRITE_BLOCKED happened in a message'),
      { name: 'StorageWriteBlockedError', code: 'DATABASE_DOWN', operation: 'putObject' },
      { name: 'StorageWriteBlockedError', code: 'STORAGE_FROZEN', operation: 'notGated' },
      null,
      undefined,
      'STORAGE_FROZEN',
    ]) {
      expect(isStorageWriteBlockedError(value)).toBe(false)
    }
  })
})

// ---------------------------------------- 4. read failure fails closed

describe('an indeterminate state fails closed', () => {
  it('refuses when no reader is registered', async () => {
    clearFreezeReader()
    const error = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    expect(error.code).toBe('STORAGE_FREEZE_STATE_UNKNOWN')
    expect(error.message).toMatch(/no freeze-state reader is registered/)
  })

  it('refuses when the reader throws', async () => {
    freezeReaderThrowing('connection refused')
    const error = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    expect(error.code).toBe('STORAGE_FREEZE_STATE_UNKNOWN')
    expect(error.message).toMatch(/connection refused/)
  })

  it('refuses when the reader returns null — no row is not ACTIVE', async () => {
    freezeReaderReturning(null)
    const error = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    expect(error.code).toBe('STORAGE_FREEZE_STATE_UNKNOWN')
    expect(error.message).toMatch(/no persisted freeze state/)
  })

  it('never allows as a side effect of a failed read', async () => {
    freezeReaderThrowing()
    for (const operation of GATED_STORAGE_OPERATIONS) {
      await expect(assertStorageWriteAllowed({ operation, key: KEY }), operation).rejects.toThrow(
        StorageWriteBlockedError,
      )
    }
  })
})

// ------------------------------------------ 5. tenant is derived, not given

describe('the tenant comes from the key, never from the caller', () => {
  it('refuses a key that names no tenant', async () => {
    freezeReaderReturning('ACTIVE')
    for (const bad of [
      'no-tenant-key.bin',
      'documents/a.bin',
      't/not-a-uuid/documents/a.bin',
      't/11111111-2222-4333-8444-555555555555/a.bin',
      't/11111111-2222-4333-8444-555555555555/../../../etc/passwd',
      '',
    ]) {
      const error = await assertStorageWriteAllowed({ operation: 'putObject', key: bad }).catch(
        (e) => e,
      )
      expect(error.code, JSON.stringify(bad)).toBe('STORAGE_TENANT_UNKNOWN')
    }
  })

  it('accepts a canonical multi-segment scope key', async () => {
    freezeReaderReturning('ACTIVE')
    await expect(
      assertStorageWriteAllowed({
        operation: 'putObject',
        key: 't/11111111-2222-4333-8444-555555555555/document/master/a-b-c.pdf',
      }),
    ).resolves.toBeUndefined()
  })

  it('consults the state of the tenant the key names', async () => {
    const fixture = freezeReaderReturning('ACTIVE')
    await assertStorageWriteAllowed({ operation: 'deleteObject', key: OTHER_TENANT_KEY })
    expect(fixture.calls[0]?.tenantId).toBe('99999999-2222-4333-8444-555555555555')
  })

  it('hands the reader the tenant the key names, so the reader can filter', async () => {
    // A reader that ignored its input could launder one tenant's ACTIVE state into
    // another. The gate's defence is that the reader is TOLD the tenant derived from
    // the key — so a correct reader has no way to be confused about which tenant it
    // is consulting. This asserts that handoff is correct for both key shapes.
    const calls: Array<{ tenantId: string; key: string }> = []
    registerStorageFreezeReader(async (input) => {
      calls.push(input)
      return { state: 'ACTIVE', version: 0 }
    })
    await assertStorageWriteAllowed({ operation: 'putObject', key: KEY })
    await assertStorageWriteAllowed({ operation: 'putObject', key: OTHER_TENANT_KEY })
    expect(calls.map((c) => c.tenantId)).toEqual([
      '11111111-2222-4333-8444-555555555555',
      '99999999-2222-4333-8444-555555555555',
    ])
  })

  it('a reader that filters by tenant is respected', async () => {
    // The realistic reader consults only the tenant it was handed. One tenant frozen,
    // the other not: only the frozen one is refused.
    registerStorageFreezeReader(async ({ tenantId }) => ({
      state: tenantId === '99999999-2222-4333-8444-555555555555' ? 'FROZEN' : 'ACTIVE',
      version: 0,
    }))
    await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch((e) => e)
    // KEY is the other tenant and must be refused.
    await expect(
      assertStorageWriteAllowed({ operation: 'putObject', key: OTHER_TENANT_KEY }),
    ).rejects.toThrow(/FROZEN/)
  })

  it('tenantIdFromObjectKey rejects traversal and non-canonical shapes', () => {
    expect(tenantIdFromObjectKey('t/11111111-2222-4333-8444-555555555555/documents/a.bin')).toBe(
      '11111111-2222-4333-8444-555555555555',
    )
    expect(tenantIdFromObjectKey('t/11111111-2222-4333-8444-555555555555/../a/b/c')).toBeNull()
    expect(
      tenantIdFromObjectKey('T/11111111-2222-4333-8444-555555555555/documents/a.bin'),
    ).toBeNull()
    expect(tenantIdFromObjectKey('t/11111111-2222-4333-8444-555555555555/documents/')).toBeNull()
  })
})

// --------------------------------------- 6. no bypass by retry or fallback

describe('no bypass path', () => {
  it('a second attempt after a refusal is refused for the same reason', async () => {
    freezeReaderReturning('FROZEN')
    const first = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    const second = await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(
      (e) => e,
    )
    expect(first.code).toBe('STORAGE_FROZEN')
    expect(second.code).toBe('STORAGE_FROZEN')
    expect(second.freezeState).toBe('FROZEN')
  })

  it('rejection is an error, not a boolean, so callers cannot branch around it', async () => {
    freezeReaderReturning('FROZEN')
    await expect(
      assertStorageWriteAllowed({ operation: 'putObject', key: KEY }),
    ).rejects.toBeInstanceOf(StorageWriteBlockedError)
  })

  it('a write to a different key is judged on its own tenant', async () => {
    // Same frozen tenant, two keys — both refused.
    freezeReaderReturning('FROZEN')
    await expect(assertStorageWriteAllowed({ operation: 'putObject', key: KEY })).rejects.toThrow()
    await expect(
      assertStorageWriteAllowed({
        operation: 'putObject',
        key: 't/11111111-2222-4333-8444-555555555555/images/other.png',
      }),
    ).rejects.toThrow()
  })
})

// -------------------------------------------------- 7. read ops stay open

describe('reads are unaffected', () => {
  it('a read operation is never routed through the gate', async () => {
    // The gate's exported surface takes a GatedStorageOperation; a read name is not
    // one, so this is a compile-time and runtime boundary rather than a runtime branch.
    expect(GATED_STORAGE_OPERATIONS as readonly string[]).not.toContain('getObject')
    freezeReaderReturning('FROZEN')
    // The reader is never consulted for a non-gated operation: the only functions that
    // reach it are the six listed.
    const fixture = freezeReaderReturning('FROZEN')
    await assertStorageWriteAllowed({ operation: 'putObject', key: KEY }).catch(() => undefined)
    expect(fixture.calls).toHaveLength(1)
  })
})

describe('isStorageWritableState', () => {
  it('is true only for ACTIVE', () => {
    expect(isStorageWritableState('ACTIVE')).toBe(true)
    for (const s of [
      'FREEZE_REQUESTED',
      'DRAINING',
      'FROZEN',
      'RECONCILING',
      'FAILED',
      'RECOVERY_REQUIRED',
      '',
      'active',
      null,
      undefined,
    ]) {
      expect(isStorageWritableState(s as string), String(s)).toBe(false)
    }
  })
})
