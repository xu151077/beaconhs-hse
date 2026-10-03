// Pure serializable types for the Safety Observations surface. No runtime
// imports, so client components can import freely.

import type { JournalListItem } from '../journals/_types'

/**
 * One row of the /observations list. Structurally the journals list item — the
 * record IS a journal entry — plus the already-joined display fields the table
 * renders, so the page does not need a second round trip per row.
 */
export type ObservationRow = JournalListItem & {
  /** The two observation definitions only; the class filter guarantees it. */
  definition: 'positive_observation' | 'negative_observation'
}
