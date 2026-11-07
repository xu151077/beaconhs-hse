import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readProductionCutoverSection } from './test/read-production-cutover-section'
import { REPORT_VIEWS_SQL } from './views'

describe('reporting view cutover', () => {
  it('appends skill report columns after the installed view shape', () => {
    const skills = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_skill_assignments'),
    )
    expect(skills).toBeDefined()

    const installedTailAt = skills?.indexOf('END AS status') ?? -1
    const appendedColumnsAt = skills?.indexOf('AS cwb_standard') ?? -1
    expect(installedTailAt).toBeGreaterThan(-1)
    expect(appendedColumnsAt).toBeGreaterThan(installedTailAt)
  })

  it('reads equipment type categories through the canonical catalog relation', () => {
    const fleet = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_equipment_fleet'),
    )
    expect(fleet).toBeDefined()
    expect(fleet).toContain('type_category.name                   AS type_category')
    expect(fleet).toContain('LEFT JOIN equipment_categories type_category')
    expect(fleet).toContain('type_category.id = t.category_id')
    expect(fleet).not.toContain('t.category                           AS type_category')
  })

  it('exposes assigned training and legacy-parity runtime filter fields', () => {
    const training = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_training_matrix'),
    )
    expect(training).toBeDefined()
    expect(training).toContain('p.department_id                   AS department_id')
    expect(training).toContain('c.delivery_type                   AS delivery_type')
    expect(training).toContain('AS group_ids')
    expect(training).toContain('AS group_id_list')
    expect(training).toContain('FROM compliance_status cs')
    expect(training).toContain('AS is_required')
    expect(training).toContain('c.course_type                     AS course_type')
    expect(training).toContain('p.status                          AS person_status')
    expect(training).not.toContain("p.status = 'active'")
    expect(training?.indexOf('AS course_type')).toBeGreaterThan(
      training?.indexOf('AS is_required') ?? -1,
    )
    expect(training?.indexOf('AS person_status')).toBeGreaterThan(
      training?.indexOf('AS group_id_list') ?? -1,
    )
  })

  it('joins employee department and status onto training records and skills', () => {
    const records = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_training_records'),
    )
    const skills = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_skill_assignments'),
    )
    expect(records).toContain('p.status AS person_status')
    expect(records).toContain('AS department_name')
    expect(records).toContain('AS group_id_list')
    expect(records).toContain('c.code AS course_code')
    expect(skills).toContain('AS department_name')
    expect(skills?.indexOf('AS department_name')).toBeGreaterThan(
      skills?.indexOf('AS group_id_list') ?? -1,
    )
  })

  it('provides readable PPE and corrective-action parity dimensions', () => {
    const ppe = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_ppe_items'),
    )
    const correctiveActions = REPORT_VIEWS_SQL.find((statement) =>
      statement.includes('CREATE OR REPLACE VIEW report_corrective_actions'),
    )
    expect(ppe).toContain('type.name AS ppe_type')
    expect(ppe).toContain('AS holder_name')
    expect(ppe).toContain('AS holder_status')
    expect(ppe).toContain('AS holder_employee_no')
    expect(ppe).toContain('item.last_annual_inspection_on')
    expect(ppe).toContain('department.name AS department_name')
    expect(ppe).toContain('AS group_id_list')
    expect(ppe?.indexOf('item.deleted_at')).toBeLessThan(ppe?.indexOf('item.is_draft') ?? -1)
    expect(correctiveActions).toContain('owner.display_name AS owner_name')
    expect(correctiveActions).toContain('department.name AS department_name')
    expect(correctiveActions).toContain('AS group_id_list')
    expect(correctiveActions).toContain('location.name AS location_name')
  })

  it('retires the installed legacy fleet view before dropping its source column', () => {
    const migration = readProductionCutoverSection('0033_physical_schema_convergence.sql')
    const dropViewAt = migration.indexOf('DROP VIEW IF EXISTS "report_equipment_fleet"')
    const dropColumnAt = migration.indexOf('ALTER TABLE "equipment_types" DROP COLUMN "category"')

    expect(dropViewAt).toBeGreaterThan(-1)
    expect(dropColumnAt).toBeGreaterThan(dropViewAt)
  })
})

describe('every curated report projection is a real relation', () => {
  const declaredViews = () =>
    new Set(
      REPORT_VIEWS_SQL.flatMap((statement) =>
        [...statement.matchAll(/CREATE OR REPLACE VIEW (report_[a-z_]+)/g)].map((m) => m[1]!),
      ),
    )

  it('declares the three formerly authored projections', () => {
    // These three used to be authored `from` subqueries on their REPORT_ENTITIES
    // entry. The report engine honours `from`; the public REST API does not - it
    // emits `FROM "${entity.table}"` literally - so each resolved a relation that
    // was never created, and /api/v1/hazid_signatures 500'd with
    // `relation "report_hazid_signatures" does not exist`.
    const declared = declaredViews()
    expect(declared).toContain('report_compliance_status')
    expect(declared).toContain('report_monitored_sessions')
    expect(declared).toContain('report_hazid_signatures')
  })

  it('covers every curated report_ entity exactly once', () => {
    // The invariant that would have caught the original defect. Every entity the
    // curated catalogue names with a `report_` prefix is published on /api/v1 and
    // queried by literal table name, so each one must exist as a real relation.
    const entities = readFileSync(
      new URL(
        ['..', '..', '..', 'packages', 'reports', 'src', 'entities.ts'].join('/'),
        import.meta.url,
      ),
      'utf8',
    )
    const curated = [...entities.matchAll(/^\s{4}table: '(report_[a-z_]+)',$/gm)].map((m) => m[1]!)
    expect(curated.length).toBeGreaterThan(0)

    const declared = declaredViews()
    const missing = curated.filter((table) => !declared.has(table))
    expect(missing).toEqual([])
  })

  it('projects tenant_id so RLS through the base tables stays meaningful', () => {
    // These views carry no policy of their own. Tenant scoping comes from the
    // FORCE-RLS base tables they read, keyed on the app.tenant_id GUC; projecting
    // tenant_id through keeps that observable and lets the reports engine bind it
    // as a parameter the way it does for every other tenant-scoped entity.
    for (const view of [
      'report_compliance_status',
      'report_monitored_sessions',
      'report_hazid_signatures',
    ]) {
      const statement = REPORT_VIEWS_SQL.find((s) => s.includes(`CREATE OR REPLACE VIEW ${view} `))
      expect(statement, `${view} must be declared`).toBeDefined()
      expect(statement).toMatch(/tenant_id/)
    }
  })

  it('adds no table and no materialized view', () => {
    // A projection is a relation to read, never a place to write. Creating a table
    // here would also silently escape the idempotent DROP/recreate cycle these
    // views rely on.
    const all = REPORT_VIEWS_SQL.join('\n')
    expect(all).not.toMatch(/CREATE\s+(?:UNLOGGED\s+)?TABLE/i)
    expect(all).not.toMatch(/CREATE\s+MATERIALIZED\s+VIEW/i)
  })
})

describe('the Builder-backed report projections are keyed by form_templates.key', () => {
  const viewFor = (name: string) =>
    REPORT_VIEWS_SQL.find((s) => s.includes(`CREATE OR REPLACE VIEW ${name} `))
  /** Collapse the column alignment so assertions do not encode prettier's spacing. */
  const flat = (name: string) => (viewFor(name) ?? '').replace(/\s+/g, ' ').trim()

  it('declares both environmental and statutory projections', () => {
    expect(viewFor('report_environmental_monitoring')).toBeDefined()
    expect(viewFor('report_statutory_compliance')).toBeDefined()
  })

  it('selects each projection by stable template key, never by template UUID', () => {
    // `form_templates.key` is unique per `(tenant_id, key)`, so the same key names the
    // same app in every tenant. Binding a seed or report to a UUID would make it
    // tenant-specific and unseedable; binding to the key is what lets these be ordinary
    // curated report entities.
    expect(viewFor('report_environmental_monitoring')).toContain(
      "template.key = 'environmental-monitoring-log'",
    )
    expect(viewFor('report_statutory_compliance')).toContain(
      "template.key = 'statutory-compliance-register'",
    )
    for (const name of ['report_environmental_monitoring', 'report_statutory_compliance']) {
      const sql = viewFor(name)!
      expect(flat(name)).toContain('template.key AS app_key')
      expect(sql).not.toMatch(/template_id\s*=\s*'[0-9a-f-]{36}'/i)
    }
  })

  it('joins form_templates on tenant as well as id, so no cross-tenant fan-out', () => {
    // The join is many-to-one; a missing tenant predicate would still be unique per
    // tenant here, but stating it keeps the view consistent with every other view in
    // this list and keeps the RLS story obvious.
    for (const name of ['report_environmental_monitoring', 'report_statutory_compliance']) {
      expect(viewFor(name)).toContain('template.tenant_id = response.tenant_id')
    }
  })

  it('projects the org-unit UUID in site_org_unit_id, not a display name', () => {
    // `TABLE_SCOPE` filters `SITE_COLUMNS` on this column, comparing it to an org-unit
    // id. Projecting a name here would make site scoping silently match nothing.
    // (`report_monitored_sessions` aliases `location.name AS site_org_unit_id`, which is
    // why its site tier cannot narrow; these two must not copy that.)
    for (const name of ['report_environmental_monitoring', 'report_statutory_compliance']) {
      const sql = viewFor(name)!
      expect(flat(name)).toContain('response.site_org_unit_id, location.name AS site_name')
      expect(flat(name)).not.toMatch(/AS site_org_unit_id/)
    }
  })

  it('resolves the payload person reference into person_id for self scoping', () => {
    // `PERSON_COLUMNS` looks for `person_id`. The payload carries a UUID as text, so the
    // join is on `id::text` rather than casting untrusted text to uuid.
    for (const [name, key] of [
      ['report_environmental_monitoring', 'monitored_by'],
      ['report_statutory_compliance', 'responsible_person'],
    ] as const) {
      const sql = viewFor(name)!
      expect(flat(name)).toContain(`person.id::text = response.data->>'${key}'`)
      expect(flat(name)).toContain('person.id AS person_id')
    }
  })

  it('guards every payload cast so one malformed value cannot fail the relation', () => {
    // The payload is free text written by a form filler. A bare `::numeric` or `::date`
    // cast raises on the first bad legacy value and takes the whole report down.
    for (const name of ['report_environmental_monitoring', 'report_statutory_compliance']) {
      const sql = viewFor(name)!
      const casts = [...sql.matchAll(/END\s+AS\s+(\w+)/g)].map((m) => m[1]!)
      expect(casts.length).toBeGreaterThan(0)
      for (const cast of casts) {
        expect(sql, `${name}.${cast} must be regex-guarded`).toMatch(
          new RegExp(`WHEN[^;]*?~[^;]*?END\\s+AS\\s+${cast}\\b`, 's'),
        )
      }
    }
  })

  it('keeps the raw payload so no captured field is lost', () => {
    for (const name of ['report_environmental_monitoring', 'report_statutory_compliance']) {
      expect(flat(name)).toContain('response.data AS payload')
    }
  })
})

describe('defect D7 — a site column may never hold a display name', () => {
  const viewFor = (name: string) =>
    REPORT_VIEWS_SQL.find((s) => s.includes(`CREATE OR REPLACE VIEW ${name} `))
  const flat = (name: string) => (viewFor(name) ?? '').replace(/\s+/g, ' ').trim()

  const SITE_SCOPED_VIEWS = [
    'report_monitored_sessions',
    'report_environmental_monitoring',
    'report_statutory_compliance',
  ] as const

  for (const name of SITE_SCOPED_VIEWS) {
    it(`${name} projects the real org-unit uuid in site_org_unit_id`, () => {
      // `SITE_COLUMNS` filters `site_org_unit_id` against `org_units.id`. A display name
      // there can never match: Postgres raises `invalid input syntax for type uuid` when
      // the value is cast, and a plain text comparison never equals a uuid. Site-scoped
      // callers were therefore unable to narrow this entity at all.
      expect(flat(name)).toContain('response.site_org_unit_id,')
      expect(flat(name)).not.toMatch(/AS site_org_unit_id/)
      // No expression of any kind may land in that column — only the bare uuid column.
      const aliased = flat(name).match(/(\S+) AS site_org_unit_id/)
      expect(aliased, `${name} must not alias anything into site_org_unit_id`).toBeNull()
    })

    it(`${name} carries the readable location in its own column`, () => {
      // The name is still needed for reports; it just may not share the uuid column.
      expect(flat(name)).toContain('AS site_name')
      expect(viewFor(name)).toContain('AS site_name')
    })

    it(`${name} joins org_units on the uuid, not on the name`, () => {
      expect(flat(name)).toContain('location.id = response.site_org_unit_id')
      expect(viewFor(name)).toContain('location.id = response.site_org_unit_id')
    })
  }

  it('report_monitored_sessions is dropped before recreation, so the type change applies', () => {
    // Postgres refuses `CREATE OR REPLACE VIEW` when it would change a column's TYPE:
    // "cannot change data type of view column site_org_unit_id from text to uuid". The
    // view must therefore appear in the up-front idempotent DROP list, which is the
    // mechanism `report_equipment_fleet` already used when it shed columns. Without
    // this, `db:migrate` fails on every install that has the old view.
    const drops = REPORT_VIEWS_SQL.find((s) => s.includes('DROP VIEW IF EXISTS'))!
    expect(drops).toContain('DROP VIEW IF EXISTS report_monitored_sessions')
    // The drop must precede the CREATE in statement order.
    const dropIndex = REPORT_VIEWS_SQL.findIndex((s) =>
      s.includes('DROP VIEW IF EXISTS report_monitored_sessions'),
    )
    const createIndex = REPORT_VIEWS_SQL.findIndex((s) =>
      s.includes('CREATE OR REPLACE VIEW report_monitored_sessions '),
    )
    expect(dropIndex).toBeGreaterThanOrEqual(0)
    expect(createIndex).toBeGreaterThan(dropIndex)
  })

  it('never lets a name expression land in site_org_unit_id, in any view', () => {
    // Guards the whole class rather than the three views above. The invariant is about
    // the SOURCE of the alias: whatever is aliased `AS site_org_unit_id` must itself be a
    // `site_org_unit_id` column.
    //
    //   tl.site_org_unit_id  AS site_org_unit_id   <- correct, a real uuid
    //   location.name        AS site_org_unit_id   <- D7: a display name
    //
    // Comments are stripped first, because the D7 rationale deliberately quotes the bad
    // shape and a naive scan would match the prose describing the bug.
    const sqlOnly = (text: string) =>
      text
        .split('\n')
        .map((line) => line.replace(/--.*$/, '').trim())
        .join('\n')
    let checked = 0
    for (const statement of REPORT_VIEWS_SQL) {
      const body = sqlOnly(statement)
      for (const match of body.matchAll(/(\S+)\s+AS\s+site_org_unit_id\b/gi)) {
        checked += 1
        expect(
          match[1],
          `site_org_unit_id must be sourced from a site_org_unit_id column, got ${match[1]}`,
        ).toMatch(/\.?site_org_unit_id$/i)
      }
    }
    // Sanity: the fixture really did exercise at least one such alias.
    expect(checked).toBeGreaterThan(0)
  })
})

describe('defect D10 — a person column may never hold a display name', () => {
  const viewFor = (name: string) =>
    REPORT_VIEWS_SQL.find((s) => s.includes(`CREATE OR REPLACE VIEW ${name} `))
  const flat = (name: string) => (viewFor(name) ?? '').replace(/\s+/g, ' ').trim()
  const sqlOnly = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/--.*$/, '').trim())
      .join('\n')

  it('report_monitored_sessions resolves subject_person_id to the real person uuid', () => {
    // `PERSON_COLUMNS` is ['person_id', 'subject_person_id', ...] and `pickColumn`
    // returns the first candidate an entity actually has, so this entity is scoped by
    // `subject_person_id`. That column used to hold the resolved NAME. A self-tier
    // caller therefore compared 'Anderson, John' against a person uuid and matched
    // nothing at all — proven live: 2 rows for the right person before the fix became
    // 2 rows after, and comparing the name as a uuid raises
    // `invalid input syntax for type uuid`.
    expect(flat('report_monitored_sessions')).toContain('person.id AS subject_person_id')
    expect(flat('report_monitored_sessions')).not.toMatch(
      /person\.last_name[^;]*AS subject_person_id/,
    )
    // Whatever is aliased into the scoped column must itself be a person id.
    const alias = sqlOnly(viewFor('report_monitored_sessions')!).match(
      /(\S+)\s+AS\s+subject_person_id\b/i,
    )
    expect(alias?.[1]).toMatch(/\.?person_id$|person\.id$/i)
  })

  it('keeps the readable name in its own column so reports lose nothing', () => {
    expect(flat('report_monitored_sessions')).toContain('AS subject_person_name')
    expect(flat('report_monitored_sessions')).toContain(
      "person.last_name || ', ' || person.first_name",
    )
    // Two distinct aliases: the readable name is a separate column, not the id column
    // wearing a different label. Their order in the SELECT is not significant.
    const aliases = [...flat('report_monitored_sessions').matchAll(/AS (subject_person_\w+)/g)].map(
      (m) => m[1]!,
    )
    expect(new Set(aliases)).toEqual(new Set(['subject_person_id', 'subject_person_name']))
  })

  it('leaves subject_person_id NULL when the response has no person', () => {
    // The join is a LEFT JOIN on people, so an unmatched response yields NULL rather
    // than dropping the row or erroring. Both columns are null together.
    expect(viewFor('report_monitored_sessions')).toContain('LEFT JOIN people person')
    expect(flat('report_monitored_sessions')).toContain(
      'WHEN person.id IS NULL THEN NULL ELSE person.last_name',
    )
    // The id comes from person.id, which is NULL for an unmatched LEFT JOIN.
    expect(flat('report_monitored_sessions')).toContain('person.id AS subject_person_id')
  })

  it('joins people on tenant as well as id, so no cross-tenant person can attach', () => {
    expect(flat('report_monitored_sessions')).toContain('person.tenant_id = response.tenant_id')
    expect(flat('report_monitored_sessions')).toContain('person.id = response.subject_person_id')
  })

  it('never lets a name expression land in any PERSON_COLUMNS candidate', () => {
    // The class-level guard. `person_id`, `subject_person_id`, `driver_person_id`,
    // `inspector_person_id`, `current_holder_person_id` and `operator_person_id` are all
    // compared against person uuids, so none may be sourced from a name.
    //
    // Capture the WHOLE select-list item up to the alias. The old `(\S+)\s+AS`
    // only saw the last token, so `CASE ... END AS person_id` passed it as the
    // harmless word "END" — the exact bypass that let D10's sibling ship.
    const PERSON_COLUMNS = [
      'person_id',
      'subject_person_id',
      'driver_person_id',
      'inspector_person_id',
      'current_holder_person_id',
      'operator_person_id',
    ]
    // One historical exception: this view has ALWAYS exposed `person_id` as the
    // "Last, First" display name (seeded report definitions and custom-field
    // options select it as text). Changing it would show UUIDs in every
    // existing tenant's report. The scope spec binds `person_uuid` instead —
    // asserted below — so no uuid comparison ever lands on this display column.
    const DISPLAY_ONLY_ALIASES = new Set(['report_hazid_signatures.person_id'])
    let checked = 0
    for (const statement of REPORT_VIEWS_SQL) {
      const body = sqlOnly(statement)
      const viewName = /CREATE OR REPLACE VIEW (\w+)/.exec(body)?.[1] ?? ''
      for (const column of PERSON_COLUMNS) {
        if (DISPLAY_ONLY_ALIASES.has(`${viewName}.${column}`)) continue
        for (const match of body.matchAll(
          new RegExp(`(?:SELECT|,)([^,;]*?)\\s+AS\\s+${column}\\b`, 'gi'),
        )) {
          checked += 1
          const source = match[1] ?? ''
          expect(
            source,
            `${viewName}.${column} must be sourced from a person id column, got ${source}`,
          ).not.toMatch(/last_name|first_name|full_name|\|\|/i)
        }
      }
    }
    expect(checked, 'fixture must exercise at least one person-column alias').toBeGreaterThan(0)
  })

  it('report_hazid_signatures keeps the display name AND exposes a real uuid binding', () => {
    // Regression for the sibling of D10: a worker with hazid.read.self saw ZERO
    // signatures because the scope engine compared a "Last, First" name to a
    // person uuid. The display column stays for compatibility; `person_uuid`
    // (appended, so CREATE OR REPLACE accepts it) is what scope binds to.
    const body = flat('report_hazid_signatures')
    expect(body).toContain('person.id AS person_uuid')
    expect(body).toContain('END AS person_id')
    expect(body.indexOf('AS person_id')).toBeLessThan(body.indexOf('AS person_uuid'))
  })
})
