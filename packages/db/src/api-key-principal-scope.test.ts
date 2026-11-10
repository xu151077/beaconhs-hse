// PD-01 phase 1 — structural contract for the API-key authorization principal.
//
// The credential is the machine identity; the principal is the authorization
// subject it acts as. Phase 1 only adds the nullable columns (pure additive, no
// behaviour change): existing keys stay tenant-level until an operator binds
// them. These assertions pin the contract so a later phase cannot silently
// change nullability, drop the narrowing column, or lose the lookup index.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { apiKeys } from './schema'

const drizzleFolder = new URL('../drizzle/', import.meta.url)
const migration = readFileSync(new URL('0058_api_key_principal_scope.sql', drizzleFolder), 'utf8')

describe('api_keys principal + scope (PD-01 phase 1)', () => {
  it('exposes a nullable principal and nullable scope column', () => {
    const config = getTableConfig(apiKeys)
    const principal = config.columns.find((c) => c.name === 'principal_tenant_user_id')
    const scopes = config.columns.find((c) => c.name === 'scopes')
    expect(principal).toBeDefined()
    expect(scopes).toBeDefined()
    // Nullable is the whole compatibility story: NULL = legacy tenant-level key.
    expect(principal?.notNull).toBe(false)
    expect(scopes?.notNull).toBe(false)
  })

  it('indexes the principal lookup by tenant', () => {
    const config = getTableConfig(apiKeys)
    const idx = config.indexes.find((i) => i.config.name === 'api_keys_principal_idx')
    expect(idx).toBeDefined()
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'tenant_id',
      'principal_tenant_user_id',
    ])
  })

  it('ships an additive migration only', () => {
    // No DROP / no NOT NULL / no rewrite: a replay on a live table is a no-op.
    expect(migration).not.toMatch(/\bDROP\b/i)
    expect(migration).not.toMatch(/\bNOT NULL\b/i)
    expect(migration).toContain('ADD COLUMN "principal_tenant_user_id" uuid')
    expect(migration).toContain('ADD COLUMN "scopes" jsonb')
    expect(migration).toContain('CREATE INDEX "api_keys_principal_idx"')
  })

  it('is registered in the migration journal after 0057', () => {
    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', drizzleFolder), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> }
    const last = journal.entries.at(-1)
    expect(last).toMatchObject({ idx: 58, tag: '0058_api_key_principal_scope' })
    expect(journal.entries.at(-2)).toMatchObject({
      idx: 57,
      tag: '0057_audit_immutable_trigger_owner_fix',
    })
  })
})
