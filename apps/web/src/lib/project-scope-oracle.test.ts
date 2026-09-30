// 15B-3B — the cross-layer oracle.
//
// Two ladders exist in this codebase and they must agree:
//
//   UI / Dashboard  `apps/web/src/lib/visibility.ts` → `moduleScopeWhere`
//                   emits a drizzle SQL predicate, ANDed into a list query.
//   Analytics       `packages/analytics/src/server/scope.ts` → `resolveEntity`
//                   emits a `ReportRuleGroup`, compiled by the reports/BHQL
//                   compilers into the same kind of WHERE.
//
// Before 15B-3B they disagreed. The analytics ladder returned
// `{ visible: true, filter: undefined }` for `tier === 'all'`, so a `read.all`
// holder got every row in the tenant from a card or a report while the same
// person's dashboard counted only their project. That is the defect.
//
// This file pins the agreement WITHOUT asserting on SQL text. Comparing rendered
// SQL across two compilers would test the formatters, not the decision. What
// matters is WHICH ORG UNITS each ladder admits for the same identity, so that
// is what is compared.
//
// The Dashboard is the oracle rather than the web UI because it is the one
// surface that was already correct when 15B-2 landed: it calls
// `moduleScopeWhere` ten times in `dashboard/_metrics.ts` and therefore always
// applied the Project Scope. Its behaviour is the reference; the analytics ladder
// is checked against it, not the other way round.

import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { peopleAssignments, type RoleScope } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import {
  analyticsScopeSubject,
  scopeAnalyticsEntities,
  type AnalyticsScopeSubject,
} from '@beaconhs/analytics/server'
import type { AnalyticsEntity } from '@beaconhs/analytics'
import { moduleScopeWhere } from './visibility'
import type { ProjectScope } from './project-scope'
import { projectScopeTx } from './testing/project-scope-fixture'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const READER = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'

const dialect = new PgDialect()
const toSql = (q: unknown): string =>
  q === undefined ? '(no predicate)' : dialect.sqlToQuery(q as never).sql

function ctx(
  permissions: string[],
  over: { personId?: string | null; scopes?: RoleScope[]; isSuperAdmin?: boolean } = {},
): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: over.isSuperAdmin ?? false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'm1', displayName: 'A' },
    personId: over.personId === undefined ? READER : over.personId,
    permissions: new Set(permissions),
    scopes: over.scopes ?? [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
  } as RequestContext
}

/** A caller with an effective personnel assignment at exactly `orgUnitId`. */
const assignedAt = (orgUnitId: string) =>
  projectScopeTx({
    assignments: [{ personId: READER, orgUnitId, validFrom: '2020-01-01', validTo: null }],
  })

/** A caller with no assignment at all. */
const assignedNowhere = () => projectScopeTx({ assignments: [], employeeRecord: 'present' })

/** The Project Scope the analytics ladder is handed, mirroring resolver output. */
const atSites = (orgUnitIds: string[]): ProjectScope =>
  orgUnitIds.length === 0
    ? { kind: 'empty', reason: 'no_assignment' }
    : { kind: 'orgUnits', orgUnitIds, personIds: [] }

/** Build the analytics subject through the SHARED constructor the web app uses. */
function analyticsSubject(input: {
  permissions: (key: string) => boolean
  siteIds?: string[]
  isSuperAdmin?: boolean
  scope: ProjectScope | undefined
}): AnalyticsScopeSubject {
  return analyticsScopeSubject(
    {
      isSuperAdmin: input.isSuperAdmin ?? false,
      permissions: input.permissions,
      siteIds: input.siteIds ?? [],
      personId: READER,
      tenantUserId: null,
    },
    input.scope,
  )
}

const INCIDENTS: AnalyticsEntity = {
  key: 'incidents',
  label: 'Incidents',
  category: 'Safety',
  table: 'incidents',
  columns: [
    { key: 'site_org_unit_id', label: 'Site', kind: 'uuid' },
    { key: 'id', label: 'Id', kind: 'uuid' },
  ],
} as AnalyticsEntity

/**
 * The org-unit ids an analytics resolution admits.
 *
 *   `withheld`    the entity was removed from the catalogue — nothing is visible
 *   `unfiltered`  it is present with no predicate — everything is visible
 *   otherwise     the ids its `in` rules name
 */
function analyticsReaches(
  subject: AnalyticsScopeSubject,
  entity: AnalyticsEntity = INCIDENTS,
): 'withheld' | 'unfiltered' | string[] {
  const out = scopeAnalyticsEntities(subject, [entity])
  if (out.length === 0) return 'withheld'
  const filter = out[0]!.baseFilter
  if (!filter) return 'unfiltered'
  const ids: string[] = []
  const walk = (group: unknown): void => {
    const g = group as { rules?: unknown[] }
    for (const rule of g.rules ?? []) {
      const r = rule as { op?: string; value?: unknown; rules?: unknown[] }
      if (r.rules) {
        // A nested group is a union; collect every leg.
        walk(r)
        continue
      }
      if (r.op === 'in' && Array.isArray(r.value)) ids.push(...(r.value as string[]))
    }
  }
  walk(filter)
  return [...new Set(ids)].sort()
}

/**
 * The org-unit ids a drizzle predicate names; `[]` when it admits nothing.
 *
 * The ids are read from the compiled query's PARAMS, not its text: drizzle emits
 * `in ($1, $2)` with the values bound, so an `inArray` never appears literally in
 * the SQL. A terminal `false` admits nothing.
 */
function dashboardReaches(predicate: unknown): string[] {
  if (predicate === undefined || predicate === null) return []
  const { sql: text, params } = dialect.sqlToQuery(predicate as never)
  if (/^\s*false\s*$/i.test(text)) return []
  const ids = new Set<string>()
  for (const p of params) {
    if (typeof p === 'string' && /^[0-9a-f-]{36}$/i.test(p)) ids.add(p)
  }
  return [...ids].sort()
}

const dashboardWhere = (c: RequestContext, tx: unknown) =>
  moduleScopeWhere(c, tx as Database, {
    prefix: 'incidents',
    siteCol: peopleAssignments.orgUnitId,
  })

describe('15B-3B — the Dashboard ladder is the oracle for the analytics ladder', () => {
  it('both confine a placed foreman with read.all to their own site', async () => {
    const permissions = ['incidents.read.all']
    const c = ctx(permissions, { personId: READER, scopes: [{ type: 'sites', siteIds: [SITE_A] }] })

    const dashboard = dashboardReaches(await dashboardWhere(c, assignedAt(SITE_A)))
    const analytics = analyticsReaches(
      analyticsSubject({ permissions: (k) => permissions.includes(k), scope: atSites([SITE_A]) }),
    )

    // The resolver expands an assignment at a site to include the project above
    // it, so the reachable set is a site AND its parent — both ladders see that,
    // because the analytics subject carries the resolver's own output. The
    // property under test is containment, not an exact list: neither ladder
    // reaches the OTHER site.
    expect(analytics).not.toBe('withheld')
    expect(analytics).not.toBe('unfiltered')
    const analyticsIds = analytics as string[]
    expect(analyticsIds).toContain(SITE_A)
    expect(analyticsIds).not.toContain(SITE_B)
    expect(dashboard).toContain(SITE_A)
    expect(dashboard).not.toContain(SITE_B)
    // Analytics may never be the wider of the two.
    for (const id of analyticsIds) expect(dashboard).toContain(id)
  })

  it('both give an unrestricted caller everything', async () => {
    const permissions = ['incidents.read.all']
    const c = ctx(permissions, { isSuperAdmin: true })
    // The fixture must not matter: an unrestricted caller short-circuits.
    const dashboard = dashboardReaches(await dashboardWhere(c, assignedAt(SITE_A)))
    const analytics = analyticsReaches(
      analyticsSubject({
        permissions: (k) => permissions.includes(k),
        isSuperAdmin: true,
        scope: { kind: 'unrestricted' },
      }),
    )

    expect(dashboard, 'the dashboard adds no predicate for an unrestricted caller').toEqual([])
    expect(analytics).toBe('unfiltered')
  })

  it('both refuse a caller with no placement', async () => {
    const permissions = ['incidents.read.all']
    const c = ctx(permissions, { personId: READER, scopes: [] })

    const dashboard = dashboardReaches(await dashboardWhere(c, assignedNowhere()))
    const analytics = analyticsReaches(
      analyticsSubject({
        permissions: (k) => permissions.includes(k),
        scope: { kind: 'empty', reason: 'no_assignment' },
      }),
    )

    expect(dashboard, 'the dashboard predicate is terminal').toEqual([])
    expect(analytics, 'analytics withholds the entity').toBe('withheld')
  })

  it('both refuse an UNRESOLVED scope rather than treating it as company-wide', () => {
    // The trap 15B-3D exists to prevent. The analytics half is the one that
    // changed: an absent scope is `unknown`, which withholds.
    const analytics = analyticsReaches(
      analyticsSubject({ permissions: (k) => k === 'incidents.read.all', scope: undefined }),
    )
    expect(analytics).toBe('withheld')
  })

  it('analytics never reaches a site the dashboard does not, at any tier', async () => {
    // A sweep rather than named cases. For every tier, the set analytics admits
    // must be a SUBSET of what the dashboard admits. A superset is precisely the
    // leak 15B-3B removes.
    //
    // The Project Scope handed to analytics is the RESOLVER'S output, which comes
    // from the caller's personnel placement alone. The `{type:'sites'}` scope is
    // varied independently below, so this also proves the two vocabularies stay
    // independent: widening the legacy scope does not widen Project Scope.
    for (const key of ['incidents.read.all', 'incidents.read.site', 'incidents.read.self']) {
      for (const legacySites of [[SITE_A], [SITE_A, SITE_B], []]) {
        const c = ctx([key], {
          personId: READER,
          scopes: [{ type: 'sites', siteIds: legacySites }],
        })
        const dashboard = dashboardReaches(await dashboardWhere(c, assignedAt(SITE_A)))
        const analytics = analyticsReaches(
          analyticsSubject({
            permissions: (k) => k === key,
            siteIds: legacySites,
            // Placed at Site A, whatever the legacy scope says.
            scope: atSites([SITE_A]),
          }),
        )
        const admitted = analytics === 'withheld' || analytics === 'unfiltered' ? [] : analytics
        expect(analytics, `${key} over ${legacySites.length} legacy site(s)`).not.toBe('unfiltered')
        for (const id of admitted) {
          expect(dashboard, `${key} over ${legacySites.length} legacy site(s)`).toContain(id)
        }
      }
    }
  })

  it('a scoped analytics caller is never "unfiltered"', () => {
    // The single most important assertion in this file: this is the exact value
    // the old `tier === 'all'` branch produced.
    for (const orgUnits of [[SITE_A], [SITE_A, SITE_B]]) {
      const reached = analyticsReaches(
        analyticsSubject({
          permissions: (k) => k === 'incidents.read.all',
          scope: atSites(orgUnits),
        }),
      )
      expect(reached, orgUnits.join(',')).not.toBe('unfiltered')
    }
  })
})
