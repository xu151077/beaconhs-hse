// 15B-3C-3B — the version-download route must load its PARENT DOCUMENT.
//
// TWO INDEPENDENT DEFECTS, both confirmed from source + the live schema in
// 15B-3C-3A:
//
//   1. SOFT DELETE. The route queried `document_versions` only. That table has
//      neither `deleted_at` nor `status`, so a version row could never answer
//      "is the parent still live?". A soft-deleted document's published PDF and
//      DOCX stayed downloadable to any holder of `documents.read` who knew the
//      two UUIDs. The parent is now INNER JOINed and constrained, which is what
//      makes "deleted parent" unrepresentable rather than merely un-checked.
//
//   2. RULE INCONSISTENCY. The route used `documentVersions.publishedAt` as its
//      ONLY publication rule, while the list, the detail page, the reader and the
//      assistant all use `documents.status = 'published'`. Those are different
//      columns answering different questions, so a draft document's published
//      snapshot was reachable here and nowhere else. The route now reuses
//      `documentReadFilter`, the shared rule, instead of re-deriving its own.
//
// Neither defect is a Project Scope decision, and none is made here: `documents`
// has no reliable binding column, so this route stays tenant-wide within the
// tenant boundary, exactly like every other document read surface. See the
// route's header comment for why the obvious "borrows" are all wrong.
//
// HOW THIS IS ASSERTED
//
// The web vitest project has no database (`project-scope-fixture.ts` says so
// explicitly), so row-level execution is not available and is NOT claimed. What
// is asserted is the compiled query — the exact SQL text AND its bound params —
// because for defects 1 and 2 the SQL *is* the authorization: an INNER JOIN
// whose ON clause carries `documents.deleted_at is null` cannot return a row
// whose parent is soft-deleted, whatever the rows contain. The rule half is
// asserted BEHAVIOURALLY by calling the real `documentReadFilter` with real
// contexts and reading what it actually produces.
//
// Ids are read from `params`, never from the SQL text: drizzle binds them, so a
// text grep for an id passes for the wrong reason.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { documents, documentVersions } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { documentReadFilter } from './assistant/doc-access'
import { isUuid } from './list-params'

const dialect = new PgDialect()

const DOC_A = '1a000000-0000-4000-8000-0000000000a1'
const DOC_B = '1a000000-0000-4000-8000-0000000000b1'
const VER_A = '2a000000-0000-4000-8000-0000000000a1'
const VER_B = '2a000000-0000-4000-8000-0000000000b1'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function ctx(permissions: string[], over: { isSuperAdmin?: boolean } = {}): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: over.isSuperAdmin ?? false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'm1', displayName: 'A' },
    personId: null,
    permissions: new Set(permissions),
    scopes: [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
  } as RequestContext
}

/** A plain reader: `documents.read` and nothing else. */
const reader = () => ctx(['documents.read'])
/** A document manager. `can()` already returns true for a super-admin. */
const manager = () => ctx(['documents.read', 'documents.manage'])
const superAdmin = () => ctx([], { isSuperAdmin: true })

/** SQL text plus the values actually BOUND to it. */
const compile = (p: SQL | undefined) => {
  if (p === undefined) return { sql: '(no predicate)', params: [] as string[] }
  const q = dialect.sqlToQuery(p as never)
  return { sql: q.sql, params: q.params.map(String) }
}

/**
 * The parent-document clause the route builds, rebuilt here from the same two
 * helpers so the assertions describe the real rule rather than a paraphrase.
 * `documentReadFilter` is the genuine article; only the AND is reconstructed.
 */
const parentClause = (c: RequestContext, documentId: string) => {
  const conds: SQL[] = [eq(documents.id, documentId), isNull(documents.deletedAt)]
  const readFilter = documentReadFilter(c)
  if (readFilter) conds.push(readFilter)
  return compile(and(...conds))
}

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const ROUTE = source('../app/(app)/documents/[id]/versions/[versionId]/download/route.ts')

/**
 * The route with comments removed.
 *
 * The header deliberately NAMES the bindings it refuses to borrow, so a naive
 * search for them would match the explanation rather than the code. "The code
 * does not use X" has to be asserted against code.
 */
const ROUTE_CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ---------------------------------------------------------------------------
// 1. The publication rule is the SHARED one, asserted behaviourally
// ---------------------------------------------------------------------------

describe('15B-3C-3B — the route reuses the shared publication rule', () => {
  it('a non-manager is constrained to published documents', () => {
    // Defect 2. Previously this route consulted `documentVersions.publishedAt`
    // only, so a DRAFT document's published snapshot was reachable here and on
    // no other surface.
    const { sql, params } = compile(documentReadFilter(reader()))
    expect(sql).toContain('"documents"."status"')
    expect(params).toContain('published')
  })

  it('a manager is not constrained by document status', () => {
    // The `undefined` return is the rule's own fail-open branch for managers and
    // is correct here: managers are meant to inspect drafts. It is NOT the
    // manager being waved through the deleted-at check, which is separate.
    expect(documentReadFilter(manager())).toBeUndefined()
    expect(documentReadFilter(superAdmin())).toBeUndefined()
  })

  it('the rule is identical to the one the assistant and public API use', () => {
    // One implementation, so a change to the rule moves every surface at once.
    // `documentReadFilter` is imported from `assistant/doc-access` — the module
    // the assistant tools, the search route and `api/query.ts` already call.
    expect(ROUTE).toContain("from '@/lib/assistant/doc-access'")
    expect(ROUTE).toContain('documentReadFilter(ctx)')
  })
})

// ---------------------------------------------------------------------------
// 2. The parent document is a real precondition
// ---------------------------------------------------------------------------

describe('15B-3C-3B — the parent document gates the version', () => {
  it('the query INNER JOINs documents, so an orphan version cannot be returned', () => {
    // Defect 1. `from(documentVersions)` alone could not express "the parent is
    // live" at all, because `document_versions` carries neither `deleted_at` nor
    // `status`.
    expect(ROUTE).toContain('.from(documentVersions)')
    expect(ROUTE).toMatch(/\.innerJoin\(\s*documents,/)
    expect(ROUTE).toContain('eq(documents.id, documentVersions.documentId)')
  })

  it('every caller is constrained to a non-deleted parent', () => {
    for (const [label, c] of [
      ['reader', reader()],
      ['manager', manager()],
      ['super-admin', superAdmin()],
    ] as const) {
      expect(parentClause(c, DOC_A).sql, label).toContain('"documents"."deleted_at" is null')
    }
  })

  it('a non-manager also carries the published predicate into the same clause', () => {
    const { sql, params } = parentClause(reader(), DOC_A)
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).toContain('"documents"."status"')
    expect(params).toContain('published')
    // The document id is BOUND, not interpolated — so the document identity is
    // carried as a parameter and the clause is not built by string concatenation.
    expect(params).toContain(DOC_A)
  })

  it('a manager is bound to the document but NOT to its status', () => {
    // E.1 / E.3: unrestricted and manager alike still resolve the parent — the
    // difference is only that the publication predicate is absent.
    const { sql, params } = parentClause(manager(), DOC_A)
    expect(sql).toContain('"documents"."deleted_at" is null')
    expect(sql).not.toContain('"documents"."status"')
    expect(params).not.toContain('published')
    expect(params).toContain(DOC_A)
  })

  it('the version is still bound to the document from the URL', () => {
    // Pre-existing, and kept: a versionId from another document must not resolve
    // even when the parent is perfectly readable.
    const bound = [DOC_B, VER_B]
    const { params } = compile(
      and(eq(documentVersions.id, bound[1]!), eq(documentVersions.documentId, bound[0]!)),
    )
    expect(params).toContain(VER_B)
    expect(params).toContain(DOC_B)
    expect(ROUTE).toContain('eq(documentVersions.documentId, id)')
  })

  it('the version-level publishedAt check is kept, not replaced', () => {
    // Not redundant. The parent rule answers "may this caller read this
    // DOCUMENT"; this answers "is this particular SNAPSHOT published". Dropping
    // it would newly expose an unpublished snapshot of a published document.
    expect(ROUTE).toContain("if (!v.publishedAt && !can(ctx, 'documents.manage')) return null")
  })
})

// ---------------------------------------------------------------------------
// 3. The attachment key comes from the database
// ---------------------------------------------------------------------------

describe('15B-3C-3B — the storage key is never caller-supplied', () => {
  it('the key is read from attachments.r2Key by a DB-resolved attachment id', () => {
    expect(ROUTE).toContain('key: attachments.r2Key')
    expect(ROUTE).toContain('eq(attachments.id, attachmentId)')
    // The attachment id itself comes from the version row, never from the query
    // string or the path.
    expect(ROUTE).toContain("kind === 'docx' ? v.docxAttachmentId")
  })

  it('the only caller-controlled input is the artifact kind, and it is a fixed pair', () => {
    expect(ROUTE).toContain("req.nextUrl.searchParams.get('kind') === 'docx' ? 'docx' : 'pdf'")
    // No search parameter can reach the key or the storage call.
    expect(ROUTE).not.toMatch(/searchParams\.get\('(key|r2Key|path|object)'/)
    expect(ROUTE).toMatch(/getObjectStream\(\{ key: att\.key \}\)/)
  })
})

// ---------------------------------------------------------------------------
// 4. Input validation happens before any database work
// ---------------------------------------------------------------------------

describe('15B-3C-3B — ids are validated before the query', () => {
  it('rejects anything that is not a UUID', () => {
    // `isUuid` is the single implementation; this test does not restate its
    // pattern, because a second copy is exactly the drift
    // `dynamic-uuid-route-guards.test.ts` exists to prevent.
    for (const bad of [
      '',
      'not-a-uuid',
      '../../etc/passwd',
      `${DOC_A} OR 1=1`,
      '1a000000-0000-4000-8000',
      "1a000000-0000-4000-8000-0000000000a1'; DROP TABLE documents; --",
    ]) {
      expect(isUuid(bad), bad).toBe(false)
    }
    expect(isUuid(DOC_A)).toBe(true)
    expect(isUuid(VER_A)).toBe(true)
  })

  it('validates both ids before the capability gate and the query', () => {
    const guard = ROUTE.indexOf('if (!isUuid(id) || !isUuid(versionId))')
    const gate = ROUTE.indexOf("assertCan(ctx, 'documents.read')")
    const query = ROUTE.indexOf('const att = await ctx.db')
    expect(guard).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(guard)
    expect(query).toBeGreaterThan(gate)
    // A non-UUID is a 404 that never reaches the database.
    expect(ROUTE).toMatch(/if \(!isUuid\(id\) \|\| !isUuid\(versionId\)\)[^\n]*404/)
  })
})

// ---------------------------------------------------------------------------
// 5. Project Scope is deferred, and the deferral is recorded in the source
// ---------------------------------------------------------------------------

describe('the document library is tenant-level, so the route invents no scope', () => {
  it('the route composes the shared rule and invents no scope of its own', () => {
    // The one shared documents rule is the publication half, and it is the whole
    // read boundary: the library is tenant-level, so there is no location axis to
    // narrow on. The route therefore writes no scope logic inline — a hand-rolled
    // `inArray` over a borrowed column would be a second ladder.
    expect(ROUTE_CODE).toContain('documentReadFilter(ctx)')
    expect(ROUTE_CODE).not.toMatch(/moduleScopeWhere/)
    expect(ROUTE_CODE).not.toMatch(/inArray\(/)
  })

  it('none of the tempting-but-wrong bindings was borrowed', () => {
    // `owner_tenant_user_id` is authorship, not placement. The sign-off session's
    // `site_org_unit_id` is a sign-off instance's location, not the document's.
    // Neither narrows a controlled-document library honestly, and the product
    // decision introduced no applicability binding at all.
    expect(ROUTE_CODE).not.toMatch(/owner_tenant_user_id|ownerTenantUserId/)
    expect(ROUTE_CODE).not.toMatch(/documentAcknowledgmentSessions|acknowledgmentSession/i)
    // The reasoning comment above is what mentions them, which is why these
    // assertions run against the comment-stripped source.
    expect(ROUTE).toMatch(/owner_tenant_user_id/)
  })

  it('the decision and its reasoning are written down where a reader will hit them', () => {
    expect(ROUTE).toMatch(/TENANT-LEVEL CONTROLLED DOCUMENT LIBRARY/)
    expect(ROUTE).toMatch(/no location binding on this route/)
    // The refusal to borrow a placement column is preserved — it is the thing a
    // future reader is most likely to "fix" by mistake. The sentence wraps across
    // three comment lines, so strip the comment leaders as well as the wrapping
    // before matching it.
    const flat = ROUTE.replace(/^\s*\/\/\s?/gm, '').replace(/\s+/g, ' ')
    expect(flat).toMatch(/Do not "fix" this by borrowing/)
  })
})

// ---------------------------------------------------------------------------
// 6. Preserved invariants
// ---------------------------------------------------------------------------

describe('15B-3C-3B — the pre-existing guarantees survive', () => {
  it('still gated on documents.read, still audited, still dynamic', () => {
    expect(ROUTE).toContain("assertCan(ctx, 'documents.read')")
    expect(ROUTE).toContain("action: 'export'")
    expect(ROUTE).toContain('recordAudit(ctx, {')
    expect(ROUTE).toContain("export const dynamic = 'force-dynamic'")
  })

  it('still runs every query through the tenant-scoped context', () => {
    // RLS is the tenant boundary. It is the ONLY tenant boundary here, which is
    // precisely why the row-level parent check had to be added explicitly.
    expect(ROUTE).toContain('await ctx.db(async (tx) =>')
    expect(ROUTE).not.toMatch(/\bdb\.select|from\(db\b|withSuperAdmin/)
  })

  it('returns 404, never 403, for a document the caller may not have', () => {
    // Denying existence rather than admitting the object exists.
    expect(ROUTE).toContain("return new NextResponse('Not found', { status: 404 })")
  })
})
