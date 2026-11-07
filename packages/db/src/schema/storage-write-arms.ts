import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { id, timestamps } from './_helpers'
import { tenants } from './core'

export const storageWriteArmState = pgEnum('storage_write_arm_state', [
  'issuing',
  'armed',
  'expired',
  'reconciling',
  'redeemed_confirmed',
  'redeemed_nop',
  'quarantined',
  'failed_to_activate',
])

export const storageWriteArmOperation = pgEnum('storage_write_arm_operation', [
  'presignPut',
  'presignMultipartPart',
])

export const storageWriteArms = pgTable(
  'storage_write_arms',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    operation: storageWriteArmOperation('operation').notNull(),
    objectKey: text('object_key').notNull(),
    uploadToken: text('upload_token').notNull(),
    uploadId: text('upload_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    state: storageWriteArmState('state').default('issuing').notNull(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    quarantinedReason: text('quarantined_reason'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    issuedBy: text('issued_by'),
    ...timestamps,
  },
  (t) => ({
    tenantIdIdUx: index('storage_write_arms_tenant_id_idx').on(t.tenantId),
    stateExpiresIdx: index('storage_write_arms_state_expires_idx').on(t.state, t.expiresAt),
    tenantStateIdx: index('storage_write_arms_tenant_state_idx').on(t.tenantId, t.state),
    tenantKeyCheck: check(
      'storage_write_arms_tenant_key_ck',
      sql`${t.objectKey} like ('t/' || ${t.tenantId}::text || '/%')`,
    ),
  }),
)

export type StorageWriteArm = typeof storageWriteArms.$inferSelect
export type NewStorageWriteArm = typeof storageWriteArms.$inferInsert
