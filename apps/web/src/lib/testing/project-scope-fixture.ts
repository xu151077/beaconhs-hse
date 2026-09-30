// Test fixture for the Project Scope bridge.
//
// Since 15B-2 the visibility ladder resolves a real Project Scope, so any test
// that calls `moduleScopeWhere` / `canSeeRecord` / `recordVisibilityWhere` must
// supply a transaction that can answer the resolver's queries. The web vitest
// project has no database, so this module supplies a small in-memory stand-in.
//
// It is TEST-ONLY. Nothing in `src` outside a test imports it, and a contract
// test asserts that.
//
// Two ways to use it:
//
//   // 1. Company-wide. The resolver short-circuits on `{type:'tenant'}` BEFORE
//   //    any query, so tier assertions behave exactly as they did before 15B-2 —
//   //    this is what proves 15B-2 changed nothing for a tenant-wide caller.
//   ctx: scopeTestContext(['x.read.all'], [{ type: 'tenant' }])
//
//   // 2. Project-scoped. The fake transaction answers the resolver's queries with
//   //    a fixed org tree and assignment set.
//   ctx: scopeTestContext(['x.read.all'])
//   tx:  projectScopeTx()

import { orgUnits, people, peopleAssignments } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'

/** Valid, obviously-fake UUIDs so the values survive any UUID parsing. */
const FIXTURE = {
  projectA: '0a000000-0000-4000-8000-000000000001',
  projectB: '0b000000-0000-4000-8000-000000000002',
  siteA1: '0a000000-0000-4000-8000-000000000011',
  siteA2: '0a000000-0000-4000-8000-000000000012',
  siteB1: '0b000000-0000-4000-8000-000000000021',
  // `'person_1'` matches the convention the pre-existing tier suites already use
  // for `ctx.personId`, so a record they build as "my own" is genuinely in scope.
  callerPerson: 'person_1',
  peerPersonA: '0c000000-0000-4000-8000-0000000000c2',
  peerPersonB: '0c000000-0000-4000-8000-0000000000c3',
  // The ad-hoc site ids used by the pre-existing tier contract suites, so a
  // site-scoped context there still resolves against a real org unit.
  legacySite1: 'site_1',
  legacySite2: 'site_2',
  legacySiteA: '00000000-0000-4000-8000-00000000a001',
  legacySiteB: '00000000-0000-4000-8000-00000000b001',
} as const

type OrgRow = { id: string; parentId: string | null; level: string; deletedAt: Date | null }

type ProjectScopeFixture = {
  /**
   * Whether the account has a `people` row. `'none'` models a tenant user with no
   * employee record, which is the shape a foreman actually has in the runtime
   * fixture and the case the PPE fail-open suite pins.
   */
  employeeRecord?: 'present' | 'none'
  /** The caller's effective assignments. */
  assignments?: { personId: string; orgUnitId: string; validFrom: string; validTo: string | null }[]
  /** The tenant's org tree. */
  orgs?: OrgRow[]
}

/**
 * The default fixture: the caller is assigned to site A1 under project A, a peer
 * shares that site, and a second peer sits on site B1 under project B. Project B
 * therefore exists in the tree but is NOT in the caller's scope — which is what
 * lets a test prove project A cannot see project B.
 */
function defaultProjectScopeFixture(): Required<ProjectScopeFixture> {
  return {
    employeeRecord: 'present',
    assignments: [
      // The caller is assigned to `legacySite1` (under project A) so the
      // pre-existing tier suites, which reason in terms of `site_1` / `site_2`,
      // keep their intent: site_1 visible, site_2 not. Dedicated 15B-2 tests
      // pass their own fixture when they need projectA / projectB by name.
      {
        personId: FIXTURE.callerPerson,
        orgUnitId: FIXTURE.legacySite1,
        validFrom: '2020-01-01',
        validTo: null,
      },
      {
        personId: FIXTURE.peerPersonA,
        orgUnitId: FIXTURE.siteA1,
        validFrom: '2020-01-01',
        validTo: null,
      },
      {
        personId: FIXTURE.peerPersonB,
        orgUnitId: FIXTURE.siteB1,
        validFrom: '2020-01-01',
        validTo: null,
      },
    ],
    orgs: [
      { id: FIXTURE.projectA, parentId: null, level: 'project', deletedAt: null },
      { id: FIXTURE.projectB, parentId: null, level: 'project', deletedAt: null },
      { id: FIXTURE.siteA1, parentId: FIXTURE.projectA, level: 'site', deletedAt: null },
      { id: FIXTURE.siteA2, parentId: FIXTURE.projectA, level: 'site', deletedAt: null },
      { id: FIXTURE.siteB1, parentId: FIXTURE.projectB, level: 'site', deletedAt: null },
      { id: FIXTURE.legacySite1, parentId: FIXTURE.projectA, level: 'site', deletedAt: null },
      { id: FIXTURE.legacySite2, parentId: FIXTURE.projectB, level: 'site', deletedAt: null },
      { id: FIXTURE.legacySiteA, parentId: FIXTURE.projectA, level: 'site', deletedAt: null },
      { id: FIXTURE.legacySiteB, parentId: FIXTURE.projectB, level: 'site', deletedAt: null },
    ],
  }
}

type AssignmentRow = {
  id: string
  personId: string
  orgUnitId: string
  validFrom: string
  validTo: string | null
}

/**
 * A transaction answering exactly the queries `resolveProjectScopeIn` issues: the
 * caller's person row, their assignments, the tenant's org units, and the peer
 * assignments. An unrecognised table throws, so a new query in the resolver fails
 * loudly here instead of silently resolving to an empty scope.
 */
export function projectScopeTx(fixture: ProjectScopeFixture = {}): Database {
  const f: Required<ProjectScopeFixture> = { ...defaultProjectScopeFixture(), ...fixture }
  const rows: AssignmentRow[] = f.assignments.map((a, i) => ({
    id: `assignment_${i}`,
    personId: a.personId,
    orgUnitId: a.orgUnitId,
    validFrom: a.validFrom,
    validTo: a.validTo,
  }))

  // One builder, two entry points: the resolver calls `tx.select(...)` for most
  // queries and `tx.selectDistinct(...)` directly on the transaction for the peer
  // lookup, so both must exist.
  const builder = (distinct: boolean) => {
    let table: unknown = null
    const q: Record<string, unknown> = {}
    q.from = (t: unknown) => {
      table = t
      return q
    }
    q.selectDistinct = () => builder(true)
    q.where = () => q
    q.orderBy = () => q
    q.limit = () => q
    q.then = (onOk: (rows: unknown[]) => unknown, onErr?: (e: unknown) => unknown) => {
      let result: unknown[]
      if (table === people) {
        result = f.employeeRecord === 'none' ? [] : [{ id: FIXTURE.callerPerson }]
      } else if (table === orgUnits) {
        result = f.orgs
      } else if (table === peopleAssignments) {
        result = distinct
          ? rows.map((r) => ({ personId: r.personId, orgUnitId: r.orgUnitId }))
          : rows
      } else {
        const error = new Error(`projectScopeTx: unexpected table ${String(table)}`)
        return onErr ? Promise.resolve(onErr(error)) : Promise.reject(error)
      }
      return Promise.resolve(result).then(onOk)
    }
    return q
  }

  return {
    select: () => builder(false),
    selectDistinct: () => builder(true),
  } as unknown as Database
}
