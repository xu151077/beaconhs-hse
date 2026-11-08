import { people } from '@beaconhs/db/schema'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { primaryPersonTitleName } from '@beaconhs/db'
import type { Database } from '@beaconhs/db'

export type LinkablePerson = {
  id: string
  name: string
  hint: string | null
}

/**
 * Data for the "Linked person record" control: the person currently linked to
 * this account in the active tenant (if any) plus the active, unlinked people
 * that can be chosen. People already linked to a DIFFERENT account are excluded
 * so the picker can never silently steal another user's link.
 *
 * Lives outside the 'use server' actions module so the page can call it
 * directly with the request context. Exporting it from _actions.ts would make
 * it a client-callable server action whose first parameter is a full
 * RequestContext — a shape that invites (but cannot survive) a future refactor
 * into a client-driven endpoint.
 */
export async function loadPersonLinkData(
  ctx: { db: <T>(fn: (tx: Database) => Promise<T>) => Promise<T> },
  userId: string,
): Promise<{ linked: LinkablePerson | null; options: LinkablePerson[] }> {
  return ctx.db(async (tx) => {
    const rows = await tx
      .select({
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        employeeNo: people.employeeNo,
        jobTitle: primaryPersonTitleName(people.id, people.tenantId),
        userId: people.userId,
      })
      .from(people)
      .where(and(eq(people.status, 'active'), isNull(people.deletedAt)))
      .orderBy(asc(people.lastName), asc(people.firstName))
    const toItem = (r: (typeof rows)[number]): LinkablePerson => ({
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim(),
      hint: r.employeeNo ?? r.jobTitle ?? null,
    })
    const linked = rows.find((r) => r.userId === userId)
    return {
      linked: linked ? toItem(linked) : null,
      // Unlinked people + (defensively) the one already ours.
      options: rows.filter((r) => !r.userId || r.userId === userId).map(toItem),
    }
  })
}
