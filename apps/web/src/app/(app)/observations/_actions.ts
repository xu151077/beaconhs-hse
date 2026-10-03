'use server'

// Server actions for the Safety Observations surface.
//
// Every mutation delegates to the journals action layer with
// `entryClass: 'observation'`, so the write authorization is the journals ladder
// unchanged — `journalMutationScope()` (journals.update.own / journals.submit /
// journals.assign), `journalScopeWhere()` for the read-scope leg, and the native
// audit. No observation-only permission, no second policy object, no
// `observationScopeWhere()`.
//
// The one genuinely observation-shaped action is `raiseObservationAction`, which
// reuses the EXISTING `spawnCorrectiveActionForSubject` primitive with
// `source: 'observation'` — a value `corrective_actions.source` has always had
// and that only the journals flow adapter ever passed. Nothing is reimplemented.

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { journalEntries } from '@beaconhs/db/schema'
import { requireRequestContext } from '@/lib/auth'
import { recordAuditInTransaction } from '@/lib/audit'
import { isUuid } from '@/lib/list-params'
import { spawnCorrectiveActionForSubject } from '@/lib/flows/spawn'
import {
  attachJournalPhotos,
  createObservation,
  deleteEntry,
  describeJournalPhoto,
  removeJournalPhoto,
  reorderJournalPhotos,
  submitEntry,
  updateEntry,
  updateJournalPhoto,
} from '../journals/_actions'
import { journalMutationScope } from '../journals/_mutation-policy'
import { getEntry } from '../journals/_data'
import type { EntryPatch, JournalEntryDetail } from '../journals/_types'
import type { ObservationDefinition } from '@beaconhs/db/schema'

type ActionOk<T = {}> = { ok: true } & T
type ActionErr = { ok: false; error: string }

const ENTRY_CLASS = 'observation' as const

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

// ---- create -----------------------------------------------------------------

/** Create a draft observation. Delegates to the journals writer with an
 *  observation definition, so the reference comes from the shared JRN series and
 *  the record is classed as an observation server-side, not by the client. */
export async function createObservationDraft(input: {
  observedAt: string
  definition: ObservationDefinition
  siteOrgUnitId?: string | null
  supervisorPersonId?: string | null
  title?: string
}): Promise<ActionOk<{ id: string; reference: string }> | ActionErr> {
  return createObservation(input)
}

// ---- update (autosave) ------------------------------------------------------

/** Autosave the observation body / meta / tags. The class is pinned to
 *  'observation', so a patch can never retype the record into a daily journal. */
export async function updateObservationDraft(input: {
  id: string
  patch: EntryPatch
}): Promise<ActionOk<{ updatedAt: string }> | ActionErr> {
  return updateEntry({ id: input.id, patch: input.patch, entryClass: ENTRY_CLASS })
}

// ---- lifecycle --------------------------------------------------------------

/** Submit the draft. Same `journals.submit` gate and the same one-way
 *  draft → submitted transition (and idempotency guard) as a journal. */
export async function submitObservation(id: string): Promise<ActionOk | ActionErr> {
  const result = await submitEntry(id, ENTRY_CLASS)
  if (result.ok) revalidatePath('/observations')
  return result
}

/**
 * Archive a submitted observation.
 *
 * There is no observation-specific "closed" state and no observation workflow:
 * an observation is finished when the work it raised is done, and that is
 * expressed by the corrective action's own status (`corrective_action_status`
 * already has closed / cancelled). This moves the record to the journals
 * `archived` status so it leaves the working list, which is the same meaning a
 * journal's archive has.
 */
export async function archiveObservation(id: string): Promise<ActionOk | ActionErr> {
  const ctx = await requireRequestContext()
  if (!isUuid(id)) return { ok: false, error: 'Observation not found.' }
  if (journalMutationScope(ctx, 'edit') === 'none') {
    return { ok: false, error: 'You cannot change observations.' }
  }
  // `getEntry` re-checks the full journals visibility scope (read tier +
  // own-record cross-site + soft delete) and the observation class, so an
  // archived observation can never be written by someone who cannot read it.
  const visible = await getEntry(ctx, id, ENTRY_CLASS)
  if (!visible) return { ok: false, error: 'Observation not found.' }

  const row = await ctx.db(async (tx) => {
    const rows = await tx
      .update(journalEntries)
      .set({ status: 'archived' })
      .where(and(eq(journalEntries.id, id), eq(journalEntries.status, 'submitted')))
      .returning({ reference: journalEntries.reference })
    if (!rows[0]) return null
    await recordAuditInTransaction(tx, ctx, {
      entityType: 'journal_entry',
      entityId: id,
      action: 'update',
      summary: `Archived observation ${rows[0].reference}`,
    })
    return rows[0]
  })
  if (!row) return { ok: false, error: 'This observation has already been archived.' }
  revalidatePath('/observations')
  revalidatePath(`/observations/${id}`)
  return { ok: true }
}

/** Soft-delete a draft observation (the journals `deletedAt` path, class-pinned). */
export async function discardObservation(id: string): Promise<ActionOk | ActionErr> {
  const result = await deleteEntry(id, ENTRY_CLASS)
  if (result.ok) revalidatePath('/observations')
  return result
}

// ---- corrective actions -----------------------------------------------------

/**
 * Raise a corrective action from a negative observation.
 *
 * 1:N — the link is held entirely by `corrective_actions`
 * (`source = 'observation'`, `source_entity_type = 'journal_entry'`,
 * `source_entity_id = <observation id>`), the polymorphic pair that already backs
 * the incident → action path. The observation gains no column, and no FK is added.
 *
 * The existing primitive does the work: `spawnCorrectiveActionForSubject` mints
 * the CA reference, assigns it, records the `corrective_action.created` domain
 * event (notification + integration + the corrective-actions flow) and writes the
 * audit row. We only choose the `source` and the title, and refuse to raise one
 * from a POSITIVE observation — good practice is not a defect to correct.
 */
export async function raiseObservationAction(input: {
  id: string
  title: string
  description?: string | null
  dueOn?: string | null
}): Promise<ActionOk<{ caId: string; reference: string }> | ActionErr> {
  const ctx = await requireRequestContext()
  const raw = record(input)
  const observationId = typeof raw.id === 'string' ? raw.id : ''
  if (!isUuid(observationId)) return { ok: false, error: 'Observation not found.' }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return { ok: false, error: 'Describe what needs to be done.' }
  const dueOn = typeof raw.dueOn === 'string' ? raw.dueOn : null
  if (dueOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    return { ok: false, error: 'Choose a valid due date.' }
  }

  // Reading the observation through the journals reader is the authorization
  // check: it applies the read tier, the own-record cross-site rule, the soft
  // delete and the class partition in one place.
  const observation = await getEntry(ctx, observationId, ENTRY_CLASS)
  if (!observation) return { ok: false, error: 'Observation not found.' }
  if (observation.definition !== 'negative_observation') {
    return { ok: false, error: 'Only a negative observation can raise an action.' }
  }
  if (journalMutationScope(ctx, 'edit') === 'none') {
    return { ok: false, error: 'You cannot change observations.' }
  }

  const result = await spawnCorrectiveActionForSubject(ctx, {
    sourceEntityType: 'journal_entry',
    sourceEntityId: observation.id,
    source: 'observation',
    title,
    description: typeof raw.description === 'string' ? raw.description : null,
    dueOn,
    siteOrgUnitId: observation.siteOrgUnitId,
  })
  if (!result.ok || !result.caId) {
    return { ok: false, error: 'The corrective action could not be created.' }
  }
  revalidatePath(`/observations/${observation.id}`)
  revalidatePath('/observations')
  return { ok: true, caId: result.caId, reference: result.reference ?? '' }
}

// ---- photos -----------------------------------------------------------------

/** Attach uploaded images to an observation. Reuses the journals photo writer and
 *  the shared `journal_entry_photos` → `attachments` → storage chain; an
 *  observation gets no attachment table of its own. */
export async function attachObservationPhotos(input: {
  id: string
  attachmentIds: string[]
}): Promise<ActionOk<{ photoIds: string[] }> | ActionErr> {
  const result = await attachJournalPhotos({
    entryId: input.id,
    attachmentIds: input.attachmentIds,
    entryClass: ENTRY_CLASS,
  })
  if (result.ok) revalidatePath(`/observations/${input.id}`)
  return result
}

export async function removeObservationPhoto(
  photoId: string,
  observationId: string,
): Promise<ActionOk | ActionErr> {
  const result = await removeJournalPhoto(photoId, ENTRY_CLASS)
  if (result.ok) revalidatePath(`/observations/${observationId}`)
  return result
}

export async function reorderObservationPhotos(
  observationId: string,
  photoIds: string[],
): Promise<ActionOk | ActionErr> {
  const result = await reorderJournalPhotos(observationId, photoIds, ENTRY_CLASS)
  if (result.ok) revalidatePath(`/observations/${observationId}`)
  return result
}

export async function updateObservationPhoto(
  photoId: string,
  input: unknown,
  observationId: string,
): Promise<ActionOk | ActionErr> {
  const result = await updateJournalPhoto(photoId, input, ENTRY_CLASS)
  if (result.ok) revalidatePath(`/observations/${observationId}`)
  return result
}
