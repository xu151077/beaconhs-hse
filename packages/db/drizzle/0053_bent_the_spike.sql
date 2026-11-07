-- EA-66D.23: bounded outbox retries + indexes for scope-filter columns.
-- Forward-only: no column/table drops, no data rewrite. Idempotent so a
-- re-run after a partial failure is safe.

-- A poison domain event (invalid payload, rejected web command, deleted
-- subject) used to be released back to `pending` forever, occupying the
-- oldest batch slot every hour. `dead` is terminal: the drain query only
-- claims `pending`/`publishing`, so these rows stop consuming retries and
-- become visible to operators.
ALTER TYPE "public"."domain_event_outbox_status" ADD VALUE IF NOT EXISTS 'dead';--> statement-breakpoint

-- Site/person scope predicates run after RLS narrows to the tenant; without
-- these indexes they scan every row for that tenant.
CREATE INDEX IF NOT EXISTS "corrective_actions_site_idx" ON "corrective_actions" USING btree ("tenant_id","site_org_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_supervisor_idx" ON "journal_entries" USING btree ("tenant_id","supervisor_person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safe_distance_records_operator_idx" ON "safe_distance_records" USING btree ("tenant_id","operator_person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safe_distance_records_supervisor_idx" ON "safe_distance_records" USING btree ("tenant_id","supervisor_tenant_user_id");
