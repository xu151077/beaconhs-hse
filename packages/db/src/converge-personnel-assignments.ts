// Personnel placement convergence — additive only, never destructive.
//
// WHY THIS EXISTS
// `people_assignments` is the organizational fact "this person works at this
// place, from this date". `role_assignments.scope` is a *different* fact:
// "this account's permissions reach this far". They are deliberately NOT
// derived from one another — see the note at the bottom of this file.
//
// Before this module, nothing but an org administrator clicking the Assignments
// drawer on `/people/<id>` ever wrote `people_assignments`, and `seed.ts` wrote
// none at all. Project Scope resolves from this table and fails closed, so a
// tenant whose roster is unplaced resolves every non-tenant-wide caller to
// `empty` — correct, and useless. This fills the placement gap in the one place
// that is allowed to: the fixture/dev data path.
//
// INVARIANTS (all of them load-bearing):
//   1. ADD ONLY. No update, no delete, no truncate. A row that already exists is
//      left exactly as it is, even if this module would have written it
//      differently.
//   2. Never touch `role_assignments`. The two vocabularies stay independent.
//   3. Idempotent. Running it twice inserts nothing the second time.
//   4. Never re-link a `userId` that is already set, even to a different person.
//      `people_tenant_user_ux` is unique per tenant, so stealing a link would
//      silently unbind a real employee record.
//   5. Touches only the tenant it is given.
//
// It is NOT an HR provisioning system. A person created through
// `people/_actions` or imported through `packages/sync` still needs an org
// administrator to place them; this module exists so the *seeded* and *dev*
// dataset is coherent, not so production can skip the placement step.

import { and, eq, inArray } from 'drizzle-orm'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { orgUnits, people, peopleAssignments } from './schema'

/**
 * Anything that can read and write these tables: the `db` client, a
 * `db.transaction(...)` handle, or a tenant-scoped `ctx.db(...)` executor. A
 * narrow `Database` would reject the two transaction handles, which are exactly
 * the ones this must run on — the seed wraps it in one transaction and a repair
 * script must be able to roll itself back.
 */
export type ConvergenceDb = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

/** One "this person works at this place" statement. */
export type PersonnelPlacement = {
  /**
   * `people.employee_no` — the stable, seeded identifier. Using it rather than
   * a name means a re-run cannot drift onto the wrong person after a rename.
   */
  employeeNo: string
  /** The `org_units.id` the person is placed at. Usually a site. */
  orgUnitId: string
  /** ISO date, inclusive. Defaults to `validFrom` below. */
  validFrom?: string
  /** ISO date, inclusive, or `null` for open-ended. */
  validTo?: string | null
}

/**
 * A person who must EXIST before they can be placed. A placement alone is not
 * enough: `people_assignments` has a composite foreign key onto
 * `(tenant_id, person_id)`, so a verification account with no employee record
 * cannot be placed at all — which is the state a fresh tenant is in.
 */
export type PersonnelRecord = {
  employeeNo: string
  firstName: string
  lastName: string
  /** Link the new row to this `users.id`. Never overrides an existing link. */
  userId?: string | null
  departmentId?: string | null
  tradeId?: string | null
  crewId?: string | null
  status?: 'active' | 'inactive' | 'terminated'
}

export type PersonnelConvergence = {
  /** Rows inserted into `people`. */
  peopleCreated: string[]
  /** `people.user_id` links filled in on rows that existed with a null link. */
  linksCreated: string[]
  /** Rows inserted into `people_assignments`. */
  assignmentsCreated: string[]
  /** Everything the module deliberately declined to touch. */
  skipped: {
    /** `userId` already pointed at a different person. Never stolen. */
    userLinkConflicts: string[]
    /** An assignment already existed for this (person, org unit). */
    existingAssignments: number
  }
}

/** Default start date: the epoch, so a placement is effective from the outset. */
const ALWAYS_FROM = '2020-01-01'

/**
 * Insert any missing personnel records and placements, and do nothing else.
 *
 * The caller owns the transaction. Pass the seed's transaction so the whole
 * fixture is one atomic unit; pass a repair script's transaction so a failure
 * rolls the repair back entirely.
 */
export async function convergePersonnelAssignments(
  tx: ConvergenceDb,
  tenantId: string,
  input: { records?: readonly PersonnelRecord[]; placements: readonly PersonnelPlacement[] },
): Promise<PersonnelConvergence> {
  const result: PersonnelConvergence = {
    peopleCreated: [],
    linksCreated: [],
    assignmentsCreated: [],
    skipped: { userLinkConflicts: [], existingAssignments: 0 },
  }

  const records = input.records ?? []

  // --- 1. Ensure the employee records exist -------------------------------
  for (const rec of records) {
    const [existing] = await tx
      .select({ id: people.id, userId: people.userId })
      .from(people)
      .where(and(eq(people.tenantId, tenantId), eq(people.employeeNo, rec.employeeNo)))
      .limit(1)

    if (existing) {
      // Invariant 4: only ever FILL a null link. A link that already exists is
      // an administrator's decision, or another module's, and is left alone.
      if (rec.userId && existing.userId === null) {
        await tx
          .update(people)
          .set({ userId: rec.userId })
          .where(and(eq(people.tenantId, tenantId), eq(people.id, existing.id)))
        result.linksCreated.push(rec.employeeNo)
      } else if (rec.userId && existing.userId !== rec.userId) {
        result.skipped.userLinkConflicts.push(rec.employeeNo)
      }
      continue
    }

    const [created] = await tx
      .insert(people)
      .values({
        tenantId,
        employeeNo: rec.employeeNo,
        firstName: rec.firstName,
        lastName: rec.lastName,
        formalName: `${rec.firstName} ${rec.lastName}`,
        userId: rec.userId ?? null,
        departmentId: rec.departmentId ?? null,
        tradeId: rec.tradeId ?? null,
        crewId: rec.crewId ?? null,
        status: rec.status ?? 'active',
      })
      .returning({ id: people.id })
    if (created) result.peopleCreated.push(rec.employeeNo)
  }

  // --- 2. Ensure the placements exist -------------------------------------
  // Resolve every referenced org unit once, and refuse any placement that names
  // a unit this tenant does not own. A dangling placement would silently
  // resolve to nothing at read time, which is the exact failure this module
  // exists to remove.
  const orgUnitIds = [...new Set(input.placements.map((p) => p.orgUnitId))]
  const liveOrgUnits = new Set<string>()
  if (orgUnitIds.length > 0) {
    const units = await tx
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(and(eq(orgUnits.tenantId, tenantId), inArray(orgUnits.id, orgUnitIds)))
    for (const u of units) liveOrgUnits.add(u.id)
  }

  for (const placement of input.placements) {
    if (!liveOrgUnits.has(placement.orgUnitId)) continue

    const [person] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.tenantId, tenantId), eq(people.employeeNo, placement.employeeNo)))
      .limit(1)
    // No employee record means the composite FK has nothing to point at. Skip
    // rather than fail the whole convergence: one unplaceable person must not
    // block the rest.
    if (!person) continue

    const [already] = await tx
      .select({ id: peopleAssignments.id })
      .from(peopleAssignments)
      .where(
        and(
          eq(peopleAssignments.tenantId, tenantId),
          eq(peopleAssignments.personId, person.id),
          eq(peopleAssignments.orgUnitId, placement.orgUnitId),
        ),
      )
      .limit(1)
    // Invariant 1: an existing assignment is left untouched, whatever its dates.
    if (already) {
      result.skipped.existingAssignments++
      continue
    }

    const [inserted] = await tx
      .insert(peopleAssignments)
      .values({
        tenantId,
        personId: person.id,
        orgUnitId: placement.orgUnitId,
        validFrom: placement.validFrom ?? ALWAYS_FROM,
        validTo: placement.validTo ?? null,
      })
      .returning({ id: peopleAssignments.id })
    if (inserted) result.assignmentsCreated.push(placement.employeeNo)
  }

  return result
}

// ---------------------------------------------------------------------------
// WHY THERE IS NO role_assignments -> people_assignments CONVERGENCE HERE
//
// It is tempting: a `foreman` holding `{type:'sites', siteIds:[<org_unit_id>]}`
// has already had its working location chosen by an administrator, so the
// assignment row could just be written from it. This module deliberately does
// not, for three reasons:
//
//   1. They are different facts. A scope says how far an ACCOUNT's permissions
//      reach; an assignment says where a PERSON works. A person can be scoped
//      narrower than where they stand (a visitor covering one site), and can
//      change job without their permissions changing. Conflating them makes
//      "change this person's role" silently rewrite their employment record.
//   2. A role assignment can be held by an account with no employee record at
//      all — a service account, or a user who has not been onboarded. There is
//      nothing to place, so the derivation would have to invent a person.
//   3. It is a permission-derived widening, and a permission must never be the
//      reason a row appears that widens visibility. Project Scope is
//      fail-closed precisely because it is computed from placement, not from
//      access.
//
// If an access scope and a personnel placement genuinely disagree, that is
// reported, not reconciled. See `docs/hse-project-scope-resolver.md`.
// ---------------------------------------------------------------------------
