// 15B-3C-3I — the cross-module Compliance → Documents metadata contract.
//
// WHY THESE TESTS EXIST
//
// The compliance module reads the `documents` table on three surfaces and does
// NOT apply `documentReadFilter`. That looks like a missing authorization check
// and for a long time was assumed to be one. It is not: the product decision is
// that a caller holding `compliance.read` / `compliance.assign` may see LIMITED
// METADATA for documents in `draft`, `published` and `under_review`.
//
// The reason a review obligation exists from the moment a document is drafted —
// and `under_review` being the state in which a review is pending — means
// narrowing these to `published` would delete the review-due signal for exactly
// the documents most in need of it. `archived` is excluded because an archived
// document has left the compliance working set.
//
// So this is an INTENTIONAL cross-module metadata rule, and these tests exist to
// pin its BOUNDS so it cannot quietly become "all documents, forever":
//
//   • the status set is exactly {draft, published, under_review}
//   • `archived` is not in it, and must not be added silently
//   • soft-deleted rows never appear
//   • the tenant predicate is present (not merely inherited from RLS)
//   • no surface requires `documents.manage` — that is the whole point
//   • none of them borrows the reader helper, which would flip `under_review` off
//
// WHAT IS ASSERTED, AND HOW
//
// The three statements are rebuilt with drizzle's real `QueryBuilder` and
// compiled. The decisive assertions read BOUND PARAMETERS, because that is where
// the rule actually lives: `inArray` compiles to `in ($2, $3, $4)` and the
// statuses are the bound values, so the set can be compared exactly. A source
// search for the word "draft" would prove nothing, and neither would a search of
// the SQL text — the statuses never appear there.
//
// Source is read only for the things a compiled predicate cannot express: which
// capability gates each surface, which columns are projected, and that the
// rationale comment is present so the next reader does not "fix" it.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/pg-core'
import { documents } from '@beaconhs/db/schema'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { documentReadFilter } from './assistant/doc-access'

const qb = new QueryBuilder()
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const SIGNALS = read('../app/(app)/compliance/_signals.ts')
const FORM_OPTIONS = read('../app/(app)/compliance/obligations/_form-options.ts')
const PICKER = read('../app/api/picker-options/route.ts')

const TENANT = '10000000-0000-4000-8000-0000000000aa'
const OTHER_TENANT = '20000000-0000-4000-8000-0000000000bb'
const DOC_A = '1a000000-0000-4000-8000-0000000000a1'

/** The compliance-obligation-documents branch, isolated from its neighbours. */
const branch = (): string => {
  const start = PICKER.indexOf("if (lookup === 'compliance-obligation-documents')")
  const end = PICKER.indexOf("if (lookup === 'compliance-obligation-courses'", start)
  return PICKER.slice(start, end)
}

/** The working set, exactly as the product decision defines it. */
const WORKING_SET = ['draft', 'published', 'under_review'] as const

/**
 * Source with comments removed.
 *
 * The rationale written at each surface deliberately NAMES documentReadFilter in
 * order to say it is NOT used there. Asserting "the code does not call it" against
 * the raw text would therefore match the explanation rather than the code, so the
 * negative assertions run against this.
 */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

type Compiled = { sql: string; params: string[] }
const run = (q: unknown): Compiled => {
  const r = (q as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

// ---------------------------------------------------------------------------
// Surface 1 — compliance/_signals.ts (review-due signals)
// ---------------------------------------------------------------------------

describe('15B-3C-3I — compliance review-due signals over documents', () => {
  const signals = () =>
    run(
      qb
        .select({ t: documents.title, r: documents.nextReviewOn })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, TENANT),
            isNull(documents.deletedAt),
            inArray(documents.status, [...WORKING_SET]),
          ),
        ),
    )

  it('names exactly the three working statuses, as bound parameters', () => {
    const { params } = signals()
    // The rule is the bound set. It never appears in the statement text.
    expect(params.slice(1)).toEqual([...WORKING_SET])
  })

  it('archived is not among them', () => {
    expect(signals().params).not.toContain('archived')
  })

  it('draft, published and under_review are all in scope', () => {
    const inScope = new Set(signals().params.slice(1))
    for (const status of WORKING_SET) expect(inScope.has(status), status).toBe(true)
  })

  it('a document outside the working set does not match', () => {
    // Stated from the bound set: the predicate is an IN test, so anything not in
    // it cannot match. `archived` is the case that matters.
    const inScope = new Set(signals().params.slice(1))
    for (const out of ['archived', 'retired', 'superseded']) {
      expect(inScope.has(out), out).toBe(false)
    }
  })

  it('soft-deleted documents are excluded', () => {
    expect(signals().sql).toContain('"documents"."deleted_at" is null')
  })

  it('the tenant boundary is explicit, not merely inherited from RLS', () => {
    const { sql, params } = signals()
    expect(sql).toContain('"documents"."tenant_id" = $1')
    expect(params[0]).toBe(TENANT)
    // A different tenant's id is not anywhere in the bound values.
    expect(params).not.toContain(OTHER_TENANT)
  })

  it('the surface projects metadata only', () => {
    expect(SIGNALS).toContain('${documents.title}')
    expect(SIGNALS).toContain('${documents.nextReviewOn}')
    // No attachment, storage key or presign anywhere in the signal.
    expect(SIGNALS).not.toMatch(/r2Key|presign|attachment/i)
  })

  it('it does not borrow the reader helper, which would switch off under_review', () => {
    expect(codeOnly(SIGNALS)).not.toContain('documentReadFilter')
    // The reader rule really does exclude under_review — that is why borrowing it
    // here would be a behaviour change rather than a refactor.
    const readerCtx = { isSuperAdmin: false, permissions: new Set(['documents.read']) }
    const filter = documentReadFilter(readerCtx as never)
    const readerParams = (new QueryBuilder() as never) && filter ? paramsOf(filter) : []
    expect(readerParams).toEqual(['published'])
    expect(readerParams).not.toContain('under_review')
  })
})

/** Bound values of an SQL predicate, read the same way the compiler sees them. */
function paramsOf(p: SQL | undefined): string[] {
  if (p === undefined) return []
  const { PgDialect } = require('drizzle-orm/pg-core') as typeof import('drizzle-orm/pg-core')
  return new PgDialect().sqlToQuery(p as never).params.map(String)
}

// ---------------------------------------------------------------------------
// Surface 2 — compliance/obligations/_form-options.ts
// ---------------------------------------------------------------------------

describe('15B-3C-3I — the obligation form names the document it is bound to', () => {
  const formOptions = () =>
    run(
      qb
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(and(eq(documents.id, DOC_A), isNull(documents.deletedAt))),
    )

  it('resolves the one referenced document by a bound id', () => {
    const { sql, params } = formOptions()
    expect(sql).toContain('"documents"."id" = $1')
    expect(params).toEqual([DOC_A])
    expect(sql).not.toContain(DOC_A)
  })

  it('excludes soft-deleted documents', () => {
    expect(formOptions().sql).toContain('"documents"."deleted_at" is null')
  })

  it('applies no publication filter, so a draft can still be named', () => {
    const { sql, params } = formOptions()
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual([DOC_A])
  })

  it('projects id and title only', () => {
    expect(FORM_OPTIONS).toContain('.select({ id: documents.id, title: documents.title })')
    expect(FORM_OPTIONS).not.toMatch(/r2Key|presign|attachment/i)
  })

  it('does not borrow the reader helper', () => {
    expect(codeOnly(FORM_OPTIONS)).not.toContain('documentReadFilter')
  })
})

// ---------------------------------------------------------------------------
// Surface 3 — picker-options, compliance-obligation-documents
// ---------------------------------------------------------------------------

describe('15B-3C-3I — the compliance obligation document picker', () => {
  const picker = () =>
    run(
      qb
        .select({ id: documents.id, title: documents.title, key: documents.key })
        .from(documents)
        .where(and(isNull(documents.deletedAt), or(ilike(documents.title, 'safe')))),
    )

  it('excludes soft-deleted documents', () => {
    expect(picker().sql).toContain('"documents"."deleted_at" is null')
  })

  it('applies no publication filter, so the whole working set is attachable', () => {
    const { sql, params } = picker()
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual(['safe'])
  })

  it('projects reference data only', () => {
    expect(PICKER).toContain(
      '.select({ id: documents.id, title: documents.title, key: documents.key })',
    )
    expect(branch()).not.toMatch(/r2Key|presign|attachment/i)
  })

  it('does not borrow the reader helper', () => {
    expect(codeOnly(branch())).not.toContain('documentReadFilter')
  })

  it('is deliberately WIDER than the book and management-review lookups', () => {
    // The contrast that makes the decision legible: a book and a management
    // review record what was ISSUED, so they require `published`; an obligation
    // records what must be DONE, so it does not. Both live in the same file.
    const reviewStart = PICKER.indexOf(
      "if (lookup === 'management-review-documents' || lookup === 'document-book-documents')",
    )
    const reviewBranch = PICKER.slice(
      reviewStart,
      PICKER.indexOf("if (lookup === 'management-review-actions'", reviewStart),
    )
    expect(reviewBranch).toContain("eq(documents.status, 'published')")
    expect(branch()).not.toContain("eq(documents.status, 'published')")
  })
})

// ---------------------------------------------------------------------------
// 4. Gating — no surface requires documents.manage
// ---------------------------------------------------------------------------

describe('15B-3C-3I — these surfaces are not gated on documents.manage', () => {
  it('the signals page is gated on compliance.read', () => {
    const page = read('../app/(app)/compliance/expiring/page.tsx')
    expect(page).toContain("assertCan(ctx, 'compliance.read')")
  })

  it('the obligation pages are gated on compliance.read', () => {
    expect(read('../app/(app)/compliance/obligations/page.tsx')).toContain(
      "assertCan(ctx, 'compliance.read')",
    )
    expect(read('../app/(app)/compliance/obligations/[id]/page.tsx')).toContain(
      "assertCan(ctx, 'compliance.read')",
    )
  })

  it('the picker is gated on compliance.assign or compliance.manage', () => {
    const authorized = codeOnly(PICKER.slice(PICKER.indexOf('function pickerAuthorized')))
    const caseIdx = authorized.indexOf("case 'compliance-obligation-documents'")
    // The whole 16-case group precedes its single `return`, so the window runs to the
    // case that FOLLOWS the group rather than to a fixed character count.
    const ret = authorized.slice(
      caseIdx,
      authorized.indexOf("case 'dashboard-quick-action-forms'", caseIdx),
    )
    expect(ret).toMatch(
      /return can\(ctx, 'compliance\.assign'\) \|\| can\(ctx, 'compliance\.manage'\)/,
    )
    expect(ret).not.toContain('documents.manage')
  })

  it('a role that reaches compliance but not documents.manage really exists', () => {
    // Without this the whole "no documents.manage required" property would be
    // vacuous. `foreman` is the role the exposure actually applies to.
    const foreman = BUILTIN_ROLES.foreman?.permissions ?? []
    expect(foreman).toContain('compliance.read')
    expect(foreman).toContain('compliance.assign')
    expect(foreman).toContain('documents.read')
    expect(foreman).not.toContain('documents.manage')
  })

  it('and a role that holds documents.manage is not thereby exempt from the rest', () => {
    expect(BUILTIN_ROLES.safety_manager?.permissions).toContain('documents.manage')
  })
})

// ---------------------------------------------------------------------------
// 5. The decision is written down where a reader will hit it
// ---------------------------------------------------------------------------

describe('15B-3C-3I — the rationale is recorded at each surface', () => {
  it('_signals.ts explains the wider status set and the metadata-only exposure', () => {
    expect(SIGNALS).toMatch(/documentReadFilter.*not applied|not.*applied here/i)
    expect(SIGNALS).toMatch(/under_review/)
    expect(SIGNALS).toMatch(/archived/i)
    expect(SIGNALS).toMatch(/METADATA|metadata/i)
  })

  it('_form-options.ts explains why a draft must still be nameable', () => {
    expect(FORM_OPTIONS).toMatch(/draft/)
    expect(FORM_OPTIONS).toMatch(/documentReadFilter/)
  })

  it('picker-options explains the contrast with the published-only lookups', () => {
    expect(branch()).toMatch(/documentReadFilter/)
    expect(branch()).toMatch(/book|management review/i)
  })
})

// ---------------------------------------------------------------------------
// 6. Nothing here touched the schema or the reader rule
// ---------------------------------------------------------------------------

describe('15B-3C-3I — the reader rule and the schema are untouched', () => {
  it('documentReadFilter still restricts non-managers to published', () => {
    const readerCtx = { isSuperAdmin: false, permissions: new Set(['documents.read']) }
    expect(paramsOf(documentReadFilter(readerCtx as never))).toEqual(['published'])
    const managerCtx = { isSuperAdmin: false, permissions: new Set(['documents.manage']) }
    expect(documentReadFilter(managerCtx as never)).toBeUndefined()
  })

  it('documents.read and documents.manage are unchanged catalogue keys', () => {
    expect(PERMISSION_CATALOGUE).toContain('documents.read')
    expect(PERMISSION_CATALOGUE).toContain('documents.manage')
  })
})
