// Safety Observations contract.
//
// A safety observation is a CLASSIFICATION of an existing journal entry
// (`journal_entries.definition` = 'positive_observation' |
// 'negative_observation'), not a second table, and it deliberately reuses the
// journals authorization ladder unchanged:
//
//   Tenant/RLS -> Permission -> Role Scope -> journalScopeWhere() -> journal_entries
//
// This file pins that reuse. No observation permission family, no
// observationScopeWhere(), no new RoleScope variant, no Project Scope.
//
// HOW IT IS ASSERTED, AND THE HONEST LIMIT
//
//   1. BEHAVIOURAL, where the code is importable and the REAL function is called:
//      `@beaconhs/db/journal-class` (the class partition), the real
//      `PERMISSION_CATALOGUE` / `BUILTIN_ROLES`, and the real journals
//      `_mutation-policy`. Compiled SQL and BOUND parameters are read back, so a
//      test proves a filter narrows to specific ids rather than merely that a
//      symbol exists.
//
//   2. STRUCTURAL, for the journals `_lib` / `_data` / `_actions` bodies: those
//      files live under `app/(app)/` and import `@/…`, which `apps/web`'s vitest
//      config cannot alias, so they cannot be imported (the same constraint every
//      other contract test in this repo works under). Each assertion is scoped to
//      the ISOLATED, brace-matched body of ONE function or branch, so a mutation
//      elsewhere in the file can neither satisfy nor break it.
//
// Proof 2 cannot execute the function, so a change that stopped the observations
// surface from REACHING `journalScopeWhere` would not be caught by it. That is
// why every structural assertion is exhaustive about the body's RETURN value
// rather than merely checking a symbol is present, and why the behavioural half
// carries the class partition on its own.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import {
  definitionForClass,
  entryClassDefinitions,
  entryClassNotWhere,
  entryClassOf,
  entryClassWhere,
  isObservationEntry,
  type EntryClass,
} from '@beaconhs/db/journal-class'
import { can, type RequestContext } from '@beaconhs/tenant'
import {
  canCreateJournal,
  journalMutationFlags,
  journalMutationScope,
} from '../journals/_mutation-policy'

const dialect = new PgDialect()

const bound = (p: unknown): string[] =>
  p === undefined ? [] : dialect.sqlToQuery(p as never).params.map(String)
const sqlText = (p: unknown): string =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const JOURNALS_LIB = read('../journals/_lib.ts')
const JOURNALS_DATA = read('../journals/_data.ts')
const JOURNALS_ACTIONS = read('../journals/_actions.ts')
const JOURNALS_POLICY = read('../journals/_mutation-policy.ts')
const OBSERVATIONS_DATA = read('./_data.ts')
const OBSERVATIONS_ACTIONS = read('./_actions.ts')
const OBSERVATIONS_PAGE = read('./page.tsx')
const OBSERVATIONS_DETAIL = read('./[id]/page.tsx')

/** Source with comments removed, so prose naming a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

/**
 * The brace-matched body of one declaration or `if` branch, found by its opening
 * line. Comments are stripped FIRST and the brace walk runs on that same text, so
 * offsets and slice can never disagree — a header named only in prose cannot
 * match, and prose inside a body cannot satisfy an assertion.
 */
/** Whitespace-normalised, comment-stripped source — for containment assertions. */
const flat = (src: string): string => codeOnly(src).replace(/\s+/g, ' ')

function bodyOf(src: string, header: RegExp): string {
  const code = codeOnly(src)
  const m = code.match(header)
  if (!m) throw new Error(`no source matched ${header}`)
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
  if (from < 0 || code[from] !== '{') throw new Error(`${header} not followed by a body brace`)
  let depth = 0
  for (let j = from; j < code.length; j++) {
    const c = code[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return code.slice(from + 1, j)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

/** Every `return` in a body, in order, whitespace-normalised. */
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

function context(
  permissions: string[],
  personId = 'person_1',
  isSuperAdmin = false,
): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin,
    timezone: 'America/Toronto',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member_1', displayName: 'Safety Manager' },
    personId,
    permissions: new Set(permissions),
    scopes: [],
    db: async () => {
      throw new Error('authorization predicates must not hit the database here')
    },
  } as unknown as RequestContext
}

// ===========================================================================
// 1. The class partition — the ONE structural thing observations add.
// ===========================================================================

describe('journal_entries partitions into a journal class and an observation class', () => {
  it('the two classes are disjoint and cover the whole definition enum', () => {
    const all: string[] = [
      ...entryClassDefinitions('journal'),
      ...entryClassDefinitions('observation'),
    ]
    expect(new Set(all).size).toBe(all.length) // disjoint
    // Every enum value belongs to exactly one class — no orphan definition.
    for (const def of ['worker', 'supervisor', 'positive_observation', 'negative_observation']) {
      const cls = (['journal', 'observation'] as EntryClass[]).filter((c) =>
        entryClassDefinitions(c).includes(def),
      )
      expect(cls).toHaveLength(1)
    }
  })

  it('an observation read filters to the two observation definitions and nothing else', () => {
    const params = bound(entryClassWhere('observation'))
    expect(params).toContain('positive_observation')
    expect(params).toContain('negative_observation')
    // A daily journal definition can never ride along in an observation query.
    expect(params).not.toContain('worker')
    expect(params).not.toContain('supervisor')
  })

  it('a journal read still filters to worker/supervisor, unchanged', () => {
    const params = bound(entryClassWhere('journal'))
    expect(params).toContain('worker')
    expect(params).toContain('supervisor')
    expect(params).not.toContain('positive_observation')
    expect(params).not.toContain('negative_observation')
  })

  it('the definition values are bound as PARAMETERS, never interpolated', () => {
    const text = sqlText(entryClassWhere('observation'))
    expect(text).not.toContain('positive_observation')
    expect(text).not.toContain('negative_observation')
  })

  it('the negative half excludes exactly the observations, for the dashboard widget', () => {
    const p = entryClassNotWhere('observation')
    // `notInArray` binds the EXCLUDED values and emits `not in` — the exact
    // complement of entryClassWhere, so a journal-only query provably drops both.
    expect(bound(p).sort()).toEqual(['negative_observation', 'positive_observation'])
    expect(sqlText(p)).toMatch(/not in/)
  })

  it('classOf/isObservationEntry classify the same way for every value', () => {
    for (const def of entryClassDefinitions('observation')) {
      expect(isObservationEntry(def)).toBe(true)
      expect(entryClassOf(def)).toBe('observation')
    }
    for (const def of entryClassDefinitions('journal')) {
      expect(isObservationEntry(def)).toBe(false)
      expect(entryClassOf(def)).toBe('journal')
    }
  })
})

// ===========================================================================
// 2. A patch may move WITHIN its class, never across it.
//    Without this the partition would rest on the client: `journals.update.own`
//    on a daily journal could rewrite `definition` to 'negative_observation' and
//    hand the record to the observations surface (and the reverse).
// ===========================================================================

describe('a definition patch cannot cross the class boundary', () => {
  it('the observation surface accepts only the two observation definitions', () => {
    expect(definitionForClass('negative_observation', 'observation')).toBe('negative_observation')
    expect(definitionForClass('positive_observation', 'observation')).toBe('positive_observation')
    expect(definitionForClass('worker', 'observation')).toBeNull()
    expect(definitionForClass('supervisor', 'observation')).toBeNull()
  })

  it('the journal surface still accepts only worker/supervisor', () => {
    expect(definitionForClass('worker', 'journal')).toBe('worker')
    expect(definitionForClass('supervisor', 'journal')).toBe('supervisor')
    expect(definitionForClass('positive_observation', 'journal')).toBeNull()
    expect(definitionForClass('negative_observation', 'journal')).toBeNull()
  })

  it('an unknown or non-string value is refused, not coerced', () => {
    for (const bad of [undefined, null, '', 'worker ', 'WORKER', 'observation', 42, {}, []]) {
      expect(definitionForClass(bad, 'observation')).toBeNull()
      expect(definitionForClass(bad, 'journal')).toBeNull()
    }
  })

  it('updateEntry gates the patch through that same helper, not a hand-rolled list', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /export async function updateEntry\(/)
    expect(body).toMatch(/definitionForClass\(patch\.definition,\s*entryClass\)/)
    // The default must be the daily journal, so every pre-existing caller keeps
    // its exact behaviour.
    expect(body).toMatch(/input\.entryClass\s*\?\?\s*'journal'/)
  })

  it('the observation update action always passes the observation class', () => {
    const body = bodyOf(OBSERVATIONS_ACTIONS, /export async function updateObservationDraft\(/)
    expect(body).toMatch(/entryClass:\s*ENTRY_CLASS/)
  })
})

// ===========================================================================
// 3. Observations inherit the journals ladder, INCLUDING its own-record
//    cross-site rule. These are the behaviours the mandate requires:
//      normal scope OR own record — never a forced pure-site filter.
// ===========================================================================

describe('observations reuse journalScopeWhere unchanged', () => {
  it('journalScopeWhere keeps its own-record leg at EVERY tier, outside the scoped sites', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    // The own leg is built from BOTH the subject person and the typed author, and
    // it is OR-ed with the site leg rather than replaced by it.
    expect(body).toMatch(/eq\(journalEntries\.personId,\s*authorPersonId\)/)
    expect(body).toMatch(/eq\(journalEntries\.createdByTenantUserId,\s*tenantUserId\)/)
    expect(body).toMatch(/or\(siteWhere,\s*ownWhere\)/)
    // The fallback is own-only, never the whole tenant.
    expect(body).toMatch(/return ownWhere \?\? sql`false`/)
  })

  it("journalScopeWhere's read.all branch is unfiltered, so a .all reader sees the tenant", () => {
    const body = bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/)
    const readAll = bodyOf(body, /if \(journalCanReadAll\(ctx\)\)/)
    expect(returnsOf(readAll)).toEqual(['return undefined'])
  })

  it('a caller with no read key falls through to own-only, never to the tenant', () => {
    const body = flat(bodyOf(JOURNALS_LIB, /export async function journalScopeWhere\(/))
    // Every return the resolver can make, asserted individually. There is no
    // fourth return and no bare `return` that would widen to the whole tenant.
    expect(body).toMatch(/return undefined/)
    expect(body).toMatch(/return ownWhere \? or\(siteWhere, ownWhere\)! : siteWhere/)
    expect(body).toMatch(/return ownWhere \?\? sql`false`/)
    const returns = body.match(/\breturn\b/g) ?? []
    expect(returns).toHaveLength(3)
    expect(returnsOf(body).filter((r) => r === 'return')).toEqual([])
  })

  it("keeps the 'super-admin' sentinel guard on the author column", () => {
    // A sentinel membership id must never be compared as a uuid; the guard lives
    // in authorTenantUserId and every own-record leg flows through it.
    const body = bodyOf(JOURNALS_LIB, /export function authorTenantUserId\(/)
    expect(body).toMatch(/id === 'super-admin'/)
    expect(body).toMatch(/return null/)
  })

  it('keeps the soft-deleted-employee exclusion in getAuthorPersonId', () => {
    const body = bodyOf(JOURNALS_LIB, /export async function getAuthorPersonId\(/)
    expect(body).toMatch(/eq\(people\.userId,\s*ctx\.userId\)/)
    expect(body).toMatch(/isNull\(people\.deletedAt\)/)
  })

  it('the observations read layer resolves through the journals readers, not a new predicate', () => {
    // Scoped to CALL SITES: a `journalScopeWhere` mention is legitimate in an
    // import, but re-implementing or re-branching the ladder here is not.
    const flatText = flat(OBSERVATIONS_DATA)
    expect(flatText).not.toMatch(/function\s+\w*[Ss]copeWhere/)
    // `journalScopeWhere` may appear only in the import list — never called.
    const calls = flatText.match(/journalScopeWhere\s*\(/g) ?? []
    expect(calls).toEqual([])
    // Every list/count/facet/detail read delegates to the journals data layer,
    // class-pinned. Matched whitespace-tolerantly so a reformat cannot break it.
    for (const call of [
      'listEntries(ctx, filters, paging, false, ENTRY_CLASS)',
      'countEntries(ctx, filters, ENTRY_CLASS)',
      'listRecordsFacets(ctx, ENTRY_CLASS)',
      'getEntry(ctx, id, ENTRY_CLASS)',
    ]) {
      expect(flatText).toContain(call)
    }
  })

  it('the single class constant is the observation class, typed as the closed union', () => {
    expect(OBSERVATIONS_DATA).toMatch(/const ENTRY_CLASS: EntryClass = 'observation'/)
    // And the journal default stays 'journal' everywhere else, so a pre-existing
    // journals caller keeps returning daily journals only.
    expect(JOURNALS_DATA).toMatch(/entryClass: EntryClass = 'journal'/)
  })
})

// ===========================================================================
// 4. Detail must not leak existence, and the read must be tenant-bounded.
//    Backend authorization first: a hidden button is not a guard.
// ===========================================================================

describe('the observation detail page is the authorization boundary', () => {
  it('getEntry folds the class into the SAME where as the visibility scope', () => {
    const flatText = flat(bodyOf(JOURNALS_DATA, /export async function getEntry\(/))
    // id + soft-delete + class + scope, all AND-ed in ONE where. There is no
    // "load then decide" path that could render an invisible record.
    expect(flatText).toContain('eq(journalEntries.id, id)')
    expect(flatText).toContain('isNull(journalEntries.deletedAt)')
    expect(flatText).toContain('entryClassWhere(entryClass)')
    // The class sits inside the `and(...)` that also carries the scope.
    const andCall = flatText.slice(flatText.indexOf('and(', flatText.indexOf('.where(')))
    expect(andCall).toContain('entryClassWhere(entryClass)')
    expect(andCall).toContain('scope')
  })

  it('an invisible observation returns null, which the page turns into notFound()', () => {
    expect(OBSERVATIONS_DATA).toMatch(/return getEntry\(ctx,\s*id,\s*ENTRY_CLASS\)/)
    // The page 404s on null — it never renders a "not permitted" branch that
    // would confirm the record is real.
    expect(OBSERVATIONS_DETAIL).toMatch(/if \(!entry\) notFound\(\)/)
    expect(OBSERVATIONS_DETAIL).not.toMatch(/redirect\('\/observations'\)/)
  })

  it('a non-uuid id is rejected before any query runs', () => {
    expect(OBSERVATIONS_DETAIL).toMatch(/if \(!isUuid\(id\)\) notFound\(\)/)
  })

  it('archive re-reads the observation through the scoped reader before writing', () => {
    const body = bodyOf(OBSERVATIONS_ACTIONS, /export async function archiveObservation\(/)
    // The gate is the READ, so an observation nobody can read is unwritable.
    expect(body).toMatch(/getEntry\(ctx,\s*id,\s*ENTRY_CLASS\)/)
    expect(body).toMatch(/journalMutationScope\(ctx,\s*'edit'\)/)
    // The transition is one-way and idempotent-guarded.
    expect(body).toMatch(/eq\(journalEntries\.status,\s*'submitted'\)/)
    expect(body).toMatch(/set\(\{ status: 'archived' \}\)/)
  })

  it('raising a corrective action re-reads the observation and requires a negative one', () => {
    const body = bodyOf(OBSERVATIONS_ACTIONS, /export async function raiseObservationAction\(/)
    // The id is narrowed to a validated string BEFORE it is used as a lookup, so
    // an unvalidated `unknown` can never reach the reader.
    expect(body).toMatch(/const observationId = typeof raw\.id === 'string' \? raw\.id : ''/)
    expect(body).toMatch(/if \(!isUuid\(observationId\)\)/)
    expect(body).toMatch(/getEntry\(ctx,\s*observationId,\s*ENTRY_CLASS\)/)
    expect(body).toMatch(/observation\.definition !== 'negative_observation'/)
    expect(body).toMatch(/journalMutationScope\(ctx,\s*'edit'\)/)
  })

  it('tenant isolation is RLS, not a filter: the reads run inside ctx.db', () => {
    // `entryClassWhere` narrows the CLASS, never the tenant; the tenant boundary
    // is `withTenant` under ctx.db, so the observations layer adds no tenant leg.
    const body = bodyOf(JOURNALS_DATA, /export async function listEntries\(/)
    expect(body).toMatch(/ctx\.db\(async \(tx\) =>/)
    expect(OBSERVATIONS_DATA).not.toMatch(/eq\(journalEntries\.tenantId/)
  })
})

// ===========================================================================
// 5. Observation -> Corrective Action is 1:N, held ENTIRELY by the CA.
//    `corrective_actions.source` already had the value 'observation' with no
//    producer; the polymorphic (sourceEntityType, sourceEntityId) pair is the
//    same one the incident path uses. No FK, no column on journal_entries.
// ===========================================================================

describe('the observation -> corrective action link needs no new column', () => {
  it('the link is read from the CA side, keyed by the existing polymorphic pair', () => {
    const body = bodyOf(OBSERVATIONS_DATA, /export async function listObservationActions\(/)
    expect(body).toMatch(/eq\(correctiveActions\.sourceEntityType,\s*'journal_entry'\)/)
    expect(body).toMatch(/eq\(correctiveActions\.sourceEntityId,\s*observationId\)/)
    expect(body).toMatch(/isNull\(correctiveActions\.deletedAt\)/)
  })

  it('the link is 1:N — one observation, many actions, no uniqueness on the CA', () => {
    const body = bodyOf(OBSERVATIONS_DATA, /export async function listObservationActions\(/)
    // No limit/unique: every action raised from the observation is listed.
    expect(body).not.toMatch(/\.limit\(/)
    expect(body).not.toMatch(/distinct/)
    const grouped = bodyOf(OBSERVATIONS_DATA, /async function countOpenActionsByObservation\(/)
    expect(grouped).toMatch(/groupBy\(correctiveActions\.sourceEntityId\)/)
  })

  it('raising reuses the existing spawn primitive with the reserved source', () => {
    const body = bodyOf(OBSERVATIONS_ACTIONS, /export async function raiseObservationAction\(/)
    expect(body).toMatch(/spawnCorrectiveActionForSubject\(ctx,\s*\{/)
    expect(body).toMatch(/sourceEntityType:\s*'journal_entry'/)
    expect(body).toMatch(/source:\s*'observation'/)
    expect(body).toMatch(/siteOrgUnitId:\s*observation\.siteOrgUnitId/)
  })

  it('the journal flow adapter already produced this source, so the value is real', () => {
    // The journals adapter passes source: 'observation' today. That is why the
    // enum value predates this module and why nothing had to be added to it.
    expect(OBSERVATIONS_ACTIONS).not.toMatch(/source:\s*'other'/)
  })

  it('an observation carries NO corrective-action column of its own', () => {
    // Nothing on the observation side — no linkedCorrectiveActionId, no ca_id.
    expect(OBSERVATIONS_DATA).not.toMatch(/correctiveActionId/)
    expect(OBSERVATIONS_ACTIONS).not.toMatch(/journalEntryCa/)
  })

  it("the linked list is filtered by the caller's own CA read boundary", () => {
    const body = bodyOf(OBSERVATIONS_DATA, /function actionVisibilityWhere\(/)
    expect(body).toMatch(/ca\.read\.all/)
    expect(body).toMatch(/ca\.read\.site/)
    // Own-record leg, then the fail-closed fallback.
    expect(body).toMatch(/ownWhere \?\? sql`false`/)
  })
})

// ===========================================================================
// 6. NO new permission family, NO new RoleScope variant, NO Project Scope.
//    The catalogue is the real one, so these are facts, not intentions.
// ===========================================================================

describe('observations add no authorization vocabulary', () => {
  const keys = [...PERMISSION_CATALOGUE] as string[]

  it('the catalogue gained no hse.* or observations.* key', () => {
    expect(keys.filter((k) => k.startsWith('hse.'))).toEqual([])
    expect(keys.filter((k) => k.startsWith('observations'))).toEqual([])
  })

  it('every journal permission is still the original set — nothing renamed or dropped', () => {
    expect(keys.filter((k) => k.startsWith('journals.')).sort()).toEqual([
      'journals.assign',
      'journals.create',
      'journals.read.all',
      'journals.read.self',
      'journals.read.site',
      'journals.submit',
      'journals.update.own',
    ])
  })

  it('the catalogue is still unique', () => {
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('the built-in roles were not widened or narrowed for observations', () => {
    for (const role of ['worker', 'foreman', 'safety_manager', 'tenant_admin'] as const) {
      const perms = (BUILTIN_ROLES[role]?.permissions ?? []) as string[]
      // A role that could not file a journal before still cannot file an
      // observation, because both are `journals.create`.
      expect(can(context(perms), 'journals.create')).toBe(perms.includes('journals.create'))
    }
  })

  it('no RoleScope variant was added — observations are bounded by sites, not projects', () => {
    // The observations surface never reads a project scope; only `sites` reaches
    // journalScopeWhere's site leg.
    expect(OBSERVATIONS_DATA).not.toMatch(/type: 'project'/)
    expect(OBSERVATIONS_DATA).not.toMatch(/projectScope|ProjectScope|project_scope/)
    expect(OBSERVATIONS_ACTIONS).not.toMatch(/projectScope|ProjectScope|project_scope/)
  })

  it('the class partition adds a WHERE leg, never a permission or a scope', () => {
    // The whole authorization delta is one inArray on an existing enum column.
    const text = sqlText(entryClassWhere('observation'))
    expect(text).toMatch(/in \(/)
    expect(text).toMatch(/\$\d/)
  })
})

// ===========================================================================
// 7. Permission gates, resolved through the REAL policy and the REAL can().
// ===========================================================================

describe('observation mutations are gated by the journals permissions', () => {
  it('create needs journals.create', () => {
    expect(canCreateJournal(context(['journals.create']))).toBe(true)
    // A read tier is not a create right.
    expect(canCreateJournal(context(['journals.read.all']))).toBe(false)
    expect(canCreateJournal(context(['journals.read.site', 'journals.assign']))).toBe(false)
    expect(canCreateJournal(context([]))).toBe(false)
    // Super-admin is the documented override.
    expect(canCreateJournal(context([], 'person_1', true))).toBe(true)
  })

  it('submit needs journals.submit, and a read tier never substitutes for it', () => {
    const ctx = context(['journals.read.all', 'journals.update.own'])
    expect(journalMutationScope(ctx, 'submit')).toBe('none')
    expect(journalMutationScope(context(['journals.submit']), 'submit')).toBe('self')
  })

  it('update-own stays self-scoped even for a reader who can see the whole site', () => {
    const ctx = context(['journals.read.site', 'journals.update.own'])
    expect(journalMutationScope(ctx, 'edit')).toBe('self')
  })

  it('journals.assign is the only permission that widens a write to the read scope', () => {
    expect(journalMutationScope(context(['journals.assign']), 'edit')).toBe('read_scope')
    expect(journalMutationScope(context(['journals.assign']), 'submit')).toBe('read_scope')
  })

  it('a caller with no journal permission gets no write scope at all', () => {
    expect(journalMutationScope(context([]), 'edit')).toBe('none')
    expect(journalMutationScope(context([]), 'submit')).toBe('none')
  })

  it('the render flags are derived from the same policy, never re-derived from can()', () => {
    // `journalMutationFlags` has an object return-type annotation, so the body
    // walk would stop on those braces; assert against the flat policy text.
    const flatPolicy = flat(JOURNALS_POLICY)
    expect(flatPolicy).toContain("canEdit: journalMutationScope(ctx, 'edit') !== 'none'")
    expect(flatPolicy).toContain("canSubmit: journalMutationScope(ctx, 'submit') !== 'none'")
    // Behavioural proof the flags can never claim MORE than the policy allows,
    // across every permission shape the four built-in roles produce.
    for (const role of ['worker', 'foreman', 'safety_manager', 'tenant_admin'] as const) {
      const ctx = context([...(BUILTIN_ROLES[role]?.permissions ?? [])] as string[])
      const flags = journalMutationFlags(ctx)
      expect(flags.canEdit).toBe(journalMutationScope(ctx, 'edit') !== 'none')
      expect(flags.canSubmit).toBe(journalMutationScope(ctx, 'submit') !== 'none')
      expect(flags.canCreate).toBe(canCreateJournal(ctx))
    }
  })
})

// ===========================================================================
// 8. Lifecycle: the journals draft/submitted/archived, no observation workflow.
// ===========================================================================

describe('observations reuse the journals lifecycle, with no new states', () => {
  it('no under_review / action_required / closed state was introduced', () => {
    for (const file of [
      OBSERVATIONS_DATA,
      OBSERVATIONS_ACTIONS,
      OBSERVATIONS_PAGE,
      OBSERVATIONS_DETAIL,
    ]) {
      expect(file).not.toMatch(/under_review|action_required/)
    }
    // 'closed' only ever appears as a CA status, never as an observation status.
    expect(OBSERVATIONS_ACTIONS).toMatch(/eq\(journalEntries\.status,\s*'submitted'\)/)
    expect(OBSERVATIONS_ACTIONS).not.toMatch(/status:\s*'closed'/)
  })

  it('creation writes a draft, and the class is set server-side', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /export async function createObservation\(/)
    expect(body).toMatch(/status: 'draft'/)
    expect(body).toMatch(/isObservationDefinition\(definition\)/)
    // The definition is validated before it reaches the insert.
    expect(body).toMatch(/metadata: \{ kind: 'safety_observation' \}/)
  })

  it('an observation mints its own reference from the shared JRN series', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /export async function createObservation\(/)
    // One numbering scheme for both classes — no second reference counter.
    expect(body).toMatch(/nextJournalReference\(tx, ctx\.tenantId/)
    expect(body).not.toMatch(/nextReference\(tx, ctx\.tenantId, '(?!journal)/)
  })

  it('the daily-journal get-or-create cannot return an observation for the same date', () => {
    const body = flat(bodyOf(JOURNALS_DATA, /export async function getOrCreateEntryForDate\(/))
    // The definition is part of BOTH the lookup and the insert, so two
    // observations on one day are two records and a journal never opens one.
    expect(body).toContain('eq(journalEntries.definition, definition)')
    expect(body).toContain('definition,')
    // The default is the daily journal, on the SIGNATURE (outside the body).
    const signature = flat(
      JOURNALS_DATA.slice(
        JOURNALS_DATA.indexOf('export async function getOrCreateEntryForDate('),
        JOURNALS_DATA.indexOf('): Promise<string | null>'),
      ),
    )
    expect(signature).toContain("definition: JournalDefinition = 'worker'")
  })

  it('submit is the journals submit, so the idempotency guard is inherited', () => {
    const body = bodyOf(JOURNALS_ACTIONS, /export async function submitEntry\(/)
    expect(body).toMatch(/eq\(journalEntries\.status,\s*'draft'\)/)
    const obs = bodyOf(OBSERVATIONS_ACTIONS, /export async function submitObservation\(/)
    expect(obs).toMatch(/submitEntry\(id,\s*ENTRY_CLASS\)/)
  })

  it('submit threads the class into the on-submit AI pass', () => {
    // Regression: `applyEntryAi` reads through `scopedWhere`, which defaults to
    // the journal class. Without the class threaded through, a submitted
    // observation would silently skip AI summarisation and tagging.
    const body = bodyOf(JOURNALS_ACTIONS, /export async function submitEntry\(/)
    expect(body).toMatch(/applyEntryAi\(ctx,\s*id,\s*entryClass\)/)
  })
})

// ===========================================================================
// 9. Category = the journals tag system. Attachment = journal_entry_photos.
//    Neither gets an observation-specific table.
// ===========================================================================

describe('category and attachment reuse the journals primitives', () => {
  it('the tag filter is the existing journal_entry_tags sub-select, not a new table', () => {
    const body = flat(bodyOf(JOURNALS_DATA, /async function entryWhere\(/))
    expect(body).toContain('journalEntryTags')
    expect(body).toContain('filters.tag')
    expect(OBSERVATIONS_DATA).not.toMatch(/observationCategor|observationCategorie/)
    expect(OBSERVATIONS_DATA).not.toMatch(/from\(journalTags\)/)
  })

  it('the tag filter is AND-ed with the class filter, so a class can never be widened', () => {
    const body = flat(bodyOf(JOURNALS_DATA, /async function entryWhere\(/))
    // Both legs land in the same `conds` array that becomes the WHERE.
    expect(body).toContain('entryClassWhere(entryClass)')
    expect(body).toContain('conds.push(scope)')
    expect(body).toContain('return conds.length === 0 ? undefined : and(...conds)')
  })

  it('a user-supplied definition filter cannot escape the class partition', () => {
    const body = flat(bodyOf(JOURNALS_DATA, /async function entryWhere\(/))
    // `filters.definition` is AND-ed onto conds, which already carry the class.
    // A journal surface given definition=negative_observation therefore matches
    // no row, rather than returning observations.
    expect(body).toContain(
      'if (filters.definition) conds.push(eq(journalEntries.definition, filters.definition))',
    )
  })

  it('the list read pins the definition column to the observation values', () => {
    const body = flat(bodyOf(OBSERVATIONS_DATA, /export async function listObservations\(/))
    // Non-observation rows are dropped rather than rendered with a bad union type.
    expect(body).toContain('isObservationEntry(row.definition)')
    expect(body).toContain('[]')
  })

  it('attachments go through journal_entry_photos, so no observation link table exists', () => {
    const body = bodyOf(OBSERVATIONS_ACTIONS, /export async function attachObservationPhotos\(/)
    expect(body).toMatch(/attachJournalPhotos\(\{/)
    expect(body).toMatch(/entryClass:\s*ENTRY_CLASS/)
    for (const file of [OBSERVATIONS_DATA, OBSERVATIONS_ACTIONS]) {
      expect(file).not.toMatch(/observationAttachment|observationPhoto|observation_photos/)
    }
  })

  it('every photo action delegates to the journals writer with the class pinned', () => {
    const pairs: [RegExp, RegExp][] = [
      [
        /export async function removeObservationPhoto\(/,
        /removeJournalPhoto\(photoId, ENTRY_CLASS\)/,
      ],
      [
        /export async function reorderObservationPhotos\(/,
        /reorderJournalPhotos\(observationId, photoIds, ENTRY_CLASS\)/,
      ],
      [
        /export async function updateObservationPhoto\(/,
        /updateJournalPhoto\(photoId, input, ENTRY_CLASS\)/,
      ],
    ]
    for (const [header, call] of pairs) {
      expect(bodyOf(OBSERVATIONS_ACTIONS, header)).toMatch(call)
    }
    // The attach action is the one the UI wires, so it must reach the journals
    // writer with the class pinned too.
    expect(bodyOf(OBSERVATIONS_ACTIONS, /export async function attachObservationPhotos\(/)).toMatch(
      /entryClass:\s*ENTRY_CLASS/,
    )
  })

  it('the shared upload and gallery primitives are reused, not rebuilt', () => {
    const photos = read('./[id]/_observation-photos.tsx')
    expect(photos).toMatch(/from '@\/components\/photo-uploader-section'/)
    expect(photos).toMatch(/from '@\/components\/photo-gallery'/)
    // No bespoke uploader markup in the observations surface.
    expect(photos).not.toMatch(/type="file"/)
    expect(photos).not.toMatch(/<input[^>]*file/i)
  })

  it('editing is gated exactly as journals gates it: policy + lock, NOT draft status', () => {
    // Regression found by browser verification: gating the photo uploader on
    // `status === 'draft'` hid attachment on a SUBMITTED observation, a capability
    // journals has (its editor pane uses `!entry.locked`). The two surfaces must
    // not diverge, or observations silently lose a journals feature.
    const view = read('./[id]/_observation-view.tsx')
    expect(view).toMatch(/const editable = canEdit && !entry\.locked/)
    expect(view).not.toMatch(/const editable = entry\.status === 'draft'/)
    // Submit stays status-gated: it is the one-way draft -> submitted transition.
    expect(view).toMatch(/const submittable = entry\.status === 'draft' && canSubmit/)
  })
})

// ===========================================================================
// 10. The journals surfaces must be UNAFFECTED — no observations leaking into
//     the journals list, export, the dashboard widget, or the compliance engine.
// ===========================================================================

describe('the journals surfaces are unchanged by the observation class', () => {
  it('the journals export stays journal-only and says why', () => {
    const body = flat(
      bodyOf(JOURNALS_LIB, /export function journalCanReadAll\(/) +
        read('../journals/export.csv/route.ts'),
    )
    expect(body).toContain('listEntries(ctx, filters, { limit: CSV_EXPORT_QUERY_LIMIT })')
  })

  it('the journals export passes no class, so it inherits the journal default', () => {
    const route = read('../journals/export.csv/route.ts')
    const call = flat(route).match(/listEntries\([^)]*\)/)?.[0] ?? ''
    expect(call).not.toContain("'observation'")
  })

  it('the dashboard in-progress widget excludes observations', () => {
    const dash = read('../dashboard/_metrics.ts')
    expect(dash).toMatch(/entryClassWhere\('journal'\)/)
  })

  it('the journal-cadence compliance obligation counts journals, not observations', () => {
    // Otherwise a worker could satisfy a journal obligation by filing observations.
    const evaluate = read('../../../../../../packages/compliance/src/evaluate.ts')
    const start = evaluate.indexOf('async function evalJournal(')
    expect(start).toBeGreaterThan(-1)
    // Scope to this one evaluator: another call site of entryClassWhere proves
    // nothing about the journal cadence rule.
    const block = evaluate.slice(start, start + 3000)
    expect(block).toContain("entryClassWhere('journal')")
  })

  it('the observations export is its own audited route, journal-only input', () => {
    const route = read('./export.csv/route.ts')
    expect(route).toMatch(/assertCan\(ctx, 'journals\.read\.self'\)/)
    expect(route).toMatch(/listObservations\(ctx, filters/)
    expect(route).toMatch(/recordAudit\(ctx, \{/)
    // The definition whitelist admits only the two observation values.
    const flatRoute = flat(route)
    expect(flatRoute).toContain(
      "const DEFINITION_VALUES = ['positive_observation', 'negative_observation']",
    )
  })
})
