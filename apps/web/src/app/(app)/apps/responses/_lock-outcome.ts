import { FormResponseParentIntegrityError, FormResponseParentLockedError } from '@beaconhs/db'

/**
 * Classify a failure from `lockFormResponseForMutation` when deleting a
 * response.
 *
 * The lock helper throws an integrity error when the response's parent (a
 * HazID assessment) no longer exists — which is exactly the state left behind
 * after the parent assessment is deleted. There is nothing left to lock, so
 * deletion must proceed. A parent that still exists but is LOCKED is a real
 * refusal with its own explanation. Anything else is a genuine fault.
 */
export type ParentLockOutcome = 'parent-gone' | 'parent-locked' | 'unknown'

export function classifyParentLockError(error: unknown): ParentLockOutcome {
  if (error instanceof FormResponseParentIntegrityError) {
    // Only a physically missing parent row means "nothing left to protect".
    // The other integrity failures (null source link, a link changed under
    // us) were designed to fail closed and retry instead of deleting.
    return /missing parent/i.test(error.message) ? 'parent-gone' : 'unknown'
  }
  if (error instanceof FormResponseParentLockedError) return 'parent-locked'
  return 'unknown'
}
