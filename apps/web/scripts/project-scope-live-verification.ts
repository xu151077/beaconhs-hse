// Project Scope — live verification against the REPAIRED development database.
//
// The unit suites in `authorization-bridge-contract.test.ts` prove the semantics
// against an in-memory fixture. This proves the same semantics against the rows
// that actually exist, which is the only way to know the repair landed and that
// a real foreman resolves the way the contract says.
//
//   cd apps/web && set -a && . ../../.env && set +a
//   pnpm exec tsx scripts/project-scope-live-verification.ts
//
// READ-ONLY. The only writes are inside a transaction that is deliberately
// rolled back, used solely for the expired/future/deleted cases that need
// synthetic validity windows. Nothing in the development fixture is modified.

import { and, eq } from 'drizzle-orm'
import { createSuperClient, withSuperAdmin } from '@beaconhs/db'
import {
  orgUnits,
  people,
  peopleAssignments,
  roleAssignments,
  roles,
  tenantUsers,
  tenants,
} from '@beaconhs/db/schema'
import { resolveProjectScope, resolveProjectScopeIn } from '../src/lib/project-scope'
import { canSeeRecord } from '../src/lib/visibility'
import type { RequestContext } from '@beaconhs/tenant'
import type { RoleScope } from '@beaconhs/db/schema'

const { db } = createSuperClient()
const ROLLBACK = Symbol('rollback')
const LAST_YEAR = '2020-01-01'
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10)

let failures = 0
function check(id: string, name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name.padEnd(52)} ${detail}`)
}

function ctx(over: {
  tenantId: string
  userId: string
  personId: string | null
  permissions?: string[]
  scopes?: RoleScope[]
  isSuperAdmin?: boolean
}): RequestContext {
  return {
    userId: over.userId,
    tenantId: over.tenantId,
    isSuperAdmin: over.isSuperAdmin ?? false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'live', displayName: 'Live' },
    personId: over.personId,
    permissions: new Set(over.permissions ?? ['x.read.all']),
    scopes: over.scopes ?? [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn(db)) as RequestContext['db'],
  } as RequestContext
}

async function main() {
  const [tenant] = await db.select({ id: tenants.id, name: tenants.name }).from(tenants).limit(1)
  if (!tenant) throw new Error('no tenant')
  console.log(`\nTenant: ${tenant.name}\n`)

  const sites = await db
    .select({ id: orgUnits.id, name: orgUnits.name })
    .from(orgUnits)
    .where(and(eq(orgUnits.tenantId, tenant.id), eq(orgUnits.level, 'site')))
  const siteA = sites.find((s) => s.name.includes('Site A'))
  const siteB = sites.find((s) => s.name.includes('Site B'))
  if (!siteA || !siteB) throw new Error('seeded sites not found')

  // Real person + scope for each verification foreman.
  const foremanRows = await db
    .select({
      userId: people.userId,
      personId: people.id,
      employeeNo: people.employeeNo,
      firstName: people.firstName,
      lastName: people.lastName,
    })
    .from(people)
    .where(eq(people.tenantId, tenant.id))
  const byUser = new Map(foremanRows.filter((p) => p.userId).map((p) => [p.userId!, p]))

  // The foreman's role scope, read straight out of role_assignments.
  const foremanScopes = await db
    .select({ userId: tenantUsers.userId, key: roles.key, scope: roleAssignments.scope })
    .from(tenantUsers)
    .innerJoin(roleAssignments, eq(roleAssignments.tenantUserId, tenantUsers.id))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(eq(tenantUsers.tenantId, tenant.id))

  const foremanA = byUser.get('verif-foreman-a')
  const foremanB = byUser.get('verif-foreman-b')
  if (!foremanA || !foremanB) {
    throw new Error('foreman person records missing — run the personnel placement repair')
  }

  const scopeOf = (userId: string) =>
    foremanScopes.filter((s) => s.userId === userId).map((s) => s.scope as RoleScope)

  const ctxA = ctx({
    tenantId: tenant.id,
    userId: 'verif-foreman-a',
    personId: foremanA.personId,
    scopes: scopeOf('verif-foreman-a'),
  })
  const ctxB = ctx({
    tenantId: tenant.id,
    userId: 'verif-foreman-b',
    personId: foremanB.personId,
    scopes: scopeOf('verif-foreman-b'),
  })

  console.log('--- A/B: each foreman resolves to exactly its own site ---')
  const scopeA = await resolveProjectScope(ctxA, db)
  const scopeB = await resolveProjectScope(ctxB, db)
  const orgsA =
    scopeA.kind === 'unrestricted' ? [] : 'orgUnitIds' in scopeA ? scopeA.orgUnitIds : []
  const orgsB =
    scopeB.kind === 'unrestricted' ? [] : 'orgUnitIds' in scopeB ? scopeB.orgUnitIds : []
  check(
    'A',
    'verif-foreman-a resolves to Site A',
    orgsA.includes(siteA.id) && !orgsA.includes(siteB.id),
    orgsA.join(','),
  )
  check(
    'B',
    'verif-foreman-b resolves to Site B',
    orgsB.includes(siteB.id) && !orgsB.includes(siteA.id),
    orgsB.join(','),
  )

  console.log('\n--- C/D: neither can see the other site ---')
  check(
    'C',
    'foreman A cannot see a Site B record',
    (await canSeeRecord(ctxA, db, { prefix: 'x', siteId: siteB.id })) === false,
  )
  check(
    'D',
    'foreman B cannot see a Site A record',
    (await canSeeRecord(ctxB, db, { prefix: 'x', siteId: siteA.id })) === false,
  )
  check(
    'C+',
    'foreman A can see a Site A record',
    (await canSeeRecord(ctxA, db, { prefix: 'x', siteId: siteA.id })) === true,
  )

  console.log('\n--- E: {type:"sites"} scope present, and it granted nothing on its own ---')
  const aScope = scopeOf('verif-foreman-a')[0]
  check(
    'E1',
    'foreman A really does hold a {type:"sites"} scope',
    aScope?.type === 'sites' && aScope.siteIds.includes(siteA.id),
    JSON.stringify(aScope),
  )
  check(
    'E2',
    'a scope naming only A does not let A reach B',
    (await canSeeRecord(ctxA, db, { prefix: 'x', siteId: siteB.id })) === false,
  )
  const spoofCtx = ctx({
    tenantId: tenant.id,
    userId: 'verif-foreman-a',
    personId: foremanA.personId,
    scopes: [{ type: 'sites', siteIds: [siteB.id] }],
  })
  check(
    'E3',
    'a scope naming B is ignored — placement at A still wins',
    (await canSeeRecord(spoofCtx, db, { prefix: 'x', siteId: siteB.id })) === false,
  )

  console.log('\n--- F: a person with no assignment resolves empty ---')
  // "Unplaced" must mean no `people_assignments` row at all — not merely no
  // user link, because every field worker has a placement but no login.
  const placedIds = new Set(
    (
      await db
        .select({ personId: peopleAssignments.personId })
        .from(peopleAssignments)
        .where(eq(peopleAssignments.tenantId, tenant.id))
    ).map((r) => r.personId),
  )
  const unplaced = foremanRows.find((p) => !placedIds.has(p.personId))
  const unplacedCtx = ctx({
    tenantId: tenant.id,
    userId: 'unplaced-probe',
    personId: unplaced?.personId ?? null,
  })
  const unplacedScope = await resolveProjectScope(unplacedCtx, db)
  check(
    'F',
    'unplaced person -> empty',
    unplacedScope.kind === 'empty',
    `${unplaced?.employeeNo ?? 'n/a'}: ${unplacedScope.kind}/${'reason' in unplacedScope ? unplacedScope.reason : ''}`,
  )

  console.log('\n--- G: expired / future / deleted-org-unit all fail closed ---')
  await db
    .transaction(async () => {
      // `withSuperAdmin` hands its callback a value already typed `Database` —
      // it does the `tx as unknown as Database` cast itself, which is how the
      // whole project treats transaction handles (see `packages/db/src/rls.ts`).
      // Going through it instead of calling `db.transaction()` raw means no local
      // cast is needed here, and the query runs on the BYPASSRLS pool exactly as
      // a cross-tenant read should.
      return withSuperAdmin(db, async (txDb) => {
        const probe = foremanA.personId
        const cases: [string, { validFrom: string; validTo: string | null }, string][] = [
          ['G1 expired', { validFrom: LAST_YEAR, validTo: YESTERDAY }, 'expired_assignment'],
          ['G2 future', { validFrom: TOMORROW, validTo: null }, 'no_assignment'],
        ]
        for (const [name, window, expected] of cases) {
          await txDb.delete(peopleAssignments).where(eq(peopleAssignments.personId, probe))
          await txDb.insert(peopleAssignments).values({
            tenantId: tenant.id,
            personId: probe,
            orgUnitId: siteA.id,
            validFrom: window.validFrom,
            validTo: window.validTo,
          })
          const s = await resolveProjectScopeIn(ctxA, txDb)
          check(
            name,
            `-> ${expected}`,
            s.kind === 'empty' && s.reason === expected,
            s.kind === 'empty' ? s.reason : s.kind,
          )
        }

        // An assignment to a soft-deleted org unit must contribute nothing.
        const ghost = '00000000-0000-4000-8000-00000000dead'
        await txDb.insert(orgUnits).values({
          id: ghost,
          tenantId: tenant.id,
          name: 'Decommissioned Pad',
          level: 'site',
          deletedAt: new Date(),
        })
        await txDb.delete(peopleAssignments).where(eq(peopleAssignments.personId, probe))
        await txDb.insert(peopleAssignments).values({
          tenantId: tenant.id,
          personId: probe,
          orgUnitId: ghost,
          validFrom: LAST_YEAR,
          validTo: null,
        })
        const s = await resolveProjectScopeIn(ctxA, txDb)
        check(
          'G3 soft-deleted org unit',
          '-> missing_org_unit',
          s.kind === 'empty' && s.reason === 'missing_org_unit',
          s.kind === 'empty' ? s.reason : s.kind,
        )
      })
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e
    })

  console.log('\n--- H/I/J: scope variants and role names ---')
  const tenantWide = ctx({
    tenantId: tenant.id,
    userId: 'probe-tenant-wide',
    personId: null,
    scopes: [{ type: 'tenant' }],
  })
  check(
    'H',
    'explicit {type:"tenant"} -> unrestricted',
    (await resolveProjectScope(tenantWide, db)).kind === 'unrestricted',
  )

  const siteOnly = ctx({
    tenantId: tenant.id,
    userId: 'probe-site-scope',
    personId: foremanA.personId,
    scopes: [{ type: 'sites', siteIds: [siteA.id] }],
  })
  check(
    'I',
    '{type:"sites"} is not upgraded to unrestricted',
    (await resolveProjectScope(siteOnly, db)).kind !== 'unrestricted',
  )
  check(
    'I+',
    'and it cannot reach B without a placement there',
    (await canSeeRecord(siteOnly, db, { prefix: 'x', siteId: siteB.id })) === false,
  )

  const named = { ...ctxA, activeRoleId: 'tenant_admin' } as RequestContext
  const namedScope = await resolveProjectScope(named, db)
  check(
    'J',
    'a role NAMED tenant_admin with no tenant scope is NOT unrestricted',
    namedScope.kind !== 'unrestricted',
    namedScope.kind,
  )
  const noPlace = ctx({
    tenantId: tenant.id,
    userId: 'probe',
    personId: unplaced?.personId ?? null,
    permissions: ['*'],
  })
  const noPlaceNamed = { ...noPlace, activeRoleId: 'tenant_admin' } as RequestContext
  const namedEmpty = await resolveProjectScope(noPlaceNamed, db)
  check(
    'J+',
    'role name + full catalogue, no placement -> still empty',
    namedEmpty.kind === 'empty',
    namedEmpty.kind === 'empty' ? namedEmpty.reason : namedEmpty.kind,
  )
  check(
    'J++',
    'and it cannot see an in-tree site record',
    (await canSeeRecord(noPlaceNamed, db, { prefix: 'x', siteId: siteA.id })) === false,
  )

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
