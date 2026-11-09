'use server'

// People groups are the one reusable audience system across the People module,
// notification rules, Flows, and on-demand email.

import { and, asc, eq, isNull } from 'drizzle-orm'
import { personGroups } from '@beaconhs/db/schema'
import { resolveGroupEmails } from '@beaconhs/events'
import { assertCan } from '@beaconhs/tenant'
import { requireRequestContext } from '@/lib/auth'

// A server action is a POST endpoint: rendering the send-email dialog only on
// pages a manager can open does not authorize this module. Both actions return
// person-level data (group membership and e-mail addresses), so they require the
// same `people.read.all` boundary as the workforce directory. Without it the
// group picker is simply absent; addresses can still be typed by hand.
async function requirePeopleReader() {
  const ctx = await requireRequestContext()
  assertCan(ctx, 'people.read.all')
  return ctx
}

export async function listPersonGroups(): Promise<{ value: string; label: string }[]> {
  const ctx = await requirePeopleReader()
  const rows = await ctx.db((tx) =>
    tx
      .select({ id: personGroups.id, name: personGroups.name })
      .from(personGroups)
      .where(and(eq(personGroups.tenantId, ctx.tenantId), isNull(personGroups.deletedAt)))
      .orderBy(asc(personGroups.name)),
  )
  return rows.map((row) => ({ value: row.id, label: row.name }))
}

export async function resolvePersonGroupEmails(groupId: string): Promise<string[]> {
  const ctx = await requirePeopleReader()
  if (!groupId) return []
  return ctx.db((tx) => resolveGroupEmails(tx, ctx.tenantId, [groupId]))
}
