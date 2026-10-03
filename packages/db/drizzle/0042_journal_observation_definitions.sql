-- Safety observations are a CLASSIFICATION of a journal entry, not a second
-- table. `journal_entries` already carries everything an observation needs:
-- the JRN reference series, entry_date (when observed), site_org_unit_id, the
-- reporter/subject (person_id) and the typed author (created_by_tenant_user_id),
-- title + body_text, the draft/submitted/archived lifecycle, tags, photos via
-- journal_entry_photos -> attachments, full-text search, soft delete, audit and
-- the journals read tiers / journalScopeWhere.
--
-- 'observation' is already a value of corrective_actions.source and the journals
-- flow adapter already spawns CAs with it, so an observation can already raise a
-- corrective action through the existing polymorphic source link
-- (source_entity_type = 'journal_entry', source_entity_id = <id>). This
-- migration only adds the two definitions that let a journal entry BE an
-- observation.
--
-- The two added values are disjoint from 'worker' / 'supervisor', so the existing
-- daily-journal rows are untouched and every journal query that filters on
-- definition IN ('worker','supervisor') keeps its exact meaning.
ALTER TYPE "journal_definition" ADD VALUE IF NOT EXISTS 'positive_observation';--> statement-breakpoint
ALTER TYPE "journal_definition" ADD VALUE IF NOT EXISTS 'negative_observation';
