-- D8 resolution, part 1: drop nine redundant single-column foreign keys and
-- install one tenant-attachment FK that was never installed.
--
-- A live-database audit (Postgres pg_constraint vs drizzle/meta/0054_snapshot.json)
-- found 82 foreign keys in Postgres that the snapshot chain does not record.
-- They break down as:
--
--   * 67 composite `ON DELETE SET NULL (col)` keys (32 attachment keys plus 35
--     tenant keys). The partial form is required because tenant_id is NOT NULL
--     (a full SET NULL would try to null tenant_id too). Drizzle cannot express
--     partial SET NULL, so these are intentionally SQL-only: the attachment keys
--     are owned by ATTACHMENT_TENANT_REFERENCES in packages/db/src/attachment-integrity.ts,
--     the document/equipment keys by their relational-integrity manifest tests.
--     Declaring them in schema would misrepresent their semantics.
--   * 6 attachment composite CASCADE keys, owned by the same attachment manifest.
--   * 9 single-column CASCADE keys that are exact semantic duplicates of
--     composite tenant keys that ARE declared in schema and recorded in the
--     snapshot. Those composites subsume the singles (same CASCADE behaviour;
--     e.g. ai_conversation_shares_tenant_user_fk already guarantees the target
--     exists via tenant_users.user_id -> "user".id). The singles are leftovers
--     of 0000_init / 0003 rename normalization, never recorded in any snapshot.
--     This migration drops them so the physical database converges to the
--     snapshot; no schema or snapshot change is needed for the drops.
--
-- The same audit found the reverse gap: ATTACHMENT_TENANT_REFERENCES names
-- att_tenant_ppe_inspection_attachments_attachment_id_3b75c366 (onDelete
-- 'cascade') for ppe_inspection_attachments.attachment_id, but the table was
-- created in 0005_production_cutover without ever installing that key, so the
-- column had no tenant-integrity FK at all. It is installed below following the
-- 0004 pattern (ADD ... NOT VALID, then VALIDATE). On a database holding
-- cross-tenant rows for that column the VALIDATE would fail closed; the
-- pre-launch baseline has a clean column.
--
-- The residual 73 + 1 SQL-only keys remain intentionally unrecorded in the
-- snapshot chain. packages/db/src/fk-snapshot-coverage.test.ts pins them as an
-- allowlist so this classification is regression-tested, not discoverable only
-- by re-running a live-database audit.
ALTER TABLE "ai_conversation_shares" DROP CONSTRAINT IF EXISTS "ai_conversation_shares_conversation_id_ai_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "ai_conversation_shares" DROP CONSTRAINT IF EXISTS "ai_conversation_shares_target_role_id_roles_id_fk";--> statement-breakpoint
ALTER TABLE "ai_conversation_shares" DROP CONSTRAINT IF EXISTS "ai_conversation_shares_target_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP CONSTRAINT IF EXISTS "ai_messages_conversation_id_ai_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "report_runs" DROP CONSTRAINT IF EXISTS "report_runs_schedule_id_report_schedules_id_fk";--> statement-breakpoint
ALTER TABLE "role_assignments" DROP CONSTRAINT IF EXISTS "role_assignments_role_id_roles_id_fk";--> statement-breakpoint
ALTER TABLE "role_assignments" DROP CONSTRAINT IF EXISTS "role_assignments_tenant_user_id_tenant_users_id_fk";--> statement-breakpoint
ALTER TABLE "role_dashboard_layouts" DROP CONSTRAINT IF EXISTS "role_dashboard_layouts_role_id_roles_id_fk";--> statement-breakpoint
ALTER TABLE "user_permission_overrides" DROP CONSTRAINT IF EXISTS "user_permission_overrides_tenant_user_id_tenant_users_id_fk";--> statement-breakpoint
ALTER TABLE "ppe_inspection_attachments" ADD CONSTRAINT "att_tenant_ppe_inspection_attachments_attachment_id_3b75c366" FOREIGN KEY ("tenant_id", "attachment_id") REFERENCES "attachments" ("tenant_id", "id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "ppe_inspection_attachments" VALIDATE CONSTRAINT "att_tenant_ppe_inspection_attachments_attachment_id_3b75c366";
