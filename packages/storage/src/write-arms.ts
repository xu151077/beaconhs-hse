// Phase 6U-B3-E2: presigned write arm issuer registration.
//
// Presigning is the only storage-side operation that can "publish" a capability
// without seeing the eventual redeem. The caller (production bootstrap) installs a
// DB-backed issuer; unit tests install the no-op issuer by default through the
// test setup file.
//
// The gate is delegated: the issuer itself must keep the freeze check and arm
// insert atomic (B4-A locking). This module only owns the wiring.

import { randomUUID } from 'node:crypto'
import { getStorageGateRegistry } from './gate-registry'

type StorageWriteArmIssueResult = {
  armId: string
  uploadToken: string
  expiresAt: Date
  expiresInSeconds: number
}

export type StorageWriteArmIssuer = {
  issue: (args: {
    tenantId: string
    key: string
    operation: 'presignPut' | 'presignMultipartPart'
    requestedExpiresInSeconds?: number
    uploadId?: string | null
    /** Caller token that will be embedded in the signed object's metadata. */
    uploadToken?: string | null
  }) => Promise<StorageWriteArmIssueResult | null>
  activate: (args: { armId: string; tenantId: string }) => Promise<boolean>
  withdraw: (args: { armId: string; tenantId: string; error: string }) => Promise<boolean>
}

export function registerStorageWriteArmIssuer(next: StorageWriteArmIssuer | null): void {
  getStorageGateRegistry().issuer = next
}

export function getStorageWriteArmIssuer(): StorageWriteArmIssuer | null {
  return getStorageGateRegistry().issuer
}

export function createNoOpStorageWriteArmIssuer(): StorageWriteArmIssuer {
  return {
    issue: async (args) => {
      const expiresAt = new Date(Date.now() + 60_000)
      return {
        armId: randomUUID(),
        uploadToken: args.uploadToken ?? randomUUID(),
        expiresAt,
        expiresInSeconds: args.operation === 'presignPut' ? 120 : 60,
      }
    },
    activate: async () => true,
    withdraw: async () => true,
  }
}
