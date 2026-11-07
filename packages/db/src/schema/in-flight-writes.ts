import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { id } from './_helpers'
import { tenants } from './core'

export const inFlightWrite = pgTable(
  'in_flight_writes',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    leaseId: uuid('lease_id'),
    leaseVersion: integer('lease_version').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    success: boolean('success').notNull(),
    error: text('error'),
  },
  (t) => ({
    tenantIdIdx: index('in_flight_writes_tenant_id_idx').on(t.tenantId),
    tenantKeyIdx: index('in_flight_writes_tenant_key_idx').on(t.tenantId, t.key),
    leaseIdIdx: index('in_flight_writes_lease_id_idx').on(t.leaseId),
    tenantCompletedIdx: index('in_flight_writes_tenant_completed_idx').on(
      t.tenantId,
      sql`completed_at NULLS FIRST`,
    ),
    tenantKeyCheck: check(
      'in_flight_writes_tenant_key_ck',
      sql`${t.key} LIKE ('t/' || ${t.tenantId}::text || '/%')`,
    ),
    leaseVersionCheck: check('in_flight_writes_lease_version_ck', sql`${t.leaseVersion} >= 0`),
    statusCheck: check(
      'in_flight_writes_status_ck',
      sql`(
        (${t.completedAt} IS NULL AND ${t.success} = false)
        OR
        (${t.completedAt} IS NOT NULL)
      )`,
    ),
  }),
)

export type InFlightWrite = typeof inFlightWrite.$inferSelect
export type NewInFlightWrite = typeof inFlightWrite.$inferInsert
