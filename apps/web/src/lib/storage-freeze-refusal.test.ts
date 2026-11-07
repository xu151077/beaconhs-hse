import { describe, expect, it } from 'vitest'
import { StorageWriteBlockedError } from '@beaconhs/storage'
import { STORAGE_FROZEN_ACTION } from './storage-freeze-copy'
import { isStorageFreezeRefusal, storageFreezeRefusalMessage } from './storage-freeze-refusal'

const KEY = 't/11111111-2222-4333-8444-555555555555/document/frozen.docx'

function frozen(state: string): StorageWriteBlockedError {
  return new StorageWriteBlockedError({
    code: 'STORAGE_FROZEN',
    operation: 'putObject',
    key: KEY,
    freezeState: state,
  })
}

describe('storage freeze refusal recognition', () => {
  it('recognises a determinate freeze refusal in every blocking state', () => {
    for (const state of [
      'FREEZE_REQUESTED',
      'DRAINING',
      'FROZEN',
      'RECONCILING',
      'FAILED',
      'RECOVERY_REQUIRED',
    ]) {
      expect(isStorageFreezeRefusal(frozen(state)), state).toBe(true)
    }
  })

  it('does not treat an indeterminate freeze read as a freeze', () => {
    // A missing reader / unreadable state is a misconfiguration. Telling the user the
    // workspace is frozen would be a lie, and would hide the real fault.
    expect(
      isStorageFreezeRefusal(
        new StorageWriteBlockedError({
          code: 'STORAGE_FREEZE_STATE_UNKNOWN',
          operation: 'putObject',
          key: KEY,
        }),
      ),
    ).toBe(false)
    expect(
      isStorageFreezeRefusal(
        new StorageWriteBlockedError({
          code: 'STORAGE_TENANT_UNKNOWN',
          operation: 'putObject',
          key: 'not-a-tenant-key',
        }),
      ),
    ).toBe(false)
  })

  it('does not disguise unrelated errors as a freeze', () => {
    for (const error of [
      new Error('permission denied'),
      new Error('Upload reservation expired'),
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
      undefined,
      null,
      'storage frozen',
    ]) {
      expect(isStorageFreezeRefusal(error)).toBe(false)
    }
  })
})

describe('storage freeze refusal message', () => {
  it('returns the frozen copy only for a determinate freeze refusal', () => {
    expect(storageFreezeRefusalMessage(frozen('FROZEN'), 'Upload could not be started')).toBe(
      STORAGE_FROZEN_ACTION,
    )
  })

  it('keeps every other failure on its own message', () => {
    expect(storageFreezeRefusalMessage(new Error('boom'), 'Upload could not be started')).toBe(
      'Upload could not be started',
    )
    expect(
      storageFreezeRefusalMessage(
        new StorageWriteBlockedError({
          code: 'STORAGE_FREEZE_STATE_UNKNOWN',
          operation: 'presignMultipartPart',
          key: KEY,
        }),
        'Failed to sign part URL',
      ),
    ).toBe('Failed to sign part URL')
  })

  it('names the freeze and the reason in plain language', () => {
    expect(STORAGE_FROZEN_ACTION).toContain('frozen')
    expect(STORAGE_FROZEN_ACTION).toContain('platform administrator')
  })
})
