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
import type { ProjectScope } from './project-scope'

/** Everything the scope rules need EXCEPT Project Scope, resolved by the caller. */
export type AnalyticsScopeIdentity = {
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
 * The three restricted kinds collapse to one state: any non-empty scope is
 * `'restricted'`. `unrestricted` and `empty` stay distinct, because a caller who
 * can see nothing must never be served a company-wide result. `undefined` (no
 * scope was resolved at all) becomes `'unknown'`, which the rules below treat as
 * DENY — an absent scope is not evidence of a wide one.
 */
export function analyticsScopeSubject(
  identity: AnalyticsScopeIdentity,
  projectScope?: ProjectScope,
): AnalyticsScopeSubject {
  return {
    isSuperAdmin: identity.isSuperAdmin,
    permissions: identity.permissions,
    siteIds: identity.siteIds,
    personId: identity.personId,
    tenantUserId: identity.tenantUserId,
    projectScopeKind: !projectScope
      ? 'unknown'
      : projectScope.kind === 'unrestricted'
        ? 'unrestricted'
        : projectScope.kind === 'empty'
          ? 'empty'
          : 'restricted',
    // Only the kinds that actually carry ids expose them. An `orgUnits` scope can
    // legitimately have an empty `personIds`, so a consumer must not infer
    // emptiness from one list and widen on it.
    orgUnitIds:
      projectScope &&
      (projectScope.kind === 'orgUnits' || projectScope.kind === 'peopleAndOrgUnits')
        ? projectScope.orgUnitIds
        : undefined,
    projectPersonIds:
      projectScope && projectScope.kind !== 'unrestricted' && projectScope.kind !== 'empty'
        ? projectScope.personIds
        : undefined,
  }
}

/** Everything the scope rules need, resolved by the caller. */
export type AnalyticsScopeSubject = {
  isSuperAdmin: boolean
  /** Mirrors `can()` from `@beaconhs/tenant`, including tier widening. */
  permissions: (key: string) => boolean
  /** Site org-unit ids from `{ type: 'sites' }` scopes. */
  siteIds: readonly string[]
  personId: string | null
  /** `ctx.membership.id` — the tenant_users row id. */
  tenantUserId: string | null
  /**
   * Project Scope org-unit ids, since 15B-2.
   *
   * Deliberately carried on the SUBJECT rather than consumed by the resolver
   * rules in this commit: `resolveEntity` keeps its current tier behaviour, and
   * 15B-3 changes that. Today these two fields exist so the insights card cache
   * key reflects the caller's Project Scope — without them a caller whose
   * assignment was revoked keeps being served the previous project's rows for
   * the cache TTL. Undefined means "not resolved", which cannot collide with an
   * empty-but-resolved scope.
   */
  orgUnitIds?: readonly string[]
  /** Project Scope person ids, for the same cache-key reason. */
  projectPersonIds?: readonly string[]
  /**
   * Whether a Project Scope was resolved at all, and whether it was unrestricted.
   *
   * This discriminator exists because of a real collision the cache-key tests
   * caught: an `unrestricted` caller and a caller whose scope resolved to `empty`
   * both produce empty id lists, and would otherwise share one cache key — so a
   * caller who can see nothing could be served a company-wide result. The three
   * states must never collapse.
   */
  projectScopeKind?: 'unrestricted' | 'empty' | 'restricted' | 'unknown'
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
  /**
   * An EXPLICIT, named exemption from the Project Scope row predicate.
   *
   * Only set on a spec that declares NO scope columns at all, and only for a
   * table whose entire content is per-tenant configuration or organizational
   * definition — never for one that holds per-person or per-project business
   * records. `validateScopeSpecs` rejects any spec that both exempts itself and
   * declares columns, so an exemption can never quietly become a licence to
   * skip a bindable entity.
   *
   * An exemption skips the ROW PREDICATE only. The read tier is resolved first
   * and independently, so an exempt table is still withheld from a caller who
   * lacks the module's read permission.
   *
   * This is the ONLY way an entity may skip the Project Scope. Falling through
   * the `tier === 'all'` branch is not an exemption; it is the bug.
   */
  projectScopeExempt?: ProjectScopeExemption
}

/**
 * The recognised exemption reasons.
 *
 *   `tenant-level-setting`   — a single-row-per-tenant configuration knob
 *                               (`vehicle_log_settings`).
 *   `tenant-level-definition` — tenant-level organizational
 *                               definition/configuration data rather than
 *                               per-person, per-project, or project-scoped
 *                               business records: `org_units` (which DEFINES the
 *                               tree every scope is expressed in) and the
 *                               `departments` / `crews` / `trades` grouping
 *                               catalogs drawn from it. Intentionally visible to
 *                               authorized tenant administrators regardless of the
 *                               caller's Project Scope, because a scope expressed
 *                               in org units cannot restrict the org units
 *                               themselves without being circular.
 *
 * An exemption skips the Project Scope ROW PREDICATE only. It never grants a
 * read permission — a caller without the module's read key is still withheld by
 * `tierFor` before the scope is ever consulted.
 */
export type ProjectScopeExemption = 'tenant-level-setting' | 'tenant-level-definition'

/** Every reason `validateScopeSpecs` will accept. Anything else is an error. */
const PROJECT_SCOPE_EXEMPTIONS: readonly ProjectScopeExemption[] = [
  'tenant-level-setting',
  'tenant-level-definition',
]

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
  // `person_` / `people_` / `job_title` declare NO scope column, so since
  // 15B-3B they are WITHHELD for a caller inside a Project Scope rather than
  // returned unfiltered. They carry no location column at all — a person's
  // reporting line (`manager_person_id`) is not a placement and is deliberately
  // NOT used as a Project Scope binding, because "reports to" and "works at" are
  // different facts and binding on the former would leak across projects.
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
  // with no Project Scope bound. `scope.test.ts` pins that unreachability.
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
  // `safe_distance_records` really does carry `site_org_unit_id` and
  // `operator_person_id`, so this spec was unbindable by omission rather than by
  // data model. 15B-3B declares both so a restricted caller is narrowed rather
  // than withheld.
  [
    'safe_distance',
    {
      read: { key: 'tools.safe-distance.use' },
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
  documents: { read: { key: 'documents.read' } },
  people: { read: { key: 'admin.users.manage' } },

  // `corrective_actions` has no `ca_` prefix, so it is spelled out here.
  corrective_actions: {
    read: { prefix: 'ca' },
    siteCols: SITE_COLUMNS,
    userCols: USER_COLUMNS,
  },

  // Vehicle log settings is a single per-tenant configuration row: `enabled_modes`
  // and `default_mode`, and nothing else. It holds no per-person, per-site or
  // per-project record, so a Project Scope has nothing to select on and narrowing
  // it could not hide anything.
  //
  // This spec is exempt, and the exemption is named rather than inferred from
  // "has no columns" — `validateScopeSpecs` rejects a spec that both exempts
  // itself and declares a column, so an exemption can never become a licence to
  // skip a bindable entity. `runScopeSpecValidation` asserts this table's shape
  // as well, so a future column cannot silently turn it into business data.
  vehicle_log_settings: {
    read: { key: 'equipment.read.all' },
    projectScopeExempt: 'tenant-level-setting',
  },

  // Organisation structure is tenant master data, not workforce records.
  //
  // These four ARE the Project Scope definition domain: `org_units` defines the
  // tree every scope is expressed in, and `departments` / `crews` / `trades` are
  // grouping sets drawn from that tree.
  //
  // 15B-3E — DECISION: option (c), exempt them as definition-domain data.
  //
  // Why an exemption and not a binding: there is no usable column to bind on, and
  // inventing one is worse than useless. `org_units.parent_id` points at another
  // org unit, so restricting the org tree by the org tree is CIRCULAR — the scope
  // is expressed in the very rows it would filter. The other three are pure
  // name/code catalogs with no relationship to any record.
  //
  // Why withholding (the 15B-3B fail-closed default) was wrong: it removed a
  // tenant administrator's ability to group or filter a report by location,
  // department, crew or trade while holding the very permission that administers
  // them. They are definitional, not business facts.
  //
  // Why this is not a licence to read tenant business data: the exemption skips
  // the Project Scope ROW PREDICATE only. `tierFor` runs FIRST, so a caller
  // without `admin.org.manage` is still withheld, and the four tables hold no
  // per-person, per-site or per-project rows to leak in the first place. This is
  // explicitly NOT a restoration of the `tier === 'all' -> undefined` fail-open
  // that 15B-3B fixed: that path made EVERY unbindable table tenant-wide, whereas
  // this names four tables and is enforced by `validateScopeSpecs`.
  //
  // `locations/export.csv` is deliberately NOT covered. Its exported columns and
  // business semantics must be verified before deciding whether it is
  // definition-domain data or needs a real Project Scope binding; it remains
  // deferred to a separate 3E decision.
  org_units: { read: { key: 'admin.org.manage' }, projectScopeExempt: 'tenant-level-definition' },
  departments: { read: { key: 'admin.org.manage' }, projectScopeExempt: 'tenant-level-definition' },
  crews: { read: { key: 'admin.org.manage' }, projectScopeExempt: 'tenant-level-definition' },
  trades: { read: { key: 'admin.org.manage' }, projectScopeExempt: 'tenant-level-definition' },

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
 * against a synthetic spec — otherwise "an exemption cannot be attached to a
 * table that has columns" would be an untested claim, which is exactly the shape
 * of bug this exists to prevent.
 */
export function validateScopeSpecs(specs: readonly { match: string; spec: ScopeSpec }[]): string[] {
  const errors: string[] = []
  for (const { match, spec } of specs) {
    const declaresColumns = Boolean(
      spec.siteCols || spec.personCols || spec.userCols || spec.orgUnitCols,
    )
    if (spec.projectScopeExempt && declaresColumns) {
      errors.push(
        `${match}: declares projectScopeExempt ('${spec.projectScopeExempt}') AND scope columns. ` +
          `An exemption must only apply to a table with nothing to narrow on; otherwise it is a ` +
          `licence to skip a bindable entity.`,
      )
    }
    if (spec.projectScopeExempt && !PROJECT_SCOPE_EXEMPTIONS.includes(spec.projectScopeExempt)) {
      errors.push(`${match}: unrecognised projectScopeExempt '${spec.projectScopeExempt}'.`)
    }
  }
  return errors
}

/**
 * Structural invariants on the real spec table.
 *
 * Called from `scope.test.ts` rather than at import time, so a mistake surfaces in
 * a test with a readable failure instead of at module load in production.
 */
export function runScopeSpecValidation(): { errors: string[] } {
  const errors = validateScopeSpecs(allScopeSpecs())
  // Every exemption in use must be justified by the table's actual shape. The
  // column lists are asserted statically rather than introspected so the check
  // runs without a database; each is transcribed from `packages/db/src/schema`.
  for (const [table, allowed] of Object.entries(DEFINITION_DOMAIN_COLUMNS)) {
    if (TABLE_SCOPE[table]?.projectScopeExempt !== 'tenant-level-definition') continue
    const unexpected = allowed.actual.filter((c) => !allowed.expected.includes(c))
    if (unexpected.length > 0) {
      errors.push(
        `${table}: exempts itself as tenant-level definition data, but the entity exposes ` +
          `${unexpected.join(', ')}. A person-, site- or project-keyed column would make this a ` +
          `business-data table and the exemption a leak.`,
      )
    }
  }
  // The one exemption in use must be justified by the table's actual shape.
  const vehicle = TABLE_SCOPE.vehicle_log_settings
  if (vehicle?.projectScopeExempt) {
    const allowed = new Set([
      'id',
      'tenant_id',
      'enabled_modes',
      'default_mode',
      'created_at',
      'updated_at',
    ])
    const unexpected = VEHICLE_LOG_SETTINGS_COLUMNS.filter((c) => !allowed.has(c))
    if (unexpected.length > 0) {
      errors.push(
        `vehicle_log_settings: exempts itself as tenant-level configuration, but the entity ` +
          `exposes ${unexpected.join(', ')}. A person-, site- or project-keyed column would make ` +
          `this a business-data table and the exemption a leak.`,
      )
    }
  }
  return { errors }
}

/**
 * The 15B-3E definition-domain tables, with the columns each is allowed to
 * expose while carrying `projectScopeExempt: 'tenant-level-definition'`.
 *
 * Transcribed from `packages/db/src/schema/org.ts` at the time of 15B-3E. The
 * point of the `expected` list is that it names the only columns a definitional
 * table may have: identifiers, tenant, the definition itself, and timestamps.
 *
 * Two absences carry the whole argument and are therefore asserted rather than
 * assumed:
 *
 *   • no `person_id` / `owner_tenant_user_id` — nothing here is a person's record
 *   • no `org_unit_id` / `site_org_unit_id` — nothing here is a PLACEMENT.
 *     `org_units.parent_id` is the one org-unit-shaped column and it is the TREE
 *     DEFINITION itself, not a reference to a scope-bearing record, so it is
 *     listed as definitional rather than as a binding.
 *
 * A future column here that is person-, site- or project-keyed turns the table
 * into business data and must fail this check rather than inherit the exemption.
 */
const DEFINITION_DOMAIN_COLUMNS: Record<
  string,
  { expected: readonly string[]; actual: readonly string[] }
> = {
  org_units: {
    expected: [
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
    actual: [
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
  },
  departments: {
    expected: ['id', 'tenant_id', 'name', 'code', 'description', 'created_at', 'updated_at'],
    actual: ['id', 'tenant_id', 'name', 'code', 'description', 'created_at', 'updated_at'],
  },
  crews: {
    expected: ['id', 'tenant_id', 'name', 'created_at', 'updated_at'],
    actual: ['id', 'tenant_id', 'name', 'created_at', 'updated_at'],
  },
  trades: {
    expected: ['id', 'tenant_id', 'name', 'code', 'created_at', 'updated_at'],
    actual: ['id', 'tenant_id', 'name', 'code', 'created_at', 'updated_at'],
  },
}

/**
 * The columns the vehicle-log settings entity is known to expose. Asserted
 * statically rather than introspected so the check runs without a database; the
 * live shape is `vehicle_log_settings` in `packages/db/src/schema`.
 */
const VEHICLE_LOG_SETTINGS_COLUMNS = [
  'id',
  'tenant_id',
  'enabled_modes',
  'default_mode',
  'created_at',
  'updated_at',
] as const

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
 * What the caller's Project Scope contributes to one entity, before the read
 * tier is considered.
 *
 *   `deny`     — the caller is inside no scope, or the scope was never resolved.
 *                The entity is withheld. `unknown` is grouped with `empty` on
 *                purpose: an absent scope is not evidence of a wide one, and a
 *                caller whose scope could not be resolved must never fall
 *                through to a company-wide read.
 *   `none`     — the caller is company-wide (`unrestricted`), OR the spec carries
 *                an explicit `projectScopeExempt`. Nothing to add.
 *   `restrict` — a real scope, plus the entity columns it can bind to.
 */
type ScopeContribution =
  | { kind: 'deny' }
  | { kind: 'none' }
  | {
      kind: 'restrict'
      orgUnitIds: readonly string[]
      personIds: readonly string[]
      orgUnitCol: string | null
      personCol: string | null
    }

/**
 * The Project Scope half of the decision, kept separate from `tierFor`.
 *
 * `tierFor` is a pure permission→tier mapper and must stay one: putting scope in
 * it would mean a permission could decide visibility, which is the exact
 * confusion 15B-2 removed from the web ladder.
 */
function scopeContribution(
  subject: AnalyticsScopeSubject,
  spec: ScopeSpec,
  entity: AnalyticsEntity,
): ScopeContribution {
  const kind = subject.projectScopeKind ?? 'unknown'
  if (kind === 'empty' || kind === 'unknown') return { kind: 'deny' }
  if (kind === 'unrestricted') return { kind: 'none' }
  if (spec.projectScopeExempt) return { kind: 'none' }

  const orgUnitCol = pickColumn(entity, spec.siteCols) ?? pickColumn(entity, spec.orgUnitCols)
  return {
    kind: 'restrict',
    orgUnitIds: subject.orgUnitIds ?? [],
    personIds: subject.projectPersonIds ?? [],
    orgUnitCol,
    personCol: pickColumn(entity, spec.personCols),
  }
}

/**
 * Bind a resolved scope to the entity's columns, as report filters.
 *
 * Each leg is considered on its own and a non-empty id list is required, so a
 * scope that carries only org units does not silently fall back to an empty
 * person list. `null` means "this scope cannot be expressed here" and the caller
 * MUST withhold — it must never be read as "no restriction".
 */
function scopeFilter(
  contribution: Extract<ScopeContribution, { kind: 'restrict' }>,
): ReportRuleGroup | null {
  const legs: ReportRuleGroup[] = []
  if (contribution.orgUnitCol && contribution.orgUnitIds.length > 0) {
    legs.push(rule(contribution.orgUnitCol, contribution.orgUnitIds))
  }
  if (contribution.personCol && contribution.personIds.length > 0) {
    legs.push(rule(contribution.personCol, contribution.personIds))
  }
  if (legs.length === 0) return null
  // A single leg needs no wrapper; two legs are a genuine union, because a row is
  // in scope if EITHER its place or its person is — the same `or(...)` the SQL
  // adapter in `apps/web/src/lib/project-scope-predicate.ts` builds.
  if (legs.length === 1) return legs[0]!
  return { combinator: 'or', rules: legs }
}

/**
 * Resolve one entity's read permission and row predicate.
 *
 * `visible: false` withholds the entity from the catalogue entirely. That is the
 * fail-closed path and it covers four cases: the caller holds no read
 * permission, the caller is inside no Project Scope, the caller's scope could not
 * be resolved, or the scope cannot be expressed against this entity. Withholding
 * by omission means a mis-specified table can never fall back to an unscoped,
 * tenant-wide read.
 *
 * The order is deliberate and load-bearing:
 *
 *   1. no read permission            → withhold
 *   2. no usable Project Scope       → withhold   (deny, including `unknown`)
 *   3. tier `all` + bindable scope   → the scope predicate  ← the 15B-3B fix
 *   4. tier `all` + unbindable scope → withhold
 *   5. tier `site` / `self`          → existing ladder, AND the scope
 *
 * Step 3 is what 15B-2 already did in `apps/web/src/lib/visibility.ts:205-209`,
 * where `tier === 'all'` returns the scope predicate rather than `undefined`.
 * Before this change the analytics ladder returned `{filter: undefined}` here, so
 * a `read.all` holder received every row in the tenant regardless of their
 * Project Scope — the identical defect, in the other ladder.
 */
function resolveEntity(subject: AnalyticsScopeSubject, entity: AnalyticsEntity): Resolution {
  const spec = resolveScopeSpec(entity.table)
  if (!spec || spec.read === null) return { visible: false }

  const tier = tierFor(subject, spec.read)
  if (tier === 'none') return { visible: false }

  const contribution = scopeContribution(subject, spec, entity)
  if (contribution.kind === 'deny') return { visible: false }
  // `orgUnitCol` is read from the entity only for the `restrict` case, so the
  // remaining tiers need their own picks.
  const orgUnitFilter = contribution.kind === 'restrict' ? scopeFilter(contribution) : undefined

  if (tier === 'all') {
    if (contribution.kind === 'restrict') {
      // Restricted caller, entity exposes no column the scope can bind to →
      // withhold. Never tenant-wide.
      if (orgUnitFilter === null || orgUnitFilter === undefined) return { visible: false }
      return { visible: true, filter: orgUnitFilter }
    }
    // Company-wide, or an explicit exemption: no Project Scope constraint.
    return { visible: true, filter: undefined }
  }

  const siteCol = pickColumn(entity, spec.siteCols)
  const personCol = pickColumn(entity, spec.personCols)
  const userCol = pickColumn(entity, spec.userCols)

  if (tier === 'site' && siteCol) {
    if (subject.siteIds.length === 0) return { visible: false }
    return { visible: true, filter: andFilters(rule(siteCol, subject.siteIds), orgUnitFilter) }
  }

  // Fall back to the ownership column. Own rows are strictly narrower than a
  // site scope, so this narrows rather than widens; a caller holding a crew or
  // team scope (rather than `sites`) lands here until crew expansion is
  // available, which is safe.
  const ownerCol = userCol && subject.tenantUserId ? userCol : personCol
  if (ownerCol) {
    const owner = userCol === ownerCol ? subject.tenantUserId : subject.personId
    if (owner) {
      return { visible: true, filter: andFilters(rule(ownerCol, [owner]), orgUnitFilter) }
    }
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
    // Project Scope, since 15B-2. The insights card cache is keyed on this
    // fingerprint, and a scope that only reflected `sites` would keep serving a
    // revoked project's rows for the TTL. Sorted and deduped so two callers with
    // the same scope in a different insertion order share a key, and so an
    // `unrestricted` caller can never collide with a restricted one.
    // The discriminator is part of the key, so `unrestricted`, `empty` and
    // `restricted` can never share one.
    projectScope: subject.projectScopeKind ?? 'unknown',
    orgUnits: [...new Set(subject.orgUnitIds ?? [])].sort(),
    projectPersons: [...new Set(subject.projectPersonIds ?? [])].sort(),
  })
}
