import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Structural contract for the contractor / subcontractor company association.
//
// `apps/web` has no vitest config, so the `@/*` path alias is unavailable and
// anything under `app/(app)/` cannot be imported here — these assertions read the
// source instead. That is the repo's own convention for this directory (see
// `_primary-title-directory-contract.test.ts`), and it is what pins the properties
// that matter: the association stays a named catalog under the EXISTING People
// admin, so no contractor permission, RoleScope, or authorization layer appears.
//
// Behaviour against a live database and a live browser — CRUD, the contractor /
// subcontractor distinction, reassignment, the in-use delete refusal, permission
// denial and cross-tenant isolation — is proven during verification, not here.

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const ACTIONS = '../_actions/companies.ts'
const PAGE = './page.tsx'
const DRAWERS = './_drawers.tsx'
const PEOPLE_PAGE = '../page.tsx'
const PERSON_PAGE = '../[id]/page.tsx'
const TABLE = '../_records-table.tsx'
const CSV = '../export.csv/route.ts'
const SUB_NAV = '../_components/people-sub-nav.tsx'
const MODULE_ADMIN = '../../../../lib/module-admin/registry.ts'
const MANUAL = '../../../../lib/manual/content/oversight-admin.ts'

describe('companies — create, update, and delete', () => {
  it('gates every mutation on the existing People org-admin permission', () => {
    const actions = source(ACTIONS)
    // admin.org.manage via the shared module guard. No contractor permission,
    // no new RoleScope: a company is business data, not an authorization scope.
    // Count real call sites only — the file's own comment quotes the guard too.
    expect(actions.match(/^\s+assertCanManageModule\(ctx, 'people'\)$/gm)).toHaveLength(2)
    expect(actions).not.toMatch(/'contractors?\.|'hse\.contractors?\.|assertCan\(/)
    expect(actions).not.toMatch(/moduleScopeWhere|journalScopeWhere|resolveVisibilityTier/)
  })

  it('validates the name and the type before writing', () => {
    const actions = source(ACTIONS)
    expect(actions).toContain('normalizeCatalogDisplayName(input.name)')
    expect(actions).toContain("return { ok: false, error: 'Name is required.' }")
    expect(actions).toContain("const COMPANY_TYPES = ['contractor', 'subcontractor'] as const")
    expect(actions).toContain('if (!isCompanyType(type))')
    expect(actions).toContain("return { ok: false, error: 'Invalid company type.' }")
  })

  it('turns the tenant-scoped unique-name violation into a readable message', () => {
    const actions = source(ACTIONS)
    expect(actions).toContain('/companies_tenant_(?:normalized_)?name_ux/')
    expect(actions.match(/A company with that name already exists\./g)).toHaveLength(2)
  })

  it('refuses to delete a company that still has people', () => {
    const actions = source(ACTIONS)
    // Mirrors the FK's ON DELETE no-action so the user gets a message, not a 500.
    expect(actions).toContain('eq(people.companyId, id)')
    expect(actions).toContain("if (usage > 0) return { state: 'assigned' as const, row, usage }")
    expect(actions).toContain('Reassign them before deleting.')
    // Deleting an unreferenced company is a real delete, not a soft delete.
    expect(actions).toContain('.delete(companies)')
    expect(actions).not.toContain('deletedAt')
  })

  it('audits create, update, and delete', () => {
    const actions = source(ACTIONS)
    expect(actions).toContain("entityType: 'company'")
    for (const action of ["action: 'create'", "action: 'update'", "action: 'delete'"]) {
      expect(actions).toContain(action)
    }
    expect(actions.match(/recordAudit\w*\(/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('scopes every read and write by tenant through ctx.db', () => {
    const actions = source(ACTIONS)
    // ctx.db is the RLS-bound executor; the tenant predicate is added explicitly
    // so a stale id from another tenant simply reads as missing.
    expect(actions.match(/ctx\.db\(/g)?.length).toBeGreaterThan(0)
    expect(actions).toContain('eq(companies.tenantId, ctx.tenantId)')
    // Never the raw root client: tenant data must go through the RLS-bound
    // executor, not an unscoped query.
    expect(actions).not.toMatch(/import \{[^}]*\bdb\b[^}]*\} from '@beaconhs\/db'/)
    expect(actions).not.toContain('withSuperAdmin')
  })
})

describe('companies — the list surface', () => {
  it('is a searchable, filterable, sortable, paginated table', () => {
    const page = source(PAGE)
    expect(page).toContain('ilike(companies.name, term)')
    expect(page).toContain('<SearchInput')
    expect(page).toContain('<FilterChips')
    expect(page).toContain('paramKey="type"')
    expect(page).toContain('<SortableTh')
    expect(page).toContain('column="name"')
    expect(page).toContain('column="type"')
    expect(page).toContain('<Pagination')
    // An unbounded table is not shippable.
    expect(page).toContain('.limit(params.perPage)')
    expect(page).toContain('.offset((params.page - 1) * params.perPage)')
  })

  it('counts only people who are not soft-deleted', () => {
    const page = source(PAGE)
    expect(page).toContain('select({ companyId: people.companyId, c: count() })')
    expect(page).toContain('.where(isNull(people.deletedAt))')
  })

  it('shows the contractor / subcontractor distinction and links the headcount', () => {
    const page = source(PAGE)
    expect(page).toContain("row.type === 'subcontractor'")
    expect(page).toContain('/people?company=${row.id}')
  })

  it('offers only the two real enum values in the drawer', () => {
    const drawers = source(DRAWERS)
    expect(drawers).toContain('<option value="contractor">')
    expect(drawers).toContain('<option value="subcontractor">')
    // A type <select>, not a free-text field.
    expect(drawers).not.toMatch(/type="text"[^>]*\bname="type"/)
  })
})

describe('companies — reachable without a new nav module or permission', () => {
  it('sits in the existing People Manage hub as one more section', () => {
    const registry = source(MODULE_ADMIN)
    expect(registry).toContain("key: 'companies'")
    expect(registry).toContain("href: '/people/companies'")
    // The People module keeps its existing admin.org.manage permission.
    expect(registry).not.toMatch(/'companies?\.[a-z.]*'/)
    const subNav = source(SUB_NAV)
    expect(subNav).toContain("| 'companies'")
  })

  it('uses the module-admin manage guard, exactly like the sibling catalogs', () => {
    expect(source(PAGE)).toContain("requireModuleManage('people')")
  })
})

describe('companies — the person surfaces', () => {
  it('edits the association inline on a person, app-owned not sync-owned', () => {
    const person = source(PERSON_PAGE)
    expect(person).toContain('field="companyId"')
    expect(person).toContain('options={companyOptions.map(')
    expect(person).toContain('initialValue={person.companyId}')
    // The edit path is the shared APP_OWNED_FIELDS gate, so it inherits the
    // existing auth + audit + revalidation behaviour.
    expect(person).toContain("'companyId',")
    expect(person).toContain('const APP_OWNED_FIELDS = new Set([')
    // upsertPerson maps no employer, so the sync must NOT claim the field.
    const peopleSync = source('../../../../lib/people-sync.ts')
    expect(peopleSync).not.toContain('companyId')
  })

  it('shows the company on the directory and offers it as a filter', () => {
    const peoplePage = source(PEOPLE_PAGE)
    expect(peoplePage).toContain('.leftJoin(companies, eq(companies.id, people.companyId))')
    expect(peoplePage).toContain(
      'if (companyFilter) baseFilters.push(eq(people.companyId, companyFilter))',
    )
    expect(peoplePage).toContain('activeCompanyName')
    const table = source(TABLE)
    expect(table).toContain('<SortTh column="company"')
    expect(table).toContain("<GeneratedValue value={r.companyName ?? '—'} />")
  })

  it('offers a company when creating a person', () => {
    const newPerson = source('../new/page.tsx')
    expect(newPerson).toContain('<Select name="companyId"')
    expect(newPerson).toContain("const companyId = String(formData.get('companyId')")
  })

  it('keeps the CSV export truthful: same filter, new column', () => {
    const csv = source(CSV)
    expect(csv).toContain('if (companyFilter) filters.push(eq(people.companyId, companyFilter))')
    expect(csv).toContain('.leftJoin(companies, eq(companies.id, people.companyId))')
    expect(csv).toContain("'Company',")
    expect(csv).toContain("r.company?.name ?? ''")
    // The filter is recorded in the export audit, not silently applied.
    expect(csv).toContain('company: companyFilter')
  })
})

describe('companies — no parallel authorization or entity system', () => {
  it('reuses the existing people read boundary rather than narrowing it', () => {
    const peoplePage = source(PEOPLE_PAGE)
    // `people.read.all` remains the whole boundary; the company filter is a
    // business-data filter, never a visibility tier.
    expect(peoplePage).toContain('people.read.all')
    expect(peoplePage).not.toMatch(/moduleScopeWhere|visibilityTier|readTier/)
    // Existing people permissions are untouched: exactly one key is referenced and
    // it is the pre-existing one. No new people.* or companies.* key appears.
    const keys = new Set(
      [...(peoplePage.match(/'(?:people|companies|contractors?)\.[a-z.]+'/g) ?? [])].map((k) =>
        k.slice(1, -1),
      ),
    )
    expect([...keys]).toEqual(['people.read.all'])
  })

  it('keeps the in-app guide truthful', () => {
    const manual = source(MANUAL)
    expect(manual).toContain('## Companies')
    expect(manual).toContain('[Companies](/people/companies)')
    expect(manual).toContain('**Add company**')
    expect(manual).toContain('**Contractor** or **Subcontractor**')
    expect(manual).toContain('A company cannot be deleted while people still work for it.')
  })
})
