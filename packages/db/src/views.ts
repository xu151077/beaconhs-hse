// Reporting views — flat, join-baked projections that the custom report
// builder's single-table executor can query directly (CUSTOM_ENTITY_TABLE maps
// an entity to one of these). Applied idempotently after migrations, like the
// RLS policies. RLS still applies: the views read the FORCE-RLS base tables,
// so rows are tenant-scoped by the app.tenant_id GUC exactly as usual.

export const REPORT_VIEWS_SQL: string[] = [
  // report_equipment_fleet shed its financial columns and report_equipment_charges
  // was removed entirely (equipment financials moved to a separate financial system).
  // CREATE OR REPLACE can neither shrink a view's column set nor drop a removed
  // view, so drop both up front every migrate (idempotent); the operational fleet view
  // is recreated further down.
  //
  // report_monitored_sessions joins that list for a different reason: fixing defect D7
  // changed an existing column's TYPE, from `text` (a display name) to `uuid` (the real
  // org-unit id). Postgres refuses that under CREATE OR REPLACE outright -- "cannot
  // change data type of view column" -- so the view must be dropped and rebuilt rather
  // than replaced. Same idempotent drop, same single transaction, no migration: this is
  // the view-application step, not the journal.
  `DROP VIEW IF EXISTS report_equipment_charges;
   DROP VIEW IF EXISTS report_vehicle_log_monthly;
   DROP VIEW IF EXISTS report_vehicle_log_entries;
   DROP VIEW IF EXISTS report_equipment_fleet;
   DROP VIEW IF EXISTS report_monitored_sessions`,

  // Externally-issued skills & certifications per person (the shape the old
  // hardcoded CWB welder report produced — now any tenant user can build /
  // clone reports over it).
  `CREATE OR REPLACE VIEW report_skill_assignments AS
   SELECT
     a.id,
     a.tenant_id,
     p.employee_no,
     p.last_name,
     p.first_name,
     tr.name AS trade,
     au.name AS authority,
     t.code  AS certification_code,
     t.name  AS certification_name,
     a.granted_on,
     a.expires_on,
     CASE
       WHEN a.expires_on IS NULL THEN 'no_expiry'
       WHEN a.expires_on < CURRENT_DATE THEN 'expired'
       WHEN a.expires_on <= CURRENT_DATE + 90 THEN 'expiring'
       ELSE 'valid'
     END AS status,
     -- New columns must stay appended: PostgreSQL only permits CREATE OR REPLACE
     -- VIEW to add columns after the installed view's existing column sequence.
     (SELECT ef.field_value
        FROM training_extra_fields ef
       WHERE ef.tenant_id = a.tenant_id
         AND ef.skill_type_id = t.id
         AND lower(ef.field_key) = 'standard'
       ORDER BY ef.sort_order, ef.id
       LIMIT 1) AS cwb_standard,
     (SELECT ef.field_value FROM training_extra_fields ef
       WHERE ef.tenant_id = a.tenant_id AND ef.skill_assignment_id = a.id
         AND lower(ef.field_key) = 'type' ORDER BY ef.sort_order, ef.id LIMIT 1) AS cwb_type,
     (SELECT ef.field_value FROM training_extra_fields ef
       WHERE ef.tenant_id = a.tenant_id AND ef.skill_assignment_id = a.id
         AND lower(ef.field_key) = 'process' ORDER BY ef.sort_order, ef.id LIMIT 1) AS cwb_process,
     (SELECT ef.field_value FROM training_extra_fields ef
       WHERE ef.tenant_id = a.tenant_id AND ef.skill_assignment_id = a.id
         AND lower(ef.field_key) = 'position' ORDER BY ef.sort_order, ef.id LIMIT 1) AS cwb_position,
     (SELECT ef.field_value FROM training_extra_fields ef
       WHERE ef.tenant_id = a.tenant_id AND ef.skill_assignment_id = a.id
         AND lower(ef.field_key) = 'level (w47.2 only)' ORDER BY ef.sort_order, ef.id LIMIT 1) AS cwb_level
     ,p.id AS person_id
     ,p.department_id AS department_id
     ,coalesce(
       ARRAY(
         SELECT gm.group_id
         FROM person_group_memberships gm
         WHERE gm.tenant_id = p.tenant_id AND gm.person_id = p.id
         ORDER BY gm.group_id
       ),
       ARRAY[]::uuid[]
     ) AS group_ids
     ,t.id AS skill_type_id
     ,au.id AS authority_id
     ,array_to_string(
       ARRAY(
         SELECT gm.group_id::text
         FROM person_group_memberships gm
         WHERE gm.tenant_id = p.tenant_id AND gm.person_id = p.id
         ORDER BY gm.group_id
       ),
       ','
     ) AS group_id_list
     ,(SELECT d.name FROM departments d WHERE d.id = p.department_id) AS department_name
   FROM training_skill_assignments a
   JOIN training_skill_types t ON t.id = a.skill_type_id
   JOIN training_skill_authorities au ON au.id = t.authority_id
   JOIN people p ON p.id = a.person_id
   LEFT JOIN trades tr ON tr.id = p.trade_id
   WHERE a.deleted_at IS NULL
     AND p.deleted_at IS NULL`,

  // Person × course training coverage. The cross product of people and
  // courses (so "never trained" cells exist) LEFT JOINed to each person's
  // latest record per course, with a derived coverage status. Employment
  // status is a report filter (`person_status`), not a view predicate.
  // All three base tables are FORCE-RLS, so every branch is tenant-scoped
  // by app.tenant_id; the explicit tenant equality keeps the cross join
  // within a tenant too.
  `CREATE OR REPLACE VIEW report_training_matrix AS
   WITH latest AS (
     SELECT DISTINCT ON (r.tenant_id, r.person_id, r.course_id)
            r.tenant_id, r.person_id, r.course_id, r.completed_on, r.expires_on
     FROM training_records r
     WHERE r.deleted_at IS NULL
     ORDER BY r.tenant_id, r.person_id, r.course_id,
              r.completed_on DESC, r.created_at DESC, r.id DESC
   )
   SELECT
     (p.id::text || ':' || c.id::text) AS id,
     p.tenant_id                       AS tenant_id,
     p.id                              AS person_id,
     p.employee_no                     AS employee_no,
     p.last_name                       AS last_name,
     p.first_name                      AS first_name,
     (p.last_name || ', ' || p.first_name) AS person_name,
     c.id                              AS course_id,
     c.code                            AS course_code,
     c.name                            AS course_name,
     l.completed_on                    AS completed_on,
     l.expires_on                      AS expires_on,
     CASE
       WHEN l.person_id IS NULL              THEN 'missing'
       WHEN l.expires_on IS NULL             THEN 'valid'
       WHEN l.expires_on < CURRENT_DATE      THEN 'expired'
       WHEN l.expires_on <= CURRENT_DATE + 90 THEN 'expiring'
       ELSE 'valid'
     END                               AS coverage_status,
     -- Appended runtime-filter fields used by the canonical training reports.
     p.department_id                   AS department_id,
     (SELECT d.name FROM departments d WHERE d.id = p.department_id) AS department_name,
     c.delivery_type                   AS delivery_type,
     coalesce(
       ARRAY(
         SELECT gm.group_id
         FROM person_group_memberships gm
         WHERE gm.tenant_id = p.tenant_id AND gm.person_id = p.id
         ORDER BY gm.group_id
       ),
       ARRAY[]::uuid[]
     )                                 AS group_ids,
     EXISTS (
       SELECT 1
       FROM compliance_status cs
       JOIN compliance_obligations co ON co.id = cs.obligation_id
       WHERE cs.tenant_id = p.tenant_id
         AND cs.person_id = p.id
         AND co.tenant_id = p.tenant_id
         AND co.source_module IN ('training', 'cert_requirement')
         AND co.status = 'active'
         AND co.deleted_at IS NULL
         AND co.target_ref->>'courseId' = c.id::text
     )                                 AS is_required,
     -- Keep new fields at the end so CREATE OR REPLACE remains compatible
     -- with the column order of the installed production view.
     c.course_type                     AS course_type,
     array_to_string(
       ARRAY(
         SELECT gm.group_id::text
         FROM person_group_memberships gm
         WHERE gm.tenant_id = p.tenant_id AND gm.person_id = p.id
         ORDER BY gm.group_id
       ),
       ','
     )                                 AS group_id_list,
     p.status                          AS person_status,
     -- The next class this person is booked onto for this course. Someone who
     -- is expired-but-booked still reports as expired — they are not covered
     -- until they sit it — but the missing-training report has to show a seat
     -- is already reserved, or coordinators chase people who are handled.
     (SELECT MIN(cl.starts_at)
        FROM training_class_attendees ta
        JOIN training_classes cl
          ON cl.id = ta.class_id AND cl.tenant_id = ta.tenant_id
       WHERE ta.tenant_id = p.tenant_id
         AND ta.person_id = p.id
         AND cl.course_id = c.id
         AND cl.cancelled_at IS NULL
         AND cl.completed_at IS NULL
         AND cl.starts_at >= now()
     )                                 AS booked_starts_at
   FROM people p
   CROSS JOIN training_courses c
   LEFT JOIN latest l
     ON l.person_id = p.id AND l.course_id = c.id AND l.tenant_id = p.tenant_id
   WHERE p.tenant_id = c.tenant_id
     AND p.deleted_at IS NULL
     AND c.deleted_at IS NULL`,

  // Per-month safety-rate components: recordable + DART incident counts (OSHA
  // definitions) and hours worked, so TRIR/DART are buildable as a calculated
  // rate (sum(recordable)/sum(hours)×200000). Both base tables are FORCE-RLS.
  `CREATE OR REPLACE VIEW report_incident_rates AS
   WITH months AS (
     SELECT tenant_id, date_trunc('month', occurred_at)::date AS month
     FROM incidents WHERE deleted_at IS NULL
     UNION
     SELECT tenant_id, date_trunc('month', period_start)::date AS month
     FROM incident_hours_periods WHERE deleted_at IS NULL
   ),
   inc AS (
     SELECT tenant_id, date_trunc('month', occurred_at)::date AS month,
       COUNT(*) FILTER (WHERE severity IN ('medical_aid', 'lost_time', 'fatality')) AS recordable_count,
       COUNT(*) FILTER (WHERE lost_time IS TRUE) AS dart_count
     FROM incidents WHERE deleted_at IS NULL
     GROUP BY 1, 2
   ),
   hrs AS (
     SELECT tenant_id, date_trunc('month', period_start)::date AS month,
       SUM(total_hours) AS hours_worked
     FROM incident_hours_periods WHERE deleted_at IS NULL
     GROUP BY 1, 2
   )
   SELECT
     (m.tenant_id::text || ':' || m.month::text) AS id,
     m.tenant_id                          AS tenant_id,
     m.month                              AS month,
     COALESCE(inc.recordable_count, 0)::int     AS recordable_count,
     COALESCE(inc.dart_count, 0)::int           AS dart_count,
     COALESCE(hrs.hours_worked, 0)::numeric     AS hours_worked
   FROM months m
   LEFT JOIN inc ON inc.tenant_id = m.tenant_id AND inc.month = m.month
   LEFT JOIN hrs ON hrs.tenant_id = m.tenant_id AND hrs.month = m.month`,

  // Daily vehicle-log detail with driver, vehicle, site and source metadata
  // baked in for the native report engine. Totals use persisted km when
  // present, otherwise derive from business/personal or odometer fields.
  `CREATE OR REPLACE VIEW report_vehicle_log_entries AS
   SELECT
     tl.id                                  AS id,
     tl.tenant_id                           AS tenant_id,
     tl.entry_date                          AS entry_date,
     date_trunc('month', tl.entry_date)::date AS month,
     tl.equipment_item_id                   AS equipment_item_id,
     e.asset_tag                            AS asset_tag,
     e.name                                 AS vehicle_name,
     tl.driver_person_id                    AS driver_person_id,
     p.employee_no                          AS employee_no,
     CASE WHEN p.id IS NULL THEN NULL
          ELSE p.first_name || ' ' || p.last_name END AS driver_name,
     tl.entry_mode                          AS entry_mode,
     tl.start_odometer                      AS start_odometer,
     tl.end_odometer                        AS end_odometer,
     tl.business_km                         AS business_km,
     tl.personal_km                         AS personal_km,
     tl.km_driven                           AS km_driven,
     CASE
       WHEN tl.km_driven IS NOT NULL THEN tl.km_driven
       WHEN tl.business_km IS NOT NULL OR tl.personal_km IS NOT NULL
         THEN COALESCE(tl.business_km, 0) + COALESCE(tl.personal_km, 0)
       WHEN tl.start_odometer IS NOT NULL AND tl.end_odometer IS NOT NULL
         THEN GREATEST(tl.end_odometer - tl.start_odometer, 0)
       ELSE NULL
     END                                    AS total_km,
     tl.hours_on_site                       AS hours_on_site,
     tl.manpower_count                      AS manpower_count,
     tl.site_org_unit_id                    AS site_org_unit_id,
     site.code                              AS site_code,
     site.name                              AS site_name,
     COALESCE(site.name, tl.other_destination) AS destination,
     tl.other_destination                   AS other_destination,
     tl.import_status                       AS import_status,
     sc.connector_key                       AS source_system,
     sc.name                                AS source_name,
     tl.import_meta->>'sourceLabel'         AS source_label,
     tl.source_external_id                  AS source_external_id,
     tl.imported_at                         AS imported_at,
     tl.created_at                          AS created_at,
     tl.updated_at                          AS updated_at
   FROM truck_log_entries tl
   JOIN equipment_items e ON e.id = tl.equipment_item_id AND e.tenant_id = tl.tenant_id
   LEFT JOIN people p ON p.id = tl.driver_person_id AND p.tenant_id = tl.tenant_id
   LEFT JOIN org_units site ON site.id = tl.site_org_unit_id AND site.tenant_id = tl.tenant_id
   LEFT JOIN sync_connections sc ON sc.id = tl.source_connection_id AND sc.tenant_id = tl.tenant_id
   WHERE e.deleted_at IS NULL`,

  // Monthly driver × vehicle rollup for summaries, exports and dashboard
  // diagnostics. This keeps the old annual/monthly truck-log summary shape
  // available through the native report engine instead of bespoke SQL.
  `CREATE OR REPLACE VIEW report_vehicle_log_monthly AS
   SELECT
     (tenant_id::text || ':' || equipment_item_id::text || ':' ||
      COALESCE(driver_person_id::text, 'none') || ':' || month::text) AS id,
     tenant_id,
     month,
     equipment_item_id,
     asset_tag,
     vehicle_name,
     driver_person_id,
     employee_no,
     driver_name,
     COUNT(DISTINCT entry_date)::int          AS logged_days,
     COUNT(*) FILTER (WHERE total_km IS NOT NULL)::int AS km_days,
     COALESCE(SUM(business_km), 0)::int       AS business_km,
     COALESCE(SUM(personal_km), 0)::int       AS personal_km,
     COALESCE(SUM(total_km), 0)::int          AS total_km,
     COALESCE(SUM(hours_on_site), 0)::numeric AS hours_on_site,
     COALESCE(SUM(manpower_count), 0)::int    AS manpower_count,
     COUNT(*) FILTER (WHERE import_status = 'imported')::int AS imported_days,
     COUNT(*) FILTER (WHERE import_status = 'manual')::int   AS manual_days,
     MIN(start_odometer)                      AS first_odometer,
     MAX(end_odometer)                        AS last_odometer,
     COUNT(DISTINCT site_org_unit_id) FILTER (WHERE site_org_unit_id IS NOT NULL)::int AS site_count
   FROM report_vehicle_log_entries
   GROUP BY
     tenant_id,
     month,
     equipment_item_id,
     asset_tag,
     vehicle_name,
     driver_person_id,
     employee_no,
     driver_name`,

  // Fleet register — one row per (non-deleted) asset with type/site/holder names
  // baked in plus YTD + all-time usage (hours/km). OPERATIONAL ONLY: equipment
  // financials (rates, expenses, purchase price, ROI, project charges) are owned by
  // a separate financial system, not this app. Drives the Fleet, Upcoming-inspection
  // and Upcoming-oil-change reports. All base tables are FORCE-RLS, so every row is
  // tenant-scoped by app.tenant_id; the explicit tenant equality on each join keeps
  // the projection within a tenant.
  `CREATE OR REPLACE VIEW report_equipment_fleet AS
   SELECT
     e.id                                 AS id,
     e.tenant_id                          AS tenant_id,
     e.asset_tag                          AS asset_tag,
     e.name                               AS name,
     e.serial_number                      AS serial_number,
     e.status                             AS status,
     t.name                               AS equipment_type,
     type_category.name                   AS type_category,
     e.current_site_org_unit_id           AS current_site_org_unit_id,
     site.name                            AS site_name,
     CASE WHEN holder.id IS NULL THEN NULL
          ELSE holder.first_name || ' ' || holder.last_name END AS holder_name,
     e.is_missing                         AS is_missing,
     e.manufacturer                       AS manufacturer,
     e.model                              AS model,
     e.purchase_price                     AS purchase_price,
     e.ownership                          AS ownership,
     sched.last_inspection_on             AS last_inspection_on,
     sched.next_inspection_due            AS next_inspection_due,
     e.requires_oil_change                AS requires_oil_change,
     e.last_oil_change_on                 AS last_oil_change_on,
     e.next_oil_change_due                AS next_oil_change_due,
     e.oil_change_interval_months         AS oil_change_interval_months,
     e.purchase_date                      AS purchase_date,
     usage.hours_ytd                      AS hours_ytd,
     usage.km_ytd                         AS km_ytd,
     usage.hours_total                    AS hours_total
   FROM equipment_items e
   LEFT JOIN equipment_types t ON t.id = e.type_id AND t.tenant_id = e.tenant_id
   LEFT JOIN equipment_categories type_category
     ON type_category.id = t.category_id AND type_category.tenant_id = t.tenant_id
   LEFT JOIN org_units site ON site.id = e.current_site_org_unit_id AND site.tenant_id = e.tenant_id
   LEFT JOIN people holder ON holder.id = e.current_holder_person_id AND holder.tenant_id = e.tenant_id
   LEFT JOIN LATERAL (
     SELECT
       MIN(s.next_due_on)      AS next_inspection_due,
       MAX(s.last_completed_on) AS last_inspection_on
     FROM equipment_inspection_schedules s
     WHERE s.equipment_item_id = e.id AND s.tenant_id = e.tenant_id AND s.is_active
   ) sched ON true
   LEFT JOIN LATERAL (
     SELECT
       COALESCE(SUM(tl.hours_on_site) FILTER (WHERE tl.entry_date >= date_trunc('year', CURRENT_DATE)::date), 0) AS hours_ytd,
       COALESCE(SUM(tl.km_driven)     FILTER (WHERE tl.entry_date >= date_trunc('year', CURRENT_DATE)::date), 0) AS km_ytd,
       COALESCE(SUM(tl.hours_on_site), 0) AS hours_total
     FROM truck_log_entries tl
     WHERE tl.equipment_item_id = e.id AND tl.tenant_id = e.tenant_id
   ) usage ON true
   WHERE e.deleted_at IS NULL`,

  // PPE report projection with the legacy filter/group dimensions resolved to
  // readable names. The raw ids remain available for exact runtime filters.
  `CREATE OR REPLACE VIEW report_ppe_items AS
   SELECT
     item.id,
     item.tenant_id,
     item.type_id,
     type.name AS ppe_type,
     item.serial_number,
     item.size,
     item.status,
     item.current_holder_person_id,
     CASE WHEN holder.id IS NULL THEN NULL
          ELSE holder.last_name || ', ' || holder.first_name END AS holder_name,
     holder.department_id,
     department.name AS department_name,
     array_to_string(
       ARRAY(
         SELECT membership.group_id::text
         FROM person_group_memberships membership
         WHERE membership.tenant_id = item.tenant_id
           AND membership.person_id = holder.id
         ORDER BY membership.group_id
       ),
       ','
     ) AS group_id_list,
     item.last_inspection_on,
     item.next_inspection_due,
     item.next_annual_inspection_due,
     item.purchase_date,
     item.expires_on,
     item.metadata,
     item.deleted_at,
     -- New columns stay appended. CREATE OR REPLACE VIEW cannot rename or
     -- insert columns into the installed sequence.
     item.is_draft,
     holder.status AS holder_status,
     holder.employee_no AS holder_employee_no,
     item.last_annual_inspection_on
   FROM ppe_items item
   JOIN ppe_types type
     ON type.id = item.type_id AND type.tenant_id = item.tenant_id
   LEFT JOIN people holder
     ON holder.id = item.current_holder_person_id AND holder.tenant_id = item.tenant_id
   LEFT JOIN departments department
     ON department.id = holder.department_id AND department.tenant_id = item.tenant_id`,

  // Corrective-action projection with owner, department, group, and location
  // dimensions used by the legacy report filters.
  `CREATE OR REPLACE VIEW report_corrective_actions AS
   SELECT
     action.id,
     action.tenant_id,
     action.reference,
     action.title,
     action.description,
     action.severity,
     action.status,
     action.due_on,
     action.assigned_on,
     action.source,
     action.owner_tenant_user_id,
     owner.display_name AS owner_name,
     owner_person.department_id,
     department.name AS department_name,
     array_to_string(
       ARRAY(
         SELECT membership.group_id::text
         FROM person_group_memberships membership
         WHERE membership.tenant_id = action.tenant_id
           AND membership.person_id = owner_person.id
         ORDER BY membership.group_id
       ),
       ','
     ) AS group_id_list,
     action.site_org_unit_id,
     location.name AS location_name,
     action.metadata,
     action.deleted_at
   FROM corrective_actions action
   LEFT JOIN tenant_users owner
     ON owner.id = action.owner_tenant_user_id AND owner.tenant_id = action.tenant_id
   LEFT JOIN people owner_person
     ON owner_person.user_id = owner.user_id
    AND owner_person.tenant_id = action.tenant_id
    AND owner_person.deleted_at IS NULL
   LEFT JOIN departments department
     ON department.id = owner_person.department_id AND department.tenant_id = action.tenant_id
   LEFT JOIN org_units location
     ON location.id = action.site_org_unit_id AND location.tenant_id = action.tenant_id`,

  // Training records with the employee dimensions the report studio needs
  // (department, status, groups). New view — full column order is free.
  `CREATE OR REPLACE VIEW report_training_records AS
   SELECT
     r.id,
     r.tenant_id,
     r.person_id,
     r.course_id,
     r.completed_on,
     r.expires_on,
     r.source,
     r.score,
     r.grade,
     r.deleted_at,
     p.employee_no,
     (p.last_name || ', ' || p.first_name) AS person_name,
     p.status AS person_status,
     p.department_id,
     (SELECT d.name FROM departments d WHERE d.id = p.department_id) AS department_name,
     c.code AS course_code,
     c.name AS course_name,
     array_to_string(
       ARRAY(
         SELECT gm.group_id::text
         FROM person_group_memberships gm
         WHERE gm.tenant_id = p.tenant_id AND gm.person_id = p.id
         ORDER BY gm.group_id
       ),
       ','
     ) AS group_id_list
   FROM training_records r
   JOIN people p ON p.id = r.person_id AND p.tenant_id = r.tenant_id
   JOIN training_courses c ON c.id = r.course_id AND c.tenant_id = r.tenant_id
   WHERE p.deleted_at IS NULL
     AND c.deleted_at IS NULL`,

  // The three projections below used to live only as an authored `from` subquery on
  // their REPORT_ENTITIES entry. That satisfied the report engine, which honours
  // `from`, but not the public REST API: `apps/web/src/lib/api/query.ts` emits
  // `FROM "${entity.table}"` literally and ignores `from`, so each of these entities
  // resolved a relation name that was never created in the database.
  // `/api/v1/hazid_signatures` failed outright with
  // `relation "report_hazid_signatures" does not exist`.
  //
  // Declaring them here - alongside the other report views, applied idempotently by
  // `applyReportingViews()` after the migration chain - gives the report engine and
  // the API one identical physical relation, which is how every other `report_*`
  // entity has always worked. It is a relation change only: each SELECT below is the
  // former authored `from` verbatim, keeping the same joins, the same
  // tenant-qualified ON conditions, the same soft-delete filters, the same
  // resolved-name CASE expressions and the same trailing predicates.
  //
  // RLS needs no work here. Like every other view in this list these carry no policy
  // of their own; they read FORCE-RLS base tables, so `app.tenant_id` scopes the
  // result exactly as it scopes the underlying rows. `tenant_id` is projected
  // through for that reason.
  // `report_monitored_sessions` used to project `location.name AS site_org_unit_id`,
  // putting a display name in the one column `TABLE_SCOPE` filters as an org-unit
  // UUID (`SITE_COLUMNS`). A site-scoped caller could therefore never narrow: the
  // name never equals a site id. `site_org_unit_id` now carries the real
  // `form_responses.site_org_unit_id`, and the readable name moved to its own
  // `site_name` column so nothing is lost from the report.
  //
  // Defect D10, the same class one column over: `subject_person_id` used to hold the
  // resolved NAME, but `PERSON_COLUMNS` falls back to `subject_person_id` when an entity
  // has no `person_id`, comparing it against a person uuid. A name never equals a uuid, so
  // a self-tier caller could never match their own sessions. It now carries the real
  // `person.id` — NULL when the response has no person, or the person is soft-deleted — and
  // the readable name moved to its own `subject_person_name` so reports keep it.
  //
  // That also changes this column's TYPE, so it needs the same drop-and-rebuild as D7.
  // Only the relation changed. The row set, the joins, the soft-delete filters and the
  // monitored-session semantics are untouched, and no permission or RoleScope moved.
  `CREATE OR REPLACE VIEW report_compliance_status AS
     SELECT
       status.id,
       status.tenant_id,
       obligation.source_module,
       obligation.title         AS obligation_title,
       status.subject_key,
       CASE
         WHEN person.id IS NULL THEN NULL
         ELSE person.last_name || ', ' || person.first_name
       END                      AS person_name,
       status.status,
       status.period_start,
       status.period_end,
       status.due_on,
       status.completed_on,
       status.count,
       status.expected,
       status.percent,
       status.computed_at
     FROM compliance_status status
     JOIN compliance_obligations obligation
       ON obligation.tenant_id = status.tenant_id
      AND obligation.id = status.obligation_id
      AND obligation.deleted_at IS NULL
     LEFT JOIN people person
       ON person.tenant_id = status.tenant_id
      AND person.id = status.person_id
      AND person.deleted_at IS NULL`,

  `CREATE OR REPLACE VIEW report_monitored_sessions AS
     SELECT
       response.id,
       response.tenant_id,
       person.id                             AS subject_person_id,
       CASE
         WHEN person.id IS NULL THEN NULL
         ELSE person.last_name || ', ' || person.first_name
       END                                   AS subject_person_name,
       response.site_org_unit_id,
       location.name                         AS site_name,
       template.name                         AS app_name,
       response.monitor_status,
       response.checkin_interval_minutes,
       response.grace_period_minutes,
       response.expected_end_at,
       response.next_checkin_due_at,
       response.last_checkin_at,
       response.escalated_at,
       response.created_at,
       response.closed_at
     FROM form_responses response
     JOIN form_templates template
       ON template.tenant_id = response.tenant_id
      AND template.id = response.template_id
      AND template.deleted_at IS NULL
     LEFT JOIN people person
       ON person.tenant_id = response.tenant_id
      AND person.id = response.subject_person_id
      AND person.deleted_at IS NULL
     LEFT JOIN org_units location
       ON location.tenant_id = response.tenant_id
      AND location.id = response.site_org_unit_id
      AND location.deleted_at IS NULL
     WHERE response.monitor_status IS NOT NULL
       AND response.deleted_at IS NULL`,

  // Stays on the Hazard ID module's own `hazid.read.*` ladder through the mandatory
  // `report_hazid_signatures` entry in `packages/analytics/src/server/scope.ts`.
  // Without that entry the `report_` prefix default would hand this entity the
  // studio-wide `reports.read` tier, so any viewer of reports could read every
  // hazard-assessment signature in the tenant.
  // `person_id` is the DISPLAY NAME (`Last, First`) — it has been since this
  // view shipped, and seeded report definitions/custom-field options select it
  // as a text column, so changing its value or type would break every existing
  // tenant's report. But the scope engine binds every PERSON_COLUMNS candidate
  // to the caller's person UUID, which made `hazid.read.self`/`site` holders see
  // ZERO rows. `person_uuid` is the real UUID appended at the END of the
  // projection (CREATE OR REPLACE may append columns) and is the column the
  // scope spec for this entity binds to. Name stays for display, uuid for auth.
  `CREATE OR REPLACE VIEW report_hazid_signatures AS
     SELECT
       signature.id,
       signature.tenant_id,
       assessment.reference   AS assessment_id,
       signature.signature_type,
       CASE
         WHEN person.id IS NULL THEN NULL
         ELSE person.last_name || ', ' || person.first_name
       END                    AS person_id,
       signature.external_name,
       signature.signed_at,
       person.id              AS person_uuid
     FROM hazid_assessment_signatures signature
     JOIN hazid_assessments assessment
       ON assessment.tenant_id = signature.tenant_id
      AND assessment.id = signature.assessment_id
      AND assessment.deleted_at IS NULL
     LEFT JOIN people person
       ON person.tenant_id = signature.tenant_id
      AND person.id = signature.person_id
      AND person.deleted_at IS NULL`,

  // Environmental monitoring log and statutory compliance register. Both are Builder
  // apps, so the rows already exist as `form_responses`; these views expose the two
  // stable template keys as flat, reportable relations instead of leaving a tenant's
  // environmental and statutory evidence reachable only by per-tenant template UUID.
  //
  // `form_templates.key` is the stable identifier, never `template_id`: the unique
  // constraint is `(tenant_id, key)`, so the same key names the same app in every
  // tenant and a seed or report can bind it without knowing a UUID. Each view filters
  // to exactly one key, and because `form_responses.template_id` is a single column the
  // join to `form_templates` stays one row per response - no fan-out, no aggregation.
  //
  // Columns are derived only from keys that actually occur in the payloads; the raw
  // `payload` is projected through as well so nothing is lost to a future field. Every
  // cast is regex-guarded, so one malformed legacy value yields NULL for that column
  // instead of failing the whole relation. Person references arrive as UUID text in the
  // payload and are resolved by joining `p.id::text`, which avoids casting untrusted
  // text to uuid and keeps the join on the FORCE-RLS `people` table.
  //
  // `site_org_unit_id` is the response's real org-unit UUID, NOT a display name:
  // `TABLE_SCOPE` filters `SITE_COLUMNS` on that name, so it must hold the id. The
  // readable name is projected separately as `site_name`.
  `CREATE OR REPLACE VIEW report_environmental_monitoring AS
     SELECT
       response.id,
       response.tenant_id,
       template.key                                   AS app_key,
       template.name                                  AS app_name,
       response.site_org_unit_id,
       location.name                                  AS site_name,
       response.status                                AS response_status,
       person.id                                      AS person_id,
       person.last_name || ', ' || person.first_name  AS person_name,
       response.data->>'monitoring_category'          AS monitoring_category,
       response.data->>'parameter'                    AS parameter,
       CASE
         WHEN response.data->>'reading_value' ~ '^-?[0-9]+(\\.[0-9]+)?$'
           THEN (response.data->>'reading_value')::numeric
       END                                            AS reading_value,
       response.data->>'reading_unit'                 AS reading_unit,
       CASE
         WHEN response.data->>'limit_value' ~ '^-?[0-9]+(\\.[0-9]+)?$'
           THEN (response.data->>'limit_value')::numeric
       END                                            AS limit_value,
       response.data->>'result'                       AS result,
       response.data->>'monitoring_datetime'          AS monitoring_datetime,
       CASE
         WHEN response.data->>'monitoring_datetime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
           THEN (response.data->>'monitoring_datetime')::timestamptz
       END                                            AS monitoring_on,
       response.data->>'notes'                        AS notes,
       response.data                                  AS payload,
       response.created_at,
       response.updated_at
     FROM form_responses response
     JOIN form_templates template
       ON template.tenant_id = response.tenant_id
      AND template.id = response.template_id
      AND template.deleted_at IS NULL
     LEFT JOIN org_units location
       ON location.tenant_id = response.tenant_id
      AND location.id = response.site_org_unit_id
      AND location.deleted_at IS NULL
     LEFT JOIN people person
       ON person.tenant_id = response.tenant_id
      AND person.id::text = response.data->>'monitored_by'
      AND person.deleted_at IS NULL
     WHERE template.key = 'environmental-monitoring-log'
       AND response.deleted_at IS NULL`,

  `CREATE OR REPLACE VIEW report_statutory_compliance AS
     SELECT
       response.id,
       response.tenant_id,
       template.key                                   AS app_key,
       template.name                                  AS app_name,
       response.site_org_unit_id,
       location.name                                  AS site_name,
       response.status                                AS response_status,
       person.id                                      AS person_id,
       person.last_name || ', ' || person.first_name  AS person_name,
       response.data->>'status'                       AS register_status,
       response.data->>'requirement'                  AS requirement,
       response.data->>'instrument'                   AS instrument,
       response.data->>'issuing_authority'            AS issuing_authority,
       response.data->>'applicable_on'                AS applicable_on,
       CASE
         WHEN response.data->>'applicable_on' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
           THEN (response.data->>'applicable_on')::date
       END                                            AS applicable_date,
       response.data->>'review_or_expiry_on'          AS review_or_expiry_on,
       CASE
         WHEN response.data->>'review_or_expiry_on' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
           THEN (response.data->>'review_or_expiry_on')::date
       END                                            AS review_or_expiry_date,
       response.data->>'notes'                        AS notes,
       response.data                                  AS payload,
       response.created_at,
       response.updated_at
     FROM form_responses response
     JOIN form_templates template
       ON template.tenant_id = response.tenant_id
      AND template.id = response.template_id
      AND template.deleted_at IS NULL
     LEFT JOIN org_units location
       ON location.tenant_id = response.tenant_id
      AND location.id = response.site_org_unit_id
      AND location.deleted_at IS NULL
     LEFT JOIN people person
       ON person.tenant_id = response.tenant_id
      AND person.id::text = response.data->>'responsible_person'
      AND person.deleted_at IS NULL
     WHERE template.key = 'statutory-compliance-register'
       AND response.deleted_at IS NULL`,
]
