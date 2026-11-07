import { describe, expect, it } from 'vitest'
import { StorageWriteBlockedError } from '@beaconhs/storage'
import { WOPI_STORAGE_LOCKED_STATUS, wopiStorageRefusalStatus } from './wopi-storage-refusal'

const KEY = 't/11111111-2222-4333-8444-555555555555/document/frozen.docx'

describe('WOPI storage refusal mapping', () => {
  it('admits ACTIVE and every operation reaches storage', () => {
    // An ACTIVE tenant never produces a refusal; this baseline pins that the mapping
    // is driven by the refusal type, not by the presence of an operation name.
    expect(wopiStorageRefusalStatus(undefined)).toBeNull()
    expect(wopiStorageRefusalStatus(new Error('storage unavailable'))).toBeNull()
  })

  for (const state of [
    'FREEZE_REQUESTED',
    'DRAINING',
    'FROZEN',
    'RECONCILING',
    'FAILED',
    'RECOVERY_REQUIRED',
  ] as const) {
    it(`maps ${state} to HTTP 423`, () => {
      const error = new StorageWriteBlockedError({
        code: 'STORAGE_FROZEN',
        operation: 'putObject',
        key: KEY,
        freezeState: state,
      })
      expect(wopiStorageRefusalStatus(error)).toBe(WOPI_STORAGE_LOCKED_STATUS)
    })
  }

  it('does not disguise an indeterminate freeze read as a normal lock', () => {
    const error = new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: 'putObject',
      key: KEY,
    })
    expect(wopiStorageRefusalStatus(error)).toBeNull()
  })
})
