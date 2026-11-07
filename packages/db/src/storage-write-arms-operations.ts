// Storage write-arm tracking (Phase 6U-B3-E).
//
// A "write arm" is a server-issued presigned credential that can be redeemed
// outside the application process. This module provides the atomic bookkeeping
// used to make the issue of such credentials observable, expirable and
// reconcilable (relationship model in docs/phase-6u-b3-d-design-review.md).
//
// Each function operates on a provided transaction handle. Callers are
// responsible for freeze-state checks; the freeze row must be held in the same
// transaction where the caller determines that issuance is permitted. No
// function in this module itself reads the freeze state — that is a separate,
// coordinated transactional step (see B4-A in the design review), which keeps
// the arm bookkeeping testable and side-effect-free.

import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from './client'
import {
  storageWriteArms,
  type StorageWriteArm,
  type NewStorageWriteArm,
} from './schema/storage-write-arms'
import { storageFreeze } from './schema/storage-freeze'
import { countInFlightWrites } from './storage-freeze-operations'
import { randomUUID } from 'node:crypto'
import { ensureFreezeRow } from './storage-freeze-operations'

const MAX_TTL_MS_PRESIGN_PUT = 120_000
const MAX_TTL_MS_PRESIGN_MULTIPART_PART = 60_000
const MIN_TTL_MS = 1_000

export function maxStorageWriteArmTtlMs(operation: 'presignPut' | 'presignMultipartPart'): number {
  switch (operation) {
    case 'presignMultipartPart':
      return MAX_TTL_MS_PRESIGN_MULTIPART_PART
    default:
      return MAX_TTL_MS_PRESIGN_PUT
  }
}

export function computeStorageWriteArmExpiry(
  operation: 'presignPut' | 'presignMultipartPart',
  requestedSeconds?: number | null,
): Date {
  const cap = maxStorageWriteArmTtlMs(operation)
  if (requestedSeconds === null || requestedSeconds === undefined) {
    return new Date(Date.now() + cap)
  }
  if (
    !Number.isFinite(requestedSeconds) ||
    requestedSeconds <= 0 ||
    requestedSeconds > cap / 1_000
  ) {
    throw new Error('Invalid storage write arm TTL')
  }
  return new Date(Date.now() + Math.floor(requestedSeconds * 1_000))
}

const UNRESOLVED_STATES = ['issuing', 'armed', 'expired', 'reconciling'] as const
const TERMINAL_STATES = [
  'redeemed_confirmed',
  'redeemed_nop',
  'quarantined',
  'failed_to_activate',
] as const

export function isTerminalArmState(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}

export type BeginArmArgs = {
  tenantId: string
  operation: 'presignPut' | 'presignMultipartPart'
  objectKey: string
  uploadToken: string
  uploadId?: string | null
  expiresAt?: Date
  issuedBy?: string | null
}

/** Register an arm in the `issuing` state. Returns the row, or null on insert failure. */
export async function beginIssuingStorageWriteArm(
  tx: Database,
  args: BeginArmArgs,
): Promise<StorageWriteArm | null> {
  if (!args.tenantId || !args.objectKey || !args.uploadToken) return null
  const expiresAt = args.expiresAt ?? computeStorageWriteArmExpiry(args.operation)
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) return null
  const now = new Date()
  if (expiresAt.getTime() <= now.getTime()) return null

  const rows = await tx
    .insert(storageWriteArms)
    .values({
      tenantId: args.tenantId,
      operation: args.operation,
      objectKey: args.objectKey,
      uploadToken: args.uploadToken,
      uploadId: args.uploadId ?? null,
      issuedAt: now,
      expiresAt,
      state: 'issuing',
      issuedBy: args.issuedBy ?? null,
    })
    .returning()
  return rows[0] ?? null
}

/** Flip an arm from `issuing` to `armed`. Returns true if activated. */
export async function activateStorageWriteArm(
  tx: Database,
  id: string,
  tenantId: string,
): Promise<boolean> {
  const rows = await tx
    .update(storageWriteArms)
    .set({ state: 'armed' })
    .where(
      and(
        eq(storageWriteArms.id, id),
        eq(storageWriteArms.tenantId, tenantId),
        eq(storageWriteArms.state, 'issuing'),
      ),
    )
    .returning({ id: storageWriteArms.id })
  return rows.length > 0
}

/** Mark an arm as failed-to-activate (issue failed after begin). Idempotent best-effort. */
export async function failStorageWriteArmActivation(
  tx: Database,
  args: { id: string; tenantId: string; error: string },
): Promise<boolean> {
  const rows = await tx
    .update(storageWriteArms)
    .set({
      state: 'failed_to_activate',
      lastError: args.error.slice(0, 4_000),
      reconciledAt: new Date(),
    })
    .where(
      and(
        eq(storageWriteArms.id, args.id),
        eq(storageWriteArms.tenantId, args.tenantId),
        eq(storageWriteArms.state, 'issuing'),
      ),
    )
    .returning({ id: storageWriteArms.id })
  return rows.length > 0
}

/** Read one arm by id + tenant. */
export async function readStorageWriteArm(
  tx: Database,
  id: string,
  tenantId: string,
): Promise<StorageWriteArm | null> {
  const rows = await tx
    .select()
    .from(storageWriteArms)
    .where(and(eq(storageWriteArms.id, id), eq(storageWriteArms.tenantId, tenantId)))
    .limit(1)
  return rows[0] ?? null
}

/** Mark `armed` arms whose expiry has passed as `expired`. Returns count. */
export async function expireStaleStorageWriteArms(
  tx: Database,
  now: Date = new Date(),
): Promise<number> {
  const rows = await tx
    .update(storageWriteArms)
    .set({ state: 'expired', lastCheckedAt: now })
    .where(
      and(
        inArray(storageWriteArms.state, ['armed', 'issuing'] as any),
        lte(storageWriteArms.expiresAt, now),
      ),
    )
    .returning({ id: storageWriteArms.id })
  return rows.length
}

/** List expired (unreconciled) arms for reconciliation. */
export async function listExpiredStorageWriteArms(
  tx: Database,
  input: { limit: number; tenantId?: string },
): Promise<StorageWriteArm[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new Error('arm reconciliation claim limit must be an integer from 1 to 500')
  }
  const conditions = [eq(storageWriteArms.state, 'expired')]
  if (input.tenantId) {
    conditions.push(eq(storageWriteArms.tenantId, input.tenantId))
  }
  return await tx
    .select()
    .from(storageWriteArms)
    .where(conditions.length > 1 ? and(...conditions) : conditions[0])
    .orderBy(sql`${storageWriteArms.expiresAt} asc, ${storageWriteArms.id} asc`)
    .limit(input.limit)
}

/** List arms that still need external verification (expired or reconciling), bounded. */
export async function listStorageWriteArmsForReconciliation(
  tx: Database,
  input: { limit: number; tenantId?: string },
): Promise<StorageWriteArm[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new Error('arm reconciliation claim limit must be an integer from 1 to 500')
  }
  const conditions = [inArray(storageWriteArms.state, ['expired', 'reconciling'] as any)]
  if (input.tenantId) {
    conditions.push(eq(storageWriteArms.tenantId, input.tenantId))
  }
  return await tx
    .select()
    .from(storageWriteArms)
    .where(conditions.length > 1 ? and(...conditions) : conditions[0])
    .orderBy(sql`${storageWriteArms.expiresAt} asc, ${storageWriteArms.id} asc`)
    .limit(input.limit)
}

/** Transition an arm to a terminal or intermediate reconciliation state. */
export async function updateStorageWriteArmState(
  tx: Database,
  args: {
    id: string
    tenantId: string
    state: string
    lastError?: string | null
    quarantinedReason?: string | null
    reconciledAt?: Date | null
  },
): Promise<boolean> {
  const patch: Record<string, unknown> = { state: args.state, lastCheckedAt: new Date() }
  if (args.lastError !== undefined) patch.lastError = args.lastError
  if (args.quarantinedReason !== undefined) patch.quarantinedReason = args.quarantinedReason
  if (args.reconciledAt !== undefined) patch.reconciledAt = args.reconciledAt
  const rows = await tx
    .update(storageWriteArms)
    .set(patch as any)
    .where(and(eq(storageWriteArms.id, args.id), eq(storageWriteArms.tenantId, args.tenantId)))
    .returning({ id: storageWriteArms.id })
  return rows.length > 0
}

/** Count unresolved (issuing/armed/expired/reconciling) arms for a tenant. */
export async function countUnresolvedStorageWriteArmsForTenant(
  tx: Database,
  tenantId: string,
): Promise<number> {
  const result = await tx
    .select({ count: sql<number>`COUNT(*)` })
    .from(storageWriteArms)
    .where(
      and(
        eq(storageWriteArms.tenantId, tenantId),
        inArray(storageWriteArms.state, UNRESOLVED_STATES as any),
      ),
    )
  const raw = result[0]?.count
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : 0
}

/** Drain readiness primitive used by freeze evaluation. */
export async function storageWriteArmsDrainReady(
  tx: Database,
  tenantId: string,
  now: Date = new Date(),
  graceMs: number = 15_000,
): Promise<{
  ready: boolean
  unresolvedCount: number
  maxExpiresAt: Date | null
  waitUntil: Date | null
}> {
  const rows = await tx
    .select({ expiresAt: storageWriteArms.expiresAt })
    .from(storageWriteArms)
    .where(
      and(
        eq(storageWriteArms.tenantId, tenantId),
        inArray(storageWriteArms.state, ['armed', 'issuing', 'expired', 'reconciling'] as any),
      ),
    )
  const unresolvedCount = rows.length
  let maxExpires: Date | null = null
  for (const r of rows) {
    if (!maxExpires || r.expiresAt.getTime() > maxExpires.getTime()) maxExpires = r.expiresAt
  }
  const waitUntil = maxExpires ? new Date(maxExpires.getTime() + graceMs) : null
  const pastGrace =
    !maxExpires || now.getTime() >= new Date(maxExpires.getTime() + graceMs).getTime()
  return {
    ready: unresolvedCount === 0 && pastGrace,
    unresolvedCount,
    maxExpiresAt: maxExpires,
    waitUntil,
  }
}

export type { StorageWriteArm, NewStorageWriteArm }

export async function issueStorageWriteArmUnderFreezeLock(
  tx: Database,
  args: {
    tenantId: string
    operation: 'presignPut' | 'presignMultipartPart'
    objectKey: string
    uploadToken?: string | null
    uploadId?: string | null
    requestedExpiresInSeconds?: number | null
  },
): Promise<StorageWriteArm | null> {
  await ensureFreezeRow(tx, args.tenantId)

  const lockedRows = await tx
    .select({ state: storageFreeze.state })
    .from(storageFreeze)
    .where(eq(storageFreeze.tenantId, args.tenantId))
    .for('update')

  if (!lockedRows.length || (lockedRows[0]?.state ?? '') !== 'ACTIVE') return null

  const uploadToken = args.uploadToken ?? randomUUID()
  let expiresAt: Date
  try {
    expiresAt = computeStorageWriteArmExpiry(args.operation, args.requestedExpiresInSeconds)
  } catch {
    return null
  }

  const rows = await tx
    .insert(storageWriteArms)
    .values({
      tenantId: args.tenantId,
      operation: args.operation,
      objectKey: args.objectKey,
      uploadToken,
      uploadId: args.uploadId ?? null,
      issuedAt: new Date(),
      expiresAt,
      state: 'issuing',
    })
    .returning()

  return rows[0] ?? null
}

export type StorageFreezeDrainStatus = {
  inFlightCount: number
  unresolvedArmCount: number
  maxArmExpiresAt: string | null
  waitUntil: string | null
  ready: boolean
}

export async function readStorageFreezeDrainStatus(
  tx: Database,
  tenantId: string,
  now: Date = new Date(),
  graceMs: number = 15_000,
): Promise<StorageFreezeDrainStatus> {
  const inFlightCount = await countInFlightWrites(tx, { tenantId })
  const unresolvedArmCount = await countUnresolvedStorageWriteArmsForTenant(tx, tenantId)

  const scoped = await tx
    .select({ expiresAt: storageWriteArms.expiresAt })
    .from(storageWriteArms)
    .where(
      and(
        eq(storageWriteArms.tenantId, tenantId),
        inArray(storageWriteArms.state, ['issuing', 'armed', 'expired', 'reconciling'] as any),
      ),
    )

  let maxExpiresAtMs: number | null = null
  for (const row of scoped) {
    if (maxExpiresAtMs === null || row.expiresAt.getTime() > maxExpiresAtMs) {
      maxExpiresAtMs = row.expiresAt.getTime()
    }
  }
  const waitUntilMs = maxExpiresAtMs === null ? null : maxExpiresAtMs + graceMs
  const graceComplete = waitUntilMs === null || now.getTime() >= waitUntilMs
  return {
    inFlightCount,
    unresolvedArmCount,
    // Preserve serializability before handing to callers. PostgreSQL count and timestamp
    // values can become strings, and JSONB-safe egress would otherwise widen types.
    maxArmExpiresAt: maxExpiresAtMs === null ? null : new Date(maxExpiresAtMs).toISOString(),
    waitUntil: waitUntilMs === null ? null : new Date(waitUntilMs).toISOString(),
    ready: inFlightCount >= 0 && inFlightCount === 0 && unresolvedArmCount === 0 && graceComplete,
  }
}
