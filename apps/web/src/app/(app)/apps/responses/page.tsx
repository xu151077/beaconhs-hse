import { getGeneratedValueTranslations, getGeneratedTranslations } from '@/i18n/generated.server'

import { GeneratedText, GeneratedValue } from '@/i18n/generated'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ClipboardCheck, Trash2 } from 'lucide-react'
import { and, asc, count, desc, eq, ilike, isNull, type SQL } from 'drizzle-orm'
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
import {
  formResponses,
  formTemplateVersions,
  formTemplates,
  orgUnits,
  people,
  tenantUsers,
  users as user,
} from '@beaconhs/db/schema'
import { can } from '@beaconhs/tenant'
import { DownloadLink } from '@/components/download-link'
import { requireRequestContext } from '@/lib/auth'
import { formatDate } from '@/lib/datetime'
import { moduleScopeWhere } from '@/lib/visibility'
import { ConfirmButton } from '@/components/confirm-button'
import { deleteFormResponseAction } from './_actions'
import { buildExportHref, isUuid, parseListParams, pickString } from '@/lib/list-params'
import { SearchInput } from '@/components/search-input'
import { SortableTh } from '@/components/sortable-th'
import { Pagination } from '@/components/pagination'
import { FilterChips } from '@/components/filter-bar'
import { ListPageLayout } from '@/components/page-layout'
import { TableToolbar } from '@/components/table-toolbar'
import { formCategoryLabel } from '../_lib/category-label'
import { getEffectiveRoleKeys } from '@/lib/effective-roles'
import { templateAccessWhere } from '../_lib/access'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_0382c9544c1241') }
}

const SORTS = ['submitted_at', 'created_at', 'status'] as const

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'non_compliant', label: 'Non-compliant' },
  { value: 'in_review', label: 'In review' },
  { value: 'closed', label: 'Closed' },
  { value: 'rejected', label: 'Rejected' },
]

export default async function FormResponsesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const tGeneratedValue = await getGeneratedValueTranslations()
  const tGenerated = await getGeneratedTranslations()
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'submitted_at',
    dir: 'desc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const rawStatus = pickString(sp.status)
  const statusFilter = STATUS_OPTIONS.some((option) => option.value === rawStatus)
    ? (rawStatus as (typeof formResponses.$inferSelect)['status'])
    : undefined
  // Optional deep-link filter only: `?category=…` narrows to one template
  // category (e.g. links from other modules). No hardcoded category pivot.
  const categoryFilter = pickString(sp.category)
  // The single most useful scope: pick ONE app/template. Without it this list is
  // one undifferentiated dump of every app's submissions (e.g. thousands of JHSA
  // wizard responses drowning out the rest).
  const templateFilter = pickString(sp.template)
  if (templateFilter && !isUuid(templateFilter)) notFound()
  const ctx = await requireRequestContext()
  const canExport = can(ctx, 'admin.data.export') && can(ctx, 'forms.response.read.self')
  const canDelete = can(ctx, 'forms.response.delete')
  const effectiveRoleKeys = await getEffectiveRoleKeys(ctx)

  const { rows, total, statusCounts, templateOptions } = await ctx.db(async (tx) => {
    // Per-user record visibility: read.all → everything, read.site → my sites,
    // else → responses I submitted or am the subject of.
    const vis = await moduleScopeWhere(ctx, tx, {
      prefix: 'forms.response',
      ownerCols: [formResponses.submittedBy],
      personCol: formResponses.subjectPersonId,
      siteCol: formResponses.siteOrgUnitId,
    })
    const accessWhere = templateAccessWhere(ctx, effectiveRoleKeys, 'browse-records')
    const filters: SQL<unknown>[] = [isNull(formResponses.deletedAt), accessWhere]
    if (vis) filters.push(vis)
    if (statusFilter) filters.push(eq(formResponses.status, statusFilter))
    if (templateFilter) filters.push(eq(formResponses.templateId, templateFilter))
    if (categoryFilter) filters.push(eq(formTemplates.category, categoryFilter))
    if (params.q) {
      const term = `%${params.q}%`
      const cond = ilike(formTemplates.name, term)
      if (cond) filters.push(cond)
    }
    const whereClause = filters.length > 0 ? and(...filters) : undefined

    const orderBy =
      params.sort === 'status'
        ? [params.dir === 'asc' ? asc(formResponses.status) : desc(formResponses.status)]
        : params.sort === 'created_at'
          ? [params.dir === 'asc' ? asc(formResponses.createdAt) : desc(formResponses.createdAt)]
          : [
              params.dir === 'asc'
                ? asc(formResponses.submittedAt)
                : desc(formResponses.submittedAt),
            ]

    const [tot] = await tx
      .select({ c: count() })
      .from(formResponses)
      .innerJoin(formTemplates, eq(formTemplates.id, formResponses.templateId))
      .where(whereClause)
    const data = await tx
      .select({
        response: formResponses,
        template: formTemplates,
        site: orgUnits,
        version: formTemplateVersions,
        submittedByName: user.name,
        subjectFirst: people.firstName,
        subjectLast: people.lastName,
      })
      .from(formResponses)
      .innerJoin(formTemplates, eq(formTemplates.id, formResponses.templateId))
      .leftJoin(orgUnits, eq(orgUnits.id, formResponses.siteOrgUnitId))
      .leftJoin(formTemplateVersions, eq(formTemplateVersions.id, formResponses.templateVersionId))
      .leftJoin(tenantUsers, eq(tenantUsers.id, formResponses.submittedBy))
      .leftJoin(user, eq(user.id, tenantUsers.userId))
      .leftJoin(people, eq(people.id, formResponses.subjectPersonId))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(params.perPage)
      .offset((params.page - 1) * params.perPage)
    // Status chip counts reflect the chosen app (when one is selected).
    const ss = await tx
      .select({ s: formResponses.status, c: count() })
      .from(formResponses)
      .innerJoin(formTemplates, eq(formTemplates.id, formResponses.templateId))
      .where(
        and(
          isNull(formResponses.deletedAt),
          accessWhere,
          templateFilter ? eq(formResponses.templateId, templateFilter) : undefined,
          vis,
        ),
      )
      .groupBy(formResponses.status)
    // App filter options: every template that has at least one response, most-used
    // first so the dominant apps are easy to find.
    const apps = await tx
      .select({ id: formTemplates.id, name: formTemplates.name, c: count(formResponses.id) })
      .from(formResponses)
      .innerJoin(formTemplates, eq(formTemplates.id, formResponses.templateId))
      .where(and(isNull(formResponses.deletedAt), accessWhere, vis))
      .groupBy(formTemplates.id, formTemplates.name)
      .orderBy(desc(count(formResponses.id)))
    return {
      rows: data,
      total: Number(tot?.c ?? 0),
      statusCounts: Object.fromEntries(ss.map((x) => [x.s, Number(x.c)])),
      templateOptions: apps.map((a) => ({ value: a.id, label: a.name, count: Number(a.c) })),
    }
  })

  const sortProps = { basePath: '/apps/responses', currentParams: sp, dir: params.dir }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={tGenerated('m_0382c9544c1241')}
            description={tGenerated('m_0f87656e2eefc7')}
            actions={
              canExport ? (
                <DownloadLink href={buildExportHref('/apps/responses/export.csv', sp)}>
                  <Button variant="outline">
                    <GeneratedText id="m_14c6440eca1edc" />
                  </Button>
                </DownloadLink>
              ) : null
            }
          />
          <GeneratedValue
            value={
              pickString(sp.deleteError) ? (
                <p className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                  <GeneratedValue value={pickString(sp.deleteError)} />
                </p>
              ) : null
            }
          />
          <TableToolbar>
            <SearchInput placeholder={tGenerated('m_0e87ecf4ecace2')} />
            <FilterChips
              basePath="/apps/responses"
              currentParams={sp}
              paramKey="template"
              label={tGenerated('m_0c7a3810288c4a')}
              allLabel={tGenerated('m_059aa94b4dd369')}
              options={templateOptions}
            />
            <FilterChips
              basePath="/apps/responses"
              currentParams={sp}
              paramKey="status"
              label={tGenerated('m_0b9da892d6faf0')}
              options={STATUS_OPTIONS.map((o) => ({ ...o, count: statusCounts[o.value] }))}
            />
          </TableToolbar>
        </>
      }
    >
      <GeneratedValue
        value={
          rows.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck size={32} />}
              title={tGeneratedValue(
                statusFilter || params.q || categoryFilter || templateFilter
                  ? tGenerated('m_1be15566f9e43e')
                  : tGenerated('m_1bac232173e044'),
              )}
              description={tGeneratedValue(
                categoryFilter
                  ? tGenerated('m_0be3dc3cd39801', { value0: formCategoryLabel(categoryFilter) })
                  : tGenerated('m_07f0c55a8223a6'),
              )}
              action={
                <Link href="/apps">
                  <Button>
                    <GeneratedText id="m_0a798a868ef61f" />
                  </Button>
                </Link>
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <GeneratedText id="m_1746970aea87ff" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_13704e4d90cde4" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_0e5e42c9af5dbe" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_1928431de4aaf1" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_055f11420b2da4" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_0cff7e37da2b3f" />
                    </TableHead>
                    <SortableTh {...sortProps} column="status" active={params.sort === 'status'}>
                      <GeneratedText id="m_0b9da892d6faf0" />
                    </SortableTh>
                    <SortableTh
                      {...sortProps}
                      column="created_at"
                      active={params.sort === 'created_at'}
                    >
                      <GeneratedText id="m_1922c581498469" />
                    </SortableTh>
                    <SortableTh
                      {...sortProps}
                      column="submitted_at"
                      active={params.sort === 'submitted_at'}
                    >
                      <GeneratedText id="m_0c823c3949ebd6" />
                    </SortableTh>
                    <TableHead>
                      <GeneratedText id="m_11e5c7ade0c0ab" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_003ea77d773d2d" />
                    </TableHead>
                    <TableHead className="w-16">
                      <GeneratedText id="m_1a2b2ed6729166" />
                    </TableHead>
                    <GeneratedValue
                      value={
                        canDelete ? (
                          <TableHead className="w-12">
                            <span className="sr-only">
                              <GeneratedText id="m_11773f3c3f7558" />
                            </span>
                          </TableHead>
                        ) : null
                      }
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <GeneratedValue
                    value={rows.map(
                      ({
                        response,
                        template,
                        site,
                        version,
                        submittedByName,
                        subjectFirst,
                        subjectLast,
                      }) => {
                        const subject =
                          subjectFirst || subjectLast
                            ? `${subjectLast ?? ''}${subjectLast ? ', ' : ''}${subjectFirst ?? ''}`.trim()
                            : null
                        return (
                          <TableRow key={response.id}>
                            <TableCell className="font-mono text-xs">
                              <Link
                                href={`/apps/responses/${response.id}`}
                                className="hover:underline"
                              >
                                <GeneratedValue value={response.id.slice(0, 8)} />
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Link
                                href={`/apps/responses/${response.id}`}
                                className="font-medium text-slate-900 hover:underline"
                              >
                                <GeneratedValue value={template.name} />
                              </Link>
                              <GeneratedValue
                                value={
                                  template.category ? (
                                    <div className="text-xs text-slate-500">
                                      <GeneratedValue
                                        value={formCategoryLabel(template.category)}
                                      />
                                    </div>
                                  ) : null
                                }
                              />
                            </TableCell>
                            <TableCell className="text-xs text-slate-500 tabular-nums">
                              <GeneratedValue
                                value={
                                  version ? (
                                    <GeneratedText
                                      id="m_1480a378beafd1"
                                      values={{ value0: version.version }}
                                    />
                                  ) : (
                                    '—'
                                  )
                                }
                              />
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              <GeneratedValue
                                value={subject || <span className="text-slate-400">—</span>}
                              />
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              <GeneratedValue value={site?.name ?? '—'} />
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              <GeneratedValue
                                value={
                                  response.currentStep ? (
                                    <Badge variant="outline" className="text-[10px]">
                                      <GeneratedValue value={response.currentStep} />
                                    </Badge>
                                  ) : (
                                    <span className="text-slate-400">—</span>
                                  )
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  response.status === 'non_compliant' ||
                                  response.status === 'rejected'
                                    ? 'destructive'
                                    : response.status === 'closed' ||
                                        response.status === 'submitted'
                                      ? 'success'
                                      : 'warning'
                                }
                              >
                                <GeneratedValue value={response.status.replace('_', ' ')} />
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-slate-600 tabular-nums">
                              <GeneratedValue
                                value={
                                  response.createdAt
                                    ? formatDate(
                                        new Date(response.createdAt),
                                        ctx.timezone,
                                        ctx.locale,
                                      )
                                    : '—'
                                }
                              />
                            </TableCell>
                            <TableCell className="text-xs text-slate-600 tabular-nums">
                              <GeneratedValue
                                value={
                                  response.submittedAt
                                    ? formatDate(
                                        new Date(response.submittedAt),
                                        ctx.timezone,
                                        ctx.locale,
                                      )
                                    : '—'
                                }
                              />
                            </TableCell>
                            <TableCell className="text-xs text-slate-600">
                              <GeneratedValue
                                value={submittedByName ?? <span className="text-slate-400">—</span>}
                              />
                            </TableCell>
                            <TableCell className="text-xs text-slate-600 tabular-nums">
                              <GeneratedValue
                                value={
                                  response.closedAt
                                    ? formatDate(
                                        new Date(response.closedAt),
                                        ctx.timezone,
                                        ctx.locale,
                                      )
                                    : '—'
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <GeneratedValue
                                value={
                                  response.pdfAttachmentId ? (
                                    <Badge variant="success" className="text-[10px]">
                                      <GeneratedText id="m_1a2b2ed6729166" />
                                    </Badge>
                                  ) : (
                                    <span className="text-xs text-slate-400">—</span>
                                  )
                                }
                              />
                            </TableCell>
                            <GeneratedValue
                              value={
                                canDelete ? (
                                  <TableCell>
                                    <form action={deleteFormResponseAction}>
                                      <input type="hidden" name="responseId" value={response.id} />
                                      <input
                                        type="hidden"
                                        name="returnTo"
                                        value="/apps/responses"
                                      />
                                      <ConfirmButton
                                        variant="ghost"
                                        size="sm"
                                        className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/40"
                                        message={tGenerated('m_13330801e55d2d')}
                                      >
                                        <Trash2 size={14} />
                                      </ConfirmButton>
                                    </form>
                                  </TableCell>
                                ) : null
                              }
                            />
                          </TableRow>
                        )
                      },
                    )}
                  />
                </TableBody>
              </Table>
              <Pagination
                basePath="/apps/responses"
                currentParams={sp}
                total={total}
                page={params.page}
                perPage={params.perPage}
              />
            </>
          )
        }
      />
    </ListPageLayout>
  )
}
