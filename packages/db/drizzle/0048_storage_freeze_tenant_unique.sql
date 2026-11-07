-- Phase 6U-B3-P (P-2): exactly one storage_freeze row per tenant.
--
-- WHY
--
-- `storage_freeze_tenant_ux` was created as a NON-unique btree (migration 0046),
-- so nothing prevented two rows for one tenant. That silently breaks the freeze
-- invariant: every reader selects a single row for the tenant
-- (`readFreezeState`), so with duplicates a stale `ACTIVE` row can be read while
-- an operator believes the tenant is `FROZEN`, and writes would keep flowing.
-- `ensureFreezeRow` also relies on `ON CONFLICT DO NOTHING`, which can never fire
-- without a unique constraint, so concurrent first-writes create duplicates too.
--
-- SAFETY: this migration NEVER deletes or merges rows. If duplicates are found it
-- aborts with the offending tenant ids so an operator can resolve them explicitly.
-- The runtime `FREEZE_STATE_AMBIGUOUS` guard in storage-freeze-operations.ts is
-- deliberately RETAINED as defence in depth; this constraint does not replace it.
--
-- Rollback: DROP INDEX "storage_freeze_tenant_ux"; CREATE INDEX "storage_freeze_tenant_ux"
-- ON "storage_freeze" USING btree ("tenant_id");
--
-- Locking: CREATE UNIQUE INDEX (not CONCURRENTLY) takes a ShareLock on the table
-- and blocks writes for the duration. storage_freeze holds at most one row per
-- tenant (bounded by tenant count), so this is a very small table and the lock is
-- short. CONCURRENTLY is not usable here because it cannot run inside the
-- migration's transaction.

-- 1. Pre-check. Abort loudly rather than guessing which duplicate row is correct.
DO $$
DECLARE
  duplicate_tenants text;
BEGIN
  SELECT string_agg(tenant_id::text, ', ' ORDER BY tenant_id::text)
    INTO duplicate_tenants
    FROM (
      SELECT tenant_id
      FROM storage_freeze
      GROUP BY tenant_id
      HAVING count(*) > 1
    ) duplicates;

  IF duplicate_tenants IS NOT NULL THEN
    RAISE EXCEPTION
      'storage_freeze contains duplicate tenant_id values for: % — resolve these manually before applying this migration',
      duplicate_tenants;
  END IF;
END
$$;--> statement-breakpoint

-- 2. Drop the non-unique index.
--
-- IF NOT EXISTS is deliberately NOT used on the CREATE below: it matches on index
-- NAME, so had a same-named non-unique index survived, CREATE UNIQUE INDEX would
-- skip and silently leave the constraint unenforced. Dropping first guarantees the
-- name is free and the unique index is always actually created.
DROP INDEX IF EXISTS "storage_freeze_tenant_ux";--> statement-breakpoint

-- 3. Enforce exactly one row per tenant.
CREATE UNIQUE INDEX "storage_freeze_tenant_ux" ON "storage_freeze" USING btree ("tenant_id");