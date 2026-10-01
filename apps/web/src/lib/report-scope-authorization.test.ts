// End-to-end authorization for the report and insight execution paths.
//
// The security property under test is not "a filter object exists" — it is that
// the SQL handed to Postgres is already narrowed for the caller. These tests
// drive the real production entry points (`resolveAnalyticsAccess` →
// `runBeaconReport` / `runBhql`) and capture the final statement text and its
// bound parameters, so a change that stops threading scope into the compiler
// fails here.
//
// No database is required: catalogue lookups are answered with empty sets and
// the compiled statement is captured instead of executed.

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runBhql } from '@beaconhs/analytics/server'
import type { Database } from '@beaconhs/db'
import {
  orgUnits,
  peopleAssignments,
  type ReportCustomQuery,
  type RoleScope,
} from '@beaconhs/db/schema'
import { runBeaconReport } from '@beaconhs/reports/server'
import type { RequestContext } from '@beaconhs/tenant'
import { resolveAnalyticsAccess } from './analytics-access'
import { loadAuthorizedReportCatalogInTransaction } from './report-catalog'

type Statement = { text: string; params: unknown[] }

// `analytics-access` and `report-catalog` are server-only modules; that guard
// throws outside a React Server Component, which is not the case under vitest.
vi.mock('server-only', () => ({}))

const executed = vi.hoisted(() => ({ statements: [] as { text: string; params: unknown[] }[] }))

/**
 * Walk a Drizzle `SQL` tree into readable text plus its bound parameters.
 * Literal SQL text is carried in `StringChunk` wrappers; bare values sitting
 * directly in `queryChunks` are the bound parameters.
 */
function renderSql(node: unknown, params: unknown[]): string {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map((child) => renderSql(child, params)).join('')
  if (typeof node !== 'object') {
    params.push(node)
    return '?'
  }
  const value = (node as { value?: unknown }).value
  if (Array.isArray(value)) return value.join('')
  if (value !== undefined) {
    params.push(value)
    return '?'
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks
  return chunks ? renderSql(chunks, params) : ''
}

// Report execution goes through `executeParameterizedRows`, which hands over the
// SQL text plus its bound parameters — exactly what the assertions below name.
vi.mock('@beaconhs/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beaconhs/db')>()
  return {
    ...actual,
    executeParameterizedRows: async (_tx: unknown, text: string, params: readonly unknown[]) => {
      executed.statements.push({ text, params: [...params] })
      return []
    },
  }
})

const SITE_A = '018f47ba-86c4-7ee2-8d7a-5e7602f2a001'
const SITE_B = '018f47ba-86c4-7ee2-8d7a-5e7602f2a002'

/**
 * A transaction that answers every catalogue lookup with an empty set and
 * records the statements BHQL sends, which takes the `tx.execute` path rather
 * than `executeParameterizedRows`.
 */
/**
 * A transaction stand-in that answers the Project Scope resolver's queries.
 *
 * Since 15B-3B `resolveAnalyticsAccess` calls the resolver, so this transaction
 * has to answer for `org_units`, `people` and `people_assignments` as well as the
 * empty sets the catalogue lookups want. It stays table-aware rather than
 * returning rows for everything: an unknown table still yields `[]`, which is
 * what `getEffectiveRoleKeys` and the catalogue reads expect.
 *
 * The foreman is placed at SITE_A, so the resolver answers `orgUnits` / `empty`,
 * and the compiled statement must be narrowed to that site. A test that wanted a
 * different placement changes `ASSIGNMENTS` below.
 */
const PROJECT_ID = '00000000-0000-4000-8000-00000000a000'
const ORG_ROWS = [
  { id: PROJECT_ID, parentId: null, level: 'project', deletedAt: null },
  { id: SITE_A, parentId: PROJECT_ID, level: 'site', deletedAt: null },
  { id: SITE_B, parentId: PROJECT_ID, level: 'site', deletedAt: null },
]
const ASSIGNMENTS = [
  {
    id: 'assignment-1',
    personId: 'person-1',
    orgUnitId: SITE_A,
    validFrom: '2020-01-01',
    validTo: null,
  },
]

/** The rows the resolver should get back, keyed by the table it selected from. */
/**
 * A Drizzle table's SQL name — the identity `resolveScopeSpec` matches on and
 * `.from()` is called with.
 */
function tableName(table: object): string {
  return (table as Record<PropertyKey, unknown>)[getTableName(table)] as string
}

/** Drizzle tags every table with its SQL name under this symbol. */
function getTableName(table: object): symbol {
  return Object.getOwnPropertySymbols(table).find((s) => s.description === 'drizzle:Name') as symbol
}

const RESOLVER_ROWS: Record<string, unknown[]> = {
  [tableName(orgUnits)]: ORG_ROWS,
  [tableName(peopleAssignments)]: ASSIGNMENTS,
}

function tableAwareTx(table: object | null, distinct: boolean) {
  const rows = table ? (RESOLVER_ROWS[tableName(table)] ?? []) : []
  const self = {
    then: (resolve: (value: unknown) => void) => resolve(distinct ? rows : rows),
    execute: async (statement: unknown) => {
      const params: unknown[] = []
      executed.statements.push({ text: renderSql(statement, params), params })
      return []
    },
  }
  return new Proxy(self, {
    get(target, property) {
      if (property === 'then' || property === 'execute') {
        return (target as unknown as Record<string, unknown>)[property as string]
      }
      if (property === 'from') return (t: object) => tableAwareTx(t, distinct)
      if (property === 'selectDistinct') return () => tableAwareTx(table, true)
      return () => tableAwareTx(table, distinct)
    },
  })
}

const tx = new Proxy(() => undefined, {
  get(_target, property) {
    if (property === 'then') return (resolve: (value: unknown) => void) => resolve([])
    if (property === 'execute') {
      return async (statement: unknown) => {
        const params: unknown[] = []
        executed.statements.push({ text: renderSql(statement, params), params })
        return []
      }
    }
    // `.select(...)` returns a builder that remembers its table; every other
    // chain method is a pass-through back onto that builder.
    if (property === 'select' || property === 'selectDistinct') {
      return () => tableAwareTx(null, property === 'selectDistinct')
    }
    return () => tx
  },
}) as unknown as Database

function foreman(over: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member-1', displayName: 'Foreman' },
    personId: 'person-1',
    permissions: new Set(['reports.read', 'insights.read', 'incidents.read.site', 'ca.read.site']),
    scopes: [{ type: 'sites', siteIds: [SITE_A] }] as RoleScope[],
    activeRoleId: 'foreman-role',
    db: async () => {
      throw new Error('Database access is not expected')
    },
    ...over,
  }
}

const INCIDENTS_QUERY: ReportCustomQuery = {
  entity: 'incidents',
  mode: 'rows',
  columns: ['title'],
}
const CA_QUERY: ReportCustomQuery = {
  entity: 'corrective_actions',
  mode: 'rows',
  columns: ['title'],
}

/** Discard anything a catalogue lookup produced, leaving only the target query. */
function reset(): void {
  executed.statements.length = 0
}

function onlyStatement(): Statement {
  expect(executed.statements).toHaveLength(1)
  return executed.statements[0]!
}

async function reportStatement(ctx: RequestContext, query: ReportCustomQuery): Promise<Statement> {
  const catalog = await loadAuthorizedReportCatalogInTransaction(ctx, tx)
  reset()
  await runBeaconReport(tx, 'tenant-1', query, catalog)
  return onlyStatement()
}

beforeEach(reset)

describe('report execution authorization', () => {
  it('bounds a site-scoped foreman report to the sites in their scope', async () => {
    const statement = await reportStatement(foreman(), INCIDENTS_QUERY)
    expect(statement.params).toContain(SITE_A)
  })

  it('cannot reach another site through the same report definition', async () => {
    const statement = await reportStatement(foreman(), INCIDENTS_QUERY)
    expect(statement.params).not.toContain(SITE_B)
  })

  it('does not let a corrective-action report fall back to a tenant-wide read', async () => {
    const statement = await reportStatement(foreman(), CA_QUERY)
    // The tenant id is always bound for RLS; the site id must be bound too.
    expect(statement.params).toContain('tenant-1')
    expect(statement.params).toContain(SITE_A)
    expect(statement.params).not.toContain(SITE_B)
  })

  it('keeps a read.all member unfiltered so the existing report reach is preserved', async () => {
    const statement = await reportStatement(
      foreman({
        permissions: new Set(['reports.read', 'incidents.read.all']),
        scopes: [{ type: 'tenant' }] as RoleScope[],
      }),
      INCIDENTS_QUERY,
    )
    expect(statement.params).not.toContain(SITE_A)
    expect(statement.params).not.toContain(SITE_B)
  })

  it('withholds the source entirely when the caller has no read permission for it', async () => {
    const ctx = foreman({ permissions: new Set(['reports.read']) })
    const catalog = await loadAuthorizedReportCatalogInTransaction(ctx, tx)
    reset()

    await expect(runBeaconReport(tx, 'tenant-1', INCIDENTS_QUERY, catalog)).rejects.toThrow(
      /unknown report entity/i,
    )
    // Failing closed means the report never reaches Postgres at all.
    expect(executed.statements).toHaveLength(0)
  })

  it("keeps the caller's saved filters instead of replacing them with the row scope", async () => {
    const statement = await reportStatement(foreman(), {
      ...INCIDENTS_QUERY,
      filters: { combinator: 'and', rules: [{ field: 'status', op: 'eq', value: 'open' }] },
    })
    expect(statement.params).toContain('open')
    expect(statement.params).toContain(SITE_A)
  })
})

describe('insight execution authorization', () => {
  const card = (source: string) => ({
    version: 'bhql/1' as const,
    display: 'table' as const,
    stages: [{ source, aggregations: [{ fn: 'count' as const, alias: 'count' }] }],
  })

  it('scopes an insight card the same way a report is scoped', async () => {
    const access = await resolveAnalyticsAccess(foreman(), tx)
    reset()

    await runBhql(tx, card('incidents'), { entityMap: access.entityMap })

    const statement = onlyStatement()
    expect(statement.params).toContain(SITE_A)
    expect(statement.params).not.toContain(SITE_B)
  })

  it('rejects an insight card naming a source the caller may not read', async () => {
    const access = await resolveAnalyticsAccess(
      foreman({ permissions: new Set(['insights.read']) }),
      tx,
    )
    reset()

    await expect(runBhql(tx, card('incidents'), { entityMap: access.entityMap })).rejects.toThrow(
      /Unknown source/,
    )
    expect(executed.statements).toHaveLength(0)
  })
})

describe('analytics cache isolation', () => {
  it('gives two members of the same role different cache keys', async () => {
    const atSiteA = await resolveAnalyticsAccess(foreman(), tx)
    const atSiteB = await resolveAnalyticsAccess(
      foreman({ scopes: [{ type: 'sites', siteIds: [SITE_B] }] as RoleScope[] }),
      tx,
    )

    // Same role, same active role id, same templates — only the resolved site
    // scope differs. A cache key that ignored it would serve one member's
    // scoped rows to the other.
    expect(atSiteA.scopeKey).not.toBe(atSiteB.scopeKey)
  })

  it('gives the same member a stable cache key across requests', async () => {
    expect((await resolveAnalyticsAccess(foreman(), tx)).scopeKey).toBe(
      (await resolveAnalyticsAccess(foreman(), tx)).scopeKey,
    )
  })

  it('separates a super-admin from a scoped member', async () => {
    const admin = await resolveAnalyticsAccess(foreman({ isSuperAdmin: true }), tx)
    const scoped = await resolveAnalyticsAccess(foreman(), tx)
    expect(admin.scopeKey).not.toBe(scoped.scopeKey)
  })
})

/**
 * The dashboard render path compiles cards through its own `runCardCached`, an
 * independent copy of `runAuthorizedBhql`. Fixing only the latter would leave the
 * homepage unscoped, so its wiring is asserted directly.
 */
describe('insight dashboard render path', () => {
  const data = readFileSync(new URL('../app/(app)/insights/_data.ts', import.meta.url), 'utf8')
  const render = data.slice(data.indexOf('async function runCardCached'))

  it('resolves the authorized source inventory rather than the raw discovery', () => {
    expect(render).toContain('resolveAnalyticsAccess(ctx, tx)')
    expect(render).not.toContain('discoverEntities()')
  })

  it("keys its result cache on the caller's authorization scope", () => {
    // `scopeKey` carries the resolved site ids; a key of tenant + query alone
    // would serve one member's scoped rows to another.
    expect(render).toContain('access.scopeKey')
  })

  it('gates the tenant-wide system-card source on a real read permission', () => {
    expect(render).toContain('trustedSystemCard && !canReadAppResponses(ctx)')
  })

  it('and that gate is read.all alone, not read.all OR read.site', () => {
    // The assertion above only proves a gate is CALLED. This proves what it
    // admits, because a `read.site` holder reaching a tenant-wide KPI is exactly
    // the regression 15B-3C closed. Behavioural assertions against the real
    // function live in `insights-trusted-card-scope-contract.test.ts`; this one
    // pins the wiring where the entity is injected, so the two cannot drift.
    const access = readFileSync(new URL('./analytics-access.ts', import.meta.url), 'utf8')
    const start = access.indexOf('export function canReadAppResponses')
    expect(start, 'canReadAppResponses must still exist').toBeGreaterThan(-1)
    // Read to the matching closing brace, not to the next line, so a Prettier
    // rewrap cannot truncate the slice and make these checks vacuous.
    const body = access.slice(start, access.indexOf('\n}', start))
    expect(body).toContain("can(ctx, 'forms.response.read.all')")
    expect(body).not.toContain('forms.response.read.site')
  })
})
