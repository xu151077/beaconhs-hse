// Testing utilities for Phase 6U-B write lease mechanism.
//
// This module provides a mock lease manager that accepts a custom freeze state
// reader, allowing tests to mock the lease acquisition without needing the
// actual database.
//
// Key design principles:
// - Lease acquisition is atomic: it either succeeds or fails, no partial state
// - Lease is held for the duration of the write operation
// - Lease is released even if the write fails
// - No retry on lease acquisition failure (fail fast)
// - Concurrent lease acquisitions are coordinated via version checks

import type { GatedStorageOperation } from '../freeze-gate'

export interface WriteLeaseManager {
  /**
   * Attempt to acquire a write lease for a tenant.
   *
   * @returns The lease ID and version, or null if lease could not be acquired.
   */
  acquireLease: (args: {
    tenantId: string
    operation: GatedStorageOperation
    leaseMs?: number
  }) => Promise<{ leaseId: string; version: number } | null>

  /**
   * Release a write lease for a tenant.
   *
   * @param leaseId The lease ID to release (optional, for safety)
   * @param version The version at which the lease was acquired
   */
  releaseLease: (args: { tenantId: string; leaseId?: string; version: number }) => Promise<void>
}

/**
 * Create a mock write lease manager for testing.
 *
 * The mock maintains an in-memory lease state that simulates the database's
 * optimistic concurrency control.
 */
export function createMockWriteLeaseManager(
  initialEntries: Map<
    string,
    {
      state: string
      version: number
      leaseHolderId: string | null
      leaseExpiresAt: Date | null
      leaseRenewedAt: Date | null
    }
  > = new Map(),
): WriteLeaseManager {
  const entries = new Map(initialEntries)

  return {
    async acquireLease(args: {
      tenantId: string
      operation: GatedStorageOperation
      leaseMs?: number
    }): Promise<{ leaseId: string; version: number } | null> {
      const now = new Date()
      const leaseMs = args.leaseMs ?? 7200000 // 2 hours default

      const current = entries.get(args.tenantId)
      if (!current) {
        return null
      }

      if (current.state !== 'ACTIVE') {
        return null
      }

      // Check if lease is already held
      if (current.leaseHolderId) {
        if (current.leaseExpiresAt && current.leaseExpiresAt > now) {
          // Lease still valid, refuse
          return null
        }
        // Lease expired, can take over
      }

      // Try to acquire lease
      const leaseId = `lease-${crypto.randomUUID()}`
      current.leaseHolderId = args.operation
      current.leaseExpiresAt = new Date(now.getTime() + leaseMs)
      current.leaseRenewedAt = now

      entries.set(args.tenantId, current)
      return { leaseId, version: current.version }
    },

    async releaseLease(args: {
      tenantId: string
      leaseId?: string
      version: number
    }): Promise<void> {
      const current = entries.get(args.tenantId)
      if (!current) {
        return
      }

      // Only release if version matches
      if (current.version === args.version) {
        current.leaseHolderId = null
        current.leaseExpiresAt = null
        current.leaseRenewedAt = null
        entries.set(args.tenantId, current)
      }
    },
  }
}
