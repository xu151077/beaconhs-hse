// THE single source of truth for what a custom report can query. Each entity
// carries both the UI metadata (labels, kinds, descriptions — drives the
// report studio) and the SQL metadata (physical table, whitelisted column
// identifiers — drives the executor). This replaces the old pair of
// hand-synced copies (apps/web _builder-meta.ts + apps/worker
// reports-shared.ts whitelists).

import {
  reportColumn,
  reportColumnExpression,
  type ReportColumnKind,
  type ReportEntity as AppKitReportEntity,
  type ReportEntityColumn,
  type ReportEntityCatalog,
} from '@braedonsaunders/appkit-reports'

export type ReportEntity = AppKitReportEntity & { table: string }
export type { ReportColumnKind, ReportEntityColumn, ReportEntityCatalog }

export const REPORT_ENTITIES: ReportEntity[] = [
  {
    key: 'incidents',
    label: 'Incidents',
    category: 'incidents',
    description: 'Reported incidents (injury, near-miss, property, environmental, etc.)',
    table: 'incidents',
    softDelete: true,
    columns: [
      { key: 'reference', label: 'Reference', kind: 'text' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'severity', label: 'Severity', kind: 'enum' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'type', label: 'Type', kind: 'enum' },
      { key: 'occurred_at', label: 'Occurred at', kind: 'timestamp' },
      { key: 'site_org_unit_id', label: 'Site (id)', kind: 'uuid' },
      { key: 'department_id', label: 'Department (id)', kind: 'uuid' },
      { key: 'actual_severity', label: 'Actual severity (1-5)', kind: 'number' },
      { key: 'potential_severity', label: 'Potential severity (1-5)', kind: 'number' },
    ],
    defaultSort: { column: 'occurred_at', direction: 'desc' },
  },
  {
    key: 'corrective_actions',
    label: 'Corrective actions',
    category: 'corrective_actions',
    description: 'CAs assigned from inspections, audits, incidents, observations, etc.',
    table: 'report_corrective_actions',
    softDelete: true,
    columns: [
      { key: 'reference', label: 'Reference', kind: 'text' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'severity', label: 'Severity', kind: 'enum' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'due_on', label: 'Due on', kind: 'date' },
      { key: 'assigned_on', label: 'Assigned on', kind: 'date' },
      { key: 'source', label: 'Source', kind: 'enum' },
      { key: 'owner_tenant_user_id', label: 'Owner (id)', kind: 'uuid' },
      { key: 'owner_name', label: 'Owner', kind: 'text' },
      { key: 'department_id', label: 'Department (id)', kind: 'uuid' },
      { key: 'department_name', label: 'Department', kind: 'text' },
      {
        key: 'group_id_list',
        label: 'Person group',
        kind: 'text',
        filterValueMode: 'csv-set',
      },
      { key: 'site_org_unit_id', label: 'Site (id)', kind: 'uuid' },
      { key: 'location_name', label: 'Location', kind: 'text' },
    ],
    defaultSort: { column: 'due_on', direction: 'asc' },
  },
  {
    key: 'training_records',
    label: 'Training records',
    category: 'training',
    description: 'Earned training certificates per person, with employee and course fields joined.',
    table: 'report_training_records',
    softDelete: true,
    columns: [
      { key: 'person_id', label: 'Person (id)', kind: 'uuid' },
      { key: 'employee_no', label: 'Employee #', kind: 'text' },
      { key: 'person_name', label: 'Person', kind: 'text' },
      { key: 'person_status', label: 'Employment status', kind: 'enum' },
      { key: 'course_id', label: 'Course (id)', kind: 'uuid' },
      { key: 'course_code', label: 'Course code', kind: 'text' },
      { key: 'course_name', label: 'Course', kind: 'text' },
      { key: 'completed_on', label: 'Completed on', kind: 'date' },
      { key: 'expires_on', label: 'Expires on', kind: 'date' },
      { key: 'source', label: 'Source', kind: 'enum' },
      { key: 'score', label: 'Score', kind: 'number' },
      { key: 'grade', label: 'Grade (%)', kind: 'number' },
      { key: 'department_id', label: 'Department', kind: 'uuid' },
      { key: 'department_name', label: 'Department name', kind: 'text' },
      {
        key: 'group_id_list',
        label: 'Person group',
        kind: 'text',
        filterValueMode: 'csv-set',
      },
    ],
    defaultSort: { column: 'completed_on', direction: 'desc' },
  },
  {
    key: 'skill_assignments',
    label: 'Skills & certifications',
    category: 'training',
    description:
      'Externally-issued skills and certifications per person — authority, code, granted and expiry dates (e.g. CWB welder rosters).',
    // Join-baked view (packages/db/src/views.ts) — RLS flows through from base tables.
    table: 'report_skill_assignments',
    columns: [
      { key: 'employee_no', label: 'Employee #', kind: 'text' },
      { key: 'last_name', label: 'Last name', kind: 'text' },
      { key: 'first_name', label: 'First name', kind: 'text' },
      { key: 'trade', label: 'Trade', kind: 'text' },
      { key: 'authority', label: 'Authority', kind: 'text' },
      { key: 'certification_code', label: 'Certification code', kind: 'text' },
      { key: 'certification_name', label: 'Certification name', kind: 'text' },
      { key: 'cwb_standard', label: 'CWB standard', kind: 'text' },
      { key: 'cwb_type', label: 'CWB type', kind: 'text' },
      { key: 'cwb_process', label: 'CWB process', kind: 'text' },
      { key: 'cwb_position', label: 'CWB position', kind: 'text' },
      { key: 'cwb_level', label: 'CWB level', kind: 'text' },
      { key: 'granted_on', label: 'Granted on', kind: 'date' },
      { key: 'expires_on', label: 'Expires on', kind: 'date' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'person_id', label: 'Person (id)', kind: 'uuid' },
      { key: 'department_id', label: 'Department', kind: 'uuid' },
      { key: 'department_name', label: 'Department name', kind: 'text' },
      {
        key: 'group_id_list',
        label: 'Person group',
        kind: 'text',
        filterValueMode: 'csv-set',
      },
      { key: 'skill_type_id', label: 'Skill type (id)', kind: 'uuid' },
      { key: 'authority_id', label: 'Authority (id)', kind: 'uuid' },
    ],
    defaultSort: { column: 'expires_on', direction: 'asc' },
  },
  {
    key: 'inspection_records',
    label: 'Inspection records',
    category: 'inspections',
    description: 'Inspection records performed against an inspection_type.',
    table: 'inspection_records',
    softDelete: true,
    columns: [
      { key: 'reference', label: 'Reference', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'occurred_at', label: 'Occurred at', kind: 'timestamp' },
      { key: 'location_on_site', label: 'Location on site', kind: 'text' },
      { key: 'type_id', label: 'Type (id)', kind: 'uuid' },
      { key: 'site_org_unit_id', label: 'Site (id)', kind: 'uuid' },
    ],
    defaultSort: { column: 'occurred_at', direction: 'desc' },
  },
  {
    key: 'documents',
    label: 'Documents',
    category: 'documents',
    description: 'Controlled documents in the document library.',
    table: 'documents',
    softDelete: true,
    columns: [
      { key: 'key', label: 'Document key', kind: 'text' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'next_review_on', label: 'Next review on', kind: 'date' },
    ],
    defaultSort: { column: 'next_review_on', direction: 'asc' },
  },
  {
    key: 'equipment_items',
    label: 'Equipment',
    category: 'equipment',
    description: 'Equipment items in the fleet.',
    table: 'equipment_items',
    softDelete: true,
    columns: [
      { key: 'asset_tag', label: 'Asset tag', kind: 'text' },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'serial_number', label: 'Serial number', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'current_site_org_unit_id', label: 'Current site (id)', kind: 'uuid' },
      { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
      { key: 'model', label: 'Model', kind: 'text' },
      { key: 'purchase_price', label: 'Purchase price', kind: 'number' },
      { key: 'next_oil_change_due', label: 'Next oil change', kind: 'date' },
    ],
    defaultSort: { column: 'asset_tag', direction: 'asc' },
  },
  {
    key: 'equipment_fleet',
    label: 'Equipment fleet',
    category: 'equipment',
    description:
      'One row per asset with type, current site/holder, and YTD + all-time usage (hours/km). Operational only — equipment financials live in the admin app. Drives the fleet and upcoming inspection/oil-change reports.',
    // Join-baked view (packages/db/src/views.ts) — RLS flows through base tables.
    table: 'report_equipment_fleet',
    columns: [
      { key: 'asset_tag', label: 'Asset tag', kind: 'text' },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'serial_number', label: 'Serial number', kind: 'text' },
      { key: 'equipment_type', label: 'Type', kind: 'text' },
      { key: 'type_category', label: 'Category', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'site_name', label: 'Current site', kind: 'text' },
      { key: 'holder_name', label: 'Holder', kind: 'text' },
      { key: 'is_missing', label: 'Missing', kind: 'enum' },
      { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
      { key: 'model', label: 'Model', kind: 'text' },
      { key: 'purchase_price', label: 'Purchase price', kind: 'number' },
      { key: 'ownership', label: 'Ownership', kind: 'enum' },
      { key: 'last_inspection_on', label: 'Last inspection', kind: 'date' },
      { key: 'next_inspection_due', label: 'Next inspection due', kind: 'date' },
      { key: 'requires_oil_change', label: 'Requires oil change', kind: 'boolean' },
      { key: 'last_oil_change_on', label: 'Last oil change', kind: 'date' },
      { key: 'next_oil_change_due', label: 'Next oil change', kind: 'date' },
      { key: 'oil_change_interval_months', label: 'Oil change interval (mo.)', kind: 'number' },
      { key: 'purchase_date', label: 'Purchase date', kind: 'date' },
      { key: 'hours_ytd', label: 'Hours YTD', kind: 'number' },
      { key: 'km_ytd', label: 'Km YTD', kind: 'number' },
      { key: 'hours_total', label: 'Hours (all-time)', kind: 'number' },
      { key: 'current_site_org_unit_id', label: 'Current site (id)', kind: 'uuid' },
    ],
    defaultSort: { column: 'asset_tag', direction: 'asc' },
  },
  {
    key: 'vehicle_log_entries',
    label: 'Vehicle log entries',
    category: 'equipment',
    description:
      'Daily vehicle log detail with driver, vehicle, site, km, hours and source/import status.',
    table: 'report_vehicle_log_entries',
    columns: [
      { key: 'entry_date', label: 'Entry date', kind: 'date' },
      { key: 'month', label: 'Month', kind: 'date' },
      { key: 'asset_tag', label: 'Asset tag', kind: 'text' },
      { key: 'vehicle_name', label: 'Vehicle', kind: 'text' },
      { key: 'employee_no', label: 'Employee #', kind: 'text' },
      { key: 'driver_name', label: 'Driver', kind: 'text' },
      { key: 'entry_mode', label: 'Mode', kind: 'enum' },
      { key: 'start_odometer', label: 'Start odometer', kind: 'number' },
      { key: 'end_odometer', label: 'End odometer', kind: 'number' },
      { key: 'business_km', label: 'Business km', kind: 'number' },
      { key: 'personal_km', label: 'Personal km', kind: 'number' },
      { key: 'total_km', label: 'Total km', kind: 'number' },
      { key: 'hours_on_site', label: 'Hours on site', kind: 'number' },
      { key: 'manpower_count', label: 'Crew count', kind: 'number' },
      { key: 'site_code', label: 'Site code', kind: 'text' },
      { key: 'site_name', label: 'Site', kind: 'text' },
      { key: 'destination', label: 'Destination', kind: 'text' },
      { key: 'import_status', label: 'Import status', kind: 'enum' },
      { key: 'source_system', label: 'Source system', kind: 'text' },
      { key: 'source_name', label: 'Source name', kind: 'text' },
      { key: 'source_label', label: 'Source label', kind: 'text' },
      { key: 'driver_person_id', label: 'Driver (id)', kind: 'uuid' },
      { key: 'equipment_item_id', label: 'Vehicle (id)', kind: 'uuid' },
      { key: 'site_org_unit_id', label: 'Site (id)', kind: 'uuid' },
    ],
    defaultSort: { column: 'entry_date', direction: 'desc' },
  },
  {
    key: 'vehicle_log_monthly',
    label: 'Vehicle log monthly',
    category: 'equipment',
    description:
      'Monthly driver-by-vehicle rollup for vehicle-log summaries, utilization and import coverage.',
    table: 'report_vehicle_log_monthly',
    columns: [
      { key: 'month', label: 'Month', kind: 'date' },
      { key: 'asset_tag', label: 'Asset tag', kind: 'text' },
      { key: 'vehicle_name', label: 'Vehicle', kind: 'text' },
      { key: 'employee_no', label: 'Employee #', kind: 'text' },
      { key: 'driver_name', label: 'Driver', kind: 'text' },
      { key: 'logged_days', label: 'Logged days', kind: 'number' },
      { key: 'km_days', label: 'Days with km', kind: 'number' },
      { key: 'business_km', label: 'Business km', kind: 'number' },
      { key: 'personal_km', label: 'Personal km', kind: 'number' },
      { key: 'total_km', label: 'Total km', kind: 'number' },
      { key: 'hours_on_site', label: 'Hours on site', kind: 'number' },
      { key: 'manpower_count', label: 'Crew count total', kind: 'number' },
      { key: 'imported_days', label: 'Imported days', kind: 'number' },
      { key: 'manual_days', label: 'Manual days', kind: 'number' },
      { key: 'first_odometer', label: 'First odometer', kind: 'number' },
      { key: 'last_odometer', label: 'Last odometer', kind: 'number' },
      { key: 'site_count', label: 'Sites', kind: 'number' },
      { key: 'driver_person_id', label: 'Driver (id)', kind: 'uuid' },
      { key: 'equipment_item_id', label: 'Vehicle (id)', kind: 'uuid' },
    ],
    defaultSort: { column: 'month', direction: 'desc' },
  },
  {
    key: 'ppe_items',
    label: 'PPE items',
    category: 'ppe',
    description: 'Individual PPE assets.',
    table: 'report_ppe_items',
    softDelete: true,
    columns: [
      { key: 'type_id', label: 'PPE type (id)', kind: 'uuid' },
      { key: 'ppe_type', label: 'PPE type', kind: 'text' },
      { key: 'serial_number', label: 'Serial', kind: 'text' },
      { key: 'size', label: 'Size', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'is_draft', label: 'Draft', kind: 'boolean' },
      { key: 'current_holder_person_id', label: 'Current holder (id)', kind: 'uuid' },
      { key: 'holder_name', label: 'Current holder', kind: 'text' },
      { key: 'holder_status', label: 'Holder status', kind: 'enum' },
      { key: 'holder_employee_no', label: 'Holder employee #', kind: 'text' },
      { key: 'department_id', label: 'Department (id)', kind: 'uuid' },
      { key: 'department_name', label: 'Department', kind: 'text' },
      {
        key: 'group_id_list',
        label: 'Person group',
        kind: 'text',
        filterValueMode: 'csv-set',
      },
      { key: 'last_inspection_on', label: 'Last pre-use inspection', kind: 'date' },
      { key: 'next_inspection_due', label: 'Next pre-use inspection', kind: 'date' },
      { key: 'last_annual_inspection_on', label: 'Last annual inspection', kind: 'date' },
      { key: 'next_annual_inspection_due', label: 'Next annual inspection', kind: 'date' },
      { key: 'purchase_date', label: 'Purchase date', kind: 'date' },
      { key: 'expires_on', label: 'Expires on', kind: 'date' },
    ],
    defaultSort: { column: 'next_inspection_due', direction: 'asc' },
  },
  {
    key: 'training_matrix',
    label: 'Training matrix',
    category: 'training',
    description:
      'Person × course coverage — one row per person and course with the latest record status (valid / expiring / expired / missing).',
    // Join-baked view (packages/db/src/views.ts) — RLS flows through base tables.
    table: 'report_training_matrix',
    columns: [
      { key: 'person_id', label: 'Person (id)', kind: 'uuid' },
      { key: 'employee_no', label: 'Employee #', kind: 'text' },
      { key: 'last_name', label: 'Last name', kind: 'text' },
      { key: 'first_name', label: 'First name', kind: 'text' },
      { key: 'person_name', label: 'Person', kind: 'text' },
      { key: 'person_status', label: 'Employment status', kind: 'enum' },
      { key: 'course_id', label: 'Course (id)', kind: 'uuid' },
      { key: 'course_code', label: 'Course code', kind: 'text' },
      { key: 'course_name', label: 'Course', kind: 'text' },
      { key: 'course_type', label: 'Course type', kind: 'text' },
      { key: 'completed_on', label: 'Completed on', kind: 'date' },
      { key: 'expires_on', label: 'Expires on', kind: 'date' },
      { key: 'coverage_status', label: 'Coverage', kind: 'enum' },
      // Coverage stays honest — expired is expired until the class is sat —
      // while these say a seat is already booked, so the missing-training
      // report does not send coordinators chasing people who are handled.
      { key: 'booked_starts_at', label: 'Booked for', kind: 'timestamp' },
      {
        key: 'booked',
        label: 'Booked',
        kind: 'boolean',
        expression: '(booked_starts_at IS NOT NULL)',
      },
      { key: 'department_id', label: 'Department', kind: 'uuid' },
      { key: 'department_name', label: 'Department name', kind: 'text' },
      { key: 'delivery_type', label: 'Course delivery type', kind: 'enum' },
      {
        key: 'group_id_list',
        label: 'Person group',
        kind: 'text',
        filterValueMode: 'csv-set',
      },
      { key: 'is_required', label: 'Required', kind: 'boolean' },
    ],
    defaultSort: { column: 'person_name', direction: 'asc' },
  },
  {
    key: 'incident_rates',
    label: 'Incident rates (TRIR / DART)',
    category: 'incidents',
    description:
      'Per-month recordable + DART incident counts and hours worked. Build TRIR/DART as a calculated rate: sum(recordable) ÷ sum(hours) × 200,000.',
    table: 'report_incident_rates',
    columns: [
      { key: 'month', label: 'Month', kind: 'date' },
      { key: 'recordable_count', label: 'Recordable incidents', kind: 'number' },
      { key: 'dart_count', label: 'DART incidents', kind: 'number' },
      { key: 'hours_worked', label: 'Hours worked', kind: 'number' },
    ],
    defaultSort: { column: 'month', direction: 'asc' },
  },
  {
    key: 'compliance_status',
    label: 'Compliance status',
    category: 'compliance',
    description:
      'Materialized compliance results with the obligation, source module, and person names resolved.',
    table: 'report_compliance_status',
    columns: [
      { key: 'source_module', label: 'Module', kind: 'enum' },
      { key: 'obligation_title', label: 'Requirement', kind: 'text' },
      { key: 'subject_key', label: 'Subject', kind: 'text' },
      { key: 'person_name', label: 'Employee', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'enum' },
      { key: 'period_start', label: 'Period start', kind: 'date' },
      { key: 'period_end', label: 'Period end', kind: 'date' },
      { key: 'due_on', label: 'Due on', kind: 'date' },
      { key: 'completed_on', label: 'Completed on', kind: 'date' },
      { key: 'count', label: 'Completed', kind: 'number' },
      { key: 'expected', label: 'Expected', kind: 'number' },
      { key: 'percent', label: 'Compliance %', kind: 'number' },
      { key: 'computed_at', label: 'Computed at', kind: 'timestamp' },
    ],
    defaultSort: { column: 'due_on', direction: 'asc' },
  },
  {
    key: 'monitored_sessions',
    label: 'Monitored sessions',
    category: 'apps',
    description: 'Live timed check-in sessions started from any Builder app.',
    table: 'report_monitored_sessions',
    columns: [
      // The real person UUID, so `PERSON_COLUMNS` can match a self-tier caller against
      // their own sessions (defect D10). It used to hold the resolved NAME, which never
      // equals a uuid, so self-scoping could not match.
      //
      // This column must keep resolving to `"report_monitored_sessions"."subject_person_id"`.
      // It is deliberately given NO `expression`: `columnRef` resolves an expression
      // column verbatim, so pointing this one at `subject_person_name` to make the report
      // prettier would silently redirect the SELF-SCOPE PREDICATE at the name and
      // reintroduce D10. The display fix belongs on the column below, which is the one a
      // reader actually sees.
      //
      // `kind: 'uuid'` already makes `isTechnicalIdentifierColumn` true, so the report
      // builder treats this as technical rather than a display column. It stays in
      // `columns`, and therefore in `/api/v1`, because it is the scope key.
      { key: 'subject_person_id', label: 'Employee id', kind: 'uuid' },
      // The readable name, and the column a reader sees as "Employee".
      { key: 'subject_person_name', label: 'Employee', kind: 'text' },
      // The real org-unit UUID, so a site-scoped caller can actually narrow
      // (`SITE_COLUMNS` compares this against `org_units.id`). The readable name lives
      // in its own column; it used to be aliased into this one (defect D7).
      { key: 'site_org_unit_id', label: 'Location', kind: 'uuid' },
      { key: 'site_name', label: 'Site', kind: 'text' },
      { key: 'app_name', label: 'App', kind: 'text' },
      { key: 'monitor_status', label: 'Status', kind: 'enum' },
      { key: 'checkin_interval_minutes', label: 'Check-in interval', kind: 'number' },
      { key: 'grace_period_minutes', label: 'Grace period', kind: 'number' },
      { key: 'expected_end_at', label: 'Expected end', kind: 'timestamp' },
      { key: 'next_checkin_due_at', label: 'Next check-in', kind: 'timestamp' },
      { key: 'last_checkin_at', label: 'Last check-in', kind: 'timestamp' },
      { key: 'escalated_at', label: 'Escalated at', kind: 'timestamp' },
      { key: 'created_at', label: 'Started at', kind: 'timestamp' },
      { key: 'closed_at', label: 'Closed at', kind: 'timestamp' },
    ],
    defaultSort: { column: 'created_at', direction: 'desc' },
  },
  // Environmental monitoring and statutory compliance are Builder apps, so both are
  // exposed as `report_*` views over `form_responses` (see REPORT_VIEWS_SQL in
  // `packages/db/src/views.ts`). Each view filters to one stable `form_templates.key`,
  // so the same key names the same app in every tenant and nothing depends on a
  // per-tenant template UUID.
  //
  // Both reuse the existing `forms` category, which the public API already gates on
  // `forms.response.read.all` and which `TABLE_SCOPE` already binds to the
  // `forms.response` ladder. That is deliberate: these ARE form responses, so they
  // inherit the permissions a Builder reader already holds - no new permission key, no
  // new category, and no second ladder over data the module already governs.
  {
    key: 'environmental_monitoring',
    label: 'Environmental monitoring',
    category: 'forms',
    description:
      'Environmental monitoring readings logged against a site, with the parameter, reading, limit and outcome resolved.',
    table: 'report_environmental_monitoring',
    columns: [
      { key: 'app_key', label: 'App key', kind: 'text' },
      { key: 'response_status', label: 'Response status', kind: 'enum' },
      { key: 'monitoring_category', label: 'Category', kind: 'text' },
      { key: 'parameter', label: 'Parameter', kind: 'text' },
      { key: 'reading_value', label: 'Reading', kind: 'number' },
      { key: 'reading_unit', label: 'Unit', kind: 'text' },
      { key: 'limit_value', label: 'Limit', kind: 'number' },
      { key: 'result', label: 'Result', kind: 'enum' },
      { key: 'monitoring_on', label: 'Monitored at', kind: 'timestamp' },
      { key: 'monitoring_datetime', label: 'Monitored at (raw)', kind: 'text' },
      { key: 'person_name', label: 'Monitored by', kind: 'text' },
      { key: 'site_org_unit_id', label: 'Location', kind: 'text' },
      { key: 'site_name', label: 'Site', kind: 'text' },
      { key: 'notes', label: 'Notes', kind: 'text' },
      { key: 'created_at', label: 'Logged at', kind: 'timestamp' },
      { key: 'updated_at', label: 'Updated at', kind: 'timestamp' },
    ],
    defaultSort: { column: 'monitoring_on', direction: 'desc' },
  },
  {
    key: 'statutory_compliance',
    label: 'Statutory compliance',
    category: 'forms',
    description:
      'Statutory compliance register entries with the requirement, instrument, issuing authority and review dates resolved.',
    table: 'report_statutory_compliance',
    columns: [
      { key: 'app_key', label: 'App key', kind: 'text' },
      { key: 'response_status', label: 'Response status', kind: 'enum' },
      { key: 'register_status', label: 'Register status', kind: 'enum' },
      { key: 'requirement', label: 'Requirement', kind: 'text' },
      { key: 'instrument', label: 'Instrument', kind: 'text' },
      { key: 'issuing_authority', label: 'Issuing authority', kind: 'text' },
      { key: 'applicable_date', label: 'Applicable from', kind: 'timestamp' },
      { key: 'applicable_on', label: 'Applicable from (raw)', kind: 'text' },
      { key: 'review_or_expiry_date', label: 'Review or expiry', kind: 'timestamp' },
      { key: 'review_or_expiry_on', label: 'Review or expiry (raw)', kind: 'text' },
      { key: 'person_name', label: 'Responsible person', kind: 'text' },
      { key: 'site_org_unit_id', label: 'Location', kind: 'text' },
      { key: 'site_name', label: 'Site', kind: 'text' },
      { key: 'notes', label: 'Notes', kind: 'text' },
      { key: 'created_at', label: 'Logged at', kind: 'timestamp' },
      { key: 'updated_at', label: 'Updated at', kind: 'timestamp' },
    ],
    defaultSort: { column: 'applicable_date', direction: 'desc' },
  },
  {
    key: 'hazid_signatures',
    label: 'Hazard assessment signatures',
    category: 'hazid',
    description: 'Recorded internal and external signatures on hazard assessments.',
    // The `report_` prefix is load-bearing, not cosmetic. `discover.ts` only
    // injects a curated entity into the runtime catalogue when its table starts
    // with `report_` AND its key is not already a discovered table. This entry
    // used to name the base table `hazid_assessment_signatures`, so it was never
    // injected and the seeded `hazid_signatures` report threw "Unknown report
    // entity" at runtime - invisible for as long as the parity test compiled
    // seeds against this curated list, which does contain it.
    //
    // `discoverEntities()` already exposes `hazid_assessment_signatures` as its
    // own full-schema entity, and the guard in `discover.ts` exists precisely so a
    // report-only projection never shadows a discovered business entity. Naming
    // the projection `report_hazid_signatures` satisfies both: the key stays
    // distinct, and the base table keeps its own complete entity.
    //
    // The read tier is NOT inherited from the `report_` prefix default (that is
    // the studio-wide `reports.read`); `TABLE_SCOPE` in
    // `packages/analytics/src/server/scope.ts` rebinds this projection to the
    // Hazard ID module's own `hazid.read.*` ladder, exactly as
    // `report_compliance_status` and `report_monitored_sessions` already do.
    //
    // `report_hazid_signatures` — like `report_compliance_status` and
    // `report_monitored_sessions` — is a REAL PostgreSQL view (migration
    // 0045_report_projection_views), not an authored `from` subquery. That matters
    // because the report engine honours `from` while the public REST API does not:
    // `apps/web/src/lib/api/query.ts` emits `FROM "${entity.table}"` literally, so
    // an authored projection published an endpoint that resolved a relation which
    // never existed. A real view gives both engines one identical relation, and the
    // view carries no RLS of its own — it inherits the `FORCE ROW LEVEL SECURITY`
    // policy of every base table it reads, exactly like the nine report views that
    // have always worked.
    table: 'report_hazid_signatures',
    columns: [
      { key: 'assessment_id', label: 'Assessment', kind: 'text' },
      { key: 'signature_type', label: 'Signature type', kind: 'enum' },
      { key: 'person_id', label: 'Employee', kind: 'text' },
      { key: 'external_name', label: 'External signer', kind: 'text' },
      { key: 'signed_at', label: 'Signed at', kind: 'timestamp' },
    ],
    defaultSort: { column: 'signed_at', direction: 'desc' },
  },
]

export const BEACON_REPORT_CATALOG: ReportEntityCatalog = { entities: REPORT_ENTITIES }

export const REPORT_ENTITY_MAP: Record<string, ReportEntity> = Object.fromEntries(
  REPORT_ENTITIES.map((e) => [e.key, e]),
)

/**
 * Keep the host-authorized Insights inventory while retaining report-specific
 * projections for entities that need flattened joins or calculated fields.
 *
 * The result is rebuilt from the authored projection, so every field is copied
 * across deliberately. `baseFilter` carries the caller's row-scope predicate
 * and MUST be carried across: dropping it here would silently return a source
 * to a tenant-wide read for exactly the entities that have an authored
 * projection, which is the majority of them. The caller's filter wins, because
 * it is the one that reflects who is asking.
 */
export function mergeAuthorizedReportSources(
  authorizedSources: readonly ReportEntity[],
): ReportEntity[] {
  return authorizedSources.map((source) => {
    const authored = REPORT_ENTITY_MAP[source.key]
    if (!authored) return source
    return {
      ...authored,
      label: source.label,
      category: source.category,
      description: source.description ?? authored.description,
      relations: source.relations,
      baseFilter: source.baseFilter ?? authored.baseFilter,
    }
  })
}

/** True when a column still exposes a storage identifier after relationship refinement. */
export function isTechnicalIdentifierColumn(column: ReportEntityColumn): boolean {
  return (
    Boolean(column.hidden) ||
    column.kind === 'uuid' ||
    (column.key === 'id' && !column.expression) ||
    (column.key.endsWith('_id') && /\bid\b/iu.test(column.label) && !column.expression)
  )
}

export function entityColumn(entity: ReportEntity, key: string): ReportEntityColumn | null {
  return reportColumn(entity, key)
}

/** Physical (quoted-safe) column identifier for a whitelisted column key. */
export function entityColumnSql(entity: ReportEntity, key: string): string | null {
  const col = entityColumn(entity, key)
  return col ? (col.sql ?? col.key) : null
}

/**
 * The full SQL reference for a whitelisted column — either its server-generated
 * `expr` (used verbatim) or the default `"table"."col"`. This is the single
 * place every executor (reports, BHQL, the public API) must build a column
 * reference, so synthetic expression columns (custom fields) work everywhere
 * without weakening the injection guarantee: `expr` is only ever set by trusted
 * server code, and physical identifiers still come from the whitelist.
 */
export function columnRef(entity: ReportEntity, key: string): string | null {
  return reportColumnExpression(entity, key)
}
