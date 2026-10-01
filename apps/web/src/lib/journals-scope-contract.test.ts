// The Journals visibility contract.
//
// Journals deliberately do NOT use `moduleScopeWhere`. It has its own ladder in
// `journalScopeWhere`, because three journals-specific properties would break under
// the shared resolver:
//
//   • the caller's OWN entries are visible at EVERY tier, including outside the
//     sites their Role Scope names;
//   • the `'super-admin'` sentinel guard in `authorTenantUserId`;
//   • `getAuthorPersonId`'s exclusion of soft-deleted employee rows.
//
// So the module keeps its own resolver and this file pins the properties that make
// that safe. It is a bespoke ladder, not a bespoke AUTHORIZATION model: the inputs
// are still Permission, Role Scope and RLS, and nothing here reads a second
// authorization dimension.
//
// WHAT IS ASSERTED, AND HOW — read this before trusting a green run
//
// This file uses two kinds of proof and does not pretend they are equivalent:
//
//   1. BEHAVIOURAL, where the code is importable: the shared tier ladder is
//      executed for real and its compiled SQL and BOUND parameters are read back.
//      That is what proves a tier produces a filter, and to which ids.
//
//   2. STRUCTURAL, for `journalScopeWhere` and its neighbours. They live under
//      `app/(app)/` and cannot be imported: `apps/web` has NO vitest config, so the
//      `@/*` tsconfig path is not aliased. Every contract test in this repo reads
//      those sources with `readFileSync` for the same reason. To keep that from
//      degrading into a grep, each assertion is scoped to an ISOLATED BODY — the
//      exact brace-matched text of one function or `if` branch — and asserts on that
//      body's returns, its argument lists and its column bindings. A mutation
//      elsewhere in the file can neither satisfy nor break them.
//
// The honest limit: proof 2 cannot call the function, so a change that stops
// `journalScopeWhere` from being reached at all would not be caught here. That is
// why the assertions are exhaustive about each body's RETURNS rather than merely
// checking that a symbol is present.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { journalEntries, type RoleScope } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import { moduleScopeWhere } from './visibility'

const SITE_1 = 'site_1'
const SITE_2 = 'site_2'
const PERSON_1 = 'person_1'

const dialect = new PgDialect()

/** The tier ladder resolves from `ctx` alone and never reads the transaction. */
const tx = {} as Database

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
 * line. Comments are stripped FIRST and the brace walk runs on that same text, so
 * the offsets and the slice can never disagree — a header named only in prose
 * cannot match, and prose inside a body cannot satisfy an assertion.
 */
function bodyOf(src: string, header: RegExp): string {
  const code = codeOnly(src)
  const m = code.match(header)
  if (!m) throw new Error(`no source matched ${header}`)
  // The header identifies the construct; the body starts at the next `{` that is
  // not inside a parameter list or a return-type annotation. Both depths are
  // tracked because a signature like `Promise<ActionOk<{ sent: number }>>` carries
  // braces of its own. The walk starts AT the match so its `(` is counted.
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
      // The INNER text only: the enclosing braces would otherwise be captured by a
      // trailing `return …` match and by substring assertions alike.
      if (depth === 0) return code.slice(from + 1, j)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

/**
 * Every `return` in a body, in order, normalised.
 *
 * A return's extent is "up to the next `return` or `;`", not "up to the next `;`":
 * consecutive one-line returns have no semicolons, and a multi-line return spans
 * several lines. Both shapes occur here, so the extent has to cover both without
 * merging them.
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

const bound = (p: unknown): string[] =>
  p === undefined ? [] : dialect.sqlToQuery(p as never).params.map(String)
const sqlText = (p: unknown): string =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql

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
    personId: PERSON_1,
    permissions: new Set(permissions),
    scopes,
    db: async () => {
      throw new Error('visibility predicates must not hit the database here')
    },
  } as unknown as RequestContext
}

// ===========================================================================
// The tier ladder journals deliberately does not share — pinned behaviourally
// so the divergence from `moduleScopeWhere` cannot drift silently.
// ===========================================================================

describe("the canonical tier ladder, for reference against journals' own", () => {
  it('read.all is the whole tenant, so a journals .all reader is unfiltered too', async () => {
    // This is what `journalScopeWhere` returns `undefined` for, and why that is the
    // correct answer rather than a gap.
    expect(
      await moduleScopeWhere(context(['journals.read.all'], []), tx, { prefix: 'journals' }),
    ).toBeUndefined()
  })

  it("read.site binds the caller's Role Scope ids, and not a neighbour's", async () => {
    const p = await moduleScopeWhere(
      context(['journals.read.site'], [{ type: 'sites', siteIds: [SITE_1] }]),
      tx,
      { prefix: 'journals', siteCol: journalEntries.siteOrgUnitId },
    )
    expect(bound(p)).toEqual([SITE_1])
    expect(bound(p)).not.toContain(SITE_2)
  })

  it('ids are bound as PARAMETERS, never interpolated into the statement', async () => {
    const p = await moduleScopeWhere(
      context(['journals.read.site'], [{ type: 'sites', siteIds: [SITE_1] }]),
      tx,
      { prefix: 'journals', siteCol: journalEntries.siteOrgUnitId },
    )
    expect(bound(p)).toContain(SITE_1)
    expect(sqlText(p)).not.toContain(SITE_1)
  })

  it('a caller with no read key degrades to own-only, never to the tenant', async () => {
    const p = await moduleScopeWhere(context(['journals.submit'], []), tx, {
      prefix: 'journals',
      personCol: journalEntries.personId,
    })
    expect(p).toBeDefined()
    expect(bound(p)).toEqual([PERSON_1])
  })
})

// ===========================================================================
// The `.all` branch
// ===========================================================================

describe('the .all branch is the whole tenant, and says so', () => {
  it('returns undefined and nothing else', () => {
    // The single most important structural assertion about this branch. If it ever
    // returns a filter, a `journals.read.all` holder stops seeing the tenant; if it
    // ever consults anything else, a second authorization dimension has crept in.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(returnsOf(all)).toEqual(['return undefined'])
  })

  it('consults no scope, no column and no second dimension', () => {
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).not.toContain('ctx.scopes')
    expect(all).not.toContain('inArray(')
    expect(all).not.toContain('peopleAssignments')
    expect(all).not.toContain('orgUnits')
    expect(all).not.toContain('ProjectScope')
    expect(all).not.toContain('projectScope')
  })

  it('is still a permission test, not a role-name test', () => {
    const body = bodyOf(JOURNALS_LIB, /export function journalCanReadAll\(/)
    expect(body).toMatch(/ctx\.isSuperAdmin \|\| can\(ctx, 'journals\.read\.all'\)/)
    expect(body).not.toContain('ctx.scopes')
  })
})

// ===========================================================================
// The `.site` branch — journals' own semantics
// ===========================================================================

describe("the .site branch keeps journals' own semantics", () => {
  it('reads the bare Role Scope site ids', () => {
    const body = bodyOf(JOURNALS_LIB, /if \(can\(ctx, 'journals\.read\.site'\)\)/)
    expect(body).toMatch(
      /ctx\.scopes\.flatMap\(\(s\) => \(s\.type === 'sites' \? s\.siteIds : \[\]\)\)/,
    )
    expect(body).toMatch(/inArray\(journalEntries\.siteOrgUnitId, siteIds\)/)
  })

  it('is NOT delegated to the shared resolver', () => {
    // The under-exposure this leaves behind — a `.site` reviewer reads bare scope
    // ids with no org-tree walk — is a known, deliberate gap. The test exists so it
    // cannot be closed by accident and without the product decision.
    const branch = bodyOf(JOURNALS_LIB, /if \(can\(ctx, 'journals\.read\.site'\)\)/)
    expect(branch).not.toContain('moduleScopeWhere')
  })

  it("unions the reviewer's own entries with their sites", () => {
    const body = bodyOf(JOURNALS_LIB, /if \(can\(ctx, 'journals\.read\.site'\)\)/)
    expect(body).toMatch(/or\(siteWhere, ownWhere\)/)
  })

  it('and the whole module was never migrated to the shared ladder', () => {
    expect(codeOnly(JOURNALS_LIB)).not.toContain('moduleScopeWhere')
  })
})

// ===========================================================================
// Own-entry visibility
// ===========================================================================

describe('the own-entry leg is never scope-bound', () => {
  it('matches on authorship OR the creating tenant user', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    expect(body).toMatch(/own\.push\(eq\(journalEntries\.personId, authorPersonId\)\)/)
    expect(body).toMatch(/own\.push\(eq\(journalEntries\.createdByTenantUserId, tenantUserId\)\)/)
    expect(body).toMatch(/or\(\.\.\.own\)/)
  })

  it('the .all branch adds no own leg', () => {
    // journals' `.all` never unioned own entries; it is the whole tenant instead.
    // Asserting the absence is what makes "silently swap the branch for the own
    // leg" detectable rather than a quiet behaviour change.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).not.toContain('ownWhere')
    expect(all).not.toContain('createdByTenantUserId')
    expect(all).not.toContain('authorPersonId')
  })

  it('the self-only helper fails closed with no anchors', () => {
    const body = bodyOf(JOURNALS_LIB, /export function journalSelfScopeWhere\(/)
    expect(body).toMatch(/return sql`false`/)
    // Documented contract: "a context with no person and no membership resolves to
    // `false` … never the whole tenant".
    expect(returnsOf(body)).toEqual([
      'return sql`false`',
      'return conds.length === 1 ? conds[0]! : or(...conds)!',
    ])
  })

  it('the no-permission fall-through is own-only or false', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    expect(body).toMatch(/return ownWhere \?\? sql`false`/)
  })
})

// ===========================================================================
// The two journals-specific guards
// ===========================================================================

describe('the super-admin sentinel guard survived', () => {
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

describe('the soft-deleted employee exclusion survived', () => {
  it('getAuthorPersonId still filters soft-deleted employee rows', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function getAuthorPersonId\(/)
    expect(body).toMatch(/isNull\(people\.deletedAt\)/)
    expect(body).toMatch(/eq\(people\.userId, ctx\.userId\)/)
  })

  it('resolves to null rather than an id when the row is gone', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function getAuthorPersonId\(/)
    expect(body).toMatch(/return p\?\.id \?\? null/)
  })

  it('the .all branch does not bypass it', () => {
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
    expect(all).not.toContain('getAuthorPersonId')
  })
})

// ===========================================================================
// Tenant isolation
// ===========================================================================

describe('tenant isolation is not traded away', () => {
  it('journalScopeWhere never widens beyond the RLS-bound tenant', () => {
    const body = codeOnly(bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/))
    // No tenant predicate is needed: every caller runs through `ctx.db`, so RLS
    // bounds the rowset. Pin the direction — there is no `or(…, tenantLeg)` escape
    // hatch and no literal tenant id.
    expect(body).not.toMatch(/tenantId/)
  })

  it('no journals resolver opens its own connection', () => {
    // Reading scope data outside the caller's transaction would query outside the
    // RLS context.
    const all = bodyOf(JOURNALS_LIB, /if \(journalCanReadAll\(ctx\)\)/)
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
// The write ladder, the PDF route, email, and the feed
// ===========================================================================

describe('the write ladder is independent of the read ladder', () => {
  it('journalMutationScope still decides writes on its own terms', () => {
    const body = bodyOf(JOURNALS_POLICY, /export function journalMutationScope\(/)
    expect(body).toMatch(/'none'/)
    expect(body).toMatch(/'read_scope'/)
    expect(body).not.toContain('journalScopeWhere')
  })

  it('mutationWhere keeps its own-only branch and its `false` guards', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /async function mutationWhere\(/)
    expect(body).toMatch(/journalSelfScopeWhere\(ctx, authorPersonId\)/)
    expect(body).toMatch(/return sql`false`/)
    // `read_scope` still delegates to the READ ladder — the only coupling, and it
    // was already there.
    expect(body).toMatch(/if \(scope === 'read_scope'\) return scopedWhere\(ctx, id\)/)
  })

  it('scopedWhere threads the transaction into the read ladder', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /async function scopedWhere\(/)
    expect(body).toMatch(
      /await ctx\.db\(async \(tx\) => journalScopeWhere\(ctx, tx, authorPersonId\)\)/,
    )
    expect(body).toMatch(/eq\(journalEntries\.id, id\)/)
    expect(body).toMatch(/isNull\(journalEntries\.deletedAt\)/)
  })
})

describe('the PDF route has no visibility bypass', () => {
  it('still gates on journals.read and delegates to getEntry', () => {
    expect(JOURNALS_PDF).toMatch(/can\(ctx, 'journals\.read\.[a-z]+'\)/)
    expect(JOURNALS_PDF).toContain('getEntry')
  })

  it('and queries journal_entries with no predicate of its own', () => {
    // A hand-rolled `inArray`/`or` over the entry would be a second ladder.
    const body = codeOnly(bodyOf(JOURNALS_PDF, /export async function GET/))
    expect(body).not.toContain('journalScopeWhere')
    expect(body).not.toMatch(/inArray\(/)
  })
})

describe('emailing still goes through the read ladder', () => {
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
    // A new `can(…)` here would be a change to authorization, which this module
    // was never authorised to make. Its absence is the contract.
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

describe("the feed's journal legs are threaded, not rewired", () => {
  it('both legs still call journalScopeWhere, with the transaction', () => {
    const sites = [
      ...codeOnly(FEED).matchAll(/await journalScopeWhere\(ctx, tx, authorPersonId\)/g),
    ]
    expect(sites).toHaveLength(2)
    // No un-threaded call survives anywhere in the feed.
    expect(codeOnly(FEED)).not.toMatch(/journalScopeWhere\(ctx, authorPersonId\)/)
  })

  it('neither leg was rerouted to the shared module ladder', () => {
    // The feed delegates to `moduleScope` for incidents / corrective actions / form
    // responses. Journals must stay on their own helper.
    expect(codeOnly(FEED)).not.toMatch(/moduleScope\(\s*ctx,\s*tx,\s*'journal/)
    expect([...codeOnly(FEED).matchAll(/await moduleScope\(/g)]).toHaveLength(6)
  })

  it('the delegation it sits next to is intact', () => {
    const body = bodyOf(FEED, /async function moduleScope\(/)
    expect(body).toMatch(/if \(!can\(ctx, base\)\) return 'none'/)
    expect(body).toMatch(/return await moduleScopeWhere\(ctx, tx, \{/)
  })
})

// ===========================================================================
// MUTATION SENSITIVITY
//
// Defects this file is designed to fail on. Recorded rather than executed; the
// batch runs them as a separate, explicit step.
//
//   M1  replace `return undefined` in the .all branch with a row filter
//       → "returns undefined and nothing else" (returnsOf no longer matches)
//   M2  reintroduce a second authorization dimension in the .all branch
//       → "consults no scope, no column and no second dimension"
//   M3  delete the `super-admin` sentinel guard
//       → "is still present, and still short-circuits to null"
//   M4  delete the soft-deleted employee guard
//       → "getAuthorPersonId still filters soft-deleted employee rows"
//   M5  swap the .all branch for the own leg
//       → "the .all branch adds no own leg"
//   M6  make the personal compose workspace tenant-wide
//       → "the self-only helper fails closed with no anchors"
//
// The honest limit: every M is detected STRUCTURALLY, because
// `journalScopeWhere` is not importable from this runner. The behavioural block at
// the top executes the shared ladder for real, so it fails if the LADDER regresses —
// but it would not notice journals ceasing to call it. That is why the structural
// assertions are exhaustive about each body's returns rather than presentational.
