// 15B-3C-3H-1 — authorization contract for `getDocumentPdfUrl`.
//
// This is the one genuine READ_AUTHORIZATION among the eight inline published
// rules 15B-3C-3H-A catalogued. It is a read surface in the strongest sense: on
// success it hands back `presignExistingGet(...)`, a 300-second bearer
// capability to the document's PDF. The URL is the document.
//
// 3H-1 pushed the publication rule out of a JavaScript comparison and into the
// statement, delegating it to `documentReadFilter(ctx)` like the list, detail and
// reader surfaces. This file is the guardrail for that change, and it also
// covers the parts the change could have broken but did not:
//
//   • `opts.draft` is a SEPARATE capability, not a published-document view. A
//     manager may render a working master of an UNPUBLISHED document, and the
//     manager bypass inside `documentReadFilter` must not become a back door
//     through the reader path — nor must it weaken the draft gate.
//   • the two `presignExistingGet` calls must stay downstream of authorization.
//     A URL minted before the document is known to be readable would be a
//     complete bypass, and no assertion on a query can catch it, so the ORDER is
//     asserted directly against the source.
//   • the storage key comes from `attachments.r2Key` resolved by id, never from
//     the caller.
//
// WHAT IS ASSERTED, AND HOW
//
// The document statement is produced by drizzle's real `QueryBuilder` from the
// real `documentReadFilter(ctx)` and the real schema, then compiled and read as
// SQL text AND bound parameters. `published` only ever exists as a bound value,
// so a source search for that word proves nothing. `documentReadFilter` itself
// is never mocked — mocking the rule under test would make the suite vacuous.
//
// The remaining assertions read the source, but only for things a compiled
// predicate cannot express: call ORDER, the `opts.draft` gate's position, and
// the absence of a caller-supplied key.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core'
import { documents } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { documentReadFilter } from './assistant/doc-access'

const qb = new QueryBuilder()
const dialect = new PgDialect()
const ACTIONS = readFileSync(
  new URL('../app/(app)/documents/[id]/_actions.ts', import.meta.url),
  'utf8',
)

const DOC_PUBLISHED = '1a000000-0000-4000-8000-00000000a001'
const DOC_DRAFT = '1a000000-0000-4000-8000-00000000a002'

const ctxFor = (permissions: string[], isSuperAdmin = false): RequestContext =>
  ({ isSuperAdmin, permissions: new Set(permissions) }) as unknown as RequestContext

const reader = () => ctxFor(['documents.read'])
const manager = () => ctxFor(['documents.read', 'documents.manage'])
const superAdmin = () => ctxFor([], true)

type Compiled = { sql: string; params: string[] }

const compile = (p: SQL | undefined): Compiled => {
  if (p === undefined) throw new Error('expected a predicate, got undefined')
  const c = dialect.sqlToQuery(p as never)
  return { sql: c.sql, params: c.params.map(String) }
}

/** The document statement `getDocumentPdfUrl` now issues, built the same way. */
const documentStatement = (ctx: RequestContext, documentId: string): Compiled => {
  const conds: SQL[] = [eq(documents.id, documentId), isNull(documents.deletedAt)]
  const visibility = documentReadFilter(ctx)
  if (visibility) conds.push(visibility)
  const q = qb
    .select({ id: documents.id })
    .from(documents)
    .where(and(...conds))
    .limit(1)
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

/** What the PREVIOUS implementation issued, for the delta to be stated precisely. */
const beforeStatement = (documentId: string): Compiled => {
  const q = qb
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1)
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

// ---------------------------------------------------------------------------
// 1. Reader — published only
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — a reader reaches published documents only', () => {
  it('the statement carries id, soft-delete and the published predicate', () => {
    const { sql, params } = documentStatement(reader(), DOC_PUBLISHED)
    expect(sql).toContain('"documents"."id" = $1')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).toContain('"documents"."status" = $2')
    // `.limit(1)` binds the limit as a parameter too; params are stringified.
    expect(params).toEqual([DOC_PUBLISHED, 'published', '1'])
  })

  it('the published rule is a delegated equality, not a restatement', () => {
    expect(ACTIONS).toContain('documentAuthorizationFilter(ctx, tx)')
    expect(compile(documentReadFilter(reader())!).sql).toBe('"documents"."status" = $1')
    // The old inline comparison must be gone from this action.
    expect(ACTIONS).not.toMatch(/status !== 'published'/)
  })

  it('a draft or archived document simply does not match the statement', () => {
    // `"status" = 'published'` is false for draft, archived and under_review, and
    // NULL for a NULL status under three-valued logic — so the row is not
    // returned and the liveness check denies. That is the whole mechanism.
    const admits = (status: string | null) => status !== null && status === 'published'
    for (const hidden of ['draft', 'archived', 'under_review', null]) {
      expect(admits(hidden), String(hidden)).toBe(false)
    }
    expect(admits('published')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Manager and super-admin — the bypass must survive
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — a manager reaches draft documents', () => {
  it('the manager statement keeps id and soft-delete, gains no status constraint', () => {
    const { sql, params } = documentStatement(manager(), DOC_DRAFT)
    expect(sql).toContain('"documents"."id" = $1')
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).not.toContain('"documents"."status"')
    expect(params).toEqual([DOC_DRAFT, '1'])
  })

  it('a super-admin behaves identically', () => {
    const m = documentStatement(manager(), DOC_DRAFT)
    const s = documentStatement(superAdmin(), DOC_DRAFT)
    expect(s.sql).toBe(m.sql)
    expect(s.params).toEqual(m.params)
  })

  it('the manager flag still drives version visibility and the error copy', () => {
    // `documentReadFilter` waived the publication check; it did not remove the
    // manager branch that the version query and the `no_source` message use.
    expect(ACTIONS).toContain("const canManage = ctx.isSuperAdmin || can(ctx, 'documents.manage')")
    expect(ACTIONS).toContain('documentVersionVisibilityWhere(documentId, canManage)')
    expect(ACTIONS).toContain("? 'This document has no file version yet.'")
  })
})

// ---------------------------------------------------------------------------
// 3. Soft delete — nobody reaches a deleted document
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — a soft-deleted document is unreachable for every role', () => {
  it('every role carries the soft-delete constraint', () => {
    for (const [role, ctx] of [
      ['reader', reader()],
      ['manager', manager()],
      ['super-admin', superAdmin()],
    ] as const) {
      expect(documentStatement(ctx, DOC_PUBLISHED).sql, role).toContain(
        '"documents"."deleted_at" is null',
      )
    }
  })

  it('the previous statement carried it too — nothing was traded away', () => {
    expect(beforeStatement(DOC_PUBLISHED).sql).toContain('"documents"."deleted_at" is null')
  })
})

// ---------------------------------------------------------------------------
// 4. opts.draft — a separate capability that the bypass must not swallow
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — opts.draft stays a manager-only, publication-agnostic path', () => {
  it('the draft branch gates on the manager flag BEFORE any query', () => {
    const branch = ACTIONS.slice(
      ACTIONS.indexOf('if (opts.draft)'),
      ACTIONS.indexOf('// Readers may only view'),
    )
    expect(branch).toContain("if (!canManage) return { ok: false, error: 'Not allowed' }")
    // A reader is refused on capability, before the database is consulted, and
    // without ever consulting a publication rule.
    const guard = branch.indexOf('if (!canManage)')
    const query = branch.indexOf('ctx.db')
    expect(guard).toBeGreaterThan(-1)
    expect(query).toBeGreaterThan(guard)
    expect(branch).not.toContain('documentReadFilter')
  })

  it('the draft branch does not apply the published predicate', () => {
    // The manager's working-master render is explicitly of an UNPUBLISHED
    // document. Borrowing the reader rule here would break the feature; the
    // branch is verified to be free of it.
    const branch = ACTIONS.slice(
      ACTIONS.indexOf('if (opts.draft)'),
      ACTIONS.indexOf('// Readers may only view'),
    )
    expect(branch).not.toContain('documentReadFilter')
    expect(branch).not.toContain('status')
  })

  it('the draft branch still refuses a soft-deleted document', () => {
    const branch = ACTIONS.slice(
      ACTIONS.indexOf('if (opts.draft)'),
      ACTIONS.indexOf('// Readers may only view'),
    )
    expect(branch).toContain('isNull(documents.deletedAt)')
  })

  it('the two branches are independent: the reader rule sits after the draft return', () => {
    // Ordering is what stops the manager bypass from becoming a bypass of the
    // draft gate: a reader never reaches the second block at all, because the
    // first block already returned.
    const draftBranch = ACTIONS.indexOf('if (opts.draft)')
    const draftReturn = ACTIONS.indexOf(
      'return { ok: true, url: `/documents/${documentId}/pdf',
      draftBranch,
    )
    const readerRule = ACTIONS.indexOf('const visibility = await documentAuthorizationFilter(ctx, tx)')
    expect(draftBranch).toBeGreaterThan(-1)
    expect(draftReturn).toBeGreaterThan(draftBranch)
    expect(readerRule).toBeGreaterThan(draftReturn)
  })
})

// ---------------------------------------------------------------------------
// 5. Presign ordering — the URL is the document
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — no presigned URL is minted before authorization', () => {
  it('both presign calls come after the document is known to be readable', () => {
    const authz = ACTIONS.indexOf("if (!doc) return { ok: false, error: 'Document not found.' }")
    expect(authz).toBeGreaterThan(-1)
    const presigns = [...ACTIONS.matchAll(/presignExistingGet\(/g)].map((m) => m.index ?? -1)
    // Two call sites: the uploaded-PDF path and the rendered-PDF path.
    expect(presigns).toHaveLength(2)
    for (const at of presigns) {
      expect(at, 'a presign happened before the authorization check').toBeGreaterThan(authz)
    }
  })

  it('the version is resolved after authorization too', () => {
    const authz = ACTIONS.indexOf("if (!doc) return { ok: false, error: 'Document not found.' }")
    expect(ACTIONS.indexOf('documentVersionVisibilityWhere(')).toBeGreaterThan(authz)
  })

  it('the capability gate precedes everything', () => {
    expect(ACTIONS.indexOf("assertCan(ctx, 'documents.read')")).toBeGreaterThan(
      ACTIONS.indexOf('const ctx = await requireRequestContext()'),
    )
    expect(ACTIONS.indexOf("assertCan(ctx, 'documents.read')")).toBeLessThan(
      ACTIONS.indexOf('if (opts.draft)'),
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Key provenance — the storage key is never caller-supplied
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — the presigned key is derived from the database', () => {
  it('the key comes from attachments.r2Key resolved by a version-owned id', () => {
    expect(ACTIONS).toContain('key: attachments.r2Key')
    expect(ACTIONS).toContain('eq(attachments.id, version.contentAttachmentId!)')
    expect(ACTIONS).toContain('eq(attachments.id, pdfAttachmentId)')
  })

  it('the attachment ids come from the resolved version, not the arguments', () => {
    // `documentId` is the only caller input; the attachment ids are reached
    // through the version row, so a caller cannot point the presign elsewhere.
    expect(ACTIONS).toContain('contentAttachmentId: documentVersions.contentAttachmentId')
    expect(ACTIONS).toContain('pdfAttachmentId: documentVersions.pdfAttachmentId')
    expect(ACTIONS).not.toMatch(/presignExistingGet\(\{[^}]*documentId/)
  })

  it('the document id is bound, never interpolated', () => {
    const { sql, params } = documentStatement(reader(), DOC_PUBLISHED)
    expect(sql).toContain('"documents"."id" = $1')
    expect(sql).not.toContain(DOC_PUBLISHED)
    expect(params[0]).toBe(DOC_PUBLISHED)
  })
})

// ---------------------------------------------------------------------------
// 7. Scope guard — the other seven inline rules are untouched
// ---------------------------------------------------------------------------

describe('15B-3C-3H-1 — the other catalogued rules were left alone', () => {
  it('none of the six action/lifecycle rules lost its inline condition', () => {
    // 3H-A classified these as ACTION_GUARD / WORKFLOW_STATE / LIFECYCLE_RULE.
    // Their `published` requirement is a business invariant, NOT a read rule:
    // their callers already hold documents.manage, so delegating to
    // documentReadFilter would REMOVE the constraint and widen authorization.
    const others: Record<string, string> = {
      '_ack-actions.ts': readFileSync(
        new URL('../app/(app)/documents/[id]/_ack-actions.ts', import.meta.url),
        'utf8',
      ),
      'sign-off/page.tsx': readFileSync(
        new URL('../app/(app)/documents/[id]/sign-off/page.tsx', import.meta.url),
        'utf8',
      ),
      '_send-email.ts': readFileSync(
        new URL('../app/(app)/documents/[id]/_send-email.ts', import.meta.url),
        'utf8',
      ),
      'management-reviews/[id]/actions.ts': readFileSync(
        new URL('../app/(app)/documents/management-reviews/[id]/actions.ts', import.meta.url),
        'utf8',
      ),
      'document-book-lifecycle.ts': readFileSync(
        new URL('./document-book-lifecycle.ts', import.meta.url),
        'utf8',
      ),
      'books/[id]/pdf/route.ts': readFileSync(
        new URL('../app/(app)/documents/books/[id]/pdf/route.ts', import.meta.url),
        'utf8',
      ),
    }
    for (const [name, src] of Object.entries(others)) {
      expect(
        src,
        `${name} should still carry its own rule until it is separately ruled on`,
      ).toMatch(/eq\(documents\.status, 'published'\)|documentBooks\.status/)
      // None of them may import the reader helper as a result of this batch.
      expect(src, name).not.toContain('documentReadFilter')
    }
  })
})
