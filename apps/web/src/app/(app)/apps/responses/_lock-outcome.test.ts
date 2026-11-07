import { describe, expect, it } from 'vitest'
import { FormResponseParentIntegrityError, FormResponseParentLockedError } from '@beaconhs/db'
import { classifyParentLockError } from './_lock-outcome'

describe('response delete parent-lock outcome', () => {
  it('treats a missing parent as deletable', () => {
    expect(
      classifyParentLockError(
        new FormResponseParentIntegrityError(
          'Hazard-assessment response points to a missing parent',
        ),
      ),
    ).toBe('parent-gone')
  })

  it('refuses while the parent is locked', () => {
    expect(classifyParentLockError(new FormResponseParentLockedError())).toBe('parent-locked')
  })

  it('does not swallow unrelated faults', () => {
    expect(classifyParentLockError(new Error('connection reset'))).toBe('unknown')
  })
})
