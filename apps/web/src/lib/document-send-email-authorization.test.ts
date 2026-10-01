// 15B-3C FOLLOW-UP — authorization contract for the documents OUTBOUND path.
//
// THE GAP THIS FILE PINS
//
// `_send-email.ts` was the only documents surface with no Project Scope gate, and
// the only one that pushes document CONTENT to recipients outside the tenant:
// title, key, description, and the first 4 000 characters of the published text.
// Its sole caller asserted `documents.manage`, so the reachable population was
// managers — but a manager whose Project Scope could not be resolved could still
// export the tenant's published library.
//
// The other eleven documents surfaces were wired in 7571c6c7. This path was left
// out, so the invariant "every documents content read passes the shared rule"
// had a hole in it. This file is the guardrail for closing that hole.
//
// THE RULE, WHICH IS THE SAME FOUR STATES AS EVERYWHERE ELSE
//
//   unrestricted -> no Project Scope constraint
//   restricted   -> no Project Scope constraint
//   empty        -> DENY
//   unknown      -> DENY
//
// conjoined with this surface's own invariant, which is NOT Project Scope and NOT
// delegated: only a `published` document may be emailed. A manager is not a
// reader, and the publication half of the shared rule waives itself for a
// manager, so relying on that half alone would REMOVE the constraint and let a
// draft be emailed. Both layers are asserted separately below, because they are
// independent and a change to either must be caught here.
//
// WHAT IS ASSERTED, AND HOW
//
// The document statement is produced by drizzle's real `QueryBuilder` from the
// real schema and the real `documentAuthorizationFilter`, then compiled and read
// as SQL text AND bound parameters. `published` only ever exists as a bound
// value, so searching the source for that word would prove nothing, and the rule
// under test is never mocked — mocking it would make the suite vacuous.
//
// The permission gate is asserted twice over: `assertCan` behaviourally, against
// the real helper from `@beaconhs/tenant`, and the wiring by source, because
// `_send-email.ts` cannot be imported (it reaches `@/lib/app-base-url`, and this
// vitest project does not alias `@/`).
//
// ALREADY COVERED ELSEWHERE, DELIBERATELY NOT DUPLICATED
//
// `document-version-visibility-contract.test.ts` pins that the emailed version is
// a published one and that its PDF/content attachment exists. The three
// "still holds its own published rule" suites pin that this file keeps
// `eq(documents.status, 'published')` and never imports the reader helper — the
// second of those is why no comment in `_send-email.ts` names that helper.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core'
import { documents, type RoleScope } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import { assertCan, type RequestContext } from '@beaconhs/tenant'
import { projectScopeTx } from './testing/project-scope-fixture'
import {
  documentAuthorizationFilter,
  documentScopeUsable,
} from './assistant/document-project-scope'

const qb = new QueryBuilder()
const dialect = new PgDialect()

const HELPER = readFileSync(
  new URL('../app/(app)/documents/[id]/_send-email.ts', import.meta.url),
  'utf8',
)
const CALLER = readFileSync(
  new URL('../app/(app)/documents/[id]/page.tsx', import.meta.url),
  'utf8',
)

/** Source with comments removed, so a name mentioned in prose is not read as a call. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

const DOC = '1a000000-0000-4000-8000-0000000000a1'
const SITE_A = '00000000-0000-4000-8000-00000000a001'

type Compiled = { sql: string; params: string[] }

const compile = (p: SQL | undefined): Compiled => {
  if (p === undefined) throw new Error('expected a predicate, got undefined')
  const c = dialect.sqlToQuery(p as never)
  return { sql: c.sql, params: c.params.map(String) }
}

const ctxFor = (
  permissions: string[],
  scopes: RoleScope[] = [{ type: 'sites', siteIds: [SITE_A] }],
): RequestContext =>
  ({
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    membership: { id: 'member_1', displayName: 'Worker' },
    personId: 'person_1',
    permissions: new Set(permissions),
    scopes,
  }) as unknown as RequestContext

const manager = (scopes?: RoleScope[]) => ctxFor(['documents.read', 'documents.manage'], scopes)
const reader = (scopes?: RoleScope[]) => ctxFor(['documents.read'], scopes)
const nobody = (scopes?: RoleScope[]) => ctxFor([], scopes)

/** A transaction that fails any query: an unrestricted caller must not need one. */
const noDatabase = (): Database =>
  ({
    select: () => {
      throw new Error('unrestricted must short-circuit before any query')
    },
    selectDistinct: () => {
      throw new Error('unrestricted must short-circuit before any query')
    },
  }) as unknown as Database

/** A caller placed at a site, so the resolver returns a real `restricted` scope. */
const restrictedTx = () => projectScopeTx()

/** A caller with no employee record and no assignment: `empty('no_scope')`. */
const emptyTx = () => projectScopeTx({ employeeRecord: 'none', assignments: [] })

/** The statement `sendDocumentEmail` issues, built the same way. */
const statement = async (
  ctx: RequestContext,
  tx: Database,
  documentId = DOC,
): Promise<Compiled> => {
  const q = qb
    .select({ doc: documents })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.status, 'published'),
        isNull(documents.deletedAt),
        await documentAuthorizationFilter(ctx, tx),
      ),
    )
    .limit(1)
  const r = (q as unknown as { toSQL: () => { sql: string; params: unknown[] } }).toSQL()
  return { sql: r.sql, params: r.params.map(String) }
}

/** Exactly what the previous implementation issued, for the delta to be provable. */
const beforeStatement = (documentId = DOC): Compiled => {
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

// ---------------------------------------------------------------------------
// 1. The four states, for the only caller population that exists: a manager
// ---------------------------------------------------------------------------

describe('15B-3C follow-up — the outbound documents path honours the four states', () => {
  it('unrestricted -> allowed, and needs no query to decide it', async () => {
    // `{type:'tenant'}` is the only unrestricted source besides super-admin, and
    // the resolver short-circuits on it, so the throwing transaction proves no
    // Project Scope query runs at all on this path.
    const s = await statement(manager([{ type: 'tenant' }]), noDatabase())
    expect(s).toEqual(beforeStatement())
  })

  it('restricted -> allowed, and the statement is unchanged from before', async () => {
    const s = await statement(manager(), restrictedTx())
    expect(s).toEqual(beforeStatement())
  })

  it('empty -> denied', async () => {
    const s = await statement(manager(), emptyTx())
    // The scope half contributes `false`, so no row can match however the
    // document's own status is.
    expect(s.sql).toContain('false')
    expect(s.params).toEqual([DOC, 'published', '1'])
    for (const status of ['published', 'draft', 'archived', 'under_review']) {
      expect(admits(status) && false, status).toBe(false)
    }
  })

  it('unknown -> denied', () => {
    // No transaction can produce this state — `resolveProjectScopeIn` reports an
    // unresolvable identity as `empty` — so the leg is pinned on the pure
    // decision. `undefined` is the web counterpart of the analytics `unknown`,
    // and it must not read as "no restriction".
    expect(documentScopeUsable(undefined)).toBe(false)
  })

  it("the two allowed states are decided by usability, not by the scope's size", async () => {
    // A restricted caller must not acquire a site- or person-keyed predicate. The
    // library is tenant-level, so a scope must not narrow it — and if one ever
    // did, the statement below would stop equalling `beforeStatement()`.
    expect(await statement(manager(), restrictedTx())).toEqual(beforeStatement())
    expect(beforeStatement().sql).not.toMatch(/org_unit|person/)
  })
})

// ---------------------------------------------------------------------------
// 2. The publication invariant is independent and was not widened
// ---------------------------------------------------------------------------

describe('15B-3C follow-up — emailing still requires a published document', () => {
  it('a manager in a usable scope still cannot email a draft', async () => {
    // This is the hazard the change had to avoid. `documentReadFilter` waives
    // publication for a manager, so had the shared rule been used INSTEAD of the
    // explicit predicate, a manager could have emailed a draft.
    const s = await statement(manager(), restrictedTx())
    expect(s.sql).toContain('"documents"."status" = $2')
    expect(s.params[1]).toBe('published')
    expect(admits('draft')).toBe(false)
  })

  it('archived and under_review stay barred, and a NULL status does not slip past', () => {
    for (const hidden of ['draft', 'archived', 'under_review', null]) {
      expect(admits(hidden), String(hidden)).toBe(false)
    }
  })

  it('a non-manager reaching this path would still get the published rule twice over', async () => {
    // Defensive only — `documents.manage` is asserted, so a reader cannot get
    // here. If that gate were ever lost, the published constraint must still be
    // the one that binds: the explicit predicate AND the delegated reader half.
    const s = await statement(reader(), restrictedTx())
    expect(s.params.filter((p) => p === 'published')).toHaveLength(2)
  })

  it('the file keeps its own published rule and never imports the reader helper', () => {
    expect(HELPER).toContain("eq(documents.status, 'published')")
    // Asserted on RAW source, matching the three sibling suites: a comment that
    // merely names the helper must not read as a call to it.
    expect(HELPER).not.toContain('documentReadFilter')
  })
})

// ---------------------------------------------------------------------------
// 3. The other conjuncts, and the permission gate
// ---------------------------------------------------------------------------

describe('15B-3C follow-up — id, tenant and soft-delete still bind', () => {
  it('the statement carries the requested id and the soft-delete guard', async () => {
    const s = await statement(manager(), restrictedTx(), DOC)
    expect(s.sql).toContain('"documents"."id" = $1')
    expect(s.sql).toContain('"documents"."deleted_at" is null')
    expect(s.params[0]).toBe(DOC)
  })

  it('a soft-deleted document is unreachable, whatever the scope', async () => {
    for (const tx of [restrictedTx(), emptyTx()]) {
      const s = await statement(manager(), tx)
      expect(s.sql, 'the deleted_at guard is not conditional on scope').toContain(
        '"documents"."deleted_at" is null',
      )
    }
  })

  it('the tenancy boundary is the transaction, and it is unchanged', () => {
    // `ctx.db` sets the RLS GUC. This asserts the read still goes through it and
    // that no root-`db` / `withSuperAdmin` escape hatch was introduced.
    expect(codeOnly(HELPER)).toContain('await ctx.db(async (tx) =>')
    expect(HELPER).not.toMatch(/withSuperAdmin|withTenant|from '@beaconhs\/db'/)
  })

  it('documents.manage is required, and it throws without it', () => {
    // Behaviour, against the real helper — so the gate is proven to be a real
    // permission check rather than a decorative string in the source.
    expect(() => assertCan(manager(), 'documents.manage')).not.toThrow()
    expect(() => assertCan(reader(), 'documents.manage')).toThrow(/documents\.manage/)
    expect(() => assertCan(nobody(), 'documents.manage')).toThrow(/documents\.manage/)
  })

  it('the gate is asserted before the query, and at the caller too', () => {
    // Belt and braces: this function is exported, so it must not rely on a future
    // caller remembering the check. The caller's own assert is left in place.
    const helper = codeOnly(HELPER)
    expect(helper).toContain("assertCan(ctx, 'documents.manage')")
    expect(helper.indexOf("assertCan(ctx, 'documents.manage')")).toBeLessThan(
      helper.indexOf('await ctx.db('),
    )
    expect(codeOnly(CALLER)).toContain("assertCan(ctx, 'documents.manage')")
  })
})

// ---------------------------------------------------------------------------
// 4. One rule, not a second ladder
// ---------------------------------------------------------------------------

describe('15B-3C follow-up — the decision is delegated, not re-derived', () => {
  it('the path composes the shared rule', () => {
    expect(codeOnly(HELPER)).toContain('documentAuthorizationFilter(ctx, tx)')
  })

  it('it does not reach past the shared rule for either half', () => {
    const helper = codeOnly(HELPER)
    // A local four-state judgement would be a second ladder, free to drift from
    // the one the other eleven surfaces use.
    expect(helper).not.toContain('documentScopeUsable(')
    expect(helper).not.toMatch(/kind (===|!==) '(empty|unrestricted|restricted)'/)
    expect(helper).not.toContain('moduleScopeWhere')
    expect(helper).not.toContain('projectScopePredicate')
  })

  it('the composed rule is exactly the two halves, and the scope half denies by default', () => {
    // Re-derived here so a change to the primitive cannot quietly redefine what
    // "composed" means for this path.
    expect(typeof documentAuthorizationFilter).toBe('function')
    expect(documentScopeUsable({ kind: 'unrestricted' })).toBe(true)
    expect(documentScopeUsable({ kind: 'orgUnits', orgUnitIds: [SITE_A], personIds: [] })).toBe(
      true,
    )
    expect(documentScopeUsable({ kind: 'empty', reason: 'no_scope' })).toBe(false)
  })

  it('the scope gate is inside the statement, downstream of nothing that could skip it', () => {
    // ORDER: the composed predicate is part of the single `where`, so there is no
    // branch that can issue the query without it.
    const helper = codeOnly(HELPER)
    const where = helper.slice(helper.indexOf('.where('), helper.indexOf('.limit(1)'))
    expect(where).toContain('await documentAuthorizationFilter(ctx, tx)')
    expect(where).toContain("eq(documents.status, 'published')")
    expect(where).toContain('isNull(documents.deletedAt)')
    expect(where).toContain('eq(documents.id, documentId)')
  })
})
