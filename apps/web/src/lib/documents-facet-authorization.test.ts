// 15B-3C-3G — the category and type facet counts must not disclose more than the
// rows they label.
//
// THE DEFECT
//
// `documents/page.tsx` renders the category and type filter chips for EVERY
// caller, but their counts came from `where(live)` — soft-delete only. A caller
// holding just `documents.read` therefore saw a table containing published
// documents only, and chip labels counting the drafts and archived documents
// too. The withheld rows were disclosed by aggregate. No document row crossed
// the boundary, which is why 15B-3C-3E rated this LOW rather than HIGH, but the
// disclosure is real: per category and per type, the exact number of unpublished
// documents in the tenant is readable by anyone who can open the list.
//
// WHY THE STATUS FACET WAS NEVER AFFECTED
//
// The status chips are rendered only under `canManage`, and a manager is not
// constrained by the publication rule in the first place, so bounding them would
// be a no-op. That gating is asserted here so a future change cannot quietly drop
// it and leave the status facet as the next instance of this defect.
//
// WHAT IS ASSERTED, AND HOW
//
// The statements are produced by drizzle's real `QueryBuilder` using the real
// `documentReadFilter(ctx)` and the real schema, then compiled and inspected as
// SQL text AND bound parameters. Nothing here greps a source file for the word
// "published": that string only ever exists as a bound value, so a text search
// for it would always come up empty whether or not the rule was applied.
//
// The one thing asserted from source is the WIRING — that the two count queries
// consume the constrained predicate and the status query still does not. The
// predicate itself is verified behaviourally above; a page that computed the
// right predicate and then failed to use it would pass behavioural tests alone,
// so both layers are needed.
//
// The web vitest project has no database, and none is required: `.toSQL()`
// compiles a statement without executing it, so these are proofs about the
// statement that WOULD be sent.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, count, isNull, type SQL } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/pg-core'
import { documents } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { documentReadFilter } from './assistant/doc-access'

const qb = new QueryBuilder()
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const PAGE = read('../app/(app)/documents/page.tsx')

const ctxFor = (permissions: string[], isSuperAdmin = false): RequestContext =>
  ({ isSuperAdmin, permissions: new Set(permissions) }) as unknown as RequestContext

const reader = () => ctxFor(['documents.read'])
const manager = () => ctxFor(['documents.read', 'documents.manage'])
const superAdmin = () => ctxFor([], true)

type Compiled = { sql: string; params: string[] }

/** Soft-delete only — the status facet's constraint, and the old facet one. */
const liveOnly = (): Compiled => {
  const q = qb
    .select({ id: documents.categoryId, c: count() })
    .from(documents)
    .where(and(isNull(documents.deletedAt)))
    .groupBy(documents.categoryId)
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

/** The facet predicate the page now builds: soft-delete, then visibility. */
const facetWhere = (ctx: RequestContext): SQL | undefined => {
  const conds: SQL<unknown>[] = [isNull(documents.deletedAt)]
  const visibility = documentReadFilter(ctx)
  if (visibility) conds.push(visibility)
  return and(...conds)
}

const facetQuery = (ctx: RequestContext, kind: 'category' | 'type'): Compiled => {
  const column = kind === 'category' ? documents.categoryId : documents.typeId
  const q = qb
    .select({ id: column, c: count() })
    .from(documents)
    .where(facetWhere(ctx))
    .groupBy(column)
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

/** The list's own WHERE, for the parity comparison. */
const listWhere = (ctx: RequestContext): Compiled => {
  const filters: SQL<unknown>[] = [isNull(documents.deletedAt)]
  const visibility = documentReadFilter(ctx)
  if (visibility) filters.push(visibility)
  const q = qb
    .select({ c: count() })
    .from(documents)
    .where(and(...filters))
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

// ---------------------------------------------------------------------------
// 1. Reader — bounded
// ---------------------------------------------------------------------------

describe('15B-3C-3G — a reader facet count sees published documents only', () => {
  it('categoryCounts carries soft-delete AND the published predicate', () => {
    const { sql, params } = facetQuery(reader(), 'category')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).toContain('"documents"."status" = $1')
    // The publication value is a parameter. Grepping the text for "published"
    // would find nothing here, which is precisely why the value is asserted.
    expect(params).toEqual(['published'])
  })

  it('typeCounts carries the same predicate', () => {
    const { sql, params } = facetQuery(reader(), 'type')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).toContain('"documents"."status" = $1')
    expect(params).toEqual(['published'])
  })

  it('the grouping is untouched — only the WHERE gained a conjunct', () => {
    for (const kind of ['category', 'type'] as const) {
      const { sql } = facetQuery(reader(), kind)
      const column = kind === 'category' ? 'category_id' : 'type_id'
      expect(sql).toContain(`group by "documents"."${column}"`)
      expect(sql).toContain('count(*)')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Manager and super-admin — unchanged
// ---------------------------------------------------------------------------

describe('15B-3C-3G — a manager facet count is not narrowed', () => {
  it('categoryCounts keeps soft-delete and gains no status constraint', () => {
    const { sql, params } = facetQuery(manager(), 'category')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual([])
  })

  it('typeCounts likewise', () => {
    const { sql, params } = facetQuery(manager(), 'type')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual([])
  })

  it('a super-admin is treated as a manager on both counts', () => {
    for (const kind of ['category', 'type'] as const) {
      const { sql, params } = facetQuery(superAdmin(), kind)
      expect(sql, kind).toContain('"documents"."deleted_at" is null')
      expect(sql, kind).not.toContain('"documents"."status"')
      expect(params, kind).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Soft delete — never counted, for anybody
// ---------------------------------------------------------------------------

describe('15B-3C-3G — deleted documents are counted by nobody', () => {
  it('every role and both facets carry the soft-delete constraint', () => {
    for (const [role, ctx] of [
      ['reader', reader()],
      ['manager', manager()],
      ['super-admin', superAdmin()],
    ] as const) {
      for (const kind of ['category', 'type'] as const) {
        expect(facetQuery(ctx, kind).sql, `${role}/${kind}`).toContain(
          '"documents"."deleted_at" is null',
        )
      }
    }
  })

  it('the pre-fix predicate really did lack the status conjunct', () => {
    // Pins WHY the fix was needed: the old `where(live)` statement is a strictly
    // weaker one, and it is what the chips used to be built from.
    const old = liveOnly()
    expect(old.sql).toContain('"documents"."deleted_at" is null')
    expect(old.sql).not.toContain('"documents"."status"')
    expect(old.params).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Parity — the counts and the rows agree on who may see what
// ---------------------------------------------------------------------------

describe('15B-3C-3G — list and both facet counts share one visibility rule', () => {
  it('for a reader all three constrain identically', () => {
    const ctx = reader()
    const list = listWhere(ctx)
    const category = facetQuery(ctx, 'category')
    const type = facetQuery(ctx, 'type')
    for (const [name, q] of [
      ['list', list],
      ['category', category],
      ['type', type],
    ] as const) {
      expect(q.sql, name).toContain('"documents"."deleted_at" is null')
      expect(q.sql, name).toContain('"documents"."status" = $1')
      expect(q.params, name).toEqual(['published'])
    }
    // Same conjunct, same bound value — not merely "both mention published".
    expect(category.params).toEqual(list.params)
    expect(type.params).toEqual(list.params)
  })

  it('for a manager all three are unconstrained by status', () => {
    const ctx = manager()
    for (const [name, q] of [
      ['list', listWhere(ctx)],
      ['category', facetQuery(ctx, 'category')],
      ['type', facetQuery(ctx, 'type')],
    ] as const) {
      expect(q.sql, name).not.toContain('"documents"."status"')
      expect(q.params, name).toEqual([])
    }
  })

  it('a super-admin matches the manager on all three', () => {
    const ctx = superAdmin()
    for (const [name, q] of [
      ['list', listWhere(ctx)],
      ['category', facetQuery(ctx, 'category')],
      ['type', facetQuery(ctx, 'type')],
    ] as const) {
      expect(q.sql, name).not.toContain('"documents"."status"')
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Wiring — the page feeds the counts the predicate they are built with
// ---------------------------------------------------------------------------

describe('15B-3C-3G — the page wires the two counts, and leaves status alone', () => {
  it('builds one facet predicate from soft-delete plus the shared rule', () => {
    // Behaviour above proves the predicate is right; this proves the page uses it.
    expect(PAGE).toContain('const visibility = await documentAuthorizationFilter(ctx, tx)')
    expect(PAGE).toMatch(/const facetConds: SQL<unknown>\[\] = \[live\]/)
    expect(PAGE).toMatch(/if \(visibility\) facetConds\.push\(visibility\)/)
  })

  it('both counts consume it', () => {
    const cc = PAGE.slice(PAGE.indexOf('const cc = await tx'))
    const tc = PAGE.slice(PAGE.indexOf('const tc = await tx'))
    expect(cc.slice(0, 200)).toContain('.where(facetWhere)')
    expect(tc.slice(0, 200)).toContain('.where(facetWhere)')
    expect(cc).toContain('groupBy(documents.categoryId)')
    expect(tc).toContain('groupBy(documents.typeId)')
  })

  it('the status facet still reads only `live`, unchanged by this batch', () => {
    // Slice to the end of the status statement itself, not merely up to the next
    // query: the facet predicate is now DEFINED between `ss` and `cc`, so a wider
    // slice would pick up its definition and misreport what `ss` consumes.
    const ss = PAGE.slice(
      PAGE.indexOf('const ss = await tx'),
      PAGE.indexOf('const facetConds: SQL<unknown>[] = [live]'),
    )
    expect(ss).toContain('.where(live)')
    expect(ss).toContain('groupBy(documents.status)')
    expect(ss).not.toContain('facetWhere')
    // …and nothing between the two queries re-points `ss` at the new predicate.
    expect(PAGE).not.toMatch(/const ss = await tx[\s\S]{0,300}?\.where\(facetWhere\)/)
  })

  it('the status chips remain manager-only, so that facet cannot regress this way', () => {
    // If this gate were removed, the status counts would become the next
    // unbounded facet. The gate is the reason statusCounts was left alone.
    const statusChips = PAGE.slice(PAGE.indexOf('paramKey="status"') - 400)
    expect(statusChips.slice(0, 400)).toContain('canManage')
  })

  it('the category and type chips are still rendered for every caller', () => {
    // Deliberately unchanged: the fix bounds the COUNT, it does not hide the
    // chips. A reader keeps the filter; the number on it is now truthful.
    expect(PAGE).toContain('paramKey="category"')
    expect(PAGE).toContain('paramKey="type"')
    expect(PAGE).toMatch(/categories\.length > 0 \? \(/)
    expect(PAGE).toMatch(/types\.length > 0 \? \(/)
  })

  it('the list main query and its filters are untouched by this batch', () => {
    expect(PAGE).toContain('const whereClause = and(...filters)')
    expect(PAGE).toContain('if (canManage && statusFilter)')
    expect(PAGE).toContain('if (categoryFilter) filters.push')
    expect(PAGE).toContain('if (typeFilter) filters.push')
    expect(PAGE).toContain('if (params.q) {')
  })
})
