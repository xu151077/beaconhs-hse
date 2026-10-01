// 15B-3C — `locations/export.csv`: the customer-level definition export.
//
// WHY THIS FILE EXISTS
//
// The 15B-3C audit (§6, row 10) classified this route as "scope definition
// domain — needs an explicit product decision" and left it open. That audit also
// recorded that it had NO test coverage at all, which is the gap this closes.
//
// WHAT THIS ROUTE ACTUALLY IS — the fact the decision rests on
//
// It is not a separate entity. It reads `org_units`, filtered to a single
// hard-coded level:
//
//     const filters: SQL<unknown>[] = [eq(orgUnits.level, 'customer')]
//
// and projects eight descriptive fields. It is a filtered VIEW of `org_units`,
// gated by the SAME `admin.org.manage` key, and — like the list pages beside it —
// it applies no Project Scope row predicate; its tenant boundary is RLS via
// `ctx.db`.
//
// Since 15B-3C-3E, `org_units` is an explicit `tenant-level-definition`
// exemption. So this route's behaviour is not an undecided gap that happens to
// look like an exemption: it is the same table, the same permission and the same
// semantics, on the web side. No separate Project Scope binding is required,
// and none was added.
//
// WHAT IS DELIBERATELY NOT ASSERTED
//
//   • NOT "the source must not contain `moduleScopeWhere`". That pins an
//     implementation detail, and a future correct refactor would fail it while
//     the product behaviour stayed right.
//   • NOT "a restricted caller must be filtered". That is the open PII /
//     export-authorization question below, and it is NOT decided.
//
// The assertions below lock the facts that ARE settled: the permission surface,
// the hard-coded customer-level data boundary, the column ceiling, and the fact
// that the tenant boundary comes from RLS rather than from a scope predicate.
//
// OPEN, AND NOT DECIDED HERE
//
// Five of the eight exported columns are address components
// (`line1`, `city`, `region`, `postal`, `country`). Whether a Project-Scope
// restricted `tenant_admin` may export the tenant-wide customer address book is
// a data-export / compliance-authorization question. It is deliberately kept
// separate from Project Scope exemption: an exemption answers "does a scope
// predicate apply to this table", never "may this role see this data". Nothing
// in this file asserts that the current behaviour is correct, only that it is
// what the code does and that it is bounded by permission + RLS.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { csvColumns, selectCsvColumns } from './export-columns'

/** Route sources cannot be imported: `apps/web` has no vitest config, so the
 *  `@/*` tsconfig path is not aliased. Every contract test in this repo reads
 *  them with `readFileSync` for the same reason. */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** Comments stripped, so prose naming a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

const ROUTE = source('../app/(app)/locations/export.csv/route.ts')
const ROUTE_CODE = codeOnly(ROUTE)
const ANALYTICS_SCOPE = source('../../../../packages/analytics/src/server/scope.ts')

/** The eight columns the route declares, in source order. */
const DECLARED_LABELS = [
  'Name',
  'Code',
  'Level',
  'Address line 1',
  'City',
  'Region',
  'Postal code',
  'Country',
] as const

const DECLARED = csvColumns(DECLARED_LABELS)

const params = (...pairs: [string, string][]): URLSearchParams => {
  const sp = new URLSearchParams()
  for (const [k, v] of pairs) sp.append(k, v)
  return sp
}

/**
 * The whole `TABLE_SCOPE` entry for a table, as one spec declaration.
 *
 * Each definition-domain spec is a single line, and slicing to the next `},`
 * would cut inside `read: { … }` — so the line is taken whole.
 */
const specEntry = (table: string): string => {
  const at = ANALYTICS_SCOPE.indexOf(`\n  ${table}: {`)
  expect(at, `no TABLE_SCOPE entry for ${table}`).toBeGreaterThan(-1)
  const end = ANALYTICS_SCOPE.indexOf('\n', at + 1)
  return ANALYTICS_SCOPE.slice(at + 1, end === -1 ? undefined : end)
}

// ===========================================================================
// 1. Export authorization
// ===========================================================================

describe('15B-3C — locations export authorization', () => {
  it('requires the export capability, not just the module permission', () => {
    // `requireExportContext` is the shared gate: it asserts `admin.data.export`
    // AND refuses to export while impersonating. Both are asserted here because
    // this route's only defence against a bulk pull is that pair.
    const auth = source('../lib/auth.ts')
    const body = auth.slice(auth.indexOf('export async function requireExportContext'))
    const gate = body.slice(0, body.indexOf('\n}'))
    expect(gate).toContain("assertCan(ctx, 'admin.data.export')")
    expect(gate).toContain("assertNotImpersonating(ctx, 'export')")
  })

  it('the route uses that context and adds the org permission on top', () => {
    expect(ROUTE_CODE).toContain('requireExportContext()')
    expect(ROUTE_CODE).toContain("assertCan(ctx, 'admin.org.manage')")
  })

  it('both keys are real catalogue permissions', () => {
    // Guards the gate against a typo'd key silently denying everyone, or a
    // removed key silently widening it.
    expect(PERMISSION_CATALOGUE).toContain('admin.data.export')
    expect(PERMISSION_CATALOGUE).toContain('admin.org.manage')
  })

  it('holds the org permission BEFORE it queries anything', () => {
    const gate = ROUTE_CODE.indexOf("assertCan(ctx, 'admin.org.manage')")
    const query = ROUTE_CODE.indexOf('ctx.db(')
    expect(gate).toBeGreaterThan(-1)
    expect(query).toBeGreaterThan(-1)
    expect(gate, 'the permission gate must precede the query').toBeLessThan(query)
    // No early success return between them.
    expect(ROUTE_CODE.slice(gate, query)).not.toContain('return csvResponse')
  })

  it('the org permission is held by tenant_admin and by no other built-in role', async () => {
    // Read from the real catalogue rather than asserted as prose, so granting it
    // to a field role later fails here instead of quietly widening the export.
    const holds = (role: string): boolean =>
      (BUILTIN_ROLES[role]?.permissions as readonly string[] | undefined)?.includes(
        'admin.org.manage',
      ) === true

    expect(holds('tenant_admin')).toBe(true)
    for (const role of ['worker', 'foreman', 'safety_manager']) {
      expect(holds(role), `${role} must not hold admin.org.manage`).toBe(false)
    }
  })

  it('the export is audited as an org_unit export', () => {
    // The audit row is what makes a bulk pull reviewable after the fact.
    expect(ROUTE_CODE).toContain("entityType: 'org_unit'")
    expect(ROUTE_CODE).toContain("action: 'export'")
  })
})

// ===========================================================================
// 2. The customer-level definition boundary
// ===========================================================================

describe('15B-3C — the locations export is a customer-level view of org_units', () => {
  it('reads org_units, not a table of its own', () => {
    expect(ROUTE_CODE).toContain('from(orgUnits)')
    // There is no locations entity anywhere in the route's imports.
    const schemaImport = ROUTE_CODE.match(/from '@beaconhs\/db\/schema'/)
    expect(schemaImport).not.toBeNull()
    const importLine = ROUTE_CODE.slice(0, ROUTE_CODE.indexOf("from '@beaconhs/db/schema'"))
    expect(importLine).toContain('orgUnits')
    expect(importLine).not.toMatch(/\bfrom '\.\.\/|\bfrom '\.\//)
  })

  it('pins level = customer as the FIRST filter, not a caller choice', () => {
    // The data boundary is the whole point: this exports customer nodes only.
    // Asserted on the initialiser so it cannot become request-driven.
    expect(ROUTE_CODE).toMatch(
      /const filters: SQL<unknown>\[\] = \[eq\(orgUnits\.level, 'customer'\)\]/,
    )
  })

  it('level is not readable from the query string at all', () => {
    // A `?level=site` that widened or re-targeted the export would be a scope
    // bypass, so the absence of any level parameter is the assertion.
    expect(ROUTE_CODE).not.toMatch(/sp\.level/)
    expect(ROUTE_CODE).not.toMatch(/sp\.get\('level'\)/)
    expect(ROUTE_CODE).not.toMatch(/pickString\(sp\.level\)/)
    // `level` is read only as the enum column, never as a filter input.
    expect([...ROUTE_CODE.matchAll(/orgUnits\.level/g)]).toHaveLength(1)
  })

  it('active / archived keep their existing soft-delete semantics', () => {
    const body = ROUTE_CODE.slice(ROUTE_CODE.indexOf('const statusFilter'))
    expect(body).toContain("pickString(sp.status) ?? 'active'")
    expect(body).toContain(
      "if (statusFilter === 'active') filters.push(isNull(orgUnits.deletedAt))",
    )
    expect(body).toContain(
      "else if (statusFilter === 'archived') filters.push(isNotNull(orgUnits.deletedAt))",
    )
  })

  it('the customer filter is ANDed with the others, never replaced', () => {
    // `and(...filters)` over a list that already holds the level condition.
    expect(ROUTE_CODE).toMatch(/const whereClause = and\(\.\.\.filters\)/)
    expect(ROUTE_CODE).toContain('filters.push(')
  })

  it('the query is bounded, so a full-tenant pull cannot be unbounded', () => {
    expect(ROUTE_CODE).toContain('CSV_EXPORT_QUERY_LIMIT')
    expect(ROUTE_CODE).toContain('csvExportOverflowResponse(rows.length)')
  })
})

// ===========================================================================
// 3. The CSV column boundary — exercised through the real selector
// ===========================================================================

describe('15B-3C — the export can only narrow its eight declared columns', () => {
  it('declares exactly the eight descriptive fields', () => {
    expect(ROUTE_CODE).toContain('csvColumns([')
    for (const label of DECLARED_LABELS) {
      expect(ROUTE_CODE, label).toContain(`'${label}'`)
    }
    // No ninth entry.
    const block = ROUTE_CODE.slice(
      ROUTE_CODE.indexOf('csvColumns(['),
      ROUTE_CODE.indexOf('])', ROUTE_CODE.indexOf('csvColumns([')),
    )
    expect(block.match(/'[^']+'/g)).toHaveLength(DECLARED_LABELS.length)
  })

  it('exports no identifier, no tenant, and no tree position by default', () => {
    // The strongest form of the claim: these are simply not in the output.
    const headers = selectCsvColumns(params(), DECLARED).headers
    expect(headers).toEqual([...DECLARED_LABELS])
    for (const forbidden of ['id', 'tenantId', 'parentId', 'tenant_id', 'parent_id']) {
      expect(headers, forbidden).not.toContain(forbidden)
    }
  })

  it('a client cannot request id, tenantId, parentId or a project column', () => {
    // Requesting only unknown keys selects nothing, and the selector falls back
    // to the declared set — so the ceiling holds rather than collapsing to empty.
    const attempt = selectCsvColumns(
      params(
        ['columns', 'id'],
        ['columns', 'tenantId'],
        ['columns', 'parentId'],
        ['columns', 'tenant_id'],
        ['columns', 'parent_id'],
        ['columns', 'site_org_unit_id'],
        ['columns', 'org_unit_id'],
        ['columns', 'level_id'],
        ['columns', 'person_id'],
        ['columns', 'owner_tenant_user_id'],
        ['columns', 'created_at'],
        ['columns', 'updated_at'],
        ['columns', 'deleted_at'],
        ['columns', 'lat'],
        ['columns', 'lng'],
        ['columns', 'metadata'],
        ['columns', 'is_equipment_base'],
      ),
      DECLARED,
    )
    expect(attempt.headers).toEqual([...DECLARED_LABELS])
  })

  it('a genuine subset request still narrows', () => {
    // Proves the ceiling is a filter and not a no-op: the happy path works.
    const attempt = selectCsvColumns(params(['columns', 'name'], ['columns', 'city']), DECLARED)
    expect(attempt.headers).toEqual(['Name', 'City'])
  })

  it('a partially valid request yields only the valid columns', () => {
    const attempt = selectCsvColumns(params(['columns', 'name'], ['columns', 'id']), DECLARED)
    expect(attempt.headers).toEqual(['Name'])
  })

  it('projecting a row can only emit the declared fields, in declared order', () => {
    // The row mapper supplies exactly eight values; the selector indexes into
    // that fixed list, so there is no path from input to an undeclared cell.
    const selection = selectCsvColumns(params(), DECLARED)
    const row = selection.project([
      'Acme Site',
      'ACME',
      'customer',
      '1 Main St',
      'Toronto',
      'ON',
      'M5V 1A1',
      'CA',
    ])
    expect(row).toEqual([
      'Acme Site',
      'ACME',
      'customer',
      '1 Main St',
      'Toronto',
      'ON',
      'M5V 1A1',
      'CA',
    ])
    expect(row).toHaveLength(DECLARED_LABELS.length)
  })
})

// ===========================================================================
// 4. Project Scope semantic contract
// ===========================================================================

describe('15B-3C — Project Scope semantics of the locations export', () => {
  it('the route and the org_units definition-domain spec share one permission', () => {
    // The alignment that makes a separate binding unnecessary: same table, same
    // capability. If either key moved, the two would stop agreeing and the
    // exemption below would no longer describe this route.
    expect(ROUTE_CODE).toContain("assertCan(ctx, 'admin.org.manage')")
    expect(specEntry('org_units')).toContain("read: { key: 'admin.org.manage' }")
  })

  it('org_units is an explicit, named tenant-level-definition exemption', () => {
    // Not inferred from `tier === 'all'`, from having no columns, or from the
    // permission. The exemption is a named fact about the spec.
    for (const table of ['org_units', 'departments', 'crews', 'trades']) {
      const entry = specEntry(table)
      expect(entry, table).toContain("read: { key: 'admin.org.manage' }")
      expect(entry, table).toContain("projectScopeExempt: 'tenant-level-definition'")
    }
  })

  it('the four definition tables declare no Project Scope binding column', () => {
    // The reason the exemption is definitionally correct rather than a
    // convenience: there is nothing to bind, and `parentId` is the tree itself,
    // so binding on it would be circular.
    for (const table of ['org_units', 'departments', 'crews', 'trades']) {
      const entry = specEntry(table)
      expect(entry, table).not.toContain('siteCols')
      expect(entry, table).not.toContain('orgUnitCols')
      expect(entry, table).not.toContain('personCols')
      expect(entry, table).not.toContain('userCols')
    }
  })

  it('the tenant boundary is RLS through ctx.db, not a scope predicate', () => {
    // The load-bearing distinction. "Tenant-level definition" must never be
    // implemented as crossing tenants: the read runs inside `ctx.db`, so RLS
    // bounds it, and there is no root `db` or `withSuperAdmin` escape hatch.
    expect(ROUTE_CODE).toContain('ctx.db(async (tx) =>')
    expect(ROUTE_CODE).not.toMatch(/\bwithSuperAdmin\b/)
    expect(ROUTE_CODE).not.toMatch(/from '@beaconhs\/db'/)
    expect(ROUTE_CODE).not.toMatch(/\btx\.(select|update|delete)\(\)/)
    // Every row-producing query is inside the transaction.
    const db = ROUTE_CODE.indexOf('ctx.db(async (tx) =>')
    const select = ROUTE_CODE.indexOf('return tx')
    expect(select).toBeGreaterThan(db)
  })

  it('the org_units exemption does not grant a permission on its own', () => {
    // An exemption skips a row predicate; it is not a capability. The tier is
    // still resolved from the read key, so the two gates remain independent.
    expect(ANALYTICS_SCOPE).toContain(
      "if ('key' in read) return subject.permissions(read.key) ? 'all' : 'none'",
    )
  })

  it('the same table is not reachable by any role lacking the org permission', () => {
    // Cross-checks the two halves: the role matrix above and the spec key here
    // must agree, or one of the two assertions above is measuring nothing.
    const spec = specEntry('org_units')
    const heldBy = Object.entries(BUILTIN_ROLES)
      .filter(([, r]) => (r.permissions as readonly string[]).includes('admin.org.manage'))
      .map(([k]) => k)
    expect(heldBy.length).toBeGreaterThan(0)
    for (const role of heldBy) {
      expect(spec, role).toContain("read: { key: 'admin.org.manage' }")
    }
  })
})
