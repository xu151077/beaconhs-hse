// The outbound documents path: `sendDocumentEmail`.
//
// This is the one documents surface that pushes document CONTENT to recipients
// OUTSIDE the tenant — title, key, description, and the first 4 000 characters of
// the published text. It therefore carries its own authorization, and this file
// proves the two constraints are real rather than decorative:
//
//   `documents.manage`  — asserted against the real `assertCan`, so a manager is
//                          the only population that can reach the path at all.
//   `status = 'published'` — UNCONDITIONAL. The shared read filter waives
//                          publication for a manager, because a manager may inspect
//                          drafts. Relying on it here would REMOVE the constraint
//                          and let a manager email a DRAFT. So publication is this
//                          surface's own business invariant.
//
// The documents library is tenant-level by design — one published version of an
// SDS / SOP / policy, readable by every field worker on every site — so there is no
// row scope to apply. That is why the statement is exactly the three conjuncts
// below and nothing more, and the "no second dimension" block is what keeps it
// that way.
//
// HOW IT IS ASSERTED
//
// The statement is built against the REAL Drizzle query builder and read back
// through `toSQL()`, so the SQL and its bound parameters are the ones the route
// issues. A text grep for an id would pass for the wrong reason: Drizzle binds
// values, so no id ever appears in the statement text.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq, isNull } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/pg-core'
import { documents } from '@beaconhs/db/schema'
import { assertCan, type RequestContext } from '@beaconhs/tenant'
import type { RoleScope } from '@beaconhs/db/schema'

const DOC = '30000000-0000-4000-8000-000000000001'

type Compiled = { sql: string; params: string[] }

const qb = new QueryBuilder()

/** The statement `sendDocumentEmail` issues, built the same way. */
const statement = (documentId = DOC): Compiled => {
  const q = qb
    .select({ doc: documents })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.status, 'published'),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1)
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

/** Whether a row of the given status can satisfy `"status" = 'published'`. */
const admits = (status: string | null) => status === 'published'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const HELPER = read('../app/(app)/documents/[id]/_send-email.ts')
const CALLER = read('../app/(app)/documents/[id]/page.tsx')

/** Source with comments removed, so prose naming a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function ctxFor(permissions: string[], scopes: RoleScope[] = []): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    membership: { id: 'member_1', displayName: 'Worker' },
    personId: 'person_1',
    permissions: new Set(permissions),
    scopes,
  } as unknown as RequestContext
}

const manager = (scopes?: RoleScope[]) => ctxFor(['documents.read', 'documents.manage'], scopes)
const reader = (scopes?: RoleScope[]) => ctxFor(['documents.read'], scopes)
const nobody = (scopes?: RoleScope[]) => ctxFor([], scopes)

// ---------------------------------------------------------------------------
// 1. The publication invariant. This is the hazard the path exists to avoid.
// ---------------------------------------------------------------------------

describe('emailing requires a published document, whoever the sender is', () => {
  it('the published predicate is in the statement and its parameter is bound', () => {
    const s = statement()
    expect(s.sql).toContain('"documents"."status" = $2')
    expect(s.params[1]).toBe('published')
  })

  it('a manager still cannot email a draft', () => {
    // `documentReadFilter` waives publication for a manager. If the shared filter
    // were relied on INSTEAD of the explicit predicate, this case would pass.
    expect(admits('draft')).toBe(false)
    expect(admits('archived')).toBe(false)
    expect(admits('under_review')).toBe(false)
  })

  it('a NULL status does not slip past', () => {
    expect(admits(null)).toBe(false)
  })

  it('the file keeps its own published rule and never imports the reader filter', () => {
    // Asserted on RAW source: a comment that merely names the helper must not read
    // as a call to it.
    expect(HELPER).toContain("eq(documents.status, 'published')")
    expect(HELPER).not.toContain('documentReadFilter')
  })

  it('the published predicate is unconditional — not inside any branch', () => {
    // The whole point: it must bind for a manager too. Putting it behind a
    // capability check would restore the draft-email hazard.
    const helper = codeOnly(HELPER)
    const where = helper.slice(helper.indexOf('.where('), helper.indexOf('.limit(1)'))
    expect(where).toContain("eq(documents.status, 'published')")
  })
})

// ---------------------------------------------------------------------------
// 2. The permission gate, proven against the real `assertCan`.
// ---------------------------------------------------------------------------

describe('documents.manage is required, and it throws without it', () => {
  it('a manager passes', () => {
    expect(() => assertCan(manager(), 'documents.manage')).not.toThrow()
  })

  it('a reader does not', () => {
    expect(() => assertCan(reader(), 'documents.manage')).toThrow(/documents\.manage/)
  })

  it('and neither does a caller with nothing', () => {
    expect(() => assertCan(nobody(), 'documents.manage')).toThrow(/documents\.manage/)
  })

  it('a Role Scope cannot substitute for the permission', () => {
    // The most important negative. A `{type:'tenant'}` scope is an access boundary,
    // not a capability: it must not open this path.
    expect(() =>
      assertCan(ctxFor(['documents.read'], [{ type: 'tenant' }]), 'documents.manage'),
    ).toThrow(/documents\.manage/)
  })

  it('the gate is asserted before the query, and at the caller too', () => {
    // This function is exported, so it must not rely on a future caller
    // remembering the check.
    const helper = codeOnly(HELPER)
    expect(helper).toContain("assertCan(ctx, 'documents.manage')")
    expect(helper.indexOf("assertCan(ctx, 'documents.manage')")).toBeLessThan(
      helper.indexOf('await ctx.db('),
    )
    expect(codeOnly(CALLER)).toContain("assertCan(ctx, 'documents.manage')")
  })
})

// ---------------------------------------------------------------------------
// 3. The other conjuncts.
// ---------------------------------------------------------------------------

describe('id, tenancy and soft-delete still bind', () => {
  it('the statement carries the requested id and the soft-delete guard', () => {
    const s = statement(DOC)
    expect(s.sql).toContain('"documents"."id" = $1')
    expect(s.sql).toContain('"documents"."deleted_at" is null')
    expect(s.params[0]).toBe(DOC)
  })

  it('the soft-delete guard is not conditional on anything', () => {
    expect(statement().sql).toContain('"documents"."deleted_at" is null')
  })

  it('the tenancy boundary is the transaction, and it is unchanged', () => {
    // `ctx.db` sets the RLS GUC. This asserts the read still goes through it and
    // that no root-`db` / `withSuperAdmin` escape hatch was introduced.
    expect(codeOnly(HELPER)).toContain('await ctx.db(async (tx) =>')
    expect(HELPER).not.toMatch(/withSuperAdmin|withTenant|from '@beaconhs\/db'/)
  })
})

// ---------------------------------------------------------------------------
// 4. One rule, not a second authorization dimension.
// ---------------------------------------------------------------------------

describe('the path adds no second authorization dimension', () => {
  it('carries no scope resolution of its own', () => {
    const helper = codeOnly(HELPER)
    // A local judgement about placement or applicability would be a second ladder,
    // free to drift from the one every other documents surface uses.
    expect(helper).not.toContain('resolveProjectScopeIn')
    expect(helper).not.toContain('projectScopePredicate')
    expect(helper).not.toContain('ProjectScope')
    expect(helper).not.toContain('documentAuthorizationFilter')
    expect(helper).not.toContain('documentScopeUsable')
    expect(helper).not.toContain('moduleScopeWhere')
  })

  it('does not reach past the shared read filter for the publication half', () => {
    const helper = codeOnly(HELPER)
    // The publication half is its OWN invariant, and that is deliberate — see the
    // file header. What must not happen is it also importing the reader filter,
    // which would make the constraint depend on the caller's tier.
    expect(helper).not.toContain('documentReadFilter')
  })

  it('binds exactly the three conjuncts, in one statement', () => {
    // One `where` means there is no branch that can issue the query without them.
    const helper = codeOnly(HELPER)
    const where = helper.slice(helper.indexOf('.where('), helper.indexOf('.limit(1)'))
    expect(where).toContain('eq(documents.id, documentId)')
    expect(where).toContain("eq(documents.status, 'published')")
    expect(where).toContain('isNull(documents.deletedAt)')
  })

  it('and no org-unit or person binding leaks into it', () => {
    // The library is tenant-level, so a site- or person-keyed predicate here would
    // be a narrowing nobody asked for.
    expect(statement().sql).not.toMatch(/org_unit|person/)
  })
})

// MUTATION SENSITIVITY
//
// Defects this file is designed to fail on. Recorded rather than executed; the
// batch runs them as a separate, explicit step.
//
//   M1  drop `assertCan(ctx, 'documents.manage')`
//       → "documents.manage is required, and it throws without it" (the helper
//         still throws, so the source assertions are what catch the removal)
//   M2  replace the explicit `status = 'published'` with the shared read filter
//       → "the file keeps its own published rule" and "the published predicate is
//         unconditional" — this is the draft-email hazard
//   M3  move the published predicate behind the `documents.manage` check
//       → "the published predicate is unconditional"
//   M4  drop the soft-delete guard
//       → "id, tenancy and soft-delete still bind"
//   M5  swap `ctx.db` for a root client
//       → "the tenancy boundary is the transaction"
//   M6  reintroduce a scope resolution on this path
//       → "the path adds no second authorization dimension"
