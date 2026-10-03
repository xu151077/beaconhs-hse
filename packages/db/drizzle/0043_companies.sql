-- Contractor / subcontractor company association.
--
-- A company is an EMPLOYER — the legal party a person works for — and this is the
-- minimum structure needed to record that association. It is deliberately NOT an
-- `org_units` row: `org-hierarchy.ts` brands the whole `org_unit_level` tree as
-- "Location", and its `site` / `project` levels feed `RoleScope.siteIds`, so
-- storing employers there would leak a business-data relationship into the
-- authorization ladder. `data_sources` reference rows can hold a curated
-- contractor list, but they are untyped, carry no people association, and cannot
-- be joined or counted by reports.
--
-- `people.company_id` is NULLABLE and added without a default, so this is a
-- metadata-only ALTER on PostgreSQL 11+ and every existing person stays valid with
-- no company. One company per person (a nullable column, not a join table).
--
-- The composite foreign key `people_tenant_company_fk` targets
-- `companies (tenant_id, id)`, exactly like the existing department / trade / crew
-- keys. Because it includes `tenant_id`, a person referencing another tenant's
-- company is structurally impossible, not merely rejected in application code.
--
-- `ON DELETE no action` matches `people_tenant_department_fk`: the action layer
-- refuses to remove a company that still has people, so an employer never
-- silently disappears from under its workforce. Deleting a tenant cascades both
-- sides, so tenant teardown is unaffected.
--
-- There is deliberately no `deleted_at`: the sibling people taxonomies
-- (`departments`, `trades`, `crews`) delete for real, and a soft-delete column
-- with no archived filter and no restore action would be a one-way door.
--
-- Row-level security is not in this file: `companies` is registered in
-- `TENANT_SCOPED_TABLES`, and `migrate.ts` installs the tenant policy for every
-- registered table after the migration chain has run.

DO $$
BEGIN
  CREATE TYPE "public"."company_type" AS ENUM('contractor', 'subcontractor');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "companies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "type" "company_type" DEFAULT 'contractor' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companies_name_nonblank_ck" CHECK (lower(btrim(regexp_replace(normalize("companies"."name", NFKC), '[[:space:]]+', ' ', 'g'))) <> '')
);

ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "company_id" uuid;

DO $$
BEGIN
  ALTER TABLE "companies"
    ADD CONSTRAINT "companies_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Referenced by people_tenant_company_fk below, which needs an exact (tenant_id,
-- id) unique key to target. Same reason every sibling catalog carries one.
CREATE UNIQUE INDEX IF NOT EXISTS "companies_tenant_id_id_ux"
  ON "companies" USING btree ("tenant_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "companies_tenant_normalized_name_ux"
  ON "companies" USING btree ("tenant_id", lower(btrim(regexp_replace(normalize("name", NFKC), '[[:space:]]+', ' ', 'g'))));

CREATE INDEX IF NOT EXISTS "companies_tenant_idx"
  ON "companies" USING btree ("tenant_id");

CREATE INDEX IF NOT EXISTS "companies_tenant_type_idx"
  ON "companies" USING btree ("tenant_id", "type");

DO $$
BEGIN
  ALTER TABLE "people"
    ADD CONSTRAINT "people_tenant_company_fk"
    FOREIGN KEY ("tenant_id", "company_id")
    REFERENCES "public"."companies"("tenant_id", "id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "people_company_idx"
  ON "people" USING btree ("tenant_id", "company_id");