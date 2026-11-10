// Public REST API keys, per tenant.

import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { id, timestamps } from './_helpers'
import { tenants, users } from './core'
import type { PermissionKey, RoleScope } from './iam'

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Hash of the secret; the secret itself is only shown once at creation.
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(), // e.g. 'bhs_live_…' first 8 chars, shown in UI
    permissions: jsonb('permissions').$type<PermissionKey[]>().default([]).notNull(),
    /** Explicit Builder templates this machine principal may access. Empty is
     * fail-closed even when forms permissions are present. */
    builderTemplateIds: jsonb('builder_template_ids').$type<string[]>().default([]).notNull(),
    /**
     * Authorization principal this credential acts as (PD-01, phase 1).
     *
     * Null keeps the legacy tenant-level credential: `permissions` is the whole
     * grant and there is no record-scope narrowing. Set it to a `tenant_users.id`
     * so the credential inherits that member's roles, `RoleScope` set and linked
     * person — which is what makes `site`/`self` scopes expressible for API keys
     * without a parallel permission system.
     *
     * Deliberately no FK: a composite `(tenant_id, principal_tenant_user_id)`
     * key cannot use `ON DELETE SET NULL` (tenant_id is NOT NULL) and CASCADE
     * would silently delete credentials when a membership is removed. The
     * binding write path validates tenant agreement; the auth path fails closed
     * when the principal is missing or inactive.
     */
    principalTenantUserId: uuid('principal_tenant_user_id'),
    /**
     * Explicit narrowing of the principal's scopes. Null inherits the principal
     * verbatim; an array may only narrow (never widen). Ignored while
     * `principal_tenant_user_id` is null.
     */
    scopes: jsonb('scopes').$type<RoleScope[]>(),
    createdBy: text('created_by').references(() => users.id),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    tenantIdx: index('api_keys_tenant_idx').on(t.tenantId),
    tenantIdIdUx: uniqueIndex('api_keys_tenant_id_id_ux').on(t.tenantId, t.id),
    hashUx: uniqueIndex('api_keys_key_hash_ux').on(t.keyHash),
    principalIdx: index('api_keys_principal_idx').on(t.tenantId, t.principalTenantUserId),
  }),
)

export const apiIdempotencyStatus = pgEnum('api_idempotency_status', ['processing', 'completed'])

export const apiIdempotencyKeys = pgTable(
  'api_idempotency_keys',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: apiIdempotencyStatus('status').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown> | null>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => ({
    keyUx: uniqueIndex('api_idempotency_keys_api_key_key_ux').on(t.apiKeyId, t.idempotencyKey),
    tenantExpiryIdx: index('api_idempotency_keys_tenant_expiry_idx').on(t.tenantId, t.expiresAt),
    apiKeyFk: foreignKey({
      name: 'api_idempotency_keys_tenant_api_key_fk',
      columns: [t.tenantId, t.apiKeyId],
      foreignColumns: [apiKeys.tenantId, apiKeys.id],
    }).onDelete('cascade'),
  }),
)
