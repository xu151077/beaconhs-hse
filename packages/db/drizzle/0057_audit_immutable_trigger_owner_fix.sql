-- Correct the audit_log_immutable() BEFORE-trigger return values.
--
-- 0056 left the owner-only FOR UPDATE/DELETE branch with a bare
-- `RETURN NULL`, which in a BEFORE trigger means "skip this row"
-- entirely. As a result the owner-only exception silently no-opped:
-- owner UPDATE/DELETE on audit_log affected zero rows with no error,
-- so nothing (including the test teardown that legitimately needs
-- owner identity to clear audit rows before deleting tenants) could
-- ever delete an audit row, and the RESTRICT tenant FK then failed
-- every tenant hard-delete.
--
-- Correct semantics: non-owner still raises; the owner proceeds by
-- RETURN OLD for DELETE (allow the delete) and NEW for UPDATE (allow
-- the write). CREATE OR REPLACE keeps this idempotent on replay.
CREATE OR REPLACE FUNCTION public.audit_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF current_user <> 'beaconhs_owner' THEN
      RAISE EXCEPTION 'audit_log is append-only';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END $$;
