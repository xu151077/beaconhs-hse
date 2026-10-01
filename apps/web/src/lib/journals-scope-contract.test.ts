// 15B-3C-4B — journals must not be a wider read surface than every other record
// module, and the four properties that make journals DIFFERENT must survive the
// alignment.
//
// THE DEFECT
//
// `journalScopeWhere` carried the pre-15B-2 model:
//
//     if (journalCanReadAll(ctx)) return undefined          // ← no row filter
//     …
//     if (can(ctx, 'journals.read.site')) { /* bare ctx.scopes ids */ }
//     return ownWhere ?? sql`false`
//
// Since 15B-2 a Project Scope is a dimension ORTHOGONAL to the read tier: the
// canonical ladder applies it even at tier `all` (`lib/visibility.ts`, `if (tier
// === 'all') return scopeCond`). A `safety_manager` — the built-in role holding
// `journals.read.all` — assigned `{type:'sites'}` therefore read EVERY journal in
// the tenant, from all nine call sites, while analytics had already narrowed the
// same table (`packages/analytics/src/server/scope.ts` declares `siteCols` for
// `journal_`) and every module list, export and dashboard had.
//
// WHAT IS ASSERTED, AND HOW — read this before trusting a green run
//
// This file uses two different kinds of proof, and does not pretend they are
// equivalent:
//
//   1. BEHAVIOURAL (real SQL + real bound parameters). The `.all` branch is a
//      three-line pipeline: `resolveProjectScopeIn` → `projectScopePredicate`.
//      Both are importable from `lib/`, so the pipeline is executed for real and
//      the compiled SQL and its parameters are read back. That is what proves a
//      restricted caller is narrowed, and to WHICH sites. Cases A, B, E, M.
//
//   2. STRUCTURAL (isolated function/branch bodies). `journalScopeWhere` lives
//      under `app/(app)/` and cannot be imported: `apps/web` has NO vitest config,
//      so the `@/*` tsconfig path is not aliased, and `_lib.ts` imports three
//      `@/lib/…` modules. Every contract test in this repo reads those sources
//      with `readFileSync` for the same reason. To keep that from degrading into
//      a grep, each assertion below is scoped to an ISOLATED BODY — the exact
//      brace-matched text of one `if` branch or one function — and asserts on
//      that body's returns, its argument lists and its column bindings. Cases
//      C, D, F, G, H, I, J, K, L.
//
// The limitation is stated plainly: cases 1 and 2 together prove that
// `_lib.ts` hands the canonical helpers exactly the arguments the behaviourally
// tested replica uses, and that the helper pipeline is correct. Neither alone
// proves the composed function at runtime, because it cannot be called here. The
// structural assertions are written to be MUTATION-SENSITIVE for exactly that
// reason — see the "MUTATIONS" block at the end.
//
// NOT ASSERTED HERE, ON PURPOSE
//
// `.site` and `.self` are still UNSCOPED — a `journals.read.site` reviewer reads
// bare `ctx.scopes` ids with no org-tree walk and no personnel-placement
// expansion, so they under-expose relative to the canonical ladder. That is a
// correctness gap, not a security one, and closing it means binding the own-entry
// leg to the scope, which would break the three journals-specific properties
// below. It is a product decision, deliberately NOT taken in 4B, and the tests
// pin the CURRENT behaviour so the decision cannot be made by accident.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { journalEntries, type RoleScope } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { resolveProjectScopeIn } from './project-scope'
import { isAlwaysFalse, projectScopePredicate } from './project-scope-predicate'
import { projectScopeTx } from './testing/project-scope-fixture'

const dialect = new PgDialect()
const tx = projectScopeTx()

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const JOURNALS_LIB = read('../app/(app)/journals/_lib.ts')
const JOURNALS_DATA = read('../app/(app)/journals/_data.ts')
const JOURNALS_ACTIONS = read('../app/(app)/journals/_actions.ts')
const JOURNALS_EMAIL = read('../app/(app)/journals/_send-email.ts')
const JOURNALS_TAG_PICKER = read('../app/(app)/journals/records/_tag-picker-actions.ts')
const JOURNALS_PDF = read('../app/(app)/journals/[id]/pdf/route.ts')
const JOURNALS_POLICY = read('../app/(app)/journals/_mutation-policy.ts')
const FEED = read('../app/(app)/feed/_data.ts')

/** Source with comments removed, so prose that names a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

/**
 * The brace-matched body of a declaration or `if` branch, found by its opening
 * line. Scoping every structural assertion to one of these is what stops these
 * tests from being a grep: a mutation elsewhere in the file cannot satisfy or
 * break them, and prose in a neighbouring comment cannot.
 */
function bodyOf(src: string, header: RegExp): string {
  // Comments are stripped FIRST, and the brace walk runs on that same text, so
  // the offsets and the slice can never disagree. A header named only in prose
  // therefore cannot be matched, and prose inside a body cannot satisfy an
  // assertion.
  const code = codeOnly(src)
  const m = code.match(header)
  if (!m) throw new Error(`no source matched ${header}`)
  // The header pattern identifies the construct; the body starts at the next
  // `{` that is not inside a parameter list or a return-type annotation — a
  // signature like `: Promise<ActionOk<{ sent: number }> | ActionErr>` contains
  // a brace of its own, so paren and angle depth are both tracked. The walk
  // starts AT the match so the header's own `(` is counted and the parameter
  // list's `)` balances it.
  let from = -1
  let parens = 0
  let angles = 0
  const start = m.index ?? 0
  for (let i = start; i < code.length; i++) {
    const c = code[i]
    if (c === undefined) break
    if (c === '(') parens++
    else if (c === ')') parens--
    else if (c === '<') angles++
    else if (c === '>') angles--
    else if (c === '{' && parens === 0 && angles === 0) {
      from = i
      break
    }
  }
  if (from < 0 || code[from] !== '{') throw new Error(`${header} is not followed by a body brace`)
  let depth = 0
  for (let j = from; j < code.length; j++) {
    const c = code[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      // The INNER text only: the enclosing braces would otherwise be captured by
      // a trailing `return …` match and by substring assertions alike.
      if (depth === 0) return code.slice(from + 1, j)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

/**
 * Every `return` in a body, in order, normalised.
 *
 * A return's extent is "up to the next `return` or `;`", not "up to the next
 * `;`": consecutive one-line returns have no semicolons, and a multi-line return
 * such as the adapter call spans several. Both shapes occur in this file's
 * subjects, so the extent has to cover them without merging them.
 */
const returnsOf = (body: string): string[] => {
  const out: string[] = []
  const re = /return\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const rest = body.slice(m.index)
    const stop = rest.slice(1).search(/return\b|;/)
    const end = stop === -1 ? rest.length : stop + 1
    out.push(rest.slice(0, end).replace(/\s+/g, ' ').trim())
    re.lastIndex = m.index + end
  }
  return out
}

const compile = (p: unknown) => {
  const q = dialect.sqlToQuery(p as never)
  return { sql: q.sql, params: q.params.map(String) }
}

function context(permissions: string[], scopes: RoleScope[]): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    timezone: 'America/Toronto',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member_1', displayName: 'Safety Manager' },
    personId: 'person_1',
    permissions: new Set(permissions),
    scopes,
    db: async () => {
      throw new Error('visibility predicates must not hit the database here')
    },
  } as unknown as RequestContext
}

/** A `safety_manager`: the built-in role that actually holds `journals.read.all`. */
const scopedSafetyManager = () =>
  context(['journals.read.all'], [{ type: 'sites', siteIds: ['site_1'] }])

/**
 * The `.all` branch of `journalScopeWhere`, executed for real.
 *
 * This mirrors the branch's three statements EXACTLY — same resolver, same
 * adapter, same two columns — so the SQL and parameters below are the SQL and
 * parameters the branch produces. The wiring that connects this replica to the
 * real source is asserted structurally in Case M; if the branch's arguments ever
 * drift from these, Case M fails.
 */
const allBranchPredicate = async (ctx: RequestContext) => {
  const projectScope = await resolveProjectScopeIn(ctx, tx)
  return projectScopePredicate(projectScope, {
    orgUnitCol: journalEntries.siteOrgUnitId,
    personCol: journalEntries.personId,
  })
}

// ===========================================================================
// Case A — the property the fix depends on
// ===========================================================================

describe('15B-3C-4B Case A — a .all reader with a restricted Project Scope is narrowed', () => {
  it('produces a real predicate bound to journal location and author columns', async () => {
    const predicate = await allBranchPredicate(scopedSafetyManager())
    expect(predicate).toBeDefined()

    const { sql } = compile(predicate)
    // Both columns the branch binds must appear. A branch that dropped either
    // binding would still return a predicate — just a narrower or wrong one.
    expect(sql).toContain('"journal_entries"."site_org_unit_id" in (')
    expect(sql).toContain('"journal_entries"."person_id" in (')
  })

  it("binds the caller's OWN scope ids as parameters, not as SQL text", async () => {
    const { sql, params } = compile(await allBranchPredicate(scopedSafetyManager()))
    // `site_1` is the caller's assigned site; the org-tree walk contributes its
    // project and siblings. Present as a PARAMETER…
    expect(params).toContain('site_1')
    // …and never interpolated into the statement, which is what makes the scope
    // un-injectable.
    expect(sql).not.toContain('site_1')
  })

  it('is not "no filter" — the pre-4B answer for this caller was `undefined`', async () => {
    // This is the whole defect in one assertion: the old branch returned
    // `undefined` (whole tenant) for exactly this context.
    const predicate = await allBranchPredicate(scopedSafetyManager())
    expect(predicate).not.toBeUndefined()
    expect(isAlwaysFalse(predicate)).toBe(false)
  })

  it('excludes a site the caller is NOT assigned to', async () => {
    // `site_2` sits under project B, which the fixture deliberately leaves out of
    // the caller's scope, so its id cannot reach the bound parameters.
    const { params } = compile(await allBranchPredicate(scopedSafetyManager()))
    expect(params).not.toContain('site_2')
  })
})

// ===========================================================================
// Case B — the fix must only ever NARROW
// ===========================================================================

describe('15B-3C-4B Case B — a company-wide .all reader keeps the whole tenant', () => {
  it('resolves to no predicate at all for an unrestricted caller', async () => {
    // `{type:'tenant'}` short-circuits to `unrestricted`, and `unrestricted` is
    // the ONE case that yields `undefined`. Forcing a predicate here would break
    // every tenant-wide safety manager.
    const predicate = await allBranchPredicate(context(['journals.read.all'], [{ type: 'tenant' }]))
    expect(predicate).toBeUndefined()
  })

  it('an empty role scope is NOT unrestricted — Project Scope is independent of it', async () => {
    // `{type:'tenant'}` is what makes a caller unrestricted. Empty `ctx.scopes`
    // does not: Project Scope is resolved from `people_assignments`, which is a
    // different store from `role_assignments.scope`. A caller holding
    // `journals.read.all` with no role scope rows still resolves through their
    // own assignments, so they get a real narrowed predicate — never the tenant.
    const predicate = await allBranchPredicate(context(['journals.read.all'], []))
    expect(predicate).toBeDefined()
    expect(isAlwaysFalse(predicate)).toBe(false)
    expect(compile(predicate).params).toContain('site_1')
  })
})

// ===========================================================================
// Case C — `.site` is untouched
// ===========================================================================

describe("15B-3C-4B Case C — the .site branch keeps journals' own semantics", () => {
  it('still reads the bare scope site ids, unchanged by 4B', () => {
    const body = bodyOf(JOURNALS_LIB, /if \(can\(ctx, 'journals\.read\.site'\)\)/)
    expect(body).toMatch(
      /ctx\.scopes\.flatMap\(\(s\) => \(s\.type === 'sites' \? s\.siteIds : \[\]\)\)/,
    )
    expect(body).toMatch(/inArray\(journalEntries\.siteOrgUnitId, siteIds\)/)
  })

  it('is NOT delegated to the canonical resolver', () => {
    // The under-exposure this leaves behind is a known, deliberate gap; the test
    // exists so it cannot be closed by accident and without the product decision.
    const branch = bodyOf(JOURNALS_LIB, /if \(can\(ctx, 'journals\.read\.site'\)\)/)
    expect(branch).not.toContain('moduleScopeWhere')
    expect(branch).not.toContain('projectScopePredicate')
    expect(branch).not.toContain('resolveProjectScopeIn')
  })

  it("still unions the reviewer's own entries with their sites", () => {
    const body = bodyOf(JOURNALS_LIB, /if \(can\(ctx, 'journals\.read\.site'\)\)/)
    expect(body).toMatch(/or\(siteWhere, ownWhere\)/)
  })

  it('and the whole module was never migrated to the canonical ladder', () => {
    // The 4B fix is Option A: one branch. A wholesale migration is a different
    // change with a much wider blast radius.
    expect(codeOnly(JOURNALS_LIB)).not.toContain('moduleScopeWhere')
  })
})

// ===========================================================================
// Case D — `.self` / own-entry visibility
// ===========================================================================

describe('15B-3C-4B Case D — the own-entry leg is untouched and never scope-bound', () => {
  it('still matches on authorship OR the creating tenant user', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    expect(body).toMatch(/own\.push\(eq\(journalEntries\.personId, authorPersonId\)\)/)
    expect(body).toMatch(/own\.push\(eq\(journalEntries\.createdByTenantUserId, tenantUserId\)\)/)
    expect(body).toMatch(/or\(\.\.\.own\)/)
  })

  it('the .all branch adds no own leg — it is scope-only', () => {
    // journals' `.all` never unioned own entries; the old `return undefined`
    // covered the whole tenant instead. Asserting the absence of an own leg here
    // is what makes Mutation 1/2 (silently replacing the scope with the own leg)
    // detectable rather than a quiet behaviour change.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).not.toContain('ownWhere')
    expect(all).not.toContain('createdByTenantUserId')
    expect(all).not.toContain('authorPersonId')
  })

  it('the self-only helper is untouched and still fails closed with no anchors', () => {
    const body = bodyOf(JOURNALS_LIB, /export function journalSelfScopeWhere\(/)
    expect(body).toMatch(/return sql`false`/)
    // It is deliberately NOT scope-bound: the personal compose workspace.
    expect(body).not.toContain('projectScopePredicate')
    expect(body).not.toContain('resolveProjectScopeIn')
  })

  it('a caller with neither a person nor a membership cannot become unrestricted', () => {
    // Documented contract of `journalSelfScopeWhere`: "a context with no person
    // and no membership resolves to `false` … never the whole tenant". Pinned by
    // source because the function is not importable from this test runner.
    const body = bodyOf(JOURNALS_LIB, /export function journalSelfScopeWhere\(/)
    expect(returnsOf(body)).toEqual([
      'return sql`false`',
      'return conds.length === 1 ? conds[0]! : or(...conds)!',
    ])
  })
})

// ===========================================================================
// Case E — fail closed
// ===========================================================================

describe('15B-3C-4B Case E — a reader with no scope fails closed, never open', () => {
  it('an empty scope is `empty`, and binds to a hard false', async () => {
    // `empty` ≠ `unrestricted`. This is the direction that turns an accidental
    // scope resolution failure into "see nothing" rather than "see everything".
    //
    // Note what it takes to REACH `empty`: Project Scope is derived from
    // `people_assignments`, not from `role_assignments.scope` — the two are
    // independent by design — so a caller with no `ctx.scopes` rows still
    // resolves through their employee record. An empty scope needs a caller with
    // neither an employee row nor any assignment.
    const noRecordTx = projectScopeTx({ employeeRecord: 'none', assignments: [] })
    const ctx = context(['journals.read.all'], [])
    const scope = await resolveProjectScopeIn(ctx, noRecordTx)
    expect(scope.kind).toBe('empty')
    const predicate = projectScopePredicate(scope, {
      orgUnitCol: journalEntries.siteOrgUnitId,
      personCol: journalEntries.personId,
    })
    expect(predicate).toBeDefined()
    expect(isAlwaysFalse(predicate)).toBe(true)
  })

  it('the no-permission fall-through is still `ownWhere ?? false`', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    expect(body).toMatch(/return ownWhere \?\? sql`false`/)
    // The default path must not consult Project Scope at all — an unreadable
    // caller gets their own entries or nothing.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).not.toContain('can(ctx')
  })

  it('the .all gate is still a permission test, not a role-name test', () => {
    const body = bodyOf(JOURNALS_LIB, /export function journalCanReadAll\(/)
    expect(body).toMatch(/ctx\.isSuperAdmin \|\| can\(ctx, 'journals\.read\.all'\)/)
    expect(body).not.toContain('ctx.scopes')
  })
})

// ===========================================================================
// Case F — the super-admin sentinel
// ===========================================================================

describe('15B-3C-4B Case F — the super-admin sentinel guard survived', () => {
  it('is still present, and still short-circuits to null', () => {
    const body = bodyOf(JOURNALS_LIB, /export function authorTenantUserId\(/)
    expect(body).toMatch(/id === 'super-admin'/)
    expect(returnsOf(body)).toEqual(['return null', 'return id'])
  })

  it('is reached from the own leg, so a sentinel is never compared as a uuid', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    expect(body).toMatch(/const tenantUserId = authorTenantUserId\(ctx\)/)
  })
})

// ===========================================================================
// Case G — the soft-deleted employee guard
// ===========================================================================

describe('15B-3C-4B Case G — the soft-deleted employee exclusion survived', () => {
  it('getAuthorPersonId still filters soft-deleted employee rows', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function getAuthorPersonId\(/)
    expect(body).toMatch(/isNull\(people\.deletedAt\)/)
    expect(body).toMatch(/eq\(people\.userId, ctx\.userId\)/)
  })

  it('resolves to null rather than an id when the row is gone', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function getAuthorPersonId\(/)
    expect(body).toMatch(/return p\?\.id \?\? null/)
  })

  it('the .all branch does not bypass it — it takes authorPersonId only via callers', () => {
    // The branch is handed `authorPersonId` and, in the `.all` case, ignores it;
    // the employee lookup still gates `.site` / `.self` at every call site.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).not.toContain('getAuthorPersonId')
  })
})

// ===========================================================================
// Case H — tenant isolation
// ===========================================================================

describe('15B-3C-4B Case H — tenant isolation was not traded away for Project Scope', () => {
  it('journalScopeWhere never widens beyond the RLS-bound tenant', () => {
    const body = codeOnly(bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/))
    // No tenant predicate is needed here: every caller runs through `ctx.db`, so
    // RLS bounds the rowset. The scope only ever NARROWS that. Pin the direction:
    // there is no `or(..., tenantLeg)` escape hatch and no literal tenant id.
    expect(body).not.toMatch(/tenantId/)
    expect(body).not.toMatch(/ctx\.isSuperAdmin\s*\?\s*undefined/)
  })

  it('the Project Scope resolver is the one that reads org data, through tx', () => {
    // Scope resolution must go through the caller's transaction, never a fresh
    // client — otherwise it would query outside the RLS context.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).toMatch(/await resolveProjectScopeIn\(ctx, tx\)/)
    expect(all).not.toContain('ctx.db(')
  })

  it('every journals call site runs its query inside ctx.db', () => {
    for (const [name, src] of [
      ['_data.ts', JOURNALS_DATA],
      ['_actions.ts', JOURNALS_ACTIONS],
      ['_send-email.ts', JOURNALS_EMAIL],
      ['_tag-picker-actions.ts', JOURNALS_TAG_PICKER],
    ] as const) {
      expect(src, name).toContain('ctx.db(')
    }
  })
})

// ===========================================================================
// Case I — mutation scope is a separate ladder and was not touched
// ===========================================================================

describe('15B-3C-4B Case I — the write ladder is independent of the read fix', () => {
  it('journalMutationScope still decides writes on its own terms', () => {
    const body = bodyOf(JOURNALS_POLICY, /export function journalMutationScope\(/)
    expect(body).toMatch(/'none'/)
    expect(body).toMatch(/'read_scope'/)
    // The write ladder must not have been pointed at Project Scope.
    expect(body).not.toContain('projectScopePredicate')
    expect(body).not.toContain('resolveProjectScopeIn')
  })

  it('mutationWhere keeps its own-only branch and its `false` guards', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /async function mutationWhere\(/)
    expect(body).toMatch(/journalSelfScopeWhere\(ctx, authorPersonId\)/)
    expect(body).toMatch(/return sql`false`/)
    // `read_scope` still delegates to the READ ladder — that is the only
    // coupling, and it was already there.
    expect(body).toMatch(/if \(scope === 'read_scope'\) return scopedWhere\(ctx, id\)/)
  })

  it('scopedWhere threads the transaction into the read ladder', () => {
    // This is the read ladder's own entry point. It changed only in HOW it
    // resolves scope; the predicates it ANDs are unchanged.
    const body = bodyOf(JOURNALS_ACTIONS, /async function scopedWhere\(/)
    expect(body).toMatch(
      /await ctx\.db\(async \(tx\) => journalScopeWhere\(ctx, tx, authorPersonId\)\)/,
    )
    expect(body).toMatch(/eq\(journalEntries\.id, id\)/)
    expect(body).toMatch(/isNull\(journalEntries\.deletedAt\)/)
  })

  it('journals.update.own stays own-only even for an all-reader', () => {
    // The comment states the invariant; pin that the code still routes `own`
    // through the self-only helper rather than the read scope.
    const body = codeOnly(bodyOf(JOURNALS_POLICY, /export function journalMutationScope\(/))
    expect(body).not.toMatch(/journalScopeWhere/)
  })
})

// ===========================================================================
// Case J — the PDF path
// ===========================================================================

describe('15B-3C-4B Case J — the PDF route has no scope bypass', () => {
  it('still gates on journals.read and delegates to getEntry', () => {
    expect(JOURNALS_PDF).toMatch(/can\(ctx, 'journals\.read\.[a-z]+'\)/)
    expect(JOURNALS_PDF).toContain('getEntry')
  })

  it('and queries journal_entries with no predicate of its own', () => {
    // A hand-rolled `inArray`/`or` over the entry would be a second ladder. The
    // only scoping allowed here is the one getEntry already applies.
    const body = codeOnly(bodyOf(JOURNALS_PDF, /export async function GET/))
    expect(body).not.toContain('journalScopeWhere')
    expect(body).not.toContain('projectScopePredicate')
    expect(body).not.toMatch(/inArray\(/)
  })
})

// ===========================================================================
// Case K — the email path
// ===========================================================================

describe('15B-3C-4B Case K — emailing still goes through the read scope', () => {
  it('the recap query is bound by journalScopeWhere', () => {
    const body = bodyOf(JOURNALS_EMAIL, /export async function sendJournalEntryEmail\(/)
    expect(body).toMatch(/await journalScopeWhere\(ctx, tx, authorPersonId\)/)
  })

  it('keeps the id and soft-delete guards it always had', () => {
    const body = bodyOf(JOURNALS_EMAIL, /export async function sendJournalEntryEmail\(/)
    expect(body).toMatch(/eq\(journalEntries\.id, entryId\)/)
    expect(body).toMatch(/isNull\(journalEntries\.deletedAt\)/)
  })

  it('added no permission gate of its own — the caller still owns that', () => {
    // 4B was authorised to fix a signature, not to change authorization. A new
    // `can(…)` here would be exactly that, so its absence is the contract.
    const body = codeOnly(bodyOf(JOURNALS_EMAIL, /export async function sendJournalEntryEmail\(/))
    expect(body).not.toMatch(/\bcan\(ctx/)
    expect(body).not.toContain('canEmailJournal')
  })

  it('and the caller still gates on canEmailJournal before calling it', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /export async function emailEntry\(/)
    expect(body).toMatch(/if \(!canEmailJournal\(ctx\)\)/)
    expect(body).toMatch(/const where = await mutationWhere\(ctx, id, 'submit'\)/)
  })

  it('canEmailJournal is the documented permission set, unchanged', () => {
    const body = bodyOf(JOURNALS_POLICY, /export function canEmailJournal\(/)
    expect(body).toMatch(
      /ctx\.isSuperAdmin \|\| can\(ctx, 'journals\.submit'\) \|\| can\(ctx, 'journals\.assign'\)/,
    )
  })
})

// ===========================================================================
// Case L — the feed's journal legs
// ===========================================================================

describe("15B-3C-4B Case L — the feed's journal legs are threaded, not rewired", () => {
  it('both legs still call journalScopeWhere, with the transaction', () => {
    const sites = [
      ...codeOnly(FEED).matchAll(/await journalScopeWhere\(ctx, tx, authorPersonId\)/g),
    ]
    expect(sites).toHaveLength(2)
    // No un-threaded call survives anywhere in the feed.
    expect(codeOnly(FEED)).not.toMatch(/journalScopeWhere\(ctx, authorPersonId\)/)
  })

  it('neither leg was rerouted to the canonical module ladder', () => {
    // The 4A feed fix delegates to `moduleScope` for incidents / corrective
    // actions / form responses. Journals must stay on their own helper.
    expect(codeOnly(FEED)).not.toMatch(/moduleScope\(\s*ctx,\s*tx,\s*'journal/)
    expect([...codeOnly(FEED).matchAll(/await moduleScope\(/g)]).toHaveLength(6)
  })

  it('the 4A delegation it sits next to is intact', () => {
    const body = bodyOf(FEED, /async function moduleScope\(/)
    expect(body).toMatch(/if \(!can\(ctx, base\)\) return 'none'/)
    expect(body).toMatch(/return await moduleScopeWhere\(ctx, tx, \{/)
  })
})

// ===========================================================================
// Case M — canonical helper wiring, and no second implementation
// ===========================================================================

describe('15B-3C-4B Case M — the .all branch is wired to the canonical helpers', () => {
  it("resolves the scope with the caller's transaction and awaits it", () => {
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).toMatch(/const projectScope = await resolveProjectScopeIn\(ctx, tx\)/)
  })

  it('binds the scope to the journal location and author columns', () => {
    // These two bindings are the contract with the behavioural replica in Case A.
    // If either changed, the SQL asserted there would no longer be the SQL
    // journals produce.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).toMatch(/orgUnitCol: journalEntries\.siteOrgUnitId/)
    expect(all).toMatch(/personCol: journalEntries\.personId/)
  })

  it("returns the adapter's result and NOTHING else", () => {
    // The single most important structural assertion in this file. Before 4B
    // this branch's only statement was `return undefined`. If it ever returns
    // anything other than the adapter, a restricted caller is reading the whole
    // tenant again.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(returnsOf(all)).toEqual([
      'return projectScopePredicate(projectScope, { orgUnitCol: journalEntries.siteOrgUnitId, personCol: journalEntries.personId, })',
    ])
    expect(all).not.toMatch(/return undefined/)
  })

  it('imports the two canonical helpers, and not the module ladder', () => {
    expect(JOURNALS_LIB).toContain("from '@/lib/project-scope'")
    expect(JOURNALS_LIB).toContain("from '@/lib/project-scope-predicate'")
    expect(codeOnly(JOURNALS_LIB)).not.toContain('moduleScopeWhere')
    expect(codeOnly(JOURNALS_LIB)).not.toContain("from '@/lib/visibility'")
  })

  it('has not built a second Project Scope of its own', () => {
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    // No org-tree walk, no personnel expansion, no raw scope ids, no inline
    // `inArray` — those would be a parallel implementation that could drift.
    expect(all).not.toContain('ctx.scopes')
    expect(all).not.toContain('inArray(')
    expect(all).not.toContain('peopleAssignments')
    expect(all).not.toContain('orgUnits')
    // Exactly one resolver call in the whole module.
    expect([...codeOnly(JOURNALS_LIB).matchAll(/resolveProjectScopeIn\(/g)]).toHaveLength(1)
  })

  it('the adapter is the one that decides undefined, not the branch', () => {
    // `projectScopePredicate` returns `undefined` for exactly one scope kind,
    // and a hard false for `empty`. This is what lets Case B legitimately see no
    // predicate while Case E sees `false` — and it is the branch's ONLY exit.
    expect(projectScopePredicate({ kind: 'unrestricted' })).toBeUndefined()
    expect(isAlwaysFalse(projectScopePredicate({ kind: 'empty', reason: 'no_scope' }))).toBe(true)
  })
})

// ===========================================================================
// MUTATION SENSITIVITY
//
// Each of these is a defect this file is designed to fail on. They are recorded
// here rather than executed: the batch runs them as a separate, explicit step.
//
//   M1  delete the Project Scope predicate from the .all branch
//       → Case M "returns the adapter's result and NOTHING else" (returnsOf no
//         longer matches), Case M "binds the scope to …" (no adapter call left)
//   M2  keep the call but ignore the restricted scope (drop a binding, or pass
//       an empty column set so the adapter fails closed for the wrong reason)
//       → Case M "binds the scope to the journal location and author columns"
//   M3  delete the `super-admin` sentinel guard
//       → Case F "is still present, and still short-circuits to null"
//   M4  delete the soft-deleted employee guard
//       → Case G "getAuthorPersonId still filters soft-deleted employee rows"
//   M5  restore `return undefined` to the .all branch
//       → Case M "returns the adapter's result and NOTHING else" (`return
//         undefined` is explicitly rejected), and Case A "is not 'no filter'"
//         if the pipeline replica is re-pointed at the branch
//
// Note the honest limit: M1/M2/M5 are detected STRUCTURALLY, not by executing
// `journalScopeWhere`, because that function is not importable from this runner.
// Cases A/B/E/M execute the canonical pipeline for real, so they fail if the
// HELPERS regress — but they would not notice the branch ceasing to call them.
// That is why the Case M body assertions are written to be exhaustive about the
// branch's returns rather than merely presentational.
