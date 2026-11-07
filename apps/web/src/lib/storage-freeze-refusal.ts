import { isStorageWriteBlockedError } from '@beaconhs/storage'
import { STORAGE_FROZEN_ACTION } from './storage-freeze-copy'

/**
 * The one place that decides whether a thrown error is a *determinate* storage-freeze
 * refusal — the tenant's storage is genuinely not writable — as opposed to an
 * indeterminate read (`STORAGE_FREEZE_STATE_UNKNOWN`, `STORAGE_TENANT_UNKNOWN`) or an
 * unrelated failure.
 *
 * Why the distinction matters: a determinate refusal is a normal, expected product
 * state that deserves plain-language copy ("the workspace is frozen"), while an
 * indeterminate read is a misconfiguration and a permission or database error is a
 * bug. Collapsing them would tell a user their workspace is frozen when it is not,
 * and would hide a real fault behind a friendly sentence.
 *
 * Every surface that reacts to a freeze refusal builds on this predicate, so the
 * decision cannot drift between the uploader, the document actions and the WOPI route.
 */
export function isStorageFreezeRefusal(error: unknown): boolean {
  return isStorageWriteBlockedError(error) && error.code === 'STORAGE_FROZEN'
}

/**
 * Message for a failed write where the caller shows a single sentence inline: the
 * frozen copy for a genuine freeze refusal, `fallback` for everything else.
 */
export function storageFreezeRefusalMessage(error: unknown, fallback: string): string {
  return isStorageFreezeRefusal(error) ? STORAGE_FROZEN_ACTION : fallback
}
