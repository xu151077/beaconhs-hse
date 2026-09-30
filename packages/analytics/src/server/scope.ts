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
  /** Candidate person columns, first one the entity actually has wins. */
  personCols?: readonly string[]
  /** Candidate tenant-user columns, first one the entity actually has wins. */
  userCols?: readonly string[]
}

type Tier = 'all' | 'site' | 'self' | 'none'

/** The platform's dominant location column names, most-specific first. */
const SITE_COLUMNS = ['site_org_unit_id', 'current_site_org_unit_id'] as const
/** Person-owning columns, most-specific first. */
const PERSON_COLUMNS = [
  'person_id',
  'subject_person_id',
  'driver_person_id',
  'inspector_person_id',
  'current_holder_person_id',
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
  ['person_', { read: { key: 'admin.users.manage' } }],
  ['people_', { read: { key: 'admin.users.manage' } }],
  ['customer_', { read: { key: 'admin.users.manage' } }],
  ['job_title', { read: { key: 'admin.users.manage' } }],
  // `role_` before `role`: a per-user dashboard layout is not workforce master
  // data and is withheld rather than following the `roles` tables.
  ['role_', { read: null }],
  ['role', { read: { key: 'admin.users.manage' } }],

  // --- insights / reports ---------------------------------------------
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
  ['safe_distance', { read: { key: 'tools.safe-distance.use' } }],

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

  // Vehicle log settings is a single per-tenant equipment row: a flat equipment
  // read, and no row scope to apply.
  vehicle_log_settings: { read: { key: 'equipment.read.all' } },

  // Organisation structure is tenant master data, not workforce records.
  org_units: { read: { key: 'admin.org.manage' } },
  departments: { read: { key: 'admin.org.manage' } },
  crews: { read: { key: 'admin.org.manage' } },
  trades: { read: { key: 'admin.org.manage' } },

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
    read: { key: 'compliance.read' },
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
 * `visible: false` withholds the entity from the catalogue entirely. That is
 * the fail-closed path and it is used in two cases: the caller holds no read
 * permission, and the caller's scope cannot be expressed against this entity
 * (no location or owner column). Withholding by omission means a mis-specified
 * table can never fall back to an unscoped, tenant-wide read.
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
