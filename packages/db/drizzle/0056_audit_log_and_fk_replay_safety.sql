-- Compensating migration: replay safety for 0055 + audit immutable trigger.
--
-- 1) ppe_inspection_attachments tenant FK: 0055's ADD was bare, so a replay
-- after ADD succeeded / VALIDATE failed errored with "already exists" and
-- could leave drops committed but the FK unvalidated. This migration converges
-- both states idempotently; it does not re-add the nine dropped singles.
-- 2) audit_log: trigger rejects UPDATE/DELETE (app-role tamper-evidence).
-- Owner-only exception (migrate runs as SET ROLE beaconhs_owner, so
-- current_user = beaconhs_owner during migration). No permanent migrator
-- exception; TRUNCATE is revoked at role level below (trigger does not fire
-- for TRUNCATE).

DO $$
DECLARE
  c pg_constraint%ROWTYPE;
  local_cols text[];
  remote_cols text[];
  expected_local text[] := ARRAY['tenant_id', 'attachment_id'];
  expected_remote text[] := ARRAY['tenant_id', 'id'];
  dup int;
BEGIN
  -- Semantic duplicate guard: any other FK with same local/remote cols but
  -- different name is a conflicting definition, not a harmless duplicate.
  SELECT count(*) INTO dup
  FROM pg_constraint x
  JOIN pg_class rel ON rel.oid = x.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE x.contype = 'f'
    AND x.conrelid = 'public.ppe_inspection_attachments'::regclass
    AND x.confrelid = 'public.attachments'::regclass
    AND x.conname <> 'att_tenant_ppe_inspection_attachments_attachment_id_3b75c366';
  IF dup > 0 THEN
    RAISE EXCEPTION 'conflicting foreign key on ppe_inspection_attachments->attachments already exists';
  END IF;

  SELECT * INTO c FROM pg_constraint WHERE conname = 'att_tenant_ppe_inspection_attachments_attachment_id_3b75c366';
  IF NOT FOUND THEN
    ALTER TABLE "ppe_inspection_attachments"
      ADD CONSTRAINT "att_tenant_ppe_inspection_attachments_attachment_id_3b75c366"
      FOREIGN KEY ("tenant_id", "attachment_id")
      REFERENCES "attachments" ("tenant_id", "id") ON DELETE CASCADE NOT VALID;
  ELSE
    -- Full definition check: name alone is not sufficient.
    IF c.contype <> 'f'
       OR c.connamespace <> 'public'::regnamespace
       OR c.conrelid <> 'public.ppe_inspection_attachments'::regclass
       OR c.confrelid <> 'public.attachments'::regclass THEN
      RAISE EXCEPTION 'constraint att_tenant_ppe_inspection_attachments_attachment_id_3b75c366 points at wrong table';
    END IF;
    IF c.confmatchtype <> 's'::char OR c.condeferrable OR c.condeferred THEN
      RAISE EXCEPTION 'constraint att_tenant_ppe_inspection_attachments_attachment_id_3b75c366 has wrong match/deferrable';
    END IF;
    SELECT array_agg(a.attname ORDER BY k.ordinality) INTO local_cols
    FROM unnest(c.conkey) WITH ORDINALITY AS k(idx, ordinality)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.idx;
    SELECT array_agg(a.attname ORDER BY k.ordinality) INTO remote_cols
    FROM unnest(c.confkey) WITH ORDINALITY AS k(idx, ordinality)
    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.idx;
    IF local_cols IS DISTINCT FROM expected_local OR remote_cols IS DISTINCT FROM expected_remote THEN
      RAISE EXCEPTION 'constraint att_tenant_ppe_inspection_attachments_attachment_id_3b75c366 has wrong columns';
    END IF;
    IF c.confdeltype <> 'c'::char OR c.confupdtype <> 'a'::char THEN
      RAISE EXCEPTION 'constraint att_tenant_ppe_inspection_attachments_attachment_id_3b75c366 has wrong referential actions';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "ppe_inspection_attachments"
  VALIDATE CONSTRAINT "att_tenant_ppe_inspection_attachments_attachment_id_3b75c366";
--> statement-breakpoint
-- Audit immutability: owner-only exception (migrate runs as SET ROLE owner).
-- App/super/backup are blocked even with BYPASSRLS (trigger, not RLS).
REVOKE ALL ON public.audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM beaconhs_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM beaconhs_super;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM beaconhs_backup;
GRANT SELECT, INSERT ON public.audit_log TO beaconhs_app;
GRANT SELECT, INSERT ON public.audit_log TO beaconhs_super;
GRANT SELECT ON public.audit_log TO beaconhs_backup;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.audit_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF current_user <> 'beaconhs_owner' THEN
      RAISE EXCEPTION 'audit_log is append-only';
    END IF;
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.audit_log_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_log_immutable() FROM beaconhs_app;
REVOKE EXECUTE ON FUNCTION public.audit_log_immutable() FROM beaconhs_super;
REVOKE EXECUTE ON FUNCTION public.audit_log_immutable() FROM beaconhs_backup;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_immutable_trigger ON public.audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable_trigger
BEFORE UPDATE OR DELETE ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();
--> statement-breakpoint
-- Cascade safety: audit rows must survive tenant deletion; RESTRICT makes
-- the FK fail closed instead of silently cascade-deleting the trail.
DO $$
DECLARE
  ac pg_constraint%ROWTYPE;
BEGIN
  SELECT * INTO ac FROM pg_constraint WHERE conname = 'audit_log_tenant_id_tenants_id_fk';
  IF FOUND THEN
    IF ac.contype <> 'f' OR ac.conrelid <> 'public.audit_log'::regclass OR ac.confrelid <> 'public.tenants'::regclass THEN
      RAISE EXCEPTION 'audit_log_tenant_id_tenants_id_fk does not belong to audit_log';
    END IF;
    ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_tenant_id_tenants_id_fk;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_log_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE public.audit_log
      ADD CONSTRAINT audit_log_tenant_id_tenants_id_fk
      FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;
