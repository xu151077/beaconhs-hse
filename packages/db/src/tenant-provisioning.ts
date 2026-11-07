// Tenant provisioning — the single write path that turns a name into a workspace.
//
// WHY THIS FILE EXISTS
//
// Until now the only code that could create a tenant was the `/platform/tenants/new`
// server action, and its database logic lived inline in that page. That made the
// product's definition of "a provisioned tenant" implicit and unreachable from
// anywhere else: a fresh production database has no tenant, `getRequestContext()`
// returns `null` for a super-admin while no active tenant exists, and the very page
// that would fix it is gated behind `requireRequestContext()`. The platform could not
// create its own first workspace.
//
// This module extracts that logic verbatim so there is ONE implementation, shared by
// the UI (tenants 2..N and every tenant thereafter) and the operator CLI
// (`scripts/provision-first-tenant.cli.ts`, for the first tenant of a greenfield
// database). Adding the CLI without this extraction would have produced a second,
// silently-divergent copy of tenant creation.
//
// THE PROVISIONING CONTRACT — what a tenant is, and is not
//
// Creating a tenant means all of the following, inside ONE transaction, so a failure at
// any step can never leave a half-provisioned workspace:
//
//   1. the `tenants` row
//   2. the built-in roles (`ensureBuiltinRoles`) — without these the tenant is
//      unusable: `roles` is the only way a non-super-admin can hold a permission, and
//      `/admin/users` reads its role picker from that table
//   3. the reference catalogue (`seedTenantReferenceData`) — document types, PPE types
//      and their inspection criteria, the HAZID libraries, training assessment types,
//      and the incident taxonomy
//   4. a day-one `audit_log` entry, written in the NEW tenant's own log so the
//      activity timeline shows "tenant created" on day one — a platform super-admin
//      action otherwise has no natural home in any tenant's log
//   5. the built-in Lift Plan form template, the one template the product designates
//      as required on day one (`seedLiftPlanTemplate`, idempotent on
//      `(tenant_id, key)`)
//   6. completeness assertions on both the roles and the catalogue, still inside the
//      transaction
//   7. the tenant's storage freeze row (`ensureFreezeRow`), inserted immediately
//      after the `tenants` row — the storage write gate fails closed unless it can
//      read exactly one freeze row for the tenant, so a tenant provisioned without
//      one could not accept a single controlled write until an operator intervened
//
// Note that step 3 also produces three further form templates — the HAZID embedded
// builder apps (confined-space entry, arc-flash work, fall protection). They are not
// optional extras: `hazid_assessment_type_apps.template_id` is a foreign key, so a
// tenant with the HAZID library but without those templates would have an unlinked
// library. A provisioned tenant therefore has 4 form templates, not 1. The four
// canonical demo templates (JSHA, Toolbox Talk, Lift Plan, WAH Rescue Plan) are NOT
// provisioned — they remain first-tenant-only demo content owned by `seed.ts`.
//
// What it deliberately does NOT do — this is not demo seeding, and the distinction is
// load-bearing. The remaining per-tenant seeders in `seed/` (report definitions,
// toolbox, hazard assessment app templates) are DEMO FIXTURES or optional business
// initialisation and are not run: they write demo business records, org units,
// people or notifications.
//
// INSPECTION BANKS AND TYPES ARE SEEDED HERE, NOW THAT THEY ARE REFERENCE DATA
//
// They used to be deferred: `seedInspectionTypes` read `inspection_banks`, and
// the banks were created inline in the demo flow against a demo admin, so a
// provisioned tenant would have ended up with types and no criteria. Both now
// live in idempotent reference modules (`seed/inspection-banks.ts`,
// `seed/inspection-types.ts`), so the deferred note is gone and the types come
// with their checklists.

// There is no database trigger on `tenants` and no other invariant to satisfy: the
// only structural requirements are `tenants_slug_ux` and the two CHECK constraints on
// `default_language` / `enabled_languages`.
//
// NO MEMBERSHIP IS CREATED
//
// Neither path has ever created one. `tenant_users` rows come only from
// `/admin/users`, `/platform/users` and the demo seed. And none is needed: for a
// super-admin, `getRequestContext()` orders `(tenantUsers.id is null)` FIRST, so a
// platform administrator with no membership in a workspace still resolves a working
// context and can administer it. Provisioning a membership here would invent an
// authorization relationship the product does not have.
//
// WHY THIS NEEDS THE SUPERADMIN CREDENTIAL
//
// `tenants` is the RLS scope root and is not itself RLS-protected, so the row insert
// alone would run on the runtime role. The `audit_log` row is the reason this needs
// `withSuperAdmin`: `audit_log` is a FORCE-RLS tenant-scoped table, and the tenant it
// must reference has just been created, so the runtime role has no possible RLS scope
// for it. This is not a privilege expansion — it is the same call the UI action has
// always made — but it does mean an operator running the CLI must have
// `SUPERADMIN_DATABASE_URL` present. That is inherited from the existing primitive,
// not chosen here.

import { and, eq, inArray } from 'drizzle-orm'
import { db, type Database } from './client'
import { withSuperAdmin } from './rls'
import { ensureFreezeRow } from './storage-freeze-operations'
import {
  auditLog,
  documentCategories,
  documentTypes,
  hazidAssessmentTypes,
  hazidHazardTypes,
  hazidHazards,
  hazidTasks,
  incidentClassifications,
  incidentInjuryTypes,
  ppeCriteriaBanks,
  emailTemplates,
  dataSources,
  inspectionBanks,
  inspectionTypeCriteria,
  inspectionTypes,
  equipmentTypes,
  personGroups,
  ppeTypeInspectionCriteria,
  ppeTypes,
  roles,
  tenants,
  trainingAssessmentTypeQuestions,
  trainingAssessmentTypes,
  trainingSkillTypes,
  users,
} from './schema'
import { BUILTIN_ROLES } from './schema/iam'
import { seedLiftPlanTemplate } from './seed/lift-plan-template'
import { seedDocumentTypesAndCategories } from './seed/document-types-and-categories'
import { seedHazidLibraries } from './seed/hazid-libraries'
import { seedIncidentTaxonomy } from './seed/incident-taxonomy'
import { INCIDENT_CLASSIFICATION_SEED, INCIDENT_INJURY_TYPE_SEED } from './seed/incident-taxonomy'
import { seedPpeTypesWithCriteria } from './seed/ppe-types'
import { seedTrainingAssessmentTypes } from './seed/training-assessment-types'
import { seedInspectionBanks } from './seed/inspection-banks'
import { seedInspectionTypes } from './seed/inspection-types'
import { seedPersonGroups } from './seed/person-groups'
import { seedSkillCatalogue } from './seed/skill-catalogue'
import { seedPhase11EEquipment } from './seed/phase11e-equipment'
import { seedPhase11EDocumentCategories } from './seed/phase11e-document-categories'
import { seedPhase11ERegisterApps } from './seed/phase11e-register-apps'
import { seedPdfTemplates, seedFormPdfTemplates } from './seed/pdf-templates'
import { seedWorkPermitTemplate } from './seed/work-permit-template'
import { seedToolboxTemplate } from './seed/toolbox-template'
import { seedPpeCriteriaBanks } from './seed/ppe-criteria-banks'
import { seedEmailTemplates } from './seed/email-templates'
import { seedDataSources } from './seed/data-sources'

/**
 * The tenant slug, derived exactly as the product has always derived it.
 *
 * Extracted from `/platform/tenants/new` so the UI and the CLI cannot drift. The
 * output is user-visible and load-bearing: it appears in the tenant URL, in the
 * kiosk sign-in link `/kiosk?t=<slug>`, and in printed documents, so a CLI that
 * slugified differently from the UI would hand an operator two different answers for
 * the same company name.
 *
 * Note this is deliberately NOT one of the repo's several other `slugify` helpers —
 * those differ in separator, truncation length and fallback (for example
 * `admin/roles` produces `_`-separated keys capped at 48, `apps/_lib/slug` produces
 * `_`-separated capped at 60). Reconciling those is separate work and out of scope
 * here; this function only pins the tenant behaviour.
 */
export function slugifyTenantSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** `tenants.status` values a platform administrator may provision against. */
export type ProvisionTenantInput = {
  name: string
  /** Explicit slug. Derived from `name` when omitted. */
  slug?: string | null
  region?: string
  defaultLanguage: string
  enabledLanguages: string[]
  /**
   * Recorded as the actor on the day-one audit row. A super-admin passes their own
   * user id. Pass `null` only when no authenticated actor exists — the CLI resolves
   * the single bootstrap super-admin for exactly this.
   */
  actorUserId: string | null
}

export type ProvisionedTenant = {
  id: string
  name: string
  slug: string
  region: string
  defaultLanguage: string
  enabledLanguages: string[]
}

function assertProvisionInput(input: ProvisionTenantInput): void {
  const name = input.name.trim()
  if (!name) throw new Error('A tenant name is required.')

  const slug = input.slug ? slugifyTenantSlug(input.slug) : slugifyTenantSlug(name)
  if (!slug) {
    throw new Error(
      `"${name}" contains no characters a tenant slug can use (a-z, 0-9, -, _). Pass an explicit --slug.`,
    )
  }

  if (!input.defaultLanguage) throw new Error('A default language is required.')
  if (!Array.isArray(input.enabledLanguages) || input.enabledLanguages.length === 0) {
    throw new Error('At least one enabled language is required.')
  }
  if (!input.enabledLanguages.includes(input.defaultLanguage)) {
    // Mirrors `tenants_enabled_languages_valid_check`, so the failure is a readable
    // message here instead of a constraint violation from Postgres.
    throw new Error(
      `The default language "${input.defaultLanguage}" must be one of the enabled languages.`,
    )
  }
}

/**
 * Ensure every built-in role exists for a tenant.
 *
 * WHY THIS MOVED HERE, AND WHY IT IS GUARDED
 *
 * The demo seed used to own this loop inline, inside its first-run-only bootstrap.
 * That made the loop's idempotency accidental: the `insert` was bare, with no
 * `onConflict` and no local guard, and the only thing stopping a second run from raising
 * `roles_tenant_key_ux` was the demo tenant's early `return` further up. Lifting the
 * loop into tenant provisioning meant the bare `insert` could no longer be copied — a
 * second tenant, or a re-run, would have failed on the unique index.
 *
 * So the loop moved here and gained a real guard, and `seed.ts` now calls THIS function
 * instead of keeping a second copy. One implementation, idempotent by construction.
 *
 * The guard is `onConflictDoNothing` on `(tenantId, key)` — the same target
 * `seedCanonicalTemplates` and `ensureTemplate` already use. Its properties are exactly
 * the ones provisioning needs:
 *
 *   - an existing built-in role is left AS IT IS, including any permission an
 *     administrator deliberately curated. Not overwritten, not merged here.
 *   - a CUSTOM role in the same tenant is never touched, whatever its key.
 *   - another tenant's roles are unreachable: every predicate carries `tenantId`.
 *
 * Permission drift is not this function's job. `db:migrate`'s `convergeRolePermissions`
 * already unions every built-in role in every tenant with the `BUILTIN_ROLES` baseline,
 * so a permission added to `BUILTIN_ROLES` later reaches every provisioned tenant on the
 * next migrate. This only guarantees the ROW exists.
 *
 * Reads `BUILTIN_ROLES` directly — the single source of truth. Role names, descriptions
 * and permission arrays are never restated here, and no permission key, role definition
 * or `RoleScope` variant is introduced.
 */
export async function ensureBuiltinRoles(tx: Database, tenantId: string): Promise<void> {
  for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
    await tx
      .insert(roles)
      .values({
        tenantId,
        key,
        name: def.name,
        description: def.description,
        isBuiltIn: true,
        permissions: def.permissions as unknown as string[],
      })
      .onConflictDoNothing({ target: [roles.tenantId, roles.key] })
  }
}

/**
 * Prove every built-in role is present for this tenant, or refuse to finish.
 *
 * Modelled on the demo seed's post-run completeness check, with one deliberate
 * difference: the seed throws AFTER its transaction has committed, because the seed is
 * first-run-only and has no earlier state to protect. Here the check runs INSIDE the
 * provisioning transaction, so a missing role rolls the tenant, its roles, its day-one
 * audit row and its template back together. A half-initialised tenant with no roles is
 * precisely the unusable state this change exists to prevent, so it must not be able to
 * commit.
 *
 * Expected keys come from `BUILTIN_ROLES` rather than a literal list, so the assertion
 * cannot drift from the definitions.
 */
export async function assertBuiltinRolesComplete(tx: Database, tenantId: string): Promise<void> {
  const expected = Object.keys(BUILTIN_ROLES)
  const found = (await tx
    .select({ key: roles.key, isBuiltIn: roles.isBuiltIn })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), inArray(roles.key, expected)))) as unknown as Array<{
    key: string
    isBuiltIn: boolean
  }>

  const present = new Map(found.map((row) => [row.key, row.isBuiltIn]))
  const missing = expected.filter((key) => !present.has(key))
  const notBuiltIn = expected.filter((key) => present.get(key) === false)

  if (missing.length === 0 && notBuiltIn.length === 0) return

  const problems = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    notBuiltIn.length > 0 ? `present but not built-in: ${notBuiltIn.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')

  throw new Error(
    `Tenant provisioning did not produce a complete built-in role set (${problems}). ` +
      'The transaction was rolled back, so no tenant was created.',
  )
}

/**
 * The per-tenant reference catalogue a new tenant starts with.
 *
 * WHAT "REFERENCE DATA" MEANS HERE, PRECISELY
 *
 * These are the picklists and checklists a tenant needs before anyone can record
 * anything: document types, the PPE catalogue with what an inspector checks on each
 * item, the HAZID hazard and task libraries, training assessment types, and the
 * incident classification hierarchy. They are tenant-scoped configuration, not
 * business records — the equivalent of a chart of accounts rather than a transaction.
 *
 * They are also the ONE class of optional initialisation that is safe to apply to every
 * tenant, because each is pure append-only reference content that an administrator can
 * edit afterwards and that no other table has a hard foreign key into. The remaining
 * seeders in `seed/` are demo fixtures and stay out — see the header note.
 *
 * Every one of these is the SAME exported function `seed.ts` calls. The catalogue
 * content has exactly one source of truth in the repository; provisioning does not
 * carry a second copy of any data array, and cannot drift from what the demo seed
 * produces.
 *
 * NO BUSINESS RECORDS ARE WRITTEN
 *
 * No `user`, `tenant_users`, `people`, `org_units`, no incidents, no inspections, no
 * equipment, no training history, and no audit rows beyond the tenant's own
 * day-one "created" entry. In particular the demo incident back-fill, the fabricated
 * hours-worked windows and the demo injury assignments were deliberately left in
 * `seed.ts` when the incident taxonomy was split out — a production tenant's TRIR
 * denominator must come from real timekeeping, not from a seeder.
 */
async function seedTenantReferenceData(tx: Database, tenantId: string): Promise<void> {
  await seedDocumentTypesAndCategories(tx as never, tenantId)
  await seedPpeTypesWithCriteria(tx as never, tenantId)
  await seedHazidLibraries(tx as never, tenantId)
  await seedTrainingAssessmentTypes(tx as never, tenantId)
  await seedIncidentTaxonomy(tx as never, tenantId)
  // Inspection banks first: inspection types import their criteria from them.
  await seedInspectionBanks(tx as never, tenantId)
  await seedInspectionTypes(tx as never, tenantId)
  await seedPersonGroups(tx as never, tenantId)
  await seedSkillCatalogue(tx as never, tenantId)
  // Equipment catalogue + register apps + print templates. Every one of these
  // is already proven add-only for every tenant on every seed run (see the
  // per-tenant stages in seed.ts), so provisioning reuses them instead of
  // leaving a tenant with empty Categories/Types/Library screens.
  await seedPhase11EEquipment(tx as never, tenantId)
  await seedPhase11EDocumentCategories(tx as never, tenantId)
  await seedPhase11ERegisterApps(tx as never, tenantId)
  await seedPdfTemplates(tx as never, tenantId)
  await seedFormPdfTemplates(tx as never, tenantId)
  await seedWorkPermitTemplate(tx as never, tenantId)
  await seedToolboxTemplate(tx as never, tenantId)
  await seedPpeCriteriaBanks(tx as never, tenantId)
  await seedEmailTemplates(tx as never, tenantId)
  await seedDataSources(tx as never, tenantId)
}

/**
 * Prove every reference catalogue actually holds rows for this tenant, or roll back.
 *
 * WHY NON-EMPTY RATHER THAN AN EXACT COUNT
 *
 * These catalogues are admin-editable, so "exactly 41 rows" would be a claim about a
 * moving target and would fail provisioning for a tenant that legitimately deleted a
 * hazard type. What must hold is the weaker and more useful invariant: the seeder ran
 * and produced content. That is the failure this catches — a seeder that silently
 * no-ops. `seedTrainingAssessmentTypes` is the live example: it returns early when the
 * tenant already has ANY assessment type, and `seedHazidLibraries` links to rows by
 * name, so both can legitimately produce nothing without an error being raised.
 *
 * Runs inside the provisioning transaction, for the same reason
 * `assertBuiltinRolesComplete` does: a tenant with an empty catalogue is not the state
 * this change is trying to produce, and half of it must not be able to commit.
 *
 * The catalogue list is asserted catalogue-by-catalogue rather than by row count, and
 * the incident half additionally asserts the exact standard classification set, because
 * that one IS exported as source data and can be checked key-for-key without inventing
 * an expected number.
 */
async function assertReferenceDataComplete(tx: Database, tenantId: string): Promise<void> {
  const catalogues: { label: string; count: number }[] = []

  const countOf = async (
    label: string,
    read: (t: Database) => Promise<{ id: string }[]>,
  ): Promise<void> => {
    const rows = await read(tx)
    catalogues.push({ label, count: rows.length })
  }

  await countOf('document types', (t) =>
    t
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.tenantId, tenantId)),
  )
  await countOf('document categories', (t) =>
    t
      .select({ id: documentCategories.id })
      .from(documentCategories)
      .where(eq(documentCategories.tenantId, tenantId)),
  )
  await countOf('PPE types', (t) =>
    t.select({ id: ppeTypes.id }).from(ppeTypes).where(eq(ppeTypes.tenantId, tenantId)),
  )
  await countOf('PPE inspection criteria', (t) =>
    t
      .select({ id: ppeTypeInspectionCriteria.id })
      .from(ppeTypeInspectionCriteria)
      .where(eq(ppeTypeInspectionCriteria.tenantId, tenantId)),
  )
  await countOf('HAZID hazard types', (t) =>
    t
      .select({ id: hazidHazardTypes.id })
      .from(hazidHazardTypes)
      .where(eq(hazidHazardTypes.tenantId, tenantId)),
  )
  await countOf('HAZID hazards', (t) =>
    t.select({ id: hazidHazards.id }).from(hazidHazards).where(eq(hazidHazards.tenantId, tenantId)),
  )
  await countOf('HAZID tasks', (t) =>
    t.select({ id: hazidTasks.id }).from(hazidTasks).where(eq(hazidTasks.tenantId, tenantId)),
  )
  await countOf('HAZID assessment types', (t) =>
    t
      .select({ id: hazidAssessmentTypes.id })
      .from(hazidAssessmentTypes)
      .where(eq(hazidAssessmentTypes.tenantId, tenantId)),
  )
  await countOf('training assessment types', (t) =>
    t
      .select({ id: trainingAssessmentTypes.id })
      .from(trainingAssessmentTypes)
      .where(eq(trainingAssessmentTypes.tenantId, tenantId)),
  )
  await countOf('training assessment questions', (t) =>
    t
      .select({ id: trainingAssessmentTypeQuestions.id })
      .from(trainingAssessmentTypeQuestions)
      .where(eq(trainingAssessmentTypeQuestions.tenantId, tenantId)),
  )
  await countOf('incident classifications', (t) =>
    t
      .select({ id: incidentClassifications.id })
      .from(incidentClassifications)
      .where(eq(incidentClassifications.tenantId, tenantId)),
  )
  await countOf('incident injury types', (t) =>
    t
      .select({ id: incidentInjuryTypes.id })
      .from(incidentInjuryTypes)
      .where(eq(incidentInjuryTypes.tenantId, tenantId)),
  )

  await countOf('inspection banks', (t) =>
    t
      .select({ id: inspectionBanks.id })
      .from(inspectionBanks)
      .where(eq(inspectionBanks.tenantId, tenantId)),
  )
  await countOf('inspection types', (t) =>
    t
      .select({ id: inspectionTypes.id })
      .from(inspectionTypes)
      .where(eq(inspectionTypes.tenantId, tenantId)),
  )
  await countOf('inspection type criteria', (t) =>
    t
      .select({ id: inspectionTypeCriteria.id })
      .from(inspectionTypeCriteria)
      .where(eq(inspectionTypeCriteria.tenantId, tenantId)),
  )
  await countOf('equipment types', (t) =>
    t
      .select({ id: equipmentTypes.id })
      .from(equipmentTypes)
      .where(eq(equipmentTypes.tenantId, tenantId)),
  )
  await countOf('person groups', (t) =>
    t.select({ id: personGroups.id }).from(personGroups).where(eq(personGroups.tenantId, tenantId)),
  )
  await countOf('skill types', (t) =>
    t
      .select({ id: trainingSkillTypes.id })
      .from(trainingSkillTypes)
      .where(eq(trainingSkillTypes.tenantId, tenantId)),
  )

  await countOf('PPE criteria banks', (t) =>
    t
      .select({ id: ppeCriteriaBanks.id })
      .from(ppeCriteriaBanks)
      .where(eq(ppeCriteriaBanks.tenantId, tenantId)),
  )
  await countOf('email templates', (t) =>
    t
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(eq(emailTemplates.tenantId, tenantId)),
  )
  await countOf('data sources', (t) =>
    t.select({ id: dataSources.id }).from(dataSources).where(eq(dataSources.tenantId, tenantId)),
  )

  const empty = catalogues.filter((c) => c.count === 0).map((c) => c.label)

  // Key-for-key on the incident taxonomy only, because it is the one catalogue whose
  // expected contents are exported as data rather than implied.
  const expectedClassifications = INCIDENT_CLASSIFICATION_SEED.map((c) => c.name)
  const expectedInjuryTypes = INCIDENT_INJURY_TYPE_SEED.map((i) => i.name)
  const classificationNames = new Set(
    (
      (await tx
        .select({ name: incidentClassifications.name })
        .from(incidentClassifications)
        .where(eq(incidentClassifications.tenantId, tenantId))) as unknown as Array<{
        name: string
      }>
    ).map((r) => r.name),
  )
  const injuryTypeNames = new Set(
    (
      (await tx
        .select({ name: incidentInjuryTypes.name })
        .from(incidentInjuryTypes)
        .where(eq(incidentInjuryTypes.tenantId, tenantId))) as unknown as Array<{ name: string }>
    ).map((r) => r.name),
  )
  const missingClassifications = expectedClassifications.filter((n) => !classificationNames.has(n))
  const missingInjuryTypes = expectedInjuryTypes.filter((n) => !injuryTypeNames.has(n))

  if (
    empty.length === 0 &&
    missingClassifications.length === 0 &&
    missingInjuryTypes.length === 0
  ) {
    return
  }

  const problems = [
    empty.length > 0 ? `empty: ${empty.join(', ')}` : '',
    missingClassifications.length > 0
      ? `missing classifications: ${missingClassifications.join(', ')}`
      : '',
    missingInjuryTypes.length > 0 ? `missing injury types: ${missingInjuryTypes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')

  throw new Error(
    `Tenant provisioning produced an incomplete reference catalogue (${problems}). ` +
      'The transaction was rolled back, so no tenant was created.',
  )
}

/**
 * Create one tenant, atomically, on an already-open superadmin transaction.
 *
 * Takes the transaction rather than opening one so the caller controls the
 * transaction boundary — the UI wants it inside `withSuperAdmin`, and the first-tenant
 * CLI wants to assert "no tenant exists yet" in the SAME transaction before calling
 * this, so the guard and the insert cannot be interleaved by a concurrent operator.
 */
export async function insertProvisionedTenant(
  tx: Database,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  assertProvisionInput(input)

  const name = input.name.trim()
  const slug = input.slug ? slugifyTenantSlug(input.slug) : slugifyTenantSlug(name)
  const region = (input.region ?? '').trim() || 'ca-central-1'
  // The platform form offers a fixed catalogue of regions. Keep the server-side
  // funnel honest too: an out-of-catalogue region is a data-integrity error,
  // not a tenant variant. The list mirrors apps/web/src/lib/tenant-regions.ts
  // (which @beaconhs/db cannot import); update both together.
  const KNOWN_REGIONS = new Set([
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-southeast-3',
    'ap-southeast-4',
    'cn-north-1',
    'cn-northwest-1',
    'ap-south-1',
    'ap-northeast-1',
    'ap-northeast-2',
    'ap-northeast-3',
    'ap-east-1',
    'ca-central-1',
    'ca-west-1',
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'sa-east-1',
    'eu-west-1',
    'eu-west-2',
    'eu-central-1',
    'eu-north-1',
    'eu-south-1',
    'me-central-1',
    'af-south-1',
  ])
  if (!KNOWN_REGIONS.has(region)) {
    throw new Error(`Unknown region "${region}". Choose one of the supported regions.`)
  }

  const [created] = await tx
    .insert(tenants)
    .values({
      name,
      slug,
      status: 'active',
      region,
      defaultLanguage: input.defaultLanguage,
      enabledLanguages: input.enabledLanguages,
    })
    .returning({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      region: tenants.region,
      defaultLanguage: tenants.defaultLanguage,
      enabledLanguages: tenants.enabledLanguages,
    })

  if (!created) throw new Error('The tenant row was not created.')

  // The storage write gate fails closed for any tenant without its freeze row, so a
  // tenant provisioned without one would refuse every controlled storage write
  // (uploads, document saves) from its first moment. Created in the SAME transaction
  // as the tenant row, so the two can never disagree: a new tenant starts ACTIVE,
  // version 0, with no lease and no migration in progress.
  await ensureFreezeRow(tx, created.id)

  // The built-in roles, before anything that might reference them. Without these the
  // tenant is unusable: `roles` is the only way a non-super-admin can hold a
  // permission, and `/admin/users` reads its role picker from this table, so with none
  // present no user could ever be given access and there is no in-product way out.
  await ensureBuiltinRoles(tx, created.id)

  // The day-one trail. Written in the new tenant's own log so the activity timeline
  // is not empty on arrival.
  await tx.insert(auditLog).values({
    tenantId: created.id,
    actorUserId: input.actorUserId,
    entityType: 'tenant',
    entityId: created.id,
    action: 'create',
    summary: `Created tenant "${created.name}" (${created.slug})`,
    after: {
      name: created.name,
      slug: created.slug,
      region: created.region,
      defaultLanguage: created.defaultLanguage,
      enabledLanguages: created.enabledLanguages,
    },
  })

  // Same transaction on purpose: a seeder failure must roll the tenant back rather
  // than leave a workspace whose required day-one template is missing.
  await seedLiftPlanTemplate(tx as unknown as Database, created.id)

  // The reference catalogue, on the same transaction and the same reasoning: a tenant
  // whose picklists silently failed to populate is the same unusable-workspace state
  // the role assertion below exists to prevent.
  await seedTenantReferenceData(tx, created.id)

  // Last, and still inside the transaction: a tenant is only "provisioned" once its
  // role set and its reference catalogue are both complete. Throwing here rolls back
  // the tenant, its roles, its audit row, its template and its catalogue together, so
  // nothing half-initialised can survive.
  await assertBuiltinRolesComplete(tx, created.id)
  await assertReferenceDataComplete(tx, created.id)

  return created
}

/**
 * Provision one tenant on its own superadmin transaction.
 *
 * This is the entry point the UI uses. It does NOT check whether a tenant already
 * exists — the UI legitimately creates the second, third and nth tenant.
 */
export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  return withSuperAdmin(db, (tx) => insertProvisionedTenant(tx, input))
}

/**
 * The oldest super-admin, or `null`.
 *
 * Used to attribute the day-one audit row to a real actor. Reads the same identity
 * table the bootstrap-admin command writes, so no second source of truth for "who is
 * the platform administrator" is introduced.
 */
async function oldestSuperAdmin(tx: Database): Promise<{ id: string; email: string } | null> {
  const rows = (await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(users.createdAt)
    .limit(1)) as unknown as Array<{ id: string; email: string }>
  return rows[0] ?? null
}

export type FirstTenantResult =
  | { outcome: 'provisioned'; tenant: ProvisionedTenant; actorEmail: string | null }
  | {
      outcome: 'already_provisioned'
      tenant: { id: string; slug: string }
      actorEmail: string | null
    }

export type FirstTenantInput = Omit<ProvisionTenantInput, 'actorUserId'>

/**
 * Provision the FIRST tenant of a greenfield platform, or decline.
 *
 * The guard and the insert run inside ONE transaction. That is the whole idempotency
 * story: two operators running this concurrently cannot both observe "no tenant" and
 * both insert, because the second transaction's snapshot is taken after the first
 * commits — and even if it were not, `tenants_slug_ux` turns the loser into a
 * constraint violation rather than a second workspace.
 *
 * Refusal is by design, not by upsert. On a platform that already has a tenant this
 * writes nothing at all: it never creates a second tenant, never overwrites the
 * existing one, and never touches any credential. Tenant 2..N are created through
 * `/platform/tenants/new`, which is the supported path once a workspace exists.
 */
export async function provisionFirstTenant(input: FirstTenantInput): Promise<FirstTenantResult> {
  return withSuperAdmin(db, async (tx) => {
    const actor = await oldestSuperAdmin(tx)

    // Refuse on ANY tenant, not merely any active one. A platform whose only tenant
    // is suspended still has a workspace, and silently creating a second one would
    // hide an operational problem behind a fresh, empty workspace.
    const existing = (await tx
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .orderBy(tenants.createdAt)
      .limit(1)) as unknown as Array<{ id: string; slug: string }>

    const first = existing[0]
    if (first) {
      return {
        outcome: 'already_provisioned' as const,
        tenant: first,
        actorEmail: actor?.email ?? null,
      }
    }

    const created = await insertProvisionedTenant(tx, { ...input, actorUserId: actor?.id ?? null })

    return {
      outcome: 'provisioned' as const,
      tenant: created,
      actorEmail: actor?.email ?? null,
    }
  })
}

/** How many tenants exist, of any status. Reported by the CLI; never gates. */
export async function countTenants(): Promise<number> {
  return withSuperAdmin(db, async (tx) => {
    const rows = (await tx.select({ id: tenants.id }).from(tenants)) as unknown as Array<{
      id: string
    }>
    return rows.length
  })
}

/** Whether a super-admin exists, so the CLI can warn before writing a tenant. */
export async function hasSuperAdmin(): Promise<boolean> {
  return withSuperAdmin(db, async (tx) => (await oldestSuperAdmin(tx)) !== null)
}
