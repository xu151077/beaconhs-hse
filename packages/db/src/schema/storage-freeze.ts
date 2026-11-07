import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { id, timestamps } from './_helpers'
import { tenants } from './core'

/**
 * The storage write-freeze state machine (Phase 6Q, stage E1).
 *
 * WHY THIS EXISTS
 *
 * A storage migration can only be shown consistent if writes stop at a known instant.
 * BeaconHS has no such control today, and without one the Phase 6O report had to leave
 * G2 blocking. This table is the *state record* for that control. It is deliberately
 * NOT a write gate: nothing in `packages/storage` reads it yet. E2 is the stage that
 * makes enforcement real, and until then this model describes intent and records
 * transitions only.
 *
 * WHAT IS ENFORCED HERE
 *
 * Exactly one row may exist per tenant, and at most one of them may hold an active
 * migration lease. Both are database constraints rather than application checks,
 * because a lost race between two operators must not be able to produce two valid
 * freezes — that is exactly the failure the model exists to prevent.
 *
 * WHY A VERSION COLUMN
 *
 * Transitions are compare-and-set on `version`. Two operators who both read
 * version N and both try to move to the next state cannot both succeed: the second
 * write matches zero rows and is reported as a conflict rather than silently
 * overwriting the first. Optimistic concurrency is the only mechanism that works
 * across processes without holding a row lock for the whole drain window, which may
 * legitimately last hours.
 *
 * WHY LEASE EXPIRY NEVER UNFREEZES
 *
 * An expired lease means "this operator is no longer watching", which is NOT the
 * same as "the migration is over". Auto-releasing would silently return a frozen
 * tenant to ACTIVE after a lunch break, with nobody having decided to do so. Expiry
 * therefore only permits a *new* operator to take over the lease; the state itself
 * is untouched and recovery stays an explicit, audited act.
 */
export const storageFreezeState = pgEnum('storage_freeze_state', [
  'ACTIVE',
  'FREEZE_REQUESTED',
  'DRAINING',
  'FROZEN',
  'RECONCILING',
  'FAILED',
  'RECOVERY_REQUIRED',
])

export const storageFreeze = pgTable(
  'storage_freeze',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: storageFreezeState('state').default('ACTIVE').notNull(),
    /**
     * Optimistic concurrency token. Every accepted transition increments it. A
     * caller must present the version it read; a mismatch is a conflict, never a
     * last-writer-wins overwrite.
     */
    version: integer('version').default(0).notNull(),
    /**
     * Identity of the migration this row describes. Null while ACTIVE, non-null
     * from FREEZE_REQUESTED onwards. Present so an operator reading the table can
     * tell two different attempts apart even after one has failed.
     */
    migrationId: uuid('migration_id'),
    /**
     * The single operator allowed to advance this migration. Held for the whole
     * attempt so a second operator cannot interleave transitions into it.
     */
    leaseHolderId: text('lease_holder_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    leaseRenewedAt: timestamp('lease_renewed_at', { withTimezone: true }),
    /** When the current non-ACTIVE run began. Null while ACTIVE. */
    freezeRequestedAt: timestamp('freeze_requested_at', { withTimezone: true }),
    /** Who performed the most recent transition. */
    lastTransitionBy: text('last_transition_by'),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }),
    /** Why the most recent transition happened. Operator-supplied, never secrets. */
    lastReason: text('last_reason'),
    /**
     * Manifest hash produced by reconciliation. Releasing the freeze REQUIRES this
     * to be present, so "unfreeze" cannot happen without something to reconcile
     * against.
     */
    reconciliationManifestSha256: text('reconciliation_manifest_sha256'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    /** Non-secret evidence references (report paths, run ids) for the last transition. */
    evidence: jsonb('evidence').$type<Record<string, unknown> | null>(),
    ...timestamps,
  },
  (t) => ({
    /**
     * EXACTLY ONE freeze row per tenant. This is a correctness constraint, not a
     * lookup optimisation: every reader (`readFreezeState`) and every transition
     * (`applyTransition`) selects a single row for the tenant, so a second row would
     * let the gate read a stale `ACTIVE` while an operator believed the tenant was
     * `FROZEN`. `ensureFreezeRow` relies on this constraint for its
     * `ON CONFLICT DO NOTHING`, and concurrent first-write would otherwise create
     * duplicates.
     *
     * Applied by migration after a duplicate pre-check; the runtime
     * `FREEZE_STATE_AMBIGUOUS` guard remains as defence in depth and is NOT
     * replaced by this constraint.
     */
    tenantUx: uniqueIndex('storage_freeze_tenant_ux').on(t.tenantId),
    stateIdx: index('storage_freeze_state_idx').on(t.state),
    /**
     * One active migration per tenant: a tenant has at most one lease holder at a
     * time. Partial, so a historical ACTIVE row (lease released) does not collide
     * with the next attempt.
     */
    activeLeaseUx: index('storage_freeze_active_lease_ux')
      .on(t.tenantId)
      .where(sql`${t.leaseHolderId} IS NOT NULL`),
    versionCheck: check('storage_freeze_version_ck', sql`${t.version} >= 0`),
    /**
     * A migration is identified whenever the tenant is not ACTIVE, and absent
     * whenever it is. Without this, an ACTIVE row could carry a stale migration id
     * from a previous failed attempt and two operators could not tell which run
     * they are looking at.
     */
    migrationPresenceCk: check(
      'storage_freeze_migration_presence_ck',
      sql`((${t.state} = 'ACTIVE') = (${t.migrationId} IS NULL))`,
    ),
    /**
     * A row that has been frozen may only return to ACTIVE WITH a reconciliation
     * hash. `freeze_requested_at` is what distinguishes "was frozen" from "never was":
     * it is set on the first FREEZE_REQUESTED and never cleared, so this constraint
     * survives a release.
     *
     * The hash is deliberately RETAINED after release rather than cleared — the
     * release has to stay auditable, and dropping it would break the link between
     * "we unfroze" and "what we reconciled against".
     *
     * This is the release half of the pair with `evaluateTransition`, which refuses a
     * release that supplies no hash. The two together make an unreconciled release
     * impossible from either direction.
     *
     * An earlier version of this constraint was inverted
     * (`state <> 'ACTIVE' OR sha IS NULL`), which forbade the hash on exactly the
     * transition that requires it and made RECONCILING -> ACTIVE unsatisfiable: the
     * application rejected a release with no hash, and the database rejected a row
     * that had one.
     */
    releaseRequiresReconciliationCk: check(
      'storage_freeze_release_requires_reconciliation_ck',
      sql`(
        ${t.state} <> 'ACTIVE'
        OR ${t.freezeRequestedAt} IS NULL
        OR ${t.reconciliationManifestSha256} IS NOT NULL
      )`,
    ),
  }),
)

export type StorageFreezeStateValue = (typeof storageFreezeState.enumValues)[number]
