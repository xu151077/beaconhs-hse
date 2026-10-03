// Which CLASS of journal entry a query is about: a daily journal, or a safety
// observation.
//
// `journal_entries` holds both. Every read surface that presents one class must
// exclude the other, or journals and observations appear mixed in the same list
// and the journals compliance obligation counts observations as journal evidence.
//
// This module owns that partition so it cannot drift between the web module, the
// dashboard and the compliance engine. It adds no table, no permission and no
// authorization rule — `journalScopeWhere()` and the `journals.*` read tiers
// remain the single visibility ladder for BOTH classes.

import { and, eq, inArray, notInArray, type SQL } from 'drizzle-orm'
import {
  JOURNAL_DEFINITIONS,
  OBSERVATION_DEFINITIONS,
  isJournalDefinition,
  isObservationDefinition,
  journalEntries,
  type JournalDefinitionValue,
  type ObservationDefinition,
} from './schema/journals'

/**
 * The two business classes of a journal entry. A record is exactly one of them,
 * and the `definition` values of each class are disjoint and exhaustive.
 */
export type EntryClass = 'journal' | 'observation'

/** The `definition` values that make up `cls`. */
export function entryClassDefinitions(cls: EntryClass): readonly string[] {
  return cls === 'observation' ? OBSERVATION_DEFINITIONS : JOURNAL_DEFINITIONS
}

/**
 * WHERE fragment restricting `journal_entries` to one class.
 *
 * Returns `undefined` only if the class's value set were empty, which cannot
 * happen for the two classes defined above — a caller can therefore AND it in
 * unconditionally. Passing an unknown class is impossible: the parameter is a
 * closed union, so a typo is a type error rather than a silently empty result.
 */
export function entryClassWhere(cls: EntryClass): SQL {
  return inArray(journalEntries.definition, entryClassDefinitions(cls) as never)
}

/** WHERE fragment excluding one class — the "this is NOT a journal" half. */
export function entryClassNotWhere(cls: EntryClass): SQL {
  return notInArray(journalEntries.definition, entryClassDefinitions(cls) as never)
}

/** The class an entry's `definition` belongs to. */
export function entryClassOf(definition: string): EntryClass {
  return isObservationDefinition(definition) ? 'observation' : 'journal'
}

/** True when this `definition` is a safety observation. */
export function isObservationEntry(definition: string): boolean {
  return isObservationDefinition(definition)
}

/**
 * The definition a patch may set from `cls`'s surface, or `null` when the value is
 * not a member of that class. This is the guard that keeps the partition
 * server-side: a `journals.update.own` patch cannot retype a daily journal into a
 * safety observation, and the reverse is equally refused.
 */
export function definitionForClass(
  definition: unknown,
  cls: EntryClass,
): JournalDefinitionValue | ObservationDefinition | null {
  if (cls === 'observation') return isObservationDefinition(definition) ? definition : null
  return isJournalDefinition(definition) ? definition : null
}

/**
 * True when the entry at `id` is of `cls`. A single-row existence check used to
 * refuse a record that exists but is the other class — an id from /observations
 * must not silently open as a journal, or the reverse.
 */
export function entryClassIdWhere(id: string, cls: EntryClass): SQL {
  return and(eq(journalEntries.id, id), entryClassWhere(cls))!
}
