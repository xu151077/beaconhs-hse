import {
  db,
  expireStaleStorageWriteArms,
  listStorageWriteArmsForReconciliation,
  updateStorageWriteArmState,
  withSuperAdmin,
} from '@beaconhs/db'
import { headObject } from '@beaconhs/storage'

const RECONCILIATION_GRACE_MS = 15_000
const MAX_ARMS_PER_TICK = 100

export type StorageWriteArmReconciliationResult = {
  examined: number
  reconciled: number
  quarantined: number
  deferred: number
  errors: number
}

export async function reconcileStorageWriteArms(
  now: Date = new Date(),
): Promise<StorageWriteArmReconciliationResult> {
  const result: StorageWriteArmReconciliationResult = {
    examined: 0,
    reconciled: 0,
    quarantined: 0,
    deferred: 0,
    errors: 0,
  }

  await withSuperAdmin(db, (tx) => expireStaleStorageWriteArms(tx, now))

  const arms = await withSuperAdmin(db, (tx) =>
    listStorageWriteArmsForReconciliation(tx, { limit: MAX_ARMS_PER_TICK }),
  )
  result.examined = arms.length

  for (const arm of arms) {
    if (arm.expiresAt.getTime() + RECONCILIATION_GRACE_MS > now.getTime()) {
      result.deferred += 1
      continue
    }

    try {
      await withSuperAdmin(db, (tx) =>
        updateStorageWriteArmState(tx, {
          id: arm.id,
          tenantId: arm.tenantId,
          state: 'reconciling',
          lastError: null,
        }),
      )
    } catch {
      result.errors += 1
      continue
    }

    let head
    try {
      head = await headObject({ key: arm.objectKey })
    } catch (error) {
      await withSuperAdmin(db, (tx) =>
        updateStorageWriteArmState(tx, {
          id: arm.id,
          tenantId: arm.tenantId,
          state: 'reconciling',
          lastError: (error as Error)?.message?.slice(0, 4_000) ?? String(error),
        }),
      )
      result.errors += 1
      continue
    }

    const token = arm.uploadToken ?? null
    const headToken = head?.metadata?.['upload-token'] ?? null

    if (head === null) {
      const ok = await withSuperAdmin(db, (tx) =>
        updateStorageWriteArmState(tx, {
          id: arm.id,
          tenantId: arm.tenantId,
          state: 'redeemed_nop',
          reconciledAt: now,
        }),
      )
      if (ok) result.reconciled += 1
      else result.errors += 1
      continue
    }

    if (token && headToken === token) {
      const ok = await withSuperAdmin(db, (tx) =>
        updateStorageWriteArmState(tx, {
          id: arm.id,
          tenantId: arm.tenantId,
          state: 'redeemed_confirmed',
          reconciledAt: now,
        }),
      )
      if (ok) result.reconciled += 1
      else result.errors += 1
      continue
    }

    const ok = await withSuperAdmin(db, (tx) =>
      updateStorageWriteArmState(tx, {
        id: arm.id,
        tenantId: arm.tenantId,
        state: 'quarantined',
        lastError:
          !headToken || headToken !== token
            ? 'presigned write evidence did not match arm upload token'
            : null,
        reconciledAt: now,
      }),
    )
    if (ok) result.quarantined += 1
    else result.errors += 1
  }

  return result
}
