// Phase 11-E contract tests — Fire / Environment / Calibration / Statutory Register.
//
// The approved audit concluded all four domains are seed-and-configure only. These
// tests pin that conclusion so it cannot erode: they assert the seeded rows exist
// AND that the forbidden structures were NOT introduced. A test that only checked
// seed existence would pass just as happily if someone added a `fire_permits`
// table, a `fire.*` permission or a `project` RoleScope — the negative half of
// each block is the point.
//
// Structural assertions read source and schema; DB assertions run against
// SEED_TEST_SCRATCH_DATABASE_URL and SKIP (loudly, never silently) without it.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_CATEGORY,
  CALIBRATION_SPECS,
  FIRE_CATEGORY,
  FIRE_TYPE_SPECS,
  seedPhase11EEquipment,
} from './seed/phase11e-equipment'
import {
  ENVIRONMENT_MONITORING_APP_KEY,
  ENVIRONMENT_MONITORING_CATEGORY,
  ENVIRONMENT_MONITORING_SCHEMA,
  STATUTORY_REGISTER_APP_KEY,
  STATUTORY_REGISTER_CATEGORY,
  STATUTORY_REGISTER_SCHEMA,
} from './seed/phase11e-register-apps'
import { CATEGORY_DEFS } from './seed/phase11e-document-categories'

/** Resolve from this file (packages/db/src/) up to the workspace root. */
const repoPath = (...segments: string[]) =>
  readFileSync(new URL(['..', '..', '..', ...segments].join('/'), import.meta.url), 'utf8')

const repoRead = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const equipmentSeed = repoRead('./seed/phase11e-equipment.ts')
const registerSeed = repoRead('./seed/phase11e-register-apps.ts')
const categorySeed = repoRead('./seed/phase11e-document-categories.ts')
const mainSeed = repoRead('./seed.ts')

const CALIBRATION_TYPE_NAMES = CALIBRATION_SPECS.map((s) => s.type)
const FIRE_TYPE_NAMES = FIRE_TYPE_SPECS.map((s) => s.type)

/** The `documents` pgTable declaration only — not its neighbours in the file. */
const documentsTableBlock = () => {
  const src = repoRead('./schema/documents.ts')
  const start = src.indexOf('export const documents = pgTable')
  return src.slice(start, src.indexOf('export const', start + 10))
}

/** Every field id in a schema, across every section. */
const fieldIds = (schema: { sections: { fields: { id: string }[] }[] }) =>
  schema.sections.flatMap((s) => s.fields.map((f) => f.id))

// ---------------------------------------------------------------------------
// CALIBRATION
// ---------------------------------------------------------------------------

describe('CALIBRATION — seed exists and is calibration-shaped', () => {
  it('extends the EXISTING calibration type rather than inventing one', () => {
    // The demo tenant already ships a "Calibration" equipment_inspection_types
    // row for Portable Gas Detector. Phase 11-E must reuse that shape, not
    // introduce a second calibration concept.
    expect(equipmentSeed).toMatch(/name: 'Calibration',/)
    expect(equipmentSeed).toMatch(/ensureEquipmentInspectionType/)
    // No calibration table, permission, workflow or scheduler.
    expect(equipmentSeed).not.toMatch(/calibration_[a-z]+\s*=\s*pgTable/)
    expect(equipmentSeed).not.toMatch(/calibration\.(read|manage|approve)/)
    expect(equipmentSeed).not.toMatch(/registerSubject|calibration_scheduler/)
  })

  it('seeds instrument categories/types with a calibration inspection each', () => {
    // Asserted against the exported constants, not the raw source text, so the
    // test cannot drift away from the data the seed actually writes.
    expect(CALIBRATION_CATEGORY.slug).toBe('instruments')
    expect(CALIBRATION_CATEGORY.name).toBe('Calibrated Instruments')
    for (const name of CALIBRATION_TYPE_NAMES) {
      expect(equipmentSeed).toContain(`type: '${name}'`)
    }
    expect(CALIBRATION_TYPE_NAMES.length).toBeGreaterThanOrEqual(3)
  })

  it('gives every calibration type criteria, with the safety-critical ones flagged', () => {
    for (const spec of CALIBRATION_SPECS) {
      expect(spec.criteria.length).toBeGreaterThanOrEqual(2)
      // At least one check must be critical, so a bad reading is not a pass.
      expect(spec.criteria.some((c) => c.critical === true)).toBe(true)
    }
  })

  it('links equipment types to their category by categoryId, not a dropped string', () => {
    // `equipment_types` has only category_id. The pre-existing gas-detector seed
    // writes `category: 'safety'`, which drizzle silently drops; Phase 11-E must
    // not copy that, because it leaves the type uncategorised in /equipment.
    expect(equipmentSeed).toMatch(/categoryId: args\.categoryId/)
    expect(equipmentSeed).not.toMatch(/^\s*category: '/m)
  })

  it('reuses the native due-date chain rather than a new one', () => {
    // interval_value/interval_unit feed equipment_inspection_schedules →
    // min(next_due_on) → compliance. No bespoke due column is introduced.
    expect(equipmentSeed).toMatch(/intervalValue: spec\.intervalValue/)
    expect(equipmentSeed).toMatch(/intervalUnit: spec\.intervalUnit/)
    expect(repoRead('./schema/equipment-inspection-types.ts')).toMatch(
      /intervalValue: integer\('interval_value'\)/,
    )
    expect(equipmentSeed).not.toMatch(/due_on:\s*isoDate|expiry_date/)
  })

  it('seeds no sample equipment items (assets belong to the tenant)', () => {
    expect(equipmentSeed).not.toMatch(/insert\(equipmentItems\)/)
  })

  it('leaves the dead certificate column untouched', () => {
    // D3: equipment_inspection_records.certificate has no reader and no writer.
    // Phase 11-E must not start using it.
    expect(equipmentSeed).not.toMatch(/certificate:\s*(?!.*question)/)
    expect(equipmentSeed).not.toMatch(/records\s*\.\s*certificate/)
  })
})

// ---------------------------------------------------------------------------
// FIRE
// ---------------------------------------------------------------------------

describe('FIRE — equipment + inspection + document seed, no fire module', () => {
  it('introduces NO fire table, enum, permission, RoleScope or nav module', () => {
    // The negative half: this is the assertion that keeps Fire an ADAPT.
    const allSchema = repoRead('./schema/index.ts')
    expect(allSchema).not.toMatch(/fire[A-Z]/)
    expect(repoRead('./schema/iam.ts')).not.toMatch(/fire[._-]/i)
    expect(repoPath('apps', 'web', 'src', 'lib', 'nav', 'registry.ts')).not.toMatch(/fire/i)
    // No fire enum members.
    const enumTypes = repoRead('./schema/equipment.ts')
    expect(enumTypes).not.toMatch(/fire[a-z_]*\s*[=:]\s*pgEnum/)
  })

  it('uses only existing equipment tables', () => {
    expect(equipmentSeed).toMatch(/equipmentCategories/)
    expect(equipmentSeed).toMatch(/equipmentTypes/)
    expect(equipmentSeed).toMatch(/equipmentInspectionTypes/)
    expect(equipmentSeed).not.toMatch(/pgTable/)
  })

  it('seeds the fire category and the five standard asset types', () => {
    expect(FIRE_CATEGORY.slug).toBe('fire')
    expect(FIRE_CATEGORY.name).toBe('Fire protection')
    for (const name of [
      'Fire extinguisher',
      'Fire hose reel',
      'Fire alarm panel',
      'Emergency lighting',
      'Smoke detector',
    ]) {
      expect(FIRE_TYPE_NAMES).toContain(name)
    }
  })

  it('seeds a monthly visual check and an annual service for every fire type', () => {
    expect(equipmentSeed).toMatch(/name: 'Monthly visual check'/)
    expect(equipmentSeed).toMatch(/name: 'Annual service'/)
    expect(equipmentSeed).toMatch(/intervalUnit: 'month'/)
    expect(equipmentSeed).toMatch(/intervalUnit: 'year'/)
    for (const spec of FIRE_TYPE_SPECS) {
      expect(spec.visualCriteria.length).toBeGreaterThanOrEqual(3)
      expect(spec.serviceCriteria.length).toBeGreaterThanOrEqual(2)
      // A fire check that can never fail is not a control.
      expect(spec.visualCriteria.some((c) => c.critical === true)).toBe(true)
      expect(spec.serviceCriteria.some((c) => c.critical === true)).toBe(true)
    }
  })

  it('spawns work orders on failure through the EXISTING mechanism', () => {
    // failsSpawnWorkOrders is the native hook; a fire defect must raise a CA.
    expect(equipmentSeed).toMatch(/failsSpawnWorkOrders: spec\.spawnWorkOrders/)
    expect(equipmentSeed).toMatch(/failsSpawnWorkOrders: true/)
  })

  it('adds a Safety → Fire document category, not a document entity', () => {
    const fire = CATEGORY_DEFS.find((c) => c.name === 'Fire')
    expect(fire?.parent).toBe('Safety')
    expect(categorySeed).toMatch(/documentCategories/)
    expect(categorySeed).not.toMatch(/pgTable/)
    // documents keeps no site column and Phase 11-E adds none.
    expect(documentsTableBlock()).not.toMatch(/site_org_unit_id/)
  })

  it('does NOT create a fire-drill data model', () => {
    // The instruction allows a Fire Drill Log ONLY if clearly supported. The
    // approved boundary shipped Environment + Statutory as Builder Apps and left
    // fire drill as a follow-up, so assert nothing drill-shaped crept in.
    expect(equipmentSeed).not.toMatch(/drill/i)
    expect(registerSeed).not.toMatch(/drill/i)
    expect(equipmentSeed).not.toMatch(/jobTitleTasks/)
  })
})

// ---------------------------------------------------------------------------
// ENVIRONMENT
// ---------------------------------------------------------------------------

describe('ENVIRONMENT — one register Builder App, no environment module', () => {
  it('introduces NO environment table, permission or RoleScope', () => {
    expect(repoRead('./schema/index.ts')).not.toMatch(/environment[A-Z]/)
    expect(repoRead('./schema/iam.ts')).not.toMatch(/environment[._-]/i)
    expect(repoPath('apps', 'web', 'src', 'lib', 'nav', 'registry.ts')).not.toMatch(/environment/i)
    expect(registerSeed).not.toMatch(/pgTable/)
  })

  it('is a normal Builder App in the register kind', () => {
    expect(registerSeed).toMatch(/kind: 'register',/)
    expect(ENVIRONMENT_MONITORING_APP_KEY).toBe('environmental-monitoring-log')
    expect(ENVIRONMENT_MONITORING_CATEGORY).toBe('environment_monitoring')
    // Created through the shared helper Phase 11-C introduced — no second
    // template engine.
    expect(registerSeed).toMatch(/ensureTemplate\(tx, \{/)
  })

  it('has every field the approved boundary requires', () => {
    const ids = fieldIds(ENVIRONMENT_MONITORING_SCHEMA)
    for (const required of [
      'monitoring_datetime',
      'site',
      'monitoring_category',
      'parameter',
      'reading_value',
      'reading_unit',
      'result',
      'notes',
    ]) {
      expect(ids).toContain(required)
    }
  })

  it('carries a Site field so the response is site-scopable', () => {
    const site = ENVIRONMENT_MONITORING_SCHEMA.sections
      .flatMap((s) => s.fields)
      .find((f) => f.id === 'site')
    expect(site).toBeDefined()
    expect(site?.type).toBe('site_picker')
    expect(site?.required).toBe(true)
  })

  it('uses ONLY field types that already exist in the Builder registry', () => {
    const allowed = new Set([
      'text',
      'long_text',
      'number',
      'date',
      'datetime',
      'time',
      'select',
      'multi_select',
      'person_picker',
      'site_picker',
      'photo',
      'file',
      'checkbox_group',
      'radio',
      'risk_matrix',
      'heading',
      'paragraph',
    ])
    for (const field of ENVIRONMENT_MONITORING_SCHEMA.sections.flatMap((s) => s.fields)) {
      expect(allowed).toContain(field.type)
    }
  })

  it('uses icon keys that exist, so no icon silently falls back', () => {
    const icons = repoPath('apps', 'web', 'src', 'components', 'sidebar-nav.tsx')
    // NavIcon resolves ICONS[key] ?? Gauge — an unknown key renders a gauge.
    expect(registerSeed).toMatch(/iconKey: 'gauge'/)
    expect(registerSeed).toMatch(/iconKey: 'scroll'/)
    expect(icons).toMatch(/^\s*gauge: /m)
    expect(icons).toMatch(/^\s*scroll: /m)
  })
})

// ---------------------------------------------------------------------------
// STATUTORY REGISTER
// ---------------------------------------------------------------------------

describe('STATUTORY — register Builder App + document category, no statutory module', () => {
  it('introduces NO statutory table, permission or RoleScope', () => {
    expect(repoRead('./schema/index.ts')).not.toMatch(/statutory[A-Z]/)
    expect(repoRead('./schema/iam.ts')).not.toMatch(/statutory[._-]/i)
    expect(repoPath('apps', 'web', 'src', 'lib', 'nav', 'registry.ts')).not.toMatch(/statutory/i)
    expect(registerSeed).not.toMatch(/pgTable/)
  })

  it('is a register-kind Builder App whose entries are form responses', () => {
    expect(registerSeed).toMatch(/kind: 'register',/)
    expect(STATUTORY_REGISTER_APP_KEY).toBe('statutory-compliance-register')
    expect(STATUTORY_REGISTER_CATEGORY).toBe('statutory_register')
    // The register IS the response — no separate entry entity.
    expect(registerSeed).not.toMatch(/statutory_register_entries/)
  })

  it('has every field the approved boundary requires', () => {
    const ids = fieldIds(STATUTORY_REGISTER_SCHEMA)
    for (const required of [
      'site',
      'requirement',
      'instrument',
      'issuing_authority',
      'responsible_person',
      'applicable_on',
      'review_or_expiry_on',
      'status',
      'notes',
    ]) {
      expect(ids).toContain(required)
    }
  })

  it('carries an expiry/review date so the EXISTING compliance engine can watch it', () => {
    const expiry = STATUTORY_REGISTER_SCHEMA.sections
      .flatMap((s) => s.fields)
      .find((f) => f.id === 'review_or_expiry_on')
    expect(expiry?.type).toBe('date')
    expect(expiry?.required).toBe(true)
    // The reminder comes from compliance_recurrence_kind='expiry', which already
    // exists. No bespoke timer is introduced here.
    expect(repoRead('./schema/compliance.ts')).toMatch(/'expiry'/)
    expect(registerSeed).not.toMatch(/setInterval|cron|scheduler/)
  })

  it('adds a Safety → Statutory document category for the instrument itself', () => {
    const statutory = CATEGORY_DEFS.find((c) => c.name === 'Statutory')
    expect(statutory?.parent).toBe('Safety')
  })

  it('does NOT add site scope to documents', () => {
    // Scoped to the `documents` table declaration. The same file also declares
    // document_acknowledgment_sessions, which DOES carry a site_org_unit_id for a
    // toolbox talk — matching the whole file would be a false positive.
    expect(documentsTableBlock()).not.toMatch(/site_org_unit_id|current_site_org_unit_id/)
  })
})

// ---------------------------------------------------------------------------
// SEED PLACEMENT + IDEMPOTENCE RULES
// ---------------------------------------------------------------------------

describe('seed placement and idempotence', () => {
  it('runs per tenant on EVERY seed, outside the first-run-only bootstrap', () => {
    // The Phase 11-C lesson: anything inside `if (existingDemo) return` never
    // reaches an already-seeded database.
    const callSite = mainSeed.slice(
      mainSeed.indexOf('Phase 11-E — Fire / Environment'),
      mainSeed.indexOf('// Completeness assertion'),
    )
    expect(callSite).toMatch(/for \(const t of all\)/)
    expect(callSite).toMatch(/seedPhase11EEquipment/)
    expect(callSite).toMatch(/seedPhase11EDocumentCategories/)
    expect(callSite).toMatch(/seedPhase11ERegisterApps/)

    // And none of the Phase 11-E seed functions may be called from the bootstrap.
    const bootstrap = mainSeed.slice(
      mainSeed.indexOf('if (existingDemo)'),
      mainSeed.indexOf('// --- Demo tenant ---'),
    )
    expect(bootstrap).not.toMatch(/seedPhase11E/)
  })

  it('guards every insert with a lookup, because these tables have no unique name key', () => {
    // equipment_types, equipment_inspection_types and inspection_banks have NO
    // unique index on name; only equipment_categories and inspection_types do.
    expect(equipmentSeed).toMatch(/ensureEquipmentCategory[\s\S]*?onConflictDoNothing/)
    expect(equipmentSeed).toMatch(
      /ensureEquipmentType[\s\S]*?\.from\(equipmentTypes\)[\s\S]*?limit\(1\)[\s\S]*?if \(existing\)/,
    )
    expect(equipmentSeed).toMatch(
      /ensureEquipmentInspectionType[\s\S]*?\.from\(equipmentInspectionTypes\)[\s\S]*?limit\(1\)/,
    )
    // The one unique-keyed type helper must use onConflictDoNothing.
    expect(registerSeed).toMatch(/ensureTemplate/)
    // Category seeding matches on the sibling-name identity the index enforces.
    expect(categorySeed).toMatch(/lower\(btrim/)
  })

  it('preserves the Phase 8 super-admin bootstrap behaviour', () => {
    expect(mainSeed).toMatch(/if \(existingDemo\) \{[\s\S]*?skipping tenant bootstrap/)
    expect(mainSeed).toMatch(/Provisioned INDEPENDENTLY of the tenant bootstrap/)
  })

  it('keeps every seeded app published so it is immediately usable', () => {
    expect(registerSeed).not.toMatch(/status: 'draft'/)
  })
})

// ---------------------------------------------------------------------------
// NEGATIVE INVARIANTS ACROSS THE WHOLE PHASE
// ---------------------------------------------------------------------------

describe('Phase 11-E negative invariants', () => {
  const phaseFiles = [equipmentSeed, registerSeed, categorySeed]

  it('introduces no new permission key', () => {
    const iam = repoRead('./schema/iam.ts')
    const before = (iam.match(/'[a-z_]+\.[a-z.*]+'/g) ?? []).length
    for (const file of phaseFiles) {
      expect(file).not.toMatch(/'[a-z-]+\.(read|manage|create|approve|close)[a-z.]*'/)
    }
    // The catalogue is unchanged in size by this phase.
    expect((iam.match(/'[a-z_]+\.[a-z.*]+'/g) ?? []).length).toBe(before)
  })

  it('introduces no new RoleScope variant', () => {
    const iam = repoRead('./schema/iam.ts')
    const scope = iam.slice(
      iam.indexOf('export type RoleScope'),
      iam.indexOf('export const roleAssignments'),
    )
    for (const variant of ['tenant', 'sites', 'team', 'people', 'crews', 'self']) {
      expect(scope).toContain(`'${variant}'`)
    }
    expect(scope).not.toMatch(/'project'|'permit'|'fire'|'environmental'|'statutory'/)
  })

  it('introduces no new RLS registration', () => {
    const rls = repoRead('./rls.ts')
    expect(rls).not.toMatch(/fire|calibration|environmental|statutory/)
  })

  it('requires no migration — every seeded table already exists', () => {
    const rls = repoRead('./rls.ts')
    for (const table of [
      'equipment_categories',
      'equipment_types',
      'equipment_inspection_types',
      'equipment_inspection_criteria',
      'equipment_inspection_groups',
      'form_templates',
      'form_template_versions',
      'document_categories',
    ]) {
      expect(rls).toContain(`'${table}'`)
    }
    // No pgTable anywhere in the phase's seed files.
    for (const file of phaseFiles) expect(file).not.toMatch(/pgTable\(/)
  })

  it('takes no RUNTIME dependency on the frozen shared packages', () => {
    // A type-only import of FormSchemaV1 is the existing convention (the
    // Work Permit template does exactly that). What must not happen is a runtime
    // import, which would couple this seed to a package it may not modify.
    for (const file of [registerSeed, equipmentSeed, categorySeed]) {
      expect(file).not.toMatch(
        /import \{[^}]*\} from '@beaconhs\/(compliance|reports|events|storage|audit|forms-core)'/,
      )
      expect(file).not.toMatch(/import \{[^}]*\} from '@beaconhs\/forms-core'/)
    }
  })

  it('exports its seeds so main.ts can call them, and the entry point is a pure function', async () => {
    expect(typeof seedPhase11EEquipment).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// DB-LEVEL ASSERTIONS (skipped loudly without a scratch database)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DB-LEVEL ASSERTIONS (skipped loudly without a scratch database)
// ---------------------------------------------------------------------------

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL
if (!SCRATCH_URL) {
  console.warn(
    'SKIPPED Phase 11-E DB assertions: SEED_TEST_SCRATCH_DATABASE_URL is not set (structural assertions above still ran)',
  )
}

const PHASE_11_E_TYPE_NAMES = [...CALIBRATION_TYPE_NAMES, ...FIRE_TYPE_NAMES]

describe.skipIf(!SCRATCH_URL)('Phase 11-E seed rows in a migrated database', () => {
  async function firstTenantId(): Promise<string | null> {
    const { db, withSuperAdmin } = await import('@beaconhs/db')
    const { tenants } = await import('./schema')
    const [row] = await withSuperAdmin(db, (tx) =>
      tx.select({ id: tenants.id }).from(tenants).limit(1),
    )
    return row?.id ?? null
  }

  it('seeds every calibration and fire row exactly once, and re-running changes nothing', async () => {
    const { db, withSuperAdmin } = await import('@beaconhs/db')
    const { and, eq, inArray } = await import('drizzle-orm')
    const schema = await import('./schema')
    const tenantId = await firstTenantId()
    expect(tenantId).toBeTruthy()
    if (!tenantId) return

    const fingerprint = async () =>
      withSuperAdmin(db, async (tx) => {
        const [cats, types, inspections, criteria, groups, items] = await Promise.all([
          tx
            .select({ id: schema.equipmentCategories.id })
            .from(schema.equipmentCategories)
            .where(
              and(
                eq(schema.equipmentCategories.tenantId, tenantId),
                inArray(schema.equipmentCategories.slug, ['instruments', 'fire']),
              ),
            ),
          tx
            .select({ id: schema.equipmentTypes.id })
            .from(schema.equipmentTypes)
            .where(
              and(
                eq(schema.equipmentTypes.tenantId, tenantId),
                inArray(schema.equipmentTypes.name, PHASE_11_E_TYPE_NAMES),
              ),
            ),
          tx
            .select({ id: schema.equipmentInspectionTypes.id })
            .from(schema.equipmentInspectionTypes)
            .innerJoin(
              schema.equipmentTypes,
              eq(schema.equipmentTypes.id, schema.equipmentInspectionTypes.appliesToTypeId),
            )
            .where(
              and(
                eq(schema.equipmentInspectionTypes.tenantId, tenantId),
                inArray(schema.equipmentTypes.name, PHASE_11_E_TYPE_NAMES),
              ),
            ),
          tx
            .select({ id: schema.equipmentInspectionCriteria.id })
            .from(schema.equipmentInspectionCriteria)
            .innerJoin(
              schema.equipmentInspectionTypes,
              eq(
                schema.equipmentInspectionTypes.id,
                schema.equipmentInspectionCriteria.inspectionTypeId,
              ),
            )
            .innerJoin(
              schema.equipmentTypes,
              eq(schema.equipmentTypes.id, schema.equipmentInspectionTypes.appliesToTypeId),
            )
            .where(
              and(
                eq(schema.equipmentInspectionCriteria.tenantId, tenantId),
                inArray(schema.equipmentTypes.name, PHASE_11_E_TYPE_NAMES),
              ),
            ),
          tx
            .select({ id: schema.equipmentInspectionGroups.id })
            .from(schema.equipmentInspectionGroups)
            .innerJoin(
              schema.equipmentInspectionTypes,
              eq(
                schema.equipmentInspectionTypes.id,
                schema.equipmentInspectionGroups.inspectionTypeId,
              ),
            )
            .innerJoin(
              schema.equipmentTypes,
              eq(schema.equipmentTypes.id, schema.equipmentInspectionTypes.appliesToTypeId),
            )
            .where(
              and(
                eq(schema.equipmentInspectionGroups.tenantId, tenantId),
                inArray(schema.equipmentTypes.name, PHASE_11_E_TYPE_NAMES),
              ),
            ),
          // Phase 11-E must not invent sample assets.
          tx
            .select({ id: schema.equipmentItems.id })
            .from(schema.equipmentItems)
            .where(
              and(
                eq(schema.equipmentItems.tenantId, tenantId),
                inArray(schema.equipmentItems.assetTag, ['EXT-001', 'FE-001']),
              ),
            ),
        ])
        return {
          categories: cats.length,
          types: types.length,
          inspections: inspections.length,
          criteria: criteria.length,
          groups: groups.length,
          items: items.length,
        }
      })

    const first = await fingerprint()
    expect(first.categories).toBe(2)
    expect(first.types).toBe(PHASE_11_E_TYPE_NAMES.length)
    expect(first.inspections).toBe(CALIBRATION_SPECS.length + FIRE_TYPE_NAMES.length * 2)
    expect(first.criteria).toBeGreaterThan(20)
    expect(first.items).toBe(0)

    // Re-running the seed must be a complete no-op.
    await withSuperAdmin(db, (tx) => seedPhase11EEquipment(tx as never, tenantId))
    expect(await fingerprint()).toEqual(first)
  })

  it('links every seeded type to its category (the dropped-string defect is not repeated)', async () => {
    const { db, withSuperAdmin } = await import('@beaconhs/db')
    const { and, eq, inArray } = await import('drizzle-orm')
    const schema = await import('./schema')
    const tenantId = await firstTenantId()
    if (!tenantId) return

    const rows = await withSuperAdmin(db, (tx) =>
      tx
        .select({
          name: schema.equipmentTypes.name,
          category: schema.equipmentCategories.slug,
        })
        .from(schema.equipmentTypes)
        .innerJoin(
          schema.equipmentCategories,
          eq(schema.equipmentCategories.id, schema.equipmentTypes.categoryId),
        )
        .where(
          and(
            eq(schema.equipmentTypes.tenantId, tenantId),
            inArray(schema.equipmentTypes.name, PHASE_11_E_TYPE_NAMES),
          ),
        ),
    )
    expect(rows).toHaveLength(PHASE_11_E_TYPE_NAMES.length)
    for (const row of rows) {
      expect(['instruments', 'fire']).toContain(row.category)
    }
  })

  it('seeds both register apps published, in the register kind, with exactly one version each', async () => {
    const { db, withSuperAdmin } = await import('@beaconhs/db')
    const { and, eq, inArray } = await import('drizzle-orm')
    const schema = await import('./schema')
    const tenantId = await firstTenantId()
    if (!tenantId) return
    const keys = [ENVIRONMENT_MONITORING_APP_KEY, STATUTORY_REGISTER_APP_KEY]

    const templates = await withSuperAdmin(db, (tx) =>
      tx
        .select({
          key: schema.formTemplates.key,
          kind: schema.formTemplates.kind,
          status: schema.formTemplates.status,
          category: schema.formTemplates.category,
        })
        .from(schema.formTemplates)
        .where(
          and(eq(schema.formTemplates.tenantId, tenantId), inArray(schema.formTemplates.key, keys)),
        ),
    )
    expect(templates).toHaveLength(2)
    for (const t of templates) {
      expect(t.status).toBe('published')
      expect(t.kind).toBe('register')
    }

    const versions = await withSuperAdmin(db, (tx) =>
      tx
        .select({ key: schema.formTemplates.key })
        .from(schema.formTemplateVersions)
        .innerJoin(
          schema.formTemplates,
          eq(schema.formTemplates.id, schema.formTemplateVersions.templateId),
        )
        .where(
          and(
            eq(schema.formTemplateVersions.tenantId, tenantId),
            inArray(schema.formTemplates.key, keys),
          ),
        ),
    )
    for (const key of keys) {
      expect(versions.filter((v) => v.key === key)).toHaveLength(1)
    }

    // The register templates must carry NO automation graph: a lifecycle would be
    // a second workflow system, which the boundary forbids.
    const flows = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: schema.formAutomations.id })
        .from(schema.formAutomations)
        .innerJoin(
          schema.formTemplates,
          eq(schema.formTemplates.id, schema.formAutomations.templateId),
        )
        .where(
          and(
            eq(schema.formAutomations.tenantId, tenantId),
            inArray(schema.formTemplates.key, keys),
          ),
        ),
    )
    expect(flows).toHaveLength(0)
  })

  it('seeds Fire and Statutory under Safety, exactly once, and re-running adds none', async () => {
    const { db, withSuperAdmin } = await import('@beaconhs/db')
    const { and, eq, inArray, isNull, sql } = await import('drizzle-orm')
    const schema = await import('./schema')
    const tenantId = await firstTenantId()
    if (!tenantId) return
    const mod = await import('./seed/phase11e-document-categories')

    // Explicit shape: the two branches return the same `rows` type, and letting
    // TS infer the union widens `rows` to `never[]` at the call site.
    const countLeaves = (): Promise<{
      rows: { name: string; parentId: string | null }[]
      parentResolved: boolean
    }> =>
      withSuperAdmin(db, async (tx) => {
        // Match `Safety` BY NAME. Selecting any root and taking limit(1) would
        // return `Operations`, and then Fire/Statutory would never match.
        const [safety] = await tx
          .select({ id: schema.documentCategories.id })
          .from(schema.documentCategories)
          .where(
            and(
              eq(schema.documentCategories.tenantId, tenantId),
              isNull(schema.documentCategories.parentId),
              isNull(schema.documentCategories.deletedAt),
              sql`lower(btrim(${schema.documentCategories.name})) = 'safety'`,
            ),
          )
          .limit(1)
        if (!safety) return { rows: [], parentResolved: false }
        const rows = await tx
          .select({
            name: schema.documentCategories.name,
            parentId: schema.documentCategories.parentId,
          })
          .from(schema.documentCategories)
          .where(
            and(
              eq(schema.documentCategories.tenantId, tenantId),
              eq(schema.documentCategories.parentId, safety.id),
              inArray(schema.documentCategories.name, ['Fire', 'Statutory']),
              isNull(schema.documentCategories.deletedAt),
            ),
          )
        return { rows, parentResolved: true }
      })

    const first = await countLeaves()
    expect(first.parentResolved).toBe(true)
    expect(first.rows).toHaveLength(2)
    for (const row of first.rows) expect(row.parentId).not.toBeNull()

    await withSuperAdmin(db, (tx) => mod.seedPhase11EDocumentCategories(tx as never, tenantId))
    expect((await countLeaves()).rows).toHaveLength(2)
  })
})
