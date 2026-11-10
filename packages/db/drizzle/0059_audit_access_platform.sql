CREATE TABLE "audit_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grantee_user_id" text NOT NULL,
	"grantee_tenant_id" uuid,
	"scope" text NOT NULL,
	"purpose" text NOT NULL,
	"approved_by_user_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_audit_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_tenant_id" uuid,
	"scope" text NOT NULL,
	"grant_id" uuid,
	"action" text NOT NULL,
	"purpose" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_access_grants" ADD CONSTRAINT "audit_access_grants_grantee_user_id_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_access_grants" ADD CONSTRAINT "audit_access_grants_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_access_grants" ADD CONSTRAINT "audit_access_grants_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_access_log" ADD CONSTRAINT "platform_audit_access_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_access_grants_grantee_idx" ON "audit_access_grants" USING btree ("grantee_user_id","scope");--> statement-breakpoint
CREATE INDEX "audit_access_grants_window_idx" ON "audit_access_grants" USING btree ("starts_at","expires_at");--> statement-breakpoint
CREATE INDEX "platform_audit_access_log_occurred_idx" ON "platform_audit_access_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_access_log_grant_idx" ON "platform_audit_access_log" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "platform_audit_access_log_actor_idx" ON "platform_audit_access_log" USING btree ("actor_user_id","occurred_at");
--> statement-breakpoint
-- Integrity constraints (server-side, not app-side only).
DO $$ BEGIN
  ALTER TABLE "audit_access_grants"
    ADD CONSTRAINT "audit_access_grants_scope_ck" CHECK ("scope" IN ('tenant','platform'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "audit_access_grants"
    ADD CONSTRAINT "audit_access_grants_window_ck" CHECK ("expires_at" > "starts_at");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "audit_access_grants"
    ADD CONSTRAINT "audit_access_grants_max_window_ck"
    CHECK ("expires_at" - "starts_at" <= interval '90 days');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "audit_access_grants"
    ADD CONSTRAINT "audit_access_grants_purpose_ck"
    CHECK (char_length("purpose") BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN null; END $$;
-- An approver must be a different subject than the grantee (P-4).
DO $$ BEGIN
  ALTER TABLE "audit_access_grants"
    ADD CONSTRAINT "audit_access_grants_approver_ck"
    CHECK ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "grantee_user_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
-- Revocation is all-or-nothing: both columns set, or neither.
DO $$ BEGIN
  ALTER TABLE "audit_access_grants"
    ADD CONSTRAINT "audit_access_grants_revocation_ck"
    CHECK (("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "platform_audit_access_log"
    ADD CONSTRAINT "platform_audit_access_log_scope_ck" CHECK ("scope" IN ('tenant','platform'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "platform_audit_access_log"
    ADD CONSTRAINT "platform_audit_access_log_action_ck" CHECK ("action" IN (
      'grant_requested','grant_approved','grant_rejected','grant_revoked',
      'audit_query','audit_query_failed','audit_query_timeout',
      'audit_oversize_requested','audit_export_requested','audit_export_approved',
      'audit_export_completed','audit_access_denied'
    ));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- platform_audit_access_log is append-only (same semantics as audit_log's
-- corrected 0057 trigger: non-owner raises; owner proceeds with NEW/OLD).
CREATE OR REPLACE FUNCTION public.platform_audit_access_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF current_user <> 'beaconhs_owner' THEN
      RAISE EXCEPTION 'platform_audit_access_log is append-only';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS platform_audit_access_log_immutable_trigger ON platform_audit_access_log;
CREATE TRIGGER platform_audit_access_log_immutable_trigger
  BEFORE UPDATE OR DELETE ON platform_audit_access_log
  FOR EACH ROW EXECUTE FUNCTION public.platform_audit_access_log_immutable();
--> statement-breakpoint
-- Platform-level privilege model: no default access; runtime privileges only
-- for audit_service (grants: read + append + approve/revoke updates; log:
-- read + append). beaconhs_app/beaconhs_super get NOTHING — grant management
-- and access-log writes go through the dedicated audit connection.
REVOKE ALL ON audit_access_grants FROM PUBLIC;
REVOKE ALL ON platform_audit_access_log FROM PUBLIC;
