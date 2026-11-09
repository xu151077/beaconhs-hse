-- Repair the seeded "Weekly Monitored Sessions" report definition.
--
-- The original projection listed the technical UUID columns
-- `subject_person_id` and `site_org_unit_id`. AppKit's custom-query compiler
-- rejects hidden/technical identifier columns, so opening or scheduling the
-- built-in report failed with "Report query references internal columns".
-- Rewrite only that seed-owned definition to the display columns carrying the
-- same information. Idempotent: rows already repaired are untouched.
--
-- report_definitions is FORCE RLS: the schema-owner migration login cannot see
-- tenant rows without app.tenant_id. Loop every tenant and set the GUC for the
-- update, then clear it.
DO $$
DECLARE
  tenant_row record;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_row.id::text, true);
    UPDATE "report_definitions"
    SET "query" = jsonb_set(
      "query",
      '{columns}',
      '["subject_person_name","site_name","monitor_status","created_at","last_checkin_at","next_checkin_due_at","expected_end_at"]'::jsonb,
      false
    )
    WHERE "tenant_id" = tenant_row.id
      AND "seed_key" = 'monitored_sessions_weekly'
      AND "query"->'columns' @> '["subject_person_id"]'::jsonb;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
