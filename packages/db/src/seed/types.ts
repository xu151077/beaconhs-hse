import type { Database } from '../client'

/**
 * The query surface a pure per-tenant reference seeder is allowed to use.
 *
 * Deliberately excludes `update` and `delete`. The reference seeders in this
 * folder are append-only: they may read the tenant's existing catalogue in
 * order to skip rows that are already there, and they may insert new ones.
 * Anything else is out of contract, so the type system rejects it rather than
 * leaving it to a review comment.
 *
 * Seeder modules that legitimately need to write back — e.g.
 * `lift-plan-template.ts`, which reactivates a soft-deleted template — declare
 * their own local transaction type instead of widening this one.
 */
export type SeedTx = Pick<Database, 'select' | 'insert'>
