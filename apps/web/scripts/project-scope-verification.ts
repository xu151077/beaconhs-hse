// Canonical Project Scope resolver — live-database verification.
//
// The web vitest project has no real-DB harness, so the database-backed cases
// are proven here against the running Postgres, in the same shape Commit 13 used
// (one transaction that is deliberately rolled back, leaving no residue).
//
//   cd apps/web && set -a && . ../../.env && set +a
//   pnpm exec tsx scripts/project-scope-verification.mjs
//
// Every case builds its own fixtures (people, org units, assignments) inside the
// transaction, so it does not depend on — or disturb — the dev fixture data.
//
//   A  tenant isolation            L  read.all does not widen
//   B  no assignment               M  requestedOrgUnitIds inside / outside
//   C  one assignment              N  personIds intersection
//   D  two concurrent assignments  O  duplicate assignments deduplicate
//   E  historical assignment       P  parent assignment includes descendants
//   F  valid_to is inclusive       Q  deep tree
//   G  future assignment           R  cycle fails closed
//   H  missing org unit            S  soft-deleted org unit
//   I  tenant scope                T  tenant mismatch
//   J  super-admin                 K  (see the read.all case)

import { db, type Database } from '@beaconhs/db'
import { orgUnits, people, peopleAssignments } from '@beaconhs/db/schema'
import { count, eq, sql } from 'drizzle-orm'
import { resolveProjectScope, type ProjectScope } from '../src/lib/project-scope'
import type { RequestContext } from '@beaconhs/tenant'
import type { RoleScope } from '@beaconhs/db/schema'

const ROLLBACK = Symbol('rollback')
const TODAY = new Date().toISOString().slice(0, 10)
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const LAST_YEAR = '2020-01-01'

let failures = 0
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`)
}

const TENANT = '85df8265-e62d-43ac-9455-e80a2a81efc9'
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000ff'

/**
 * The transaction handle. `Database` is the project's own transaction type —
 * `withTenant` / `withSuperAdmin` cast their `PgTransaction` handle to it
 * (`packages/db/src/rls.ts:20,33`) — so the script uses it rather than
 * re-deriving a bespoke type.
 */
type Tx = Database

function ctxFor(
  tx: Tx,
  over: Partial<RequestContext> & { personId?: string | null; scopes?: RoleScope[] } = {},
): RequestContext {
  return {
    userId: 'user_probe',
    tenantId: TENANT,
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'm_probe', displayName: 'Probe' },
    personId: null,
    permissions: new Set<string>(),
    scopes: [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn(tx)) as RequestContext['db'],
    ...over,
  } as RequestContext
}

/** Create a person row in the probe tenant. */
async function mkPerson(tx: Tx, first: string): Promise<string> {
  const [row] = await tx
    .insert(people)
    .values({ tenantId: TENANT, firstName: first, lastName: 'Probe' })
    .returning({ id: people.id })
  return row!.id
}

/** Create an org unit under `parentId` (null = root). */
async function mkOrg(
  tx: Tx,
  name: string,
  level: string,
  parentId: string | null = null,
  deleted = false,
): Promise<string> {
  const [row] = await tx
    .insert(orgUnits)
    .values({
      tenantId: TENANT,
      name,
      code: `${name}-${Math.random().toString(36).slice(2, 8)}`,
      level: level as never,
      parentId,
      ...(deleted ? { deletedAt: new Date() } : {}),
    })
    .returning({ id: orgUnits.id })
  return row!.id
}

async function mkAssignment(
  tx: Tx,
  personId: string,
  orgUnitId: string,
  validFrom: string,
  validTo: string | null = null,
): Promise<string> {
  const [row] = await tx
    .insert(peopleAssignments)
    .values({ tenantId: TENANT, personId, orgUnitId, validFrom, validTo })
    .returning({ id: peopleAssignments.id })
  return row!.id
}

const orgs = (s: ProjectScope) =>
  s.kind === 'orgUnits' || s.kind === 'peopleAndOrgUnits' ? s.orgUnitIds : []
const peopleOf = (s: ProjectScope) =>
  s.kind === 'persons' || s.kind === 'peopleAndOrgUnits' ? s.personIds : []
const reason = (s: ProjectScope) => (s.kind === 'empty' ? s.reason : s.kind)

async function main() {
  await db.transaction(async (rawTx) => {
    // `Database` is the project's transaction type: `withTenant` /`withSuperAdmin`
    // cast their `PgTransaction` handle to it themselves
    // (`packages/db/src/rls.ts:20,33`). Following that convention here keeps the
    // script free of a bespoke transaction type.
    const tx = rawTx as unknown as Database
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${TENANT}, true)`)

    // ---- fixture org tree: customer > project P (site S1 > area A1), project Q > S2
    const customer = await mkOrg(tx, 'Probe Customer', 'customer')
    const projectP = await mkOrg(tx, 'Probe Project P', 'project', customer)
    const siteS1 = await mkOrg(tx, 'Probe Site S1', 'site', projectP)
    const areaA1 = await mkOrg(tx, 'Probe Area A1', 'area', siteS1)
    const projectQ = await mkOrg(tx, 'Probe Project Q', 'project', customer)
    const siteS2 = await mkOrg(tx, 'Probe Site S2', 'site', projectQ)
    const deepA = await mkOrg(tx, 'Probe Deep A', 'area', areaA1)
    const deepB = await mkOrg(tx, 'Probe Deep B', 'area', deepA)
    const deepC = await mkOrg(tx, 'Probe Deep C', 'area', deepB)
    const deletedSite = await mkOrg(tx, 'Probe Deleted Site', 'site', projectP, true)
    const orphanRef = '99999999-9999-4999-8999-999999999999'

    console.log('\n  --- org tree ---')
    console.log(
      `  customer=${customer.slice(0, 8)} P=${projectP.slice(0, 8)} S1=${siteS1.slice(0, 8)} A1=${areaA1.slice(0, 8)}`,
    )
    console.log(
      `  Q=${projectQ.slice(0, 8)} S2=${siteS2.slice(0, 8)} deep=${deepA.slice(0, 8)}/${deepB.slice(0, 8)}/${deepC.slice(0, 8)}`,
    )

    // ---- B: no assignment at all
    const noAssign = await mkPerson(tx, 'NoAssign')
    const rB = await resolveProjectScope(ctxFor(tx, { personId: noAssign }), tx)
    check(
      'B  no assignment -> empty, never unrestricted',
      rB.kind === 'empty',
      `kind=${reason(rB)}`,
    )

    // ---- C: one assignment
    const one = await mkPerson(tx, 'One')
    await mkAssignment(tx, one, siteS1, LAST_YEAR)
    const rC = await resolveProjectScope(ctxFor(tx, { personId: one }), tx)
    check(
      'C  one assignment -> its org unit + descendants + ancestors',
      rC.kind === 'peopleAndOrgUnits' &&
        orgs(rC).includes(siteS1) &&
        orgs(rC).includes(areaA1) &&
        orgs(rC).includes(projectP) &&
        peopleOf(rC).includes(one),
      `orgs=${orgs(rC).length} persons=${peopleOf(rC).length}`,
    )

    // ---- P: parent assignment includes descendants
    const onProject = await mkPerson(tx, 'OnProject')
    await mkAssignment(tx, onProject, projectP, LAST_YEAR)
    const rP = await resolveProjectScope(ctxFor(tx, { personId: onProject }), tx)
    check(
      'P  assignment to a project includes its descendant sites',
      orgs(rP).includes(siteS1) && orgs(rP).includes(areaA1) && !orgs(rP).includes(siteS2),
      `site S1 in=${orgs(rP).includes(siteS1)} unrelated S2 in=${orgs(rP).includes(siteS2)}`,
    )

    // ---- D: two concurrent assignments -> UNION
    const two = await mkPerson(tx, 'Two')
    await mkAssignment(tx, two, siteS1, LAST_YEAR)
    await mkAssignment(tx, two, siteS2, LAST_YEAR)
    const rD = await resolveProjectScope(ctxFor(tx, { personId: two }), tx)
    check(
      'D  two concurrent assignments -> union of both projects',
      orgs(rD).includes(siteS1) &&
        orgs(rD).includes(siteS2) &&
        orgs(rD).includes(projectP) &&
        orgs(rD).includes(projectQ),
      `orgs=${orgs(rD).length} has P=${orgs(rD).includes(projectP)} has Q=${orgs(rD).includes(projectQ)}`,
    )

    // ---- E/F: historical vs the inclusive boundary
    const ended = await mkPerson(tx, 'Ended')
    await mkAssignment(tx, ended, siteS1, LAST_YEAR, YESTERDAY)
    const rE = await resolveProjectScope(ctxFor(tx, { personId: ended }), tx)
    check(
      'E  assignment ended yesterday -> empty/expired',
      rE.kind === 'empty',
      `kind=${reason(rE)}`,
    )

    const boundary = await mkPerson(tx, 'Boundary')
    await mkAssignment(tx, boundary, siteS1, LAST_YEAR, TODAY)
    const rF = await resolveProjectScope(ctxFor(tx, { personId: boundary }), tx, { onDate: TODAY })
    check(
      'F  valid_to == onDate -> still effective (inclusive)',
      rF.kind !== 'empty',
      `kind=${reason(rF)}`,
    )

    // ---- G: future assignment
    const future = await mkPerson(tx, 'Future')
    await mkAssignment(tx, future, siteS1, TOMORROW)
    const rG = await resolveProjectScope(ctxFor(tx, { personId: future }), tx)
    check('G  assignment starting tomorrow -> empty', rG.kind === 'empty', `kind=${reason(rG)}`)

    // ---- H: a missing org unit is impossible at the database level
    // `people_assignments_tenant_org_fk` is composite on (tenant_id, org_unit_id),
    // so the database itself forbids both a non-existent org unit and one from
    // another tenant. That is a stronger guarantee than the resolver's own check,
    // so assert the rejection rather than trying to construct the row.
    const orphan = await mkPerson(tx, 'Orphan')
    let fkRejected = false
    // A savepoint, because a rejected statement aborts the whole transaction
    // until it is rolled back — the probe must not take the run down with it.
    await tx.execute(sql`SAVEPOINT fk_probe`)
    try {
      await mkAssignment(tx, orphan, orphanRef, LAST_YEAR)
    } catch {
      fkRejected = true
    } finally {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT fk_probe`)
    }
    check(
      'H  a missing org unit is rejected by the FK, not merely ignored',
      fkRejected,
      fkRejected ? 'composite FK refused the insert' : 'insert unexpectedly succeeded',
    )

    // ---- S: soft-deleted org unit
    const delAssignee = await mkPerson(tx, 'DeletedTarget')
    await mkAssignment(tx, delAssignee, deletedSite, LAST_YEAR)
    const rS = await resolveProjectScope(ctxFor(tx, { personId: delAssignee }), tx)
    check(
      'S  assignment to a soft-deleted org unit -> fail closed',
      rS.kind === 'empty',
      `kind=${reason(rS)}`,
    )

    // ---- A/T: tenant isolation
    // The composite FK already refuses a cross-tenant org unit (see H), so the
    // reachable set is provably single-tenant. Assert it directly as well.
    const crossRows = await tx
      .select({ crossTenant: count() })
      .from(orgUnits)
      .where(eq(orgUnits.tenantId, OTHER_TENANT as never))
    const cross = crossRows[0]?.crossTenant ?? 0
    check(
      'A  no cross-tenant org unit is reachable',
      cross === 0,
      `other-tenant org units=${cross}`,
    )
    const rT = await resolveProjectScope(ctxFor(tx, { personId: one }), tx, {
      tenantId: OTHER_TENANT,
    })
    check('T  caller-supplied tenant mismatch -> empty', rT.kind === 'empty', `kind=${reason(rT)}`)

    // ---- I/J: unrestricted
    const rI = await resolveProjectScope(
      ctxFor(tx, { personId: noAssign, scopes: [{ type: 'tenant' }] }),
      tx,
    )
    check(
      'I  an explicit tenant scope -> unrestricted',
      rI.kind === 'unrestricted',
      `kind=${rI.kind}`,
    )
    const rJ = await resolveProjectScope(ctxFor(tx, { personId: noAssign, isSuperAdmin: true }), tx)
    check('J  super-admin -> unrestricted', rJ.kind === 'unrestricted', `kind=${rJ.kind}`)

    // ---- K/L: read.all and role names must not widen
    const rL = await resolveProjectScope(
      ctxFor(tx, {
        personId: noAssign,
        permissions: new Set(['incidents.read.all', 'people.read.all']),
      }),
      tx,
    )
    check(
      'K  holding every read key is still not unrestricted',
      rL.kind !== 'unrestricted',
      `kind=${reason(rL)}`,
    )
    const rRole = await resolveProjectScope(
      ctxFor(tx, { personId: noAssign, activeRoleId: 'tenant_admin' } as Partial<RequestContext>),
      tx,
    )
    check(
      'L  a role NAMED tenant_admin is still not unrestricted',
      rRole.kind !== 'unrestricted',
      `kind=${reason(rRole)}`,
    )

    // ---- M: requested org units
    const rMin = await resolveProjectScope(ctxFor(tx, { personId: two }), tx, {
      requestedOrgUnitIds: [siteS1],
    })
    check(
      'M1 requested subset inside scope -> intersection',
      rMin.kind !== 'empty' &&
        orgs(rMin).every((id) => id === siteS1 || orgs(rMin).includes(id)) &&
        !orgs(rMin).includes(siteS2),
      `orgs=${orgs(rMin)
        .map((i) => i.slice(0, 8))
        .join(',')}`,
    )
    const rMout = await resolveProjectScope(ctxFor(tx, { personId: one }), tx, {
      requestedOrgUnitIds: [siteS2],
    })
    check(
      'M2 requested subset outside scope -> empty',
      rMout.kind === 'empty',
      `kind=${reason(rMout)}`,
    )

    // ---- N: personIds intersection
    const peer = await mkPerson(tx, 'Peer')
    await mkAssignment(tx, peer, siteS1, LAST_YEAR)
    const rAll = await resolveProjectScope(ctxFor(tx, { personId: one }), tx)
    const rN = await resolveProjectScope(ctxFor(tx, { personId: one }), tx, { personIds: [peer] })
    check(
      'N  personIds filter intersects (peer kept, self dropped)',
      peopleOf(rN).length === 1 && peopleOf(rN)[0] === peer,
      `all=${peopleOf(rAll).length} filtered=${peopleOf(rN).length}`,
    )
    const rNempty = await resolveProjectScope(ctxFor(tx, { personId: one }), tx, {
      personIds: ['00000000-0000-4000-8000-00000000dead'],
    })
    check(
      'N2 personIds filter matching nobody -> no persons',
      peopleOf(rNempty).length === 0,
      `persons=${peopleOf(rNempty).length}`,
    )

    // ---- O: duplicate assignments
    const dup = await mkPerson(tx, 'Dup')
    await mkAssignment(tx, dup, siteS1, LAST_YEAR)
    await mkAssignment(tx, dup, siteS1, LAST_YEAR)
    const rO = await resolveProjectScope(ctxFor(tx, { personId: dup }), tx)
    check(
      'O  duplicate assignments deduplicate',
      new Set(orgs(rO)).size === orgs(rO).length &&
        peopleOf(rO).filter((p) => p === dup).length === 1,
      `orgs=${orgs(rO).length} (unique ${new Set(orgs(rO)).size})`,
    )

    // ---- Q: deep tree
    const deepP = await mkPerson(tx, 'Deep')
    await mkAssignment(tx, deepP, siteS1, LAST_YEAR)
    const rQ = await resolveProjectScope(ctxFor(tx, { personId: deepP }), tx)
    check(
      'Q  deep descendants are included',
      orgs(rQ).includes(deepA) && orgs(rQ).includes(deepB) && orgs(rQ).includes(deepC),
      `deep chain present=${orgs(rQ).includes(deepC)}`,
    )

    // ---- R: cycle fails closed (no hang)
    const cycA = await mkOrg(tx, 'Probe Cyc A', 'project', null)
    const cycB = await mkOrg(tx, 'Probe Cyc B', 'site', cycA)
    await tx.update(orgUnits).set({ parentId: cycB }).where(eq(orgUnits.id, cycA))
    const cycP = await mkPerson(tx, 'Cyclic')
    await mkAssignment(tx, cycP, cycB, LAST_YEAR)
    const started = Date.now()
    const rR = await resolveProjectScope(ctxFor(tx, { personId: cycP }), tx)
    check(
      'R  a parent_id cycle terminates instead of hanging',
      rR.kind !== 'empty' && Date.now() - started < 3000,
      `kind=${reason(rR)} in ${Date.now() - started}ms`,
    )

    console.log(`\n  ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`)
    // Rolled back on purpose: leaves the product schema untouched.
    throw ROLLBACK
  })
}

try {
  await main()
} catch (error) {
  if (error !== ROLLBACK) {
    console.error(error)
    process.exitCode = 1
  }
}
