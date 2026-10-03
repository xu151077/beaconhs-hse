/**
 * Row-level authorization for the analytics/report engines.
 *
 * Both compilers already honour an entity's `baseFilter` as an implicit,
 * non-overridable predicate:
 *   - AppKit custom queries — `@braedonsaunders/appkit-reports` `custom-query.js`
 *     pushes `entity.baseFilter` into the WHERE clause of every query.
 *   - BHQL — `compile.ts` `withBaseFilter()` ANDs `entity.baseFilter` under the
 *     caller's stage filter.
 *
 * That makes `baseFilter` the right place to enforce scope: a tenant-authored
 * definition filter is ANDed *beside* it, never instead of it, so widening a
 * saved report cannot escape the caller's own access.
 *
 * The module taxonomy below deliberately mirrors `PREFIX_CATEGORY` in
 * `./discover.ts` — the prefix→category rules that already decide which table
 * belongs to which module — and reuses them to answer a different question:
 * "who may read this table, and which rows?". Keeping one taxonomy means a new
 * table cannot be added to a module's analytics surface without also inheriting
 * that module's permission.
 *
 * This module is dependency-free: it takes a permission predicate and the
 * caller's already-resolved identity rather than importing `@beaconhs/tenant`,
 * so both `apps/web` and `apps/worker` can use it.
 */
import type { RoleScope } from '@beaconhs/db/schema'
import type { ReportRuleGroup } from '@beaconhs/reports'
import type { AnalyticsEntity } from '../semantic'

/**
 * Everything the scope rules need, resolved by the caller from BeaconHS's own
 * authorization inputs: the permission set, the `{type:'sites'}` Role Scope, the
 * caller's person record and their tenant membership.
 */
export type AnalyticsScopeSubject = {
  isSuperAdmin: boolean
  /** Mirrors `can()` from `@beaconhs/tenant`, including tier widening. */
  permissions: (key: string) => boolean
  /** Site org-unit ids from `{ type: 'sites' }` scopes. */
  siteIds: readonly string[]
  personId: string | null
  /** `ctx.membership.id` — the tenant_users row id. */
  tenantUserId: string | null
}

/**
 * THE shared constructor. `apps/web` and `apps/worker` both build their subject
 * here, so the two cannot drift into answering "what may this identity see?"
 * differently — which is the specific failure 15B-3D exists to prevent, where a
 * scheduled report would have resolved to a wider scope than the same member
 * gets by hand in the UI.
 *
 * Returns the identity unchanged. The indirection is kept because both apps
 * construct their subject here today; collapsing it would mean one of them
 * re-derives the shape locally, which is the drift this function prevents.
 */
export function analyticsScopeSubject(identity: AnalyticsScopeSubject): AnalyticsScopeSubject {
  return {
    isSuperAdmin: identity.isSuperAdmin,
    permissions: identity.permissions,
    siteIds: identity.siteIds,
    personId: identity.personId,
    tenantUserId: identity.tenantUserId,
  }
}

type ReadSpec =
  /** Tiered read keys: `<prefix>.read.all` / `.site` / `.self`. */
  | { prefix: string }
  /** A single flat key. The module has no tiered reads, so no row scope. */
  | { key: string }
  /** No module read permission owns this table. It is withheld from analytics. */
  | null

type ScopeSpec = {
  read: ReadSpec
  /** Candidate org-unit columns, first one the entity actually has wins. */
  siteCols?: readonly string[]
  /**
   * The same idea for tables that name the org unit `org_unit_id` rather than
   * `site_org_unit_id`. `customer_contacts` is the one: a customer's address is
   * an org unit, not a site.
   */
  orgUnitCols?: readonly string[]
  /** Candidate person columns, first one the entity actually has wins. */
  personCols?: readonly string[]
  /** Candidate tenant-user columns, first one the entity actually has wins. */
  userCols?: readonly string[]
}

type Tier = 'all' | 'site' | 'self' | 'none'

/** The platform's dominant location column names, most-specific first. */
const SITE_COLUMNS = ['site_org_unit_id', 'current_site_org_unit_id'] as const
/** Tables that reference an org unit generically rather than naming a site. */
const ORG_UNIT_COLUMNS = ['org_unit_id'] as const
/**
 * Person-owning columns, most-specific first.
 *
 * `pickColumn` returns the FIRST candidate the entity actually has, so this list
 * is a priority order and appending a name can only affect an entity that has
 * none of the earlier ones. `operator_person_id` was added in 15B-3C-2A for
 * `safe_distance_records`, whose operator is the person who performed the check.
 *
 * Its blast radius was verified against the live schema rather than assumed:
 * `operator_person_id` exists on exactly ONE table in the schema, so the 20 specs
 * that reference this list are unchanged for every other entity. No existing
 * entity's `pickColumn` result moves, no tenant-wide fallback is introduced (a
 * person column is a binding, which can only narrow), and no tier rule is touched.
 */
const PERSON_COLUMNS = [
  'person_id',
  'subject_person_id',
  'driver_person_id',
  'inspector_person_id',
  'current_holder_person_id',
  'operator_person_id',
] as const
/** Tenant-user-owning columns, most-specific first. */
const USER_COLUMNS = ['owner_tenant_user_id', 'assigned_to_tenant_user_id'] as const

/**
 * Table name prefix → module rule. Mirrors `PREFIX_CATEGORY` in ./discover.ts
 * and is evaluated in declared order (first match wins), so the entries here
 * are ordered to keep the more specific prefixes ahead of the broader ones
 * (`role_` before `role`, `email_` before nothing else, and so on).
 *
 * A table matching no prefix is NOT granted to anyone — see
 * `resolveScopeSpec`. That is the point: it turns the previous blocklist
 * (`EXCLUDE_TABLES`, which allowed everything by default) into an allowlist, so
 * a newly RLS-registered table stops being tenant-wide-readable on arrival.
 */
const PREFIX_SCOPE: [string, ScopeSpec][] = [
  // --- incidents -------------------------------------------------------
  ['incident_', { read: { prefix: 'incidents' }, siteCols: SITE_COLUMNS }],

  // --- corrective actions ---------------------------------------------
  ['ca_', { read: { prefix: 'ca' }, siteCols: SITE_COLUMNS, userCols: USER_COLUMNS }],

  // --- hazard assessments ---------------------------------------------
  ['hazid_', { read: { prefix: 'hazid' }, siteCols: SITE_COLUMNS, personCols: PERSON_COLUMNS }],

  // --- training --------------------------------------------------------
  [
    'training_',
    { read: { prefix: 'training' }, siteCols: SITE_COLUMNS, personCols: PERSON_COLUMNS },
  ],

  // --- builder apps ----------------------------------------------------
  [
    'form_',
    {
      read: { prefix: 'forms.response' },
      siteCols: SITE_COLUMNS,
      personCols: PERSON_COLUMNS,
    },
  ],

  // --- PPE -------------------------------------------------------------
  // PPE has no tiered read keys on the underlying tables, so the flat
  // `ppe.read.all` is the whole boundary.
  ['ppe_', { read: { key: 'ppe.read.all' }, siteCols: SITE_COLUMNS, personCols: PERSON_COLUMNS }],

  // --- equipment -------------------------------------------------------
  [
    'equipment_',
    { read: { prefix: 'equipment' }, siteCols: SITE_COLUMNS, personCols: PERSON_COLUMNS },
  ],
  ['truck_', { read: { prefix: 'equipment' }, siteCols: SITE_COLUMNS, personCols: PERSON_COLUMNS }],

  // --- inspections -----------------------------------------------------
  ['inspection_', { read: { prefix: 'inspections' }, siteCols: SITE_COLUMNS }],

  // --- journals --------------------------------------------------------
  ['journal_', { read: { prefix: 'journals' }, siteCols: SITE_COLUMNS }],

  // --- documents -------------------------------------------------------
  ['document_', { read: { key: 'documents.read' } }],

  // --- compliance ------------------------------------------------------
  ['compliance_', { read: { key: 'compliance.read' } }],

  // --- workforce & org -------------------------------------------------
  // Master data with no tiered read keys: tenant administration is the gate.
  //
  // `person_` / `people_` / `job_title` declare NO scope column and no tiered read
  // key, so they are reachable only by the flat administration key — there is
  // nothing to narrow them by. They carry no location column at all — a person's
  // reporting line (`manager_person_id`) is not a placement and is deliberately
  // NOT used as a read binding, because "reports to" and "works at" are
  // different facts and binding on the former would leak across org units.
  ['person_', { read: { key: 'admin.users.manage' } }],
  ['people_', { read: { key: 'admin.users.manage' } }],
  // `customer_contacts` is the exception in this group: it carries a real
  // `org_unit_id`, so a scoped caller is narrowed to the contacts at the places
  // they are placed.
  ['customer_', { read: { key: 'admin.users.manage' }, orgUnitCols: ORG_UNIT_COLUMNS }],
  ['job_title', { read: { key: 'admin.users.manage' } }],
  // `role_` before `role`: a per-user dashboard layout is not workforce master
  // data and is withheld rather than following the `roles` tables.
  ['role_', { read: null }],
  // NOTE: `roles` is in `discover.ts`'s EXCLUDE_TABLES, so this spec is
  // UNREACHABLE — no discovered entity can match it. It is kept, with a
  // permission, rather than `read: null`, so that re-admitting the table later
  // does not silently grant every role row to an `admin.users.manage` holder
  // unfiltered. `scope.test.ts` pins that unreachability.
  ['role', { read: { key: 'admin.users.manage' } }],

  // --- insights / reports ---------------------------------------------
  // NOTE: `insight_cards` is in `discover.ts`'s EXCLUDE_TABLES, so this spec is
  // UNREACHABLE — cards are read through the cards module, never as an analytics
  // source. Kept for the same reason as `role` above, and pinned as unreachable by
  // `scope.test.ts` so nobody reads it as an active grant.
  ['insight_', { read: { key: 'insights.read' } }],
  // `report_` is the DEFAULT for the `report_*` projection views, and it is
  // deliberately fail-closed. `reports.read` grants access to the reporting
  // studio; it must never also be the gate for the rows behind it. A flat
  // `{ key }` resolves to tier 'all' (see `tierFor`), which handed every holder
  // of `reports.read` tenant-wide rows. There is no `reports.read.all`,
  // `.site` or `.self` in the catalogue, so this spec resolves to tier 'none'
  // for every non-super-admin and the view is withheld. The report views that
  // do expose module data are listed individually in `TABLE_SCOPE` below.
  [
    'report_',
    {
      read: { prefix: 'reports' },
      siteCols: SITE_COLUMNS,
      personCols: PERSON_COLUMNS,
      userCols: USER_COLUMNS,
    },
  ],

  // --- tools -----------------------------------------------------------
  // `safe_distance_records` carries both `site_org_unit_id` and
  // `operator_person_id`, so the native tier ladder binds here with no
  // Safe Distance specific rule of any kind.
  //
  // The read spec is the TIERED PREFIX `tools.safe-distance`, not a flat key.
  // That is what lets `tierFor` resolve a real tier from
  // `tools.safe-distance.read.{all,site,self}` — the same three keys every other
  // record module in the catalogue declares — and therefore what lets the list,
  // the detail page, the print view, the CSV and this spec answer one question
  // with one ladder. A flat `read: { key: … }` resolves to tier 'all' and would
  // hand every holder of the operate capability the whole tenant.
  [
    'safe_distance',
    {
      read: { prefix: 'tools.safe-distance' },
      siteCols: SITE_COLUMNS,
      personCols: PERSON_COLUMNS,
    },
  ],

  // --- platform infrastructure: withheld -------------------------------
  // Notification/audit/admin/AI/log tables are not tenant analytical data. No
  // module read permission legitimately grants them, so they are withheld
  // rather than inheriting a permission that was never meant to cover them.
  ['tenant_', { read: null }],
  ['notification', { read: null }],
  ['webpush', { read: null }],
  ['email_', { read: null }],
  ['sms_', { read: null }],
  ['api_', { read: null }],
  ['audit', { read: null }],
  ['data_source', { read: null }],
  ['sync_', { read: null }],
  ['ai_', { read: null }],
  ['kiosk', { read: null }],
]

/**
 * Exact-table overrides, consulted before `PREFIX_SCOPE`. Used where the
 * prefix rule would pick the wrong module, or where a table is a single-row
 * per-tenant setting that needs a module gate but no row scope.
 */
const TABLE_SCOPE: Record<string, ScopeSpec> = {
  // Tables whose singular/plural form does not match any `prefix_` rule. These
  // are the most-read tables in the product, so they are spelled out explicitly
  // rather than relying on a prefix that does not apply.
  incidents: { read: { prefix: 'incidents' }, siteCols: SITE_COLUMNS },
  // 15B-3C product decision: the controlled-document library is TENANT-LEVEL.
  // A tenant publishes ONE version of an SDS / SOP / policy and every field
  // worker on every site must be able to read it: a controlled document that
  // varied by project would be a different artefact per project, which is not
  // what a controlled document is.
  //
  // So the library is TENANT-LEVEL by design. `documents.read` is a flat key
  // resolving to tier `all`, which is the correct native answer for a
  // tenant-level library: publication state is the access axis, not location.
  // The web half of this decision is `documentReadFilter` in
  // `apps/web/src/lib/assistant/doc-access.ts`, which is what actually withholds
  // an unpublished document from a non-manager.
  documents: { read: { key: 'documents.read' } },
  people: { read: { key: 'admin.users.manage' } },

  // `corrective_actions` has no `ca_` prefix, so it is spelled out here.
  corrective_actions: {
    read: { prefix: 'ca' },
    siteCols: SITE_COLUMNS,
    userCols: USER_COLUMNS,
  },

  // Vehicle log settings is a single per-tenant configuration row: `enabled_modes`
  // and `default_mode`, and nothing else. `equipment.read.all` is the right
  // capability — an `all` tier holder sees the tenant's one row, which is the
  // whole content of the table.
  vehicle_log_settings: { read: { key: 'equipment.read.all' } },

  // Organisation structure is tenant master data, not workforce records.
  //
  // `admin.org.manage` is a flat key, so these four resolve to tier `all` and a
  // holder sees the tenant's whole org structure. That is correct natively: a
  // tenant administrator who administers the tree must be able to group or filter
  // a report by location, department, crew or trade, and these tables are pure
  // structure with no per-person or per-site rows to leak.
  //
  // There is deliberately no narrower option. `org_units.parent_id` points at
  // another org unit, so filtering the org tree by the org tree would be
  // circular; the other three are name/code catalogues with no relationship to
  // any record. A caller without `admin.org.manage` is withheld by `tierFor`
  // before any of this is consulted.
  org_units: { read: { key: 'admin.org.manage' } },
  departments: { read: { key: 'admin.org.manage' } },
  crews: { read: { key: 'admin.org.manage' } },
  trades: { read: { key: 'admin.org.manage' } },
  // `companies` (contractor / subcontractor employers) is the same kind of
  // catalogue: a name plus a type, with no location, owner, or person column to
  // narrow by. `admin.org.manage` is the same flat key that already gates the
  // People admin pages that maintain it, so a company cannot become a report
  // source for anyone who cannot already see the Companies list.
  companies: { read: { key: 'admin.org.manage' } },

  // --- report_* projection views ---------------------------------------
  // These views expose another module's rows, so each one inherits THAT module's
  // read tier and row scope rather than the studio's blanket `reports.read`.
  // Only the scope columns each entity actually declares are listed: a view with
  // no location or owner column falls through to `visible: false` for a site- or
  // self-scoped caller rather than being handed unscoped rows.
  report_corrective_actions: {
    read: { prefix: 'ca' },
    siteCols: SITE_COLUMNS,
    userCols: USER_COLUMNS,
  },
  report_equipment_fleet: { read: { prefix: 'equipment' }, siteCols: SITE_COLUMNS },
  report_vehicle_log_entries: {
    read: { prefix: 'equipment' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  // Monthly rollup: no site column, so a site-scoped caller narrows to the
  // vehicles they drove, or is withheld when they have no person link.
  report_vehicle_log_monthly: {
    read: { prefix: 'equipment' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  report_ppe_items: {
    read: { prefix: 'ppe' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  report_training_records: {
    read: { prefix: 'training' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  report_skill_assignments: {
    read: { prefix: 'training' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  report_training_matrix: {
    read: { prefix: 'training' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  // Aggregated rates carry no location or owner column, so a site-scoped caller
  // cannot be narrowed and the entity is withheld for them.
  report_incident_rates: {
    read: { prefix: 'incidents' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  report_compliance_status: {
    // A PREFIX, not a flat key. `{ key }` resolves to tier `all` and returns
    // before `pickColumn` is ever called, so the site/person/user columns
    // declared below were unreachable and every `compliance.read` holder —
    // including a site-scoped foreman — received this entity unfiltered.
    // `resolveEntity` now takes the ordinary tier path for it.
    read: { prefix: 'compliance' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
    userCols: USER_COLUMNS,
  },
  report_monitored_sessions: {
    read: { prefix: 'forms.response' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },
  report_hazid_signatures: {
    // Without this entry the `report_` prefix default would hand this entity the
    // studio-wide `reports.read` tier, so ANY viewer of reports could read every
    // hazard-assessment signature in the tenant. It must stay on the Hazard ID
    // module's own ladder: the same `hazid.read.*` prefix and the same
    // site/person columns the `hazid_` prefix rule gives the base table this
    // projection selects from.
    read: { prefix: 'hazid' },
    siteCols: SITE_COLUMNS,
    personCols: PERSON_COLUMNS,
  },

  // Platform internals with no module owner.
  reference_counters: { read: null },
  user_permission_overrides: { read: null },
  attachment_upload_reservations: { read: null },
  storage_object_deletion_outbox: { read: null },
  flow_gates: { read: null },
  email_templates: { read: null },
  pdf_templates: { read: null },
  custom_field_definitions: { read: null },
  walkthrough_settings: { read: null },
  walkthrough_progress: { read: null },
  integration_export_log: { read: null },
}

/**
 * The one tenant-wide source. It is code-owned (system KPI cards) and added
 * explicitly by `addTrustedSystemAppResponsesEntity` rather than discovered, so
 * it is granted here and gated by the caller on a real response-read
 * permission — see `canReadAppResponses` in apps/web.
 */
const ALWAYS_ALLOWED = new Set(['app_responses'])

/** Pull site ids out of the caller's resolved role scopes. */
export function siteIdsFromScopes(scopes: readonly RoleScope[]): string[] {
  const ids: string[] = []
  for (const scope of scopes) {
    if (scope.type === 'sites') ids.push(...scope.siteIds)
  }
  return [...new Set(ids)]
}

function resolveScopeSpec(table: string): ScopeSpec | null {
  const exact = TABLE_SCOPE[table]
  if (exact) return exact
  for (const [prefix, spec] of PREFIX_SCOPE) {
    if (table.startsWith(prefix)) return spec
  }
  return null
}

/** Every spec, paired with the table/prefix it applies to. */
function allScopeSpecs(): { match: string; spec: ScopeSpec }[] {
  return [
    ...PREFIX_SCOPE.map(([prefix, spec]) => ({ match: prefix, spec })),
    ...Object.entries(TABLE_SCOPE).map(([table, spec]) => ({ match: table, spec })),
  ]
}

/**
 * Structural invariants on a set of specs.
 *
 * Split from {@link runScopeSpecValidation} so the guard itself can be tested
 * against a synthetic spec, which is the only way "a tenant-level table must not
 * quietly grow a binding column" is anything other than an untested claim.
 */
export function validateScopeSpecs(specs: readonly { match: string; spec: ScopeSpec }[]): string[] {
  const errors: string[] = []
  for (const { match, spec } of specs) {
    if (spec.read === null) continue
    // A FLAT key resolves to tier `all` in `tierFor`, so the entity is returned
    // with no row predicate. That is the correct answer for a tenant-level table
    // and a leak for a business-data table, so a flat-key spec that also declares
    // a scope column is contradictory: the column can never narrow anything.
    const isFlat = 'key' in spec.read
    const declaresColumns = Boolean(
      spec.siteCols || spec.personCols || spec.userCols || spec.orgUnitCols,
    )
    if (isFlat && declaresColumns) {
      errors.push(
        `${match}: declares a flat read key AND scope columns. A flat key resolves to tier ` +
          `'all' and never applies a row predicate, so the columns are dead config. Use a ` +
          `tiered \`prefix\` read spec if this table is business data.`,
      )
    }
  }
  return errors
}

/**
 * A tenant-level table is granted with a flat read key, so `tierFor` resolves
 * tier `all` and no row predicate is applied. That is the right answer for
 * per-tenant structure or configuration, and a tenant-wide leak for business
 * data. Each table below therefore carries the column list transcribed from the
 * live schema, checked against the allowlist it is allowed to keep: a future
 * person- or site-keyed column must fail here rather than silently inherit the
 * flat key.
 *
 * Split out for the same reason as {@link validateScopeSpecs} — so the guard can
 * be tested against a synthetic violation, which is the only way "a tenant-level
 * table must not quietly grow a person column" is more than an untested claim.
 */
export function validateTenantLevelColumns(
  tables: readonly string[],
  allowed: Readonly<Record<string, readonly string[]>>,
  actual: Readonly<Record<string, readonly string[]>>,
  description: string,
  readKeys: Readonly<Record<string, { key: string } | null | undefined>>,
): string[] {
  const errors: string[] = []
  for (const table of tables) {
    const spec = readKeys[table]
    // `read: null` means the table is withheld from analytics entirely, and a
    // tiered `prefix` spec gets its row predicate from its own columns. Only a
    // flat key leaves the tenant-level tables unguarded.
    if (!spec || !('key' in spec)) continue
    const allowedColumns = new Set(allowed[table] ?? [])
    const unexpected = (actual[table] ?? []).filter((c) => !allowedColumns.has(c))
    if (unexpected.length > 0) {
      errors.push(
        `${table}: granted with a flat key as ${description}, but the schema exposes ` +
          `${unexpected.join(', ')}. A person- or site-keyed column would make this a ` +
          `business-data table and the flat key a tenant-wide leak.`,
      )
    }
  }
  return errors
}

/**
 * Structural invariants on the real spec table.
 *
 * Called from `scope.test.ts` rather than at import time, so a mistake surfaces in
 * a test with a readable failure instead of at module load in production.
 *
 * The shape checks are transcribed statically rather than introspected so they
 * run without a database; each list comes from `packages/db/src/schema`.
 */
export function runScopeSpecValidation(): { errors: string[] } {
  const errors = validateScopeSpecs(allScopeSpecs())
  const flatReadKeys: Record<string, { key: string } | null | undefined> = Object.fromEntries(
    Object.entries(TABLE_SCOPE).map(([table, spec]) => [
      table,
      spec.read === null ? null : 'key' in spec.read ? { key: spec.read.key } : undefined,
    ]),
  )
  for (const group of TENANT_LEVEL_TABLES) {
    errors.push(
      ...validateTenantLevelColumns(
        group.tables,
        group.columns,
        group.actual,
        group.description,
        flatReadKeys,
      ),
    )
  }
  return { errors }
}

/**
 * Tables that are tenant-level BY DESIGN and are granted with a flat read key, so
 * they resolve to tier `all` and carry no row predicate.
 *
 * The `columns` list is what each table is allowed to expose while it stays
 * tenant-level. Two absences carry the whole argument and are therefore asserted
 * rather than assumed:
 *
 *   • no `person_id` / `owner_tenant_user_id` — nothing here is a person's record
 *   • no `site_org_unit_id` / `org_unit_id` — nothing here is a PLACEMENT
 *
 * `org_units.parent_id` is the one org-unit-shaped column in the set and is the
 * TREE DEFINITION itself, not a reference to a scope-bearing record, so it is
 * listed as definitional rather than as a binding.

/**
 * Tables that are tenant-level BY DESIGN, with the columns each is allowed to
 * expose while it stays that way.
 *
 * Each is granted with a flat read key, so `tierFor` resolves tier `all` and no
 * row predicate is applied. That is the right answer for per-tenant structure or
 * configuration, and a tenant-wide leak for business data — which is what the
 * `columns` lists are here to prevent. They are transcribed from
 * `packages/db/src/schema` rather than introspected so the check runs without a
 * database.
 *
 * The lists name the only columns such a table may have: identifiers, tenant, the
 * definition or configuration itself, and timestamps. Two absences carry the whole
 * argument and are therefore asserted rather than assumed:
 *
 *   • no `person_id` / `owner_tenant_user_id` — nothing here is a person's record
 *   • no `site_org_unit_id` / `org_unit_id` — nothing here is a PLACEMENT
 *
 * Two deliberate inclusions:
 *   • `org_units.parent_id` is the one org-unit-shaped column in the set and is
 *     the TREE DEFINITION itself, not a reference to a scope-bearing record.
 *   • `documents.owner_tenant_user_id` is real, nullable authorship. Nothing
 *     scopes by it, and its presence is exactly why this table needs a guard
 *     rather than blanket trust.
 *
 * A future person- or site-keyed column here turns the table into business data
 * and must fail this check rather than silently inherit the flat key.
 */
const TENANT_LEVEL_TABLES: readonly {
  tables: readonly string[]
  description: string
  /** The columns each table is ALLOWED to expose while it stays tenant-level. */
  columns: Readonly<Record<string, readonly string[]>>
  /** The columns each table ACTUALLY exposes, transcribed from the schema. */
  actual: Readonly<Record<string, readonly string[]>>
}[] = [
  {
    tables: ['org_units', 'departments', 'crews', 'trades', 'companies'],
    description: 'tenant-level organizational definition data',
    columns: {
      org_units: [
        'id',
        'tenant_id',
        'parent_id',
        'level',
        'name',
        'code',
        'lat',
        'lng',
        'geofence_meters',
        'is_equipment_base',
        'address',
        'metadata',
        'created_at',
        'updated_at',
        'deleted_at',
      ],
      departments: ['id', 'tenant_id', 'name', 'code', 'description', 'created_at', 'updated_at'],
      crews: ['id', 'tenant_id', 'name', 'created_at', 'updated_at'],
      trades: ['id', 'tenant_id', 'name', 'code', 'created_at', 'updated_at'],
      companies: ['id', 'tenant_id', 'name', 'type', 'created_at', 'updated_at'],
    },
    actual: {
      org_units: [
        'id',
        'tenant_id',
        'parent_id',
        'level',
        'name',
        'code',
        'lat',
        'lng',
        'geofence_meters',
        'is_equipment_base',
        'address',
        'metadata',
        'created_at',
        'updated_at',
        'deleted_at',
      ],
      departments: ['id', 'tenant_id', 'name', 'code', 'description', 'created_at', 'updated_at'],
      crews: ['id', 'tenant_id', 'name', 'created_at', 'updated_at'],
      trades: ['id', 'tenant_id', 'name', 'code', 'created_at', 'updated_at'],
      companies: ['id', 'tenant_id', 'name', 'type', 'created_at', 'updated_at'],
    },
  },
  {
    tables: ['documents'],
    description: 'a tenant-level controlled document library',
    columns: {
      documents: [
        'id',
        'tenant_id',
        'key',
        'title',
        'description',
        'type_id',
        'category_id',
        'status',
        'owner_tenant_user_id',
        'review_frequency_months',
        'next_review_on',
        'source_attachment_id',
        'created_at',
        'updated_at',
        'deleted_at',
      ],
    },
    actual: {
      documents: [
        'id',
        'tenant_id',
        'key',
        'title',
        'description',
        'type_id',
        'category_id',
        'status',
        'owner_tenant_user_id',
        'review_frequency_months',
        'next_review_on',
        'source_attachment_id',
        'created_at',
        'updated_at',
        'deleted_at',
      ],
    },
  },
  {
    tables: ['vehicle_log_settings'],
    description: 'a single per-tenant configuration row',
    columns: {
      vehicle_log_settings: [
        'id',
        'tenant_id',
        'enabled_modes',
        'default_mode',
        'created_at',
        'updated_at',
      ],
    },
    actual: {
      vehicle_log_settings: [
        'id',
        'tenant_id',
        'enabled_modes',
        'default_mode',
        'created_at',
        'updated_at',
      ],
    },
  },
]

function tierFor(subject: AnalyticsScopeSubject, read: NonNullable<ReadSpec>): Tier {
  if (subject.isSuperAdmin) return 'all'
  if ('key' in read) return subject.permissions(read.key) ? 'all' : 'none'
  const { prefix } = read
  if (subject.permissions(`${prefix}.read.all`)) return 'all'
  if (subject.permissions(`${prefix}.read.site`)) return 'site'
  if (subject.permissions(`${prefix}.read.self`)) return 'self'
  return 'none'
}

/** First candidate column the entity actually has, or null. */
function pickColumn(entity: AnalyticsEntity, candidates: readonly string[] | undefined) {
  if (!candidates) return null
  return candidates.find((key) => entity.columns.some((column) => column.key === key)) ?? null
}

function rule(field: string, value: readonly string[]): ReportRuleGroup {
  // `IN (...)` excludes NULL rows under SQL three-valued logic, so a record
  // with no site recorded is withheld from a site-scoped caller. Fail-closed.
  return { combinator: 'and', rules: [{ field, op: 'in', value: [...value] }] }
}

/** `baseFilter` is optional (not nullable), so combining yields undefined. */
function andFilters(
  ...groups: (ReportRuleGroup | null | undefined)[]
): ReportRuleGroup | undefined {
  const present = groups.filter((g): g is ReportRuleGroup => !!g)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return { combinator: 'and', rules: present }
}

type Resolution = { visible: false } | { visible: true; filter: ReportRuleGroup | undefined }

/**
 * Resolve one entity's read permission and row predicate.
 *
 * `visible: false` withholds the entity from the catalogue entirely. That is the
 * fail-closed path and it covers the cases where nothing may be answered: the
 * caller holds no read permission, or the resolved tier cannot be expressed
 * against this entity. Withholding by omission means a mis-specified table can
 * never fall back to an unscoped, tenant-wide read.
 *
 * The order is deliberate and load-bearing, and mirrors
 * `apps/web/src/lib/visibility.ts`:
 *
 *   1. no spec, or no owning read permission → withhold
 *   2. tier `all`                        → no row predicate; RLS bounds the tenant
 *   3. tier `site` + a site column       → that column IN the caller's site ids
 *   4. tier `site` with no site ids      → withhold
 *   5. otherwise                         → the ownership column
 *
 * Step 3 withholds rather than falling back, because `IN ()` is a SQL syntax
 * error and an empty list must never be read as "no restriction". A caller whose
 * `{type:'sites'}` scope is empty has no site boundary to apply, so there is
 * nothing to answer.
 *
 * Step 5 is the `self` tier, and it also catches a `site` tier on an entity with
 * no site column. Own rows are strictly narrower than a site scope, so this
 * narrows rather than widens.
 */
function resolveEntity(subject: AnalyticsScopeSubject, entity: AnalyticsEntity): Resolution {
  const spec = resolveScopeSpec(entity.table)
  if (!spec || spec.read === null) return { visible: false }

  const tier = tierFor(subject, spec.read)
  if (tier === 'none') return { visible: false }

  if (tier === 'all') return { visible: true, filter: undefined }

  const siteCol = pickColumn(entity, spec.siteCols)
  const personCol = pickColumn(entity, spec.personCols)
  const userCol = pickColumn(entity, spec.userCols)

  if (tier === 'site' && siteCol) {
    if (subject.siteIds.length === 0) return { visible: false }
    return { visible: true, filter: rule(siteCol, subject.siteIds) }
  }

  // Fall back to the ownership column. Own rows are strictly narrower than a
  // site scope, so this narrows rather than widens; a caller holding a crew or
  // team scope (rather than `sites`) lands here until crew expansion is
  // available, which is safe.
  const ownerCol = userCol && subject.tenantUserId ? userCol : personCol
  if (ownerCol) {
    const owner = userCol === ownerCol ? subject.tenantUserId : subject.personId
    if (owner) return { visible: true, filter: rule(ownerCol, [owner]) }
  }
  return { visible: false }
}

function scopeOne(subject: AnalyticsScopeSubject, entity: AnalyticsEntity): AnalyticsEntity | null {
  const resolution = resolveEntity(subject, entity)
  if (!resolution.visible) return null
  return resolution.filter
    ? { ...entity, baseFilter: andFilters(entity.baseFilter, resolution.filter) }
    : entity
}

/**
 * Apply the caller's module read permission and row scope to an entity
 * inventory. Entities the caller may not read are removed; entities they may
 * read only narrowly get a `baseFilter` both compilers AND into every query.
 */
export function scopeAnalyticsEntities(
  subject: AnalyticsScopeSubject,
  entities: readonly AnalyticsEntity[],
): AnalyticsEntity[] {
  const out: AnalyticsEntity[] = []
  for (const entity of entities) {
    if (ALWAYS_ALLOWED.has(entity.key)) {
      out.push(entity)
      continue
    }
    const scoped = scopeOne(subject, entity)
    if (scoped) out.push(scoped)
  }
  return out
}

/**
 * A stable fingerprint of everything that changes which rows a caller may see.
 *
 * Two callers may only share a cached result when this matches. It deliberately
 * includes the resolved site ids, because two members holding the same role can
 * hold different `sites` scopes — the previous cache key covered role and
 * template ids only, which would have served one member's scoped rows to
 * another.
 */
export function analyticsScopeFingerprint(subject: AnalyticsScopeSubject): string {
  return JSON.stringify({
    super: subject.isSuperAdmin,
    sites: [...subject.siteIds].sort(),
    person: subject.personId ?? null,
    user: subject.tenantUserId ?? null,
  })
}
