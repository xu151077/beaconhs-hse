import { isStorageFreezeRefusal } from './storage-freeze-refusal'

/** WOPI's existing public contract for a tenant whose storage is not writable. */
export const WOPI_STORAGE_LOCKED_STATUS = 423

/**
 * Translate a storage-admission refusal into WOPI's public status code.
 *
 * Identity, tenant and permission failures keep their existing responses; only the
 * storage freeze gate maps to 423. Unknown failures return null so the route still
 * surfaces them instead of disguising them as a normal frozen workspace.
 */
export function wopiStorageRefusalStatus(error: unknown): number | null {
  return isStorageFreezeRefusal(error) ? WOPI_STORAGE_LOCKED_STATUS : null
}
