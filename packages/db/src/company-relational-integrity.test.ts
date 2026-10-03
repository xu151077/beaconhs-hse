import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'
import { TENANT_SCOPED_TABLES } from './rls'
import { companies, companyType, people } from './schema/org'

/**
 * Structural contract for the contractor / subcontractor company association.
 *
 * The whole capability is one catalog table plus one nullable, tenant-qualified
 * column on `people`. These assertions pin the properties that make it safe, so a
 * future edit cannot quietly weaken them:
 *
 *   - the company is an EMPLOYER record, not an `org_units` location row;
 *   - `people.company_id` reaches a company through a COMPOSITE (tenant_id, id)
 *     foreign key, which is what makes a cross-tenant reference impossible;
 *   - the column is nullable, so existing people stay valid;
 *   - the table is RLS-registered like every other tenant table;
 *   - nothing widens a permission, a RoleScope, or the people read boundary.
 *
 * Behaviour that needs a live database (the FK actually rejecting a cross-tenant
 * reference, RLS hiding another tenant's row) is proven against Postgres during
 * verification and cannot be asserted from the DDL alone — so these tests assert
 * the DDL that makes it true.
 */

const MIGRATION = readFileSync(new URL('../drizzle/0043_companies.sql', import.meta.url), 'utf8')

function columns(table: unknown) {
  return getTableColumns(table as Parameters<typeof getTableConfig>[0])
}

/** One column by name, failing loudly if it is absent (noUncheckedIndexedAccess). */
function column(table: unknown, name: string) {
  const found = columns(table)[name]
  if (!found) throw new Error(`column "${name}" not found`)
  return found
}

describe('companies — catalog shape', () => {
  it('is a tenant-scoped table with exactly the minimum proven columns', () => {
    expect(getTableName(companies as unknown as PgTable)).toBe('companies')
    expect(Object.keys(columns(companies)).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'tenantId',
      'type',
      'updatedAt',
    ])
  })

  it('carries no status, code, contact, or project/site/owner columns', () => {
    // Each of these was considered and rejected as speculative: nothing in the
    // phase needs them, and an unused column is dead schema.
    const cols = columns(companies)
    for (const banned of [
      'status',
      'code',
      'description',
      'phone',
      'email',
      'address',
      'licenseNo',
      'registrationNo',
      'ownerId',
      'managerId',
      'contactPersonId',
      'projectId',
      'siteId',
    ]) {
      expect(Object.keys(cols), banned).not.toContain(banned)
    }
  })

  it('models contractor vs subcontractor as one mutable enum on one table', () => {
    // Two tables would duplicate the row shape; a company is reclassified in place.
    expect(companyType.enumValues).toEqual(['contractor', 'subcontractor'])
    expect(column(companies, 'type').default).toBe('contractor')
    expect(column(companies, 'type').notNull).toBe(true)
    expect(column(companies, 'name').notNull).toBe(true)
    expect(column(companies, 'tenantId').notNull).toBe(true)
  })

  it('rejects a blank name in the database, not only in the form', () => {
    expect(column(companies, 'name').enumValues).toBeUndefined()
    expect(MIGRATION).toContain('companies_name_nonblank_ck')
    expect(MIGRATION).toContain('companies_tenant_normalized_name_ux')
  })

  it('has no soft-delete column, so deleting a company is a real delete', () => {
    // Matches departments / trades / crews. A deleted_at that nothing writes would
    // be dead schema, and soft-deleting with no archive filter and no restore
    // action would be a one-way door.
    expect(Object.keys(columns(companies))).not.toContain('deletedAt')
    expect(MIGRATION).not.toContain('"deleted_at"')
  })
})

describe('people.companyId — one nullable, tenant-qualified association', () => {
  it('is nullable so a person can have no company', () => {
    expect(columns(people).companyId).toBeDefined()
    expect(column(people, 'companyId').notNull).toBe(false)
    expect(column(people, 'companyId').hasDefault).toBe(false)
    // Migration adds the column without a default, so it is metadata-only on
    // PostgreSQL 11+ and every existing person stays valid.
    expect(MIGRATION).toContain('ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "company_id" uuid')
    expect(MIGRATION).not.toMatch(/ADD COLUMN[^;]*company_id[^;]*DEFAULT/i)
  })

  it('reaches the company through a composite (tenant_id, company_id) foreign key', () => {
    const cfg = getTableConfig(people)
    // Match on the parent table, not just "has two columns" — `people` has
    // several composite FKs (department / trade / crew / company).
    const companyFk = cfg.foreignKeys.find((fk) => fk.reference().foreignTable === companies)
    expect(companyFk).toBeDefined()

    const reference = companyFk!.reference()
    const childColumns = reference.columns.map((c) => c.name)
    const foreignColumns = reference.foreignColumns.map((c) => c.name)
    expect(foreignColumns).toEqual(['tenant_id', 'id'])
    // tenant_id leads the composite, which is what makes a cross-tenant company
    // reference structurally impossible rather than merely rejected in app code.
    expect(childColumns).toEqual(['tenant_id', 'company_id'])

    // No ON DELETE CASCADE: the action layer refuses to remove a company that
    // still has people, so an employer never disappears from under its workforce.
    expect(companyFk!.onDelete ?? 'no action').toBe('no action')
  })

  it('is indexed by (tenant_id, company_id) for the scoped lookup', () => {
    const cfg = getTableConfig(people)
    const prefixes = cfg.indexes.map((i) =>
      i.config.columns.map((c) => ('name' in c ? c.name : '')),
    )
    expect(prefixes).toContainEqual(['tenant_id', 'company_id'])
  })

  it('targets an exact (tenant_id, id) unique key on the company', () => {
    const uniqueKeys = getTableConfig(companies)
      .indexes.filter((i) => i.config.unique)
      .map((i) => i.config.columns.map((c) => ('name' in c ? c.name : '')))
    expect(uniqueKeys).toContainEqual(['tenant_id', 'id'])
  })
})

describe('companies — tenant isolation and boundary', () => {
  it('is registered for RLS with a single-row tenant policy', () => {
    expect(TENANT_SCOPED_TABLES).toContain('companies')
    expect(MIGRATION).not.toContain('ROW LEVEL SECURITY')
    // RLS is installed by migrate.ts for every registered table, not per-migration.
    expect(new Set(TENANT_SCOPED_TABLES).size).toBe(TENANT_SCOPED_TABLES.length)
  })

  it('cascades from the tenant so tenant teardown removes companies', () => {
    const fk = getTableConfig(companies).foreignKeys.find(
      (f) => f.reference().foreignTable === schema.tenants,
    )
    expect(fk).toBeDefined()
    expect(fk!.onDelete).toBe('cascade')
  })

  it('introduces no company table, permission key, or RoleScope variant', () => {
    // Guard against the parallel-entity failure mode: `companies` is a catalog
    // under the existing People admin, not a new authorization surface. Exactly
    // one table is created, and no separate organization/employer/contractor
    // identifier column is introduced anywhere.
    expect(MIGRATION.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(1)
    expect(MIGRATION).not.toMatch(/\b(organization_id|employer_id|contractor_id)\b/)

    const source = readFileSync(new URL('./schema/iam.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/'(?:hse\.)?contractors?\./)
    expect(source).not.toMatch(/'companies?\./)

    // RoleScope gained no variant — a company association is business data, and
    // adding an authorization scope for it would be a shadow permission system.
    const roleScope = source.slice(
      source.indexOf('export type RoleScope ='),
      source.indexOf('export const roleAssignments'),
    )
    expect(roleScope).toContain("type: 'tenant'")
    for (const variant of ['sites', 'team', 'people', 'crews', 'self']) {
      expect(roleScope).toContain(`type: '${variant}'`)
    }
    expect(roleScope).not.toMatch(/compan|contractor|employer/i)
    expect(roleScope.match(/type: '/g)).toHaveLength(6)
  })
})
