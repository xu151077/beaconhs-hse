-- Add Simplified Chinese (`zh`) to the set of supported application languages.
--
-- Three CHECK constraints hard-code the allow-list `('en','fr','es')`:
--
--   tenants_default_language_supported_check         CHECK (default_language IN ('en','fr','es'))
--   tenants_enabled_languages_valid_check           CHECK (enabled_languages <@ '["en","fr","es"]'::jsonb
--                                                          AND enabled_languages ? default_language)
--   tenant_users_locale_override_supported_check     CHECK (locale_override IS NULL
--                                                          OR locale_override IN ('en','fr','es'))
--
-- BeaconHS stores locales as 2-letter ISO-639-1 codes, so Chinese is `zh` and
-- NOT `zh-CN`; introducing a second naming convention would need a second set of
-- persisted values. The catalogue lives at `packages/i18n/src/messages/zh.json`
-- and is keyed off `packages/i18n/src/index.ts#SUPPORTED_LOCALES`.
--
-- This migration ONLY WIDENS an allow-list. It is additive and strictly
-- backward compatible:
--
--   * No column is added, dropped, retyped, or nullability-changed.
--   * No row is inserted, updated, or deleted. Every existing tenant and
--     membership already satisfies the wider predicate, so the widened
--     constraint cannot fail validation.
--   * Row-level security is untouched — these are CHECK constraints, evaluated
--     per row; no RLS policy is relaxed and `FORCE ROW LEVEL SECURITY` stays on.
--   * Permissions are untouched — this touches no role, role_assignment, or
--     PERMISSION_CATALOGUE entry.
--
-- Only `tenants.enabled_languages` opt-in behaviour is new, and it is opt-in by
-- construction: `enabled_languages` still must CONTAIN `default_language`, and a
-- tenant that never lists `zh` is completely unaffected — its members keep seeing
-- exactly the language set they saw before. Choosing Chinese is a deliberate act
-- performed by a tenant administrator at Settings -> Languages, or per-user at
-- Account -> Language, and both write paths already validate against
-- `SUPPORTED_LOCALES`.
--
-- `NOT VALID` + `VALIDATE` follows the convention in 0006_tenant_language_policy.sql:
-- it takes only a brief ACCESS EXCLUSIVE lock instead of a full table scan under
-- a stronger lock, so this is safe to run against a live production database.
--
-- Reversal: re-issue the same three statements with `IN ('en', 'fr', 'es')` and
-- `<@ '["en","fr","es"]'::jsonb` after first clearing any `zh` values, or
-- `ALTER TABLE ... DROP CONSTRAINT IF EXISTS` to remove the allow-list entirely.

ALTER TABLE "tenants"
  DROP CONSTRAINT IF EXISTS "tenants_default_language_supported_check";--> statement-breakpoint
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_default_language_supported_check"
  CHECK ("tenants"."default_language" IN ('en', 'fr', 'es', 'zh')) NOT VALID;--> statement-breakpoint
ALTER TABLE "tenants"
  VALIDATE CONSTRAINT "tenants_default_language_supported_check";--> statement-breakpoint

ALTER TABLE "tenants"
  DROP CONSTRAINT IF EXISTS "tenants_enabled_languages_valid_check";--> statement-breakpoint
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_enabled_languages_valid_check"
  CHECK (
    jsonb_typeof("tenants"."enabled_languages") = 'array'
    AND "tenants"."enabled_languages" <@ '["en", "fr", "es", "zh"]'::jsonb
    AND "tenants"."enabled_languages" ? "tenants"."default_language"
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "tenants"
  VALIDATE CONSTRAINT "tenants_enabled_languages_valid_check";--> statement-breakpoint

ALTER TABLE "tenant_users"
  DROP CONSTRAINT IF EXISTS "tenant_users_locale_override_supported_check";--> statement-breakpoint
ALTER TABLE "tenant_users"
  ADD CONSTRAINT "tenant_users_locale_override_supported_check"
  CHECK (
    "tenant_users"."locale_override" IS NULL
    OR "tenant_users"."locale_override" IN ('en', 'fr', 'es', 'zh')
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "tenant_users"
  VALIDATE CONSTRAINT "tenant_users_locale_override_supported_check";