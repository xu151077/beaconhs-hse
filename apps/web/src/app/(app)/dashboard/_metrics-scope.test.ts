import { describe, expect, it } from 'vitest'
import { and, sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { can } from '@beaconhs/tenant'
import { moduleScopeWhere } from '../../../lib/visibility'

/**
 * F2 regression tests: the dashboard greeting showed tenant-wide figures to a
 * site-scoped caller.
 *
 * `_metrics.ts` had **zero** references to `site_org_unit_id`, so `incidents30`
 * counted every incident in the tenant. Verified in a real browser: foreman-a
 * (Site A) and foreman-b (Site B) both saw "4 incidents in the last 30 days",
 * which is 2 + 2 across both sites, while the /insights card for the same user
 * correctly showed 2.
 *
 * The fix routes the counts through `moduleScopeWhere`, the same primitive the
 * incidents list, the corrective-actions list and every module CSV export already
 * use. These tests assert the predicate it produces for each tier, and assert the
 * dashboard's own source so a later edit cannot quietly drop a scope again.
 */

const SITE_A = 'd83943d2-58e9-4b1c-a241-e455d8a77c8a'
const SITE_B = '85b2dbd0-b120-406c-8486-1c425ddf858d'
const TENANT = '85df8265-e62d-43ac-9455-e80a2a81efc9'
const PERSON_SELF = '11111111-2222-3333-4444-555555555555'
const USER_SELF = 'verif-foreman-a'

type Ctx = Parameters<typeof can>[0]
type Tx = Parameters<typeof moduleScopeWhere>[1]

/** The stub columns the scope resolver only ever hands to inArray/eq. */
const siteCol = { name: 'site_org_unit_id' } as never
const ownerCol = { name: 'reported_by_tenant_user_id' } as never
const personCol = { name: 'person_id' } as never

function context(
  permissions: string[],
  opts: { scopes?: unknown[]; personId?: string; userId?: string; isSuperAdmin?: boolean } = {},
): Ctx {
  const set = new Set(permissions)
  return {
    tenantId: TENANT,
    tenantUserId: opts.userId ?? USER_SELF,
    userId: opts.userId ?? USER_SELF,
    membership: { id: opts.personId ? { personId: opts.personId } : undefined },
    personId: opts.personId,
    isSuperAdmin: opts.isSuperAdmin ?? false,
    scopes: opts.scopes ?? [],
    permissions: set,
    can: (key: string) => set.has(key),
  } as unknown as Ctx
}

/** `moduleScopeWhere` ignores its tx for the site/owner tiers, so a stub is enough. */
const tx = {} as Tx

const dialect = new PgDialect()

/**
 * Render a predicate to SQL text plus its bound parameters. Walking the node
 * tree by hand misses `inArray` params, so the dialect is asked to compile it —
 * the same way Postgres would see it.
 */
function toSql(node: SQL | undefined): string {
  if (!node) return ''
  const { sql: text, params } = dialect.sqlToQuery(node)
  return `${text} ${params.map((p) => String(p)).join(' ')}`
}

// the real foreman role: site-scoped across six modules
const FOREMAN_READS = [
  'incidents.read.site',
  'ca.read.site',
  'equipment.read.site',
  'ppe.read.site',
  'inspections.read.site',
  'forms.response.read.site',
]
const foremanA = () => context(FOREMAN_READS, { scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
const foremanB = () => context(FOREMAN_READS, { scopes: [{ type: 'sites', siteIds: [SITE_B] }] })

describe('F2 — dashboard metrics resolve the caller scope', () => {
  it('adds no predicate for a tenant-wide reader', async () => {
    expect(
      await moduleScopeWhere(context(['incidents.read.all']), tx, { prefix: 'incidents', siteCol }),
    ).toBeUndefined()
  })

  it('adds no predicate for a super admin', async () => {
    const admin = context(['reports.read'], { isSuperAdmin: true })
    expect(await moduleScopeWhere(admin, tx, { prefix: 'incidents', siteCol })).toBeUndefined()
  })

  it('builds a filter over the caller site ids for a site-scoped reader', async () => {
    const text = toSql(await moduleScopeWhere(foremanA(), tx, { prefix: 'incidents', siteCol }))
    expect(text).toContain(SITE_A)
    expect(text).not.toContain(SITE_B)
  })

  it('produces different predicates for Site A and Site B', async () => {
    const a = toSql(await moduleScopeWhere(foremanA(), tx, { prefix: 'incidents', siteCol }))
    const b = toSql(await moduleScopeWhere(foremanB(), tx, { prefix: 'incidents', siteCol }))
    expect(a).not.toBe(b)
    expect(a).toContain(SITE_A)
    expect(b).toContain(SITE_B)
    expect(a).not.toContain(SITE_B)
    expect(b).not.toContain(SITE_A)
  })

  it('applies the same split to every module the dashboard counts', async () => {
    for (const prefix of ['incidents', 'ca', 'equipment', 'inspections', 'forms.response']) {
      const a = toSql(await moduleScopeWhere(foremanA(), tx, { prefix, siteCol }))
      const b = toSql(await moduleScopeWhere(foremanB(), tx, { prefix, siteCol }))
      expect(a, prefix).toContain(SITE_A)
      expect(a, prefix).not.toContain(SITE_B)
      expect(b, prefix).toContain(SITE_B)
      expect(b, prefix).not.toContain(SITE_A)
    }
  })

  it('narrows a self-scoped reader to their own records', async () => {
    const worker = context(['incidents.read.self', 'training.read.self'], {
      scopes: [{ type: 'self' }],
      personId: PERSON_SELF,
    })
    const text = toSql(await moduleScopeWhere(worker, tx, { prefix: 'incidents', personCol }))
    expect(text).toContain(PERSON_SELF)
  })

  it('matches nothing for a reader with no module read permission', async () => {
    // viewer-a's five keys: reports.read, insights.read, dashboards.read,
    // incidents.read.site, documents.read. No equipment/training/ppe read at all.
    const viewer = context(['reports.read', 'insights.read', 'dashboards.read', 'documents.read'])
    for (const prefix of ['equipment', 'training', 'ppe', 'ca', 'inspections']) {
      const text = toSql(await moduleScopeWhere(viewer, tx, { prefix, siteCol }))
      expect(text, prefix).toContain('false')
    }
  })

  it('composes with the rest of a WHERE clause without dropping either part', async () => {
    const combined = and(
      (await moduleScopeWhere(foremanA(), tx, { prefix: 'incidents', siteCol })) ?? undefined,
      sql`is_null(deleted_at)`,
    )
    const text = toSql(combined)
    expect(text).toContain(SITE_A)
    expect(text).toContain('is_null')
  })
})

describe('F2 — the metrics file scopes every count it can', () => {
  const source = readMetricsSource()

  it('resolves the tier once, up front, with the canonical primitive', () => {
    expect(source).toContain('moduleScopeWhere')
    // no second tier resolver: the feed's duplicate must not creep back in here
    expect(source).not.toMatch(/from '\.\.\/feed\/_data'/)
  })

  it('scopes incidents, corrective actions, forms, inspections and equipment', () => {
    for (const prefix of ['incidents', 'ca', 'forms.response', 'inspections', 'equipment']) {
      expect(source, prefix).toContain(`prefix: '${prefix}'`)
    }
  })

  it('scopes both incident windows and the rates series', () => {
    // incidents30, incidentsPrev30, recordableMonthly, dartMonthly, hoursMonthly
    const uses = (source.match(/scopeIncidents|scopeIncidentHours/g) ?? []).length
    expect(uses).toBeGreaterThanOrEqual(6)
  })

  it('fails closed on the tables that have no location column', () => {
    // ppe_issues / ppe_items / people cannot be narrowed at all.
    expect(source).toContain("tenantWideOnly(ctx, 'ppe.read.all')")
    expect(source).toContain("tenantWideOnly(ctx, 'admin.users.manage')")
    // a prefix here would compile to a key nobody can hold
    expect(source).not.toContain("tenantWideOnly(ctx, 'admin.users.manage.all')")
  })

  it('keeps headcount nullable so an unscoped figure cannot print as a number', () => {
    expect(source).toContain('peopleCount: number | null')
  })

  it('keeps the fail-closed helper itself closed for a site-only reader', () => {
    const tenantWideOnly = (ctx: Ctx, key: string) => (can(ctx, key) ? undefined : sql`false`)
    expect(tenantWideOnly(context(['ppe.read.all']), 'ppe.read.all')).toBeUndefined()
    // a foreman holds ppe.read.site, never ppe.read.all
    expect(toSql(tenantWideOnly(foremanA(), 'ppe.read.all'))).toContain('false')
    // `admin.users.manage` is itself the tenant-wide key — it has no `.all` tier,
    // so a helper that appended one would hide the headcount from admin too.
    expect(tenantWideOnly(context(['admin.users.manage']), 'admin.users.manage')).toBeUndefined()
    expect(
      toSql(tenantWideOnly(context(['admin.settings.manage']), 'admin.users.manage')),
    ).toContain('false')
  })
})

function readMetricsSource(): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  return readFileSync(join(import.meta.dirname, '_metrics.ts'), 'utf8')
}
