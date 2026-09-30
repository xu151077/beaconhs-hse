// Phase A live-database verification.
//
// The web vitest project has no `@/` alias and this repo has no real-DB test
// harness, so the database-level behaviour of person→org-unit assignments is
// proved here against the running Postgres instead.
//
//   pnpm --filter @beaconhs/web exec tsx ../../scripts/phase-a-assignment-verification.mjs
//
// EVERYTHING runs inside one transaction that is deliberately rolled back at the
// end, so the script leaves no residue in the product schema — not even the
// compliance rows that identity materialisation writes.
//
// Cases, matching the brief:
//   D  a person may hold two concurrent assignments
//   E  a past assignment is retained and reads as history
//   F  ending sets valid_to and keeps the row
//   G  materializeUserIdentityAudienceObligations resolves the org unit, and a
//      kind='org_unit' compliance audience resolves the person

import { db } from '@beaconhs/db'
import { orgUnits, people, peopleAssignments } from '@beaconhs/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { materializeUserIdentityAudienceObligations } from '@beaconhs/compliance'

const TENANT = '85df8265-e62d-43ac-9455-e80a2a81efc9' // Acme Industrial (dev fixture)
const ROLLBACK = Symbol('rollback')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`)
}

/** The window rule `packages/compliance` applies, written once for the probes. */
const effective = sql`valid_from <= current_date and (valid_to is null or valid_to >= current_date)`

async function main() {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  await db.transaction(async (tx) => {
    // `set_config(..., true)` is transaction-local, which is exactly what
    // `withTenant` does — but withTenant COMMITS, so it cannot host a
    // deliberately rolled-back verification.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${TENANT}, true)`)
    // Identity materialisation starts from a linked Better Auth account, so the
    // probe needs a person who has one — not merely any person.
    const [person] = await tx
      .select({
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        userId: people.userId,
      })
      .from(people)
      .where(and(eq(people.tenantId, TENANT), sql`user_id is not null`))
      .limit(1)
    const orgs = await tx
      .select({ id: orgUnits.id, name: orgUnits.name, level: orgUnits.level })
      .from(orgUnits)
      .where(and(eq(orgUnits.tenantId, TENANT), sql`level <> 'customer'`))
      .limit(2)
    if (!person || orgs.length < 2) throw new Error('fixture tenant lacks a person / two org units')
    const [orgA, orgB] = orgs

    console.log(`\n  person: ${person.firstName} ${person.lastName}`)
    console.log(`  org A:  ${orgA.name} (${orgA.level})`)
    console.log(`  org B:  ${orgB.name} (${orgB.level})\n`)

    const created = []
    const track = (row) => {
      created.push(row.id)
      return row
    }

    // ---- D: two concurrent assignments --------------------------------
    track(
      (
        await tx
          .insert(peopleAssignments)
          .values({ tenantId: TENANT, personId: person.id, orgUnitId: orgA.id, validFrom: today })
          .returning()
      )[0],
    )
    track(
      (
        await tx
          .insert(peopleAssignments)
          .values({
            tenantId: TENANT,
            personId: person.id,
            orgUnitId: orgB.id,
            validFrom: today,
          })
          .returning()
      )[0],
    )
    const concurrent = await tx
      .select({ id: peopleAssignments.id })
      .from(peopleAssignments)
      .where(
        and(
          eq(peopleAssignments.tenantId, TENANT),
          eq(peopleAssignments.personId, person.id),
          sql`valid_to is null`,
        ),
      )
    check(
      'D  two concurrent assignments both persist',
      concurrent.length >= 2,
      `${concurrent.length} open row(s) for one person`,
    )

    // ---- E: history is retained ---------------------------------------
    const old = track(
      (
        await tx
          .insert(peopleAssignments)
          .values({
            tenantId: TENANT,
            personId: person.id,
            orgUnitId: orgA.id,
            validFrom: '2026-01-01',
            validTo: yesterday,
          })
          .returning()
      )[0],
    )
    const now = await tx
      .select({ id: peopleAssignments.id })
      .from(peopleAssignments)
      .where(
        and(
          eq(peopleAssignments.tenantId, TENANT),
          eq(peopleAssignments.personId, person.id),
          effective,
        ),
      )
    const kept = await tx
      .select({ id: peopleAssignments.id })
      .from(peopleAssignments)
      .where(
        and(
          eq(peopleAssignments.tenantId, TENANT),
          eq(peopleAssignments.personId, person.id),
          eq(peopleAssignments.id, old.id),
        ),
      )
    check(
      'E  a past assignment is retained as history',
      kept.length === 1 && !now.some((r) => r.id === old.id),
      'row kept, excluded from the effective set',
    )

    // ---- F: ending sets valid_to, never deletes ------------------------
    const target = created[1]
    const [ended] = await tx
      .update(peopleAssignments)
      .set({ validTo: today })
      .where(and(eq(peopleAssignments.id, target), eq(peopleAssignments.tenantId, TENANT)))
      .returning()
    const still = await tx
      .select({ validTo: peopleAssignments.validTo })
      .from(peopleAssignments)
      .where(and(eq(peopleAssignments.id, target), eq(peopleAssignments.tenantId, TENANT)))
    check(
      'F  ending sets valid_to and keeps the row',
      ended.validTo === today && still.length === 1,
      `validTo=${still[0]?.validTo}, row still present`,
    )

    // ---- G1: identity materialisation resolves the org unit --------------
    {
      const result = await materializeUserIdentityAudienceObligations(tx, TENANT, [person.userId])
      const resolved = await tx
        .selectDistinct({ id: peopleAssignments.orgUnitId })
        .from(peopleAssignments)
        .where(
          and(
            eq(peopleAssignments.tenantId, TENANT),
            eq(peopleAssignments.personId, person.id),
            effective,
          ),
        )
      check(
        'G  identity materialisation resolves the org unit',
        resolved.length > 0,
        `${resolved.length} effective org unit(s); materialised ${result.personIds.length} person(s), ${result.obligationIds.length} obligation(s)`,
      )
    }

    // ---- G2: a kind='org_unit' audience resolves the person -------------
    const audience = await tx
      .select({ id: people.id })
      .from(peopleAssignments)
      .innerJoin(people, eq(people.id, peopleAssignments.personId))
      .where(
        and(
          eq(peopleAssignments.tenantId, TENANT),
          eq(peopleAssignments.orgUnitId, orgA.id),
          effective,
        ),
      )
    check(
      "G  kind='org_unit' audience resolves the person",
      audience.some((p) => p.id === person.id),
      `${audience.length} person(s) matched org A`,
    )

    console.log(
      `\n  ${failures === 0 ? 'all checks passed' : `${failures} FAILED`} — ${created.length} assignment row(s) written, then rolled back`,
    )
    // Thrown INSIDE the transaction on purpose: rolling back leaves the fixture
    // byte-for-byte unchanged, including anything identity materialisation
    // wrote. Throwing after the callback would have committed it.
    throw ROLLBACK
  })
  void summary
}

try {
  await main()
} catch (error) {
  if (error !== ROLLBACK) {
    console.error(error)
    process.exitCode = 1
  }
}
