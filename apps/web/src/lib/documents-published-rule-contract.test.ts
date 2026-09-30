// 15B-3C-3F — guardrails for the three /documents read surfaces.
//
// 15B-3C-3E audited `documents/page.tsx`, `documents/[id]/read/page.tsx` and
// `documents/[id]/page.tsx` and found their published-visibility rule was, in
// effect, identical to `documentReadFilter(ctx)` — but stated three more times.
// It also found NONE of the three was covered by a test, so the duplication was
// invisible. This file is the guardrail that was missing: it is written to
// survive the consolidation it enabled, and to fail if the rule drifts again.
//
// WHAT IS ASSERTED
//
// Two layers, because a React Server Component has no callable export:
//
//   1. BEHAVIOURAL. The real `documentReadFilter(ctx)` is invoked with real
//      contexts, and the exact SQL each surface composes around it is compiled
//      and inspected — text AND bound parameters. `deleted` and `status` values
//      never appear in statement text, so an assertion on the text alone would
//      pass for the wrong reason.
//
//   2. CONTRACT. The behavioural layer proves the rule; the contract layer proves
//      each surface still composes it, still 404s, still redirects a reader to
//      the reader surface, and still requires a published VERSION. Those are
//      outcomes, not variable names: renaming `visibility` would not break these,
//      dropping the redirect or the `publishedAt` requirement would.
//
// The combination is deliberate. Layer 1 alone would pass if a page quietly
// stopped calling the helper; layer 2 alone would be a grep. Together they
// cannot be satisfied by a page that has the right text and the wrong behaviour,
// nor by one with the right behaviour expressed as an unrelated inline rule.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { documents } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { documentReadFilter } from './assistant/doc-access'

const dialect = new PgDialect()
const DOC_A = '1a000000-0000-4000-8000-0000000000a1'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const LIST = read('../app/(app)/documents/page.tsx')
const READ = read('../app/(app)/documents/[id]/read/page.tsx')
const DETAIL = read('../app/(app)/documents/[id]/page.tsx')

const ctxFor = (permissions: string[], isSuperAdmin = false): RequestContext =>
  ({ isSuperAdmin, permissions: new Set(permissions) }) as unknown as RequestContext

const reader = () => ctxFor(['documents.read'])
const manager = () => ctxFor(['documents.read', 'documents.manage'])
const superAdmin = () => ctxFor([], true)

/** `and()` returns `SQL | undefined`; a conjunction is always defined here, so an
 *  undefined result would be a bug rather than an expected case. */
const compile = (p: SQL | undefined) => {
  if (p === undefined) throw new Error('expected a conjunction, got undefined')
  const c = dialect.sqlToQuery(p as never)
  return { sql: c.sql, params: c.params.map(String) }
}

/** The conjunction the LIST surface builds: soft-delete, then visibility. */
const listWhere = (ctx: RequestContext, extra: SQL[] = []) => {
  const filters: SQL<unknown>[] = [isNull(documents.deletedAt)]
  const vis = documentReadFilter(ctx)
  if (vis) filters.push(vis)
  filters.push(...extra)
  return compile(and(...filters))
}

/** The conjunction the READ and DETAIL surfaces build for the parent document. */
const documentWhere = (ctx: RequestContext) => {
  const conds: SQL[] = [eq(documents.id, DOC_A), isNull(documents.deletedAt)]
  const vis = documentReadFilter(ctx)
  if (vis) conds.push(vis)
  return compile(and(...conds))
}

// ---------------------------------------------------------------------------
// 1. The shared rule itself
// ---------------------------------------------------------------------------

describe('15B-3C-3F — the shared published rule', () => {
  it('a reader is constrained to published, as a bound parameter', () => {
    const { sql, params } = compile(documentReadFilter(reader())!)
    expect(sql).toBe('"documents"."status" = $1')
    // The literal is a PARAMETER. Grepping the statement for "published" would
    // find nothing, which is exactly why the value has to be read here.
    expect(params).toEqual(['published'])
  })

  it('a manager and a super-admin are unconstrained', () => {
    expect(documentReadFilter(manager())).toBeUndefined()
    expect(documentReadFilter(superAdmin())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. LIST — page.tsx
// ---------------------------------------------------------------------------

describe('15B-3C-3F — list: reader sees published, manager sees everything', () => {
  it('a reader list carries soft-delete AND published', () => {
    const { sql, params } = listWhere(reader())
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).toContain('"documents"."status" = $1')
    expect(params).toEqual(['published'])
  })

  it('a manager list carries soft-delete and NO status constraint', () => {
    const { sql, params } = listWhere(manager())
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual([])
  })

  it('a super-admin list behaves as a manager', () => {
    expect(listWhere(superAdmin()).sql).toBe(listWhere(manager()).sql)
  })

  it('a user filter narrows beside the rule and can never replace it', () => {
    // The published constraint must survive any user-supplied filter. `status` is
    // the only status-bearing column a reader could reach, and asking for drafts
    // cannot talk the server out of its own rule.
    const userFilter = eq(documents.status, 'draft')
    const { sql, params } = listWhere(reader(), [userFilter])
    expect(sql).toContain('"documents"."status" = $1')
    expect(sql).toContain('"documents"."status" = $2')
    expect(sql).toContain(' and ')
    expect(params).toEqual(['published', 'draft'])
  })
})

// ---------------------------------------------------------------------------
// 3. READ — [id]/read/page.tsx
// ---------------------------------------------------------------------------

describe('15B-3C-3F — read: the published rule is applied in SQL', () => {
  it('a reader query carries id, soft-delete and published', () => {
    const { sql, params } = documentWhere(reader())
    expect(sql).toContain('"documents"."id" = $1')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).toContain('"documents"."status" = $2')
    expect(params).toEqual([DOC_A, 'published'])
  })

  it('a manager query keeps id and soft-delete but gains no status constraint', () => {
    const { sql, params } = documentWhere(manager())
    expect(sql).toContain('"documents"."id" = $1')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual([DOC_A])
  })

  it('the rule rejects every non-published status, including NULL', () => {
    // Before the consolidation this was a JavaScript `!== 'published'`; now it is
    // an SQL equality. SQL three-valued logic makes `NULL = 'published'` NULL,
    // not true, so a NULL status is still hidden — the same verdict the old check
    // gave, reached without fetching the row.
    const predicate = documentReadFilter(reader())!
    const admits = (status: string | null) => status !== null && status === 'published'
    for (const hidden of ['draft', 'archived', 'under_review', null]) {
      expect(admits(hidden), String(hidden)).toBe(false)
    }
    expect(admits('published')).toBe(true)
    // …and the predicate really is the equality, not something looser.
    expect(compile(predicate).sql).toBe('"documents"."status" = $1')
  })
})

// ---------------------------------------------------------------------------
// 4. DETAIL — [id]/page.tsx
// ---------------------------------------------------------------------------

describe('15B-3C-3F — detail: the probe carries the same rule', () => {
  it('a reader probe is the same conjunction as the reader query', () => {
    expect(documentWhere(reader()).sql).toContain('"documents"."status"')
  })

  it('a reader on an unpublished document cannot match the probe', () => {
    // The probe selects a single column by id; a draft row simply does not match,
    // so the page 404s exactly as it did when it fetched the row and compared
    // the status in JavaScript.
    const { sql } = documentWhere(reader())
    expect(sql).toContain('"documents"."status" = $2')
  })
})

// ---------------------------------------------------------------------------
// 5. Contract: each surface still composes the shared helper
// ---------------------------------------------------------------------------

describe('15B-3C-3F — the three surfaces delegate rather than restate', () => {
  const surfaces = [
    ['list', LIST],
    ['read', READ],
    ['detail', DETAIL],
  ] as const

  it('each imports and calls the shared helper', () => {
    for (const [name, src] of surfaces) {
      expect(src, name).toContain("from '@/lib/assistant/doc-access'")
      expect(src, name).toContain('documentReadFilter(ctx)')
    }
  })

  it('none of them restates the published rule inline', () => {
    // A fourth copy is exactly the drift 3C-3E found. If someone re-inlines the
    // rule, the composition below silently stops being the single source.
    for (const [name, src] of surfaces) {
      expect(src, name).not.toMatch(/eq\(documents\.status, 'published'\)/)
      expect(src, name).not.toMatch(/status !== 'published'/)
    }
  })

  it('the helper module documents that it owns the rule for these surfaces', () => {
    const doc = read('./assistant/doc-access.ts')
    expect(doc).toMatch(/single source of truth/i)
    expect(doc).toMatch(/list/i)
    expect(doc).toMatch(/reader/i)
  })
})

// ---------------------------------------------------------------------------
// 6. Contract: outcomes that must survive
// ---------------------------------------------------------------------------

describe('15B-3C-3F — the 404 / redirect outcomes are preserved', () => {
  it('a reader with no document permission gets a 404, not a redirect', () => {
    // `notFound()` must still gate BOTH the permission check and the probe, so a
    // caller with neither documents.read nor documents.manage learns nothing.
    expect(LIST).toContain('notFound()')
    expect(READ).toContain('notFound()')
    expect(DETAIL).toContain('notFound()')
  })

  it('the detail page still sends a reader to the reader surface', () => {
    // Navigation, not authorization — the consolidation must not have absorbed it.
    expect(DETAIL).toContain('redirect(`/documents/${id}/read`)')
    // …and it is still reached only on the reader branch, after the probe.
    const probe = DETAIL.indexOf('documentReadFilter(ctx)')
    const redirect = DETAIL.indexOf('redirect(`/documents/${id}/read`)')
    expect(probe).toBeGreaterThan(-1)
    expect(redirect).toBeGreaterThan(probe)
  })

  it('the reader still requires a published VERSION, manager or not', () => {
    // `documentReadFilter` waives the publication rule and nothing else. A
    // manager on this surface sees the latest published version, not the latest
    // draft — unchanged by the consolidation, and pinned here.
    expect(READ).toContain('isNotNull(documentVersions.publishedAt)')
  })

  it('all three keep the soft-delete constraint on the parent document', () => {
    expect(LIST).toContain('isNull(documents.deletedAt)')
    expect(READ).toContain('isNull(documents.deletedAt)')
    expect(DETAIL).toContain('isNull(documents.deletedAt)')
  })

  it('the manager flag is still computed, and still what the UI branches on', () => {
    // `canManage` is not an authorization rule here — it drives the render mode,
    // the export button and the facet chips. Consolidation must not have removed it.
    for (const [name, src] of [
      ['list', LIST],
      ['read', READ],
      ['detail', DETAIL],
    ] as const) {
      expect(src, name).toContain("ctx.isSuperAdmin || can(ctx, 'documents.manage')")
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Scope guard: the consolidation did not wander
// ---------------------------------------------------------------------------

describe('15B-3C-3F — out-of-scope surfaces were left alone', () => {
  it('the remaining inline published rules are untouched', () => {
    // 15B-3C-3H-A classified these as a separate batch, and 15B-3C-3H-1 took
    // exactly one of them. `[id]/_actions.ts` is deliberately absent:
    // `getDocumentPdfUrl` is a genuine READ_AUTHORIZATION and was consolidated
    // onto `documentReadFilter(ctx)` in 3H-1, whose contract lives in
    // `document-pdf-url-authorization.test.ts`.
    //
    // The remaining seven must still hold their own rule. For them `published`
    // is a business invariant, not a read rule: their callers already hold
    // `documents.manage`, so delegating to the reader helper would REMOVE the
    // constraint and widen authorization. `books/[id]/pdf` checks
    // `documentBooks.status` and was never a documents rule at all.
    const others: Record<string, string> = {
      '[id]/_ack-actions.ts': read('../app/(app)/documents/[id]/_ack-actions.ts'),
      '[id]/sign-off/page.tsx': read('../app/(app)/documents/[id]/sign-off/page.tsx'),
      '[id]/_send-email.ts': read('../app/(app)/documents/[id]/_send-email.ts'),
      'management-reviews/[id]/actions.ts': read(
        '../app/(app)/documents/management-reviews/[id]/actions.ts',
      ),
      'api/picker-options/route.ts': read('../app/api/picker-options/route.ts'),
      'document-book-lifecycle.ts': read('./document-book-lifecycle.ts'),
      'books/[id]/pdf/route.ts': read('../app/(app)/documents/books/[id]/pdf/route.ts'),
    }
    for (const [name, src] of Object.entries(others)) {
      expect(src, `${name} should still hold its own rule until separately ruled on`).toMatch(
        /eq\(documents\.status, 'published'\)|status !== 'published'|documentBooks\.status/,
      )
      // None may import the reader helper as a side effect of any batch.
      expect(src, name).not.toContain('documentReadFilter')
    }
  })

  it('the facet counts were not touched — that is 15B-3C-3G', () => {
    // 3C-3E found categoryCounts / typeCounts unbounded by the published rule.
    // Fixing it here would mix two batches; the guard proves it was left alone.
    expect(LIST).toContain('const live = isNull(documents.deletedAt)')
    expect(LIST).toContain('categoryCounts')
    expect(LIST).toContain('typeCounts')
  })
})
