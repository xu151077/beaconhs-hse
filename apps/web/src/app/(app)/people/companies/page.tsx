import { getGeneratedValueTranslations, getGeneratedTranslations } from '@/i18n/generated.server'

import { GeneratedText, GeneratedValue } from '@/i18n/generated'
// /people/companies — the employers people are assigned to, one per person
// (people.companyId). A named tenant catalog exactly like /people/departments:
// standard table + right-side flyout for create/edit (?drawer=new | ?drawer=<id>),
// search, type filter, sortable columns and pagination. Delete is a row action that
// refuses while the company still has people — mirroring the `people_tenant_company_fk`
// ON DELETE no-action guard so the user gets a message instead of an FK violation.
//
// Contractor vs subcontractor is a `type` column on one table, not two modules:
// a company is reclassified in place. Gated to people who can manage the org
// (admin.org.manage), the same gate every People admin page uses — no
// contractor-specific permission and no new RoleScope variant.

import Link from 'next/link'
import { Building2, Plus, Trash2 } from 'lucide-react'
import { and, asc, count, desc, eq, ilike, isNull, or, type SQL } from 'drizzle-orm'
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@beaconhs/ui'
import { companies, people } from '@beaconhs/db/schema'
import { requireModuleManage } from '@/lib/module-admin/guard'
import { mergeHref, parseListParams, pickString, escapeIlike } from '@/lib/list-params'
import { ListPageLayout } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { FilterChips } from '@/components/filter-bar'
import { SortableTh } from '@/components/sortable-th'
import { PeopleSubNav } from '../_components/people-sub-nav'
import { CompanyDrawer, type CompanyEditing } from './_drawers'
import { deleteCompany, saveCompany } from '../_actions/companies'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_04648bfe14b9ea') }
}
export const dynamic = 'force-dynamic'

const BASE = '/people/companies'
const SORTS = ['name', 'type'] as const
const TYPES = ['contractor', 'subcontractor'] as const

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const tGeneratedValue = await getGeneratedValueTranslations()
  const tGenerated = await getGeneratedTranslations()
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'name', dir: 'asc', perPage: 25, allowedSorts: SORTS })
  const drawerParam = pickString(sp.drawer)
  const errorMsg = pickString(sp.error)
  const typeFilter = pickString(sp.type)
  const ctx = await requireModuleManage('people')

  const { rows, total } = await ctx.db(async (tx) => {
    const filters: SQL<unknown>[] = []
    if (params.q) {
      const term = `%${escapeIlike(params.q)}%`
      const cond = or(ilike(companies.name, term))
      if (cond) filters.push(cond)
    }
    if (typeFilter && (TYPES as readonly string[]).includes(typeFilter)) {
      filters.push(eq(companies.type, typeFilter as (typeof TYPES)[number]))
    }
    const whereClause = filters.length ? and(...filters) : undefined

    const dirFn = params.dir === 'asc' ? asc : desc
    const orderBy =
      params.sort === 'type'
        ? [dirFn(companies.type), dirFn(companies.name)]
        : [dirFn(companies.name)]

    const [tot] = await tx.select({ c: count() }).from(companies).where(whereClause)
    const page = await tx
      .select()
      .from(companies)
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(params.perPage)
      .offset((params.page - 1) * params.perPage)

    // Headcount per company, excluding soft-deleted people so a retired worker
    // does not keep a company looking staffed.
    const counts = await tx
      .select({ companyId: people.companyId, c: count() })
      .from(people)
      .where(isNull(people.deletedAt))
      .groupBy(people.companyId)
    const countsById = new Map(counts.map((c) => [c.companyId, Number(c.c)]))

    return {
      rows: page.map((row) => ({ ...row, memberCount: countsById.get(row.id) ?? 0 })),
      total: Number(tot?.c ?? 0),
    }
  })

  const editingRow =
    drawerParam && drawerParam !== 'new' ? rows.find((r) => r.id === drawerParam) : undefined
  const editing: CompanyEditing | null = editingRow
    ? { id: editingRow.id, name: editingRow.name, type: editingRow.type }
    : null
  const mode: 'new' | 'edit' | null = drawerParam === 'new' ? 'new' : editing ? 'edit' : null
  const closeHref = mergeHref(BASE, sp, { drawer: undefined, error: undefined })
  const newHref = mergeHref(BASE, sp, { drawer: 'new', error: undefined })

  return (
    <ListPageLayout
      header={
        <>
          <PeopleSubNav active="companies" />
          <PageHeader
            title={tGenerated('m_04648bfe14b9ea')}
            description={tGenerated('m_1d3da2946b017d')}
            actions={
              <Link href={newHref as any} scroll={false}>
                <Button>
                  <Plus size={14} /> <GeneratedText id="m_1e5d1a0db2014c" />
                </Button>
              </Link>
            }
          />
          <GeneratedValue
            value={
              errorMsg ? (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
                  <GeneratedValue value={errorMsg} />
                </p>
              ) : null
            }
          />
          <SearchInput placeholder={tGenerated('m_1db773ed40c42b')} />
          <FilterChips
            basePath={BASE}
            currentParams={sp}
            paramKey="type"
            label={tGenerated('m_074ba2f160c506')}
            options={[
              { value: 'contractor', label: tGenerated('m_03765a68a90b51') },
              { value: 'subcontractor', label: tGenerated('m_052246f4a904a3') },
            ]}
            allLabel={tGenerated('m_182aff8c076ae7')}
          />
        </>
      }
    >
      <GeneratedValue
        value={
          rows.length === 0 ? (
            <EmptyState
              icon={<Building2 size={32} />}
              title={tGeneratedValue(
                params.q
                  ? tGenerated('m_18718a9dda5e77', { value0: params.q })
                  : tGenerated('m_1dd93978ab4564'),
              )}
              description={tGeneratedValue(
                params.q ? tGenerated('m_0dcfd55260344b') : tGenerated('m_09ccbc4c0d78e7'),
              )}
              action={
                params.q ? undefined : (
                  <Link href={newHref as any} scroll={false}>
                    <Button>
                      <GeneratedText id="m_1e5d1a0db2014c" />
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTh
                      basePath={BASE}
                      currentParams={sp}
                      column="name"
                      active={params.sort === 'name'}
                      dir={params.dir}
                    >
                      <GeneratedText id="m_02b18d5c7f6f2d" />
                    </SortableTh>
                    <SortableTh
                      basePath={BASE}
                      currentParams={sp}
                      column="type"
                      active={params.sort === 'type'}
                      dir={params.dir}
                    >
                      <GeneratedText id="m_074ba2f160c506" />
                    </SortableTh>
                    <TableHead className="text-right">
                      <GeneratedText id="m_1e9ca6c7397706" />
                    </TableHead>
                    <TableHead className="text-right">
                      <GeneratedText id="m_0a7f1858f2ec46" />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <GeneratedValue
                    value={rows.map((row) => {
                      const editHref = mergeHref(BASE, sp, { drawer: row.id, error: undefined })
                      return (
                        <TableRow key={row.id}>
                          <TableCell>
                            <Link
                              href={editHref as any}
                              scroll={false}
                              className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                            >
                              <GeneratedValue value={row.name} />
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              <GeneratedValue
                                value={
                                  row.type === 'subcontractor'
                                    ? tGenerated('m_052246f4a904a3')
                                    : tGenerated('m_03765a68a90b51')
                                }
                              />
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <GeneratedValue
                              value={
                                row.memberCount > 0 ? (
                                  <Link
                                    href={`/people?company=${row.id}` as any}
                                    className="text-slate-600 tabular-nums hover:underline dark:text-slate-300"
                                  >
                                    <GeneratedValue value={row.memberCount} />
                                  </Link>
                                ) : (
                                  <span className="text-slate-400 tabular-nums">0</span>
                                )
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1">
                              <Link
                                href={editHref as any}
                                scroll={false}
                                className="rounded px-2 py-1 text-xs text-teal-700 hover:bg-teal-50 hover:underline dark:text-teal-400 dark:hover:bg-teal-500/10"
                              >
                                <GeneratedText id="m_03a66f9d34ac7b" />
                              </Link>
                              <form action={deleteCompany} className="inline">
                                <input type="hidden" name="id" value={row.id} />
                                <button
                                  type="submit"
                                  className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                                  title={tGeneratedValue(
                                    row.memberCount > 0
                                      ? tGenerated('m_090cc39a8b9b3d', { value0: row.memberCount })
                                      : tGenerated('m_11773f3c3f7558'),
                                  )}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </form>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  />
                </TableBody>
              </Table>
              <Pagination
                basePath={BASE}
                currentParams={sp}
                total={total}
                page={params.page}
                perPage={params.perPage}
              />
            </>
          )
        }
      />

      <CompanyDrawer mode={mode} editing={editing} closeHref={closeHref} saveAction={saveCompany} />
    </ListPageLayout>
  )
}
