import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { id, timestamps } from './_helpers'
import { users } from './core'

// PD-02: platform-level cross-tenant audit authorization. These tables are
// deliberately NOT tenant-scoped (never add them to TENANT_SCOPED_TABLES):
// authorization to read audit data across tenants is platform data, not
// tenant business data. Protection is privilege-based instead of RLS — see
// BEACONHS_PD02_REVISED_ARCHITECTURE.md §3-§4 and migration 0059:
//   - REVOKE ALL FROM PUBLIC; only audit_service gets runtime privileges
//     (SELECT/INSERT/UPDATE on grants, SELECT/INSERT on the access log).
//   - platform_audit_access_log is append-only (BEFORE UPDATE/DELETE trigger,
//     non-owner raises) — same pattern as audit_log.
//   - tenant_id columns are nullable (platform-scope access has NULL) with no
//     tenant FK, so no RESTRICT conflict with tenant lifecycle.
// User references use text (Better-Auth ids) with ON DELETE RESTRICT: a grant
// or audit-trail row must never outlive into an ownerless state.

export const auditAccessGrants = pgTable(
  'audit_access_grants',
  {
    id: id(),
    /** Who may read audit data. Required: a grant without a grantee is void. */
    granteeUserId: text('grantee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Tenant scope of the grant; NULL for scope='platform'. */
    granteeTenantId: uuid('grantee_tenant_id'),
    /** 'tenant' reads one tenant's audit trail, 'platform' reads across. */
    scope: text('scope').notNull(),
    /** Why the access was requested. Required, length-capped (CHECK in 0059). */
    purpose: text('purpose').notNull(),
    /** Approver — must differ from the grantee (CHECK in 0059); NULL = pending. */
    approvedByUserId: text('approved_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    /**
     * Approver-granted extension permission: oversized queries (beyond the
     * default row cap) and exports require a grant with this flag (V3 §P-6).
     */
    extraApproval: boolean('extra_approval').notNull().default(false),
    /** Mandatory validity window; ≤ 90 days (CHECK in 0059). */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Early revocation; set together with revoked_by (CHECK in 0059). */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: text('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (t) => ({
    granteeIdx: index('audit_access_grants_grantee_idx').on(t.granteeUserId, t.scope),
    windowIdx: index('audit_access_grants_window_idx').on(t.startsAt, t.expiresAt),
  }),
)

export const platformAuditAccessLog = pgTable(
  'platform_audit_access_log',
  {
    id: id(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actorTenantId: uuid('actor_tenant_id'),
    scope: text('scope').notNull(),
    /** Grant in effect (or requested); plain reference — grants are never deleted. */
    grantId: uuid('grant_id'),
    /** What happened: grant_requested | grant_approved | grant_rejected |
     * grant_revoked | audit_query | audit_query_failed | audit_query_timeout |
     * audit_oversize_requested | audit_export_requested | audit_export_approved |
     * audit_export_completed | audit_access_denied. */
    action: text('action').notNull(),
    /** Purpose copied from the grant at event time (survives grant edits). */
    purpose: text('purpose').notNull(),
    filter: jsonb('filter').$type<Record<string, unknown>>().default({}).notNull(),
    rowCount: integer('row_count'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    occurredIdx: index('platform_audit_access_log_occurred_idx').on(t.occurredAt),
    grantIdx: index('platform_audit_access_log_grant_idx').on(t.grantId),
    actorIdx: index('platform_audit_access_log_actor_idx').on(t.actorUserId, t.occurredAt),
  }),
)
