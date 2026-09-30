// Personnel placement repair — additive, idempotent, transactional.
//
// WHY THIS IS A SEPARATE SCRIPT AND NOT A RE-SEED
// The seed already converges personnel placement (see `convergePersonnel-
// assignments.ts` and its call site in `packages/db/src/seed.ts`). This database
// was seeded before that existed, so its `people_assignments` table is empty and
// every non-tenant-wide caller resolves to `empty`. Re-running the whole seed
// would be far too destructive to a working development database, so this applies
// exactly the same convergence to the rows that are already here.
//
// WHAT IT IS ALLOWED TO DO — and nothing else:
//   · insert a missing employee record for a verification account
//   · fill a NULL `people.user_id` link
//   · insert a missing Site A / Site B `people_assignments` row
//
// WHAT IT MUST NEVER DO:
//   · UPDATE an existing person, assignment, or org unit
//   · DELETE anything, ever
//   · touch `role_assignments.scope` — access scope and personnel placement are
//     deliberately independent vocabularies
//
// It runs in ONE transaction. If anything throws, the whole repair rolls back and
// the database is exactly as it was. Running it twice inserts nothing the second
// time.
//
//   cd apps/web && set -a && . ../../.env && set +a
//   pnpm exec tsx scripts/personnel-placement-repair.ts

import { and, eq, inArray } from 'drizzle-orm'
import { createSuperClient, convergePersonnelAssignments } from '@beaconhs/db'
import {
  crews,
  departments,
  orgUnits,
  people,
  peopleAssignments,
  tenants,
  trades,
  users,
} from '@beaconhs/db/schema'

const { db } = createSuperClient()

/** The crew → site mapping, identical to the one `seed.ts` derives. */
const CREW_SITES: Record<string, 'A' | 'B'> = { 'Crew Alpha': 'A', 'Crew Bravo': 'B' }

async function main() {
  const allTenants = await db.select({ id: tenants.id, name: tenants.name }).from(tenants)
  if (allTenants.length === 0) throw new Error('no tenants — run `pnpm db:seed` first')

  for (const tenant of allTenants) {
    console.log(`\nTenant: ${tenant.name}`)

    await db.transaction(async (tx) => {
      // --- Locate the verification org units ------------------------------
      const sites = await tx
        .select({ id: orgUnits.id, name: orgUnits.name, level: orgUnits.level })
        .from(orgUnits)
        .where(and(eq(orgUnits.tenantId, tenant.id), eq(orgUnits.level, 'site')))
      if (sites.length < 2) {
        console.log('  SKIP  needs two seeded sites; found', sites.length)
        return
      }
      const siteByName = new Map(sites.map((s) => [s.name, s.id]))
      const siteA =
        siteByName.get('Site A — Tank Farm') ?? sites.find((s) => s.name.includes('Site A'))?.id
      const siteB =
        siteByName.get('Site B — Cracker Unit') ?? sites.find((s) => s.name.includes('Site B'))?.id
      if (!siteA || !siteB) {
        console.log('  SKIP  could not identify Site A / Site B by name')
        return
      }
      console.log(`  sites: A=${siteA} B=${siteB}`)

      // --- The roster, placed by crew -------------------------------------
      const tenantCrews = await tx
        .select({ id: crews.id, name: crews.name })
        .from(crews)
        .where(eq(crews.tenantId, tenant.id))
      const siteForCrew = new Map<string, string>()
      for (const c of tenantCrews) {
        const which = CREW_SITES[c.name]
        if (which === 'A') siteForCrew.set(c.id, siteA)
        else if (which === 'B') siteForCrew.set(c.id, siteB)
      }

      const roster = await tx
        .select({
          id: people.id,
          employeeNo: people.employeeNo,
          crewId: people.crewId,
          firstName: people.firstName,
          lastName: people.lastName,
        })
        .from(people)
        .where(eq(people.tenantId, tenant.id))
      const supervisorTradeId = (
        await tx
          .select({ id: trades.id })
          .from(trades)
          .where(and(eq(trades.tenantId, tenant.id), eq(trades.name, 'Supervisor')))
          .limit(1)
      )[0]?.id
      const fieldOpsId =
        (
          await tx
            .select({ id: departments.id })
            .from(departments)
            .where(
              and(eq(departments.tenantId, tenant.id), eq(departments.name, 'Field Operations')),
            )
            .limit(1)
        )[0]?.id ?? null

      const rosterPlacements = roster
        .map((p) => {
          const orgUnitId = p.crewId ? siteForCrew.get(p.crewId) : undefined
          return orgUnitId && p.employeeNo ? { employeeNo: p.employeeNo, orgUnitId } : null
        })
        .filter((x): x is { employeeNo: string; orgUnitId: string } => x !== null)

      // --- The two verification foremen ----------------------------------
      // Their accounts carry hand-picked stable UUIDs and are created outside
      // the seed, so they had no employee record and therefore could not be
      // placed at all. Add the record, the link, and the placement.
      const foremen = [
        { userId: 'verif-foreman-a', employeeNo: 'E011', name: 'Frank Ortiz' },
        { userId: 'verif-foreman-b', employeeNo: 'E012', name: 'Grace Oyelaran' },
      ]
      const foremanPlacements = [
        { employeeNo: 'E011', orgUnitId: siteA },
        { employeeNo: 'E012', orgUnitId: siteB },
      ]

      // A placement needs an employee record to point at: the composite
      // foreign key is on (tenant_id, person_id), so a foreman with no person
      // row is silently unplaceable. Supply the records, carrying the account
      // id so the `user_id` link is filled in the same pass.
      const presentAccounts = new Set(
        (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(
              inArray(
                users.id,
                foremen.map((f) => f.userId),
              ),
            )
        ).map((u) => u.id),
      )
      const foremanRecords = foremen
        .filter((f) => presentAccounts.has(f.userId))
        .map((f) => {
          const [firstName = '', ...rest] = f.name.split(' ')
          return {
            employeeNo: f.employeeNo,
            firstName,
            lastName: rest.join(' '),
            userId: f.userId,
            tradeId: supervisorTradeId,
            departmentId: fieldOpsId,
          }
        })
      for (const f of foremen) {
        if (!presentAccounts.has(f.userId)) {
          console.log(`  SKIP  ${f.userId} has no users row; not creating a person for it`)
        }
      }

      const result = await convergePersonnelAssignments(tx, tenant.id, {
        records: foremanRecords,
        placements: [...rosterPlacements, ...foremanPlacements],
      })

      // --- Report exactly what changed ------------------------------------
      console.log(`  people inserted:        ${result.peopleCreated.length || '0 (none missing)'}`)
      console.log(`  user links filled:      ${result.linksCreated.length || '0'}`)
      console.log(`  assignments inserted:   ${result.assignmentsCreated.length || '0'}`)
      console.log(`  assignments already ok: ${result.skipped.existingAssignments}`)
      if (result.skipped.userLinkConflicts.length > 0) {
        console.log(
          `  WARNING link conflicts (NOT overwritten): ${result.skipped.userLinkConflicts.join(', ')}`,
        )
      }

      // --- Read back the state the repair is responsible for -------------
      const finalAssignments = await tx
        .select({
          employeeNo: people.employeeNo,
          firstName: people.firstName,
          lastName: people.lastName,
          userId: people.userId,
          orgUnit: orgUnits.name,
          validFrom: peopleAssignments.validFrom,
          validTo: peopleAssignments.validTo,
        })
        .from(peopleAssignments)
        .innerJoin(people, and(eq(people.id, peopleAssignments.personId)))
        .innerJoin(orgUnits, and(eq(orgUnits.id, peopleAssignments.orgUnitId)))
        .where(eq(peopleAssignments.tenantId, tenant.id))
        .orderBy(people.employeeNo)
      console.log(`  people_assignments now: ${finalAssignments.length}`)
      for (const a of finalAssignments) {
        console.log(
          `    ${a.employeeNo}  ${(a.firstName ?? '') + ' ' + (a.lastName ?? '')}`.padEnd(38) +
            `${a.orgUnit}  user=${a.userId ?? '(none)'}`,
        )
      }
      const unplaced = roster.filter((p) => p.employeeNo && !siteForCrew.has(p.crewId ?? ''))
      if (unplaced.length > 0) {
        console.log(
          `  deliberately unplaced (no crew, exercises the empty path): ${unplaced
            .map((p) => p.employeeNo)
            .join(', ')}`,
        )
      }
    })
  }

  // Sanity: the table is genuinely readable now, outside the transaction.
  const total = await db
    .select({ n: peopleAssignments.id })
    .from(peopleAssignments)
    .orderBy(peopleAssignments.id)
  console.log(`\nTotal people_assignments rows: ${total.length}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nREPAIR FAILED — the transaction rolled back, nothing changed:')
    console.error(e)
    process.exit(1)
  })
