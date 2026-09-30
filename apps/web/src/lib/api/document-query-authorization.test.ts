// 15B-3C-3D — regression tests for the DOCUMENTS public-API read authorization.
//
// 15B-3C-3C audited this boundary and concluded NO GAP: `documents` is in
// `SOFT_DELETE_TABLES`, and both `readEntityRows` and `getEntityRecord` AND the
// soft-delete and published predicates into the statement they execute. That
// audit also found the one thing that was missing — none of it was pinned by a
// test, so all of it could be deleted by a well-meaning refactor without a single
// test going red. This file closes that.
//
// WHAT IS UNDER TEST, AND WHAT IS NOT
//
// The real `readEntityRows` / `getEntityRecord` from `lib/api/query.ts` are
// called, and the real `documentReadFilter(ctx)` from `assistant/doc-access.ts`
// runs inside them. Nothing about the authorization is re-implemented, stubbed or
// re-derived here. The only thing faked is `tx.execute()` — the database call —
// because the web vitest project has no database. The statements those two
// functions build are captured and compiled, and the ASSERTIONS are made against
// the compiled SQL and its BOUND PARAMETERS.
//
// Reading params rather than text is the whole point. `"documents"."status" = $1`
// proves nothing on its own; `params === ['published']` is what proves the server
// narrowed the caller to published documents. A test that grepped the SQL for the
// word `published` would pass for the wrong reason — the string only ever
// appears in a bound value, never in the statement text.
//
// CONSEQUENCE: these are STRUCTURAL proofs, not row-level executions. Where a
// requirement is about a row (a draft being excluded), the proof is that the
// predicate is an equality against the literal `published`, which by
// construction cannot match `draft` or `archived`. That reasoning is stated in
// the test rather than glossed over. No live-row claim is made.

import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { REPORT_ENTITY_MAP } from '@beaconhs/reports'
import type { RequestContext } from '@beaconhs/tenant'
import { getEntityRecord, readEntityRows } from './query'
import { documentReadFilter } from '../assistant/doc-access'

const dialect = new PgDialect()

const DOC_A = '1a000000-0000-4000-8000-0000000000a1'
const DOC_B = '1a000000-0000-4000-8000-0000000000b1'

/** The documents entity exactly as the public API exposes it. */
const documentsEntity = REPORT_ENTITY_MAP['documents']!

// ---------------------------------------------------------------------------
// Harness: fake DB execution only. The predicates under test are production.
// ---------------------------------------------------------------------------

type Executed = { sql: string; params: string[] }

/**
 * A context whose `db` hands the callback a transaction that RECORDS the
 * statement instead of running it, and returns no rows. Everything above
 * `tx.execute` — the entity augmentation, the soft-delete predicate, the
 * visibility predicate, the user filters, the AND composition, the ordering, the
 * pagination, the count query — is the real production code path.
 */
function capture(permissions: string[], over: { isSuperAdmin?: boolean } = {}) {
  const executed: Executed[] = []
  const tx = {
    execute: async (query: unknown) => {
      const compiled = dialect.sqlToQuery(query as never)
      executed.push({ sql: compiled.sql, params: compiled.params.map(String) })
      return { rows: [] }
    },
  }
  const ctx = {
    userId: 'api_key_probe',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: over.isSuperAdmin ?? false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: null,
    personId: null,
    permissions: new Set(permissions),
    // API keys are tenant-level credentials (`lib/api/auth.ts`).
    scopes: [{ type: 'tenant' }],
    activeRoleId: null,
    db: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as RequestContext
  return { ctx, executed }
}

const isCount = (q: Executed) => q.sql.includes('COUNT(*)')
const dataOf = (executed: Executed[]) => executed.find((q) => !isCount(q))!
const countOf = (executed: Executed[]) => executed.find(isCount)!

type Caller = { isSuperAdmin?: boolean }

const list = async (permissions: string[], query = '', over: Caller = {}) => {
  const { ctx, executed } = capture(permissions, over)
  await readEntityRows(ctx, documentsEntity, new URLSearchParams(query))
  return executed
}

const detail = async (permissions: string[], id: string, over: Caller = {}) => {
  const { ctx, executed } = capture(permissions, over)
  await getEntityRecord(ctx, documentsEntity, id)
  return executed[0]!
}

/**
 * The WHERE clause of a statement, and nothing else.
 *
 * Trimming at `ORDER BY` / `LIMIT` matters: the data statement carries those and
 * the count statement does not, so a `whereOf` that ran to end-of-string would
 * make the two clauses compare unequal for a reason that has nothing to do with
 * authorization. It also keeps the `LIMIT`-absent assertions honest by isolating
 * the clause rather than relying on a negative match over a whole statement.
 */
const whereOf = (q: Executed): string => {
  const start = q.sql.indexOf(' WHERE ')
  if (start === -1) return ''
  const rest = q.sql.slice(start)
  const stop = rest.search(/ ORDER BY | LIMIT /)
  return stop === -1 ? rest : rest.slice(0, stop)
}

// ---------------------------------------------------------------------------
// 1. Soft delete — applies to EVERY caller, manager included
// ---------------------------------------------------------------------------

describe('15B-3C-3D — soft delete is applied to every caller', async () => {
  it('a reader list statement carries documents.deleted_at IS NULL', async () => {
    expect(whereOf(dataOf(await list(['documents.read'])))).toContain(
      '"documents"."deleted_at" IS NULL',
    )
  })

  it('a manager list statement carries it too, despite having no status predicate', async () => {
    // The two predicates are independent. A manager legitimately bypasses the
    // PUBLISHED restriction; it must never bypass SOFT DELETE.
    const q = dataOf(await list(['documents.manage']))
    expect(whereOf(q)).toContain('"documents"."deleted_at" IS NULL')
    expect(whereOf(q)).not.toContain('"documents"."status" =')
  })

  it('a super-admin is not exempt either', async () => {
    const q = dataOf(await list([], '', { isSuperAdmin: true }))
    expect(whereOf(q)).toContain('"documents"."deleted_at" IS NULL')
  })

  it('a detail statement carries it, for reader and for manager alike', async () => {
    expect(whereOf(await detail(['documents.read'], DOC_A))).toContain(
      '"documents"."deleted_at" IS NULL',
    )
    expect(whereOf(await detail(['documents.manage'], DOC_A))).toContain(
      '"documents"."deleted_at" IS NULL',
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Published — reader narrowed, manager not
// ---------------------------------------------------------------------------

describe('15B-3C-3D — the published predicate is an equality on the bound value', async () => {
  it('a reader is narrowed to exactly "published", as a bound parameter', async () => {
    const q = dataOf(await list(['documents.read']))
    // The literal never appears in the statement text — it is parameter $1. The
    // assertion that matters is on `params`.
    expect(whereOf(q)).toContain('"documents"."status" = $1')
    expect(q.params).toEqual(['published'])
  })

  it('that equality cannot match a draft or an archived document', async () => {
    // Stated rather than executed: `"status" = $1` with $1 = 'published' is
    // true only for rows whose status IS 'published'. `draft` and `archived` are
    // different literals, so the predicate is false for them. This is the whole
    // mechanism, and it is why scenarios 2 and 3 of the brief are satisfied
    // without a database.
    const q = dataOf(await list(['documents.read']))
    const statusPredicates = q.sql.match(/"documents"\."status"\s*=\s*\$\d+/g) ?? []
    expect(statusPredicates).toHaveLength(1)
    expect(q.params.filter((p) => p === 'draft' || p === 'archived')).toEqual([])
  })

  it('a manager gets NO status predicate at all', async () => {
    // `documentReadFilter` returns `undefined` for a manager, so `entityVisibilitySql`
    // yields `null` and the condition is dropped from the array. Asserted on BOTH
    // the statement and the params: no `status =`, and no stray 'published' value
    // left over from a filter that should not exist.
    const q = dataOf(await list(['documents.manage']))
    expect(whereOf(q)).not.toContain('"documents"."status"')
    expect(q.params).toEqual([])
  })

  it('the manager exemption is exactly documentReadFilter, not a role-name check', async () => {
    // Pins the real helper's behaviour so a change to `doc-access.ts` is visible
    // here rather than silently altering the public API.
    expect(documentReadFilter(capture(['documents.read']).ctx)).toBeDefined()
    expect(documentReadFilter(capture(['documents.manage']).ctx)).toBeUndefined()
  })

  it('a detail statement applies the same published rule as a list statement', async () => {
    const d = await detail(['documents.read'], DOC_A)
    expect(whereOf(d)).toContain('"documents"."status" =')
    expect(d.params).toContain('published')
    expect(whereOf(await detail(['documents.manage'], DOC_A))).not.toContain('"documents"."status"')
  })
})

// ---------------------------------------------------------------------------
// 3. A user filter can only NARROW — the central invariant
// ---------------------------------------------------------------------------

describe('15B-3C-3D — a user filter can only narrow the server predicate', async () => {
  it('a user status filter is AND-ed beside the server one, never in place of it', async () => {
    // The brief's headline case. Asking for `status IN ('draft','published')`
    // must NOT be able to talk the caller out of the published restriction.
    const q = dataOf(await list(['documents.read'], 'status__in=draft,published'))
    const where = whereOf(q)
    // Server predicate: present, as an equality.
    expect(where).toContain('"documents"."status" = $1')
    // User predicate: present too, as a membership test.
    expect(where).toMatch(/"documents"\."status" IN \(\$2, \$3\)/)
    // Conjunction, not disjunction — an OR here would be the bypass.
    expect(where).not.toMatch(/\bOR\b/i)
    // Three values, and the server's 'published' is still the first of them.
    expect(q.params).toEqual(['published', 'draft', 'published'])
  })

  it('a contradictory user filter yields both predicates, hence an empty set', async () => {
    // `archived` contradicts `published`. Nothing is "optimised away": the
    // statement keeps both, and AND semantics make the result empty rather than
    // widening it to the requested value.
    const q = dataOf(await list(['documents.read'], 'status=archived'))
    const where = whereOf(q)
    expect(where).toContain('"documents"."status" = $1')
    expect(where).toContain('"documents"."status" = $2')
    expect(q.params).toEqual(['published', 'archived'])
  })

  it('a user filter cannot remove the soft-delete predicate', async () => {
    // Even an attempt to filter on the column leaves the server predicate first
    // in the conjunction. (Naming the column at all is separately rejected —
    // see the whitelist test below.)
    const q = dataOf(await list(['documents.read'], 'key__contains=safe'))
    const where = whereOf(q)
    expect(where).toContain('"documents"."deleted_at" IS NULL')
    // The soft-delete predicate is emitted BEFORE the user filter, which is the
    // composition order `lib/api/query.ts` builds.
    expect(where.indexOf('"deleted_at" IS NULL')).toBeLessThan(where.indexOf('"documents"."key"'))
  })

  it('the soft-delete column is not filterable, so it cannot be negated at all', async () => {
    // `documents` exposes only key/title/status/next_review_on. Naming
    // `deleted_at` fails the whitelist and the request is rejected outright —
    // there is no filter that could weaken the soft-delete rule.
    const { ctx } = capture(['documents.read'])
    return expect(
      readEntityRows(ctx, documentsEntity, new URLSearchParams('deleted_at__is_not_null=1')),
    ).rejects.toThrow(/Unknown filter column "deleted_at"/)
  })

  it('a manager legitimately has no server status predicate to preserve', async () => {
    // The complement of the case above: with no server predicate, a user filter
    // is the only one — and it still cannot introduce an OR that widens nothing.
    const q = dataOf(await list(['documents.manage'], 'status__in=draft,archived'))
    const where = whereOf(q)
    expect(where).toContain('"documents"."deleted_at" IS NULL')
    expect(where).toMatch(/"documents"\."status" IN \(\$1, \$2\)/)
    expect(q.params).toEqual(['draft', 'archived'])
  })

  it('selection, ordering and pagination cannot reach the authorization clause', async () => {
    // The control params are excluded from filters (`CONTROL_PARAMS`), so they
    // land only in the projection / ORDER BY / LIMIT — never in WHERE.
    const q = dataOf(
      await list(['documents.read'], 'fields=title,status&sort=title&order=desc&limit=5&offset=10'),
    )
    const where = whereOf(q)
    expect(where).toContain('"documents"."deleted_at" IS NULL')
    expect(where).toContain('"documents"."status" = $1')
    expect(where).not.toMatch(/LIMIT|OFFSET|ORDER BY/)
    // …and the limits really were applied, i.e. they were not silently dropped
    // in a way that would have changed the meaning of the assertion above.
    expect(q.sql).toContain('ORDER BY "documents"."title" DESC')
    expect(q.sql).toContain('LIMIT 5 OFFSET 10')
  })
})

// ---------------------------------------------------------------------------
// 4. List and detail are covered independently
// ---------------------------------------------------------------------------

describe('15B-3C-3D — list and detail each carry the full predicate set', async () => {
  it('a reader list statement holds soft-delete AND published', async () => {
    const where = whereOf(dataOf(await list(['documents.read'])))
    expect(where).toContain('"documents"."deleted_at" IS NULL')
    expect(where).toContain('"documents"."status" = $1')
  })

  it('a reader detail statement holds soft-delete AND published AND the id', async () => {
    const where = whereOf(await detail(['documents.read'], DOC_A))
    expect(where).toContain('"documents"."id" = $1')
    expect(where).toContain('"documents"."deleted_at" IS NULL')
    expect(where).toContain('"documents"."status" = $2')
    expect((await detail(['documents.read'], DOC_A)).params).toEqual([DOC_A, 'published'])
  })

  it('a manager list and a manager detail both hold soft-delete and no status rule', async () => {
    for (const where of [
      whereOf(dataOf(await list(['documents.manage']))),
      whereOf(await detail(['documents.manage'], DOC_A)),
    ]) {
      expect(where).toContain('"documents"."deleted_at" IS NULL')
      expect(where).not.toContain('"documents"."status"')
    }
  })
})

// ---------------------------------------------------------------------------
// 5. pagination.total reuses the data statement's authorization
// ---------------------------------------------------------------------------

describe('15B-3C-3D — the count query cannot under-count what the data query hides', async () => {
  it('a reader list: the count WHERE is identical to the data WHERE', async () => {
    const executed = await list(['documents.read'])
    expect(whereOf(dataOf(executed))).toBe(whereOf(countOf(executed)))
  })

  it('a manager list: identical too, so a manager is not counted more narrowly than it is served', async () => {
    const executed = await list(['documents.manage'])
    expect(whereOf(dataOf(executed))).toBe(whereOf(countOf(executed)))
  })

  it('a reader list with a user filter: the filter is in BOTH statements', async () => {
    // A count that omitted the user filter would over-report how many documents
    // match; a count that omitted the authorization would over-report how many
    // are readable. Both must be the same clause.
    const executed = await list(['documents.read'], 'status__in=draft,published')
    const where = whereOf(countOf(executed))
    expect(where).toBe(whereOf(dataOf(executed)))
    expect(where).toContain('"documents"."deleted_at" IS NULL')
    expect(where).toContain('"documents"."status" = $1')
    expect(countOf(executed).params).toEqual(['published', 'draft', 'published'])
  })
})

// ---------------------------------------------------------------------------
// 6. The record id is BOUND, and is the caller's own
// ---------------------------------------------------------------------------

describe('15B-3C-3D — the detail id is a bound parameter, not interpolated text', async () => {
  it('the id appears only as a placeholder, with the value in params', async () => {
    const q = await detail(['documents.read'], DOC_A)
    expect(q.sql).toContain('"documents"."id" = $1')
    // The literal must NOT be in the statement text. That is the whole property:
    // a bound parameter cannot carry SQL syntax.
    expect(q.sql).not.toContain(DOC_A)
    expect(q.params[0]).toBe(DOC_A)
  })

  it('a different id produces a different bound value, with the same statement shape', async () => {
    const a = await detail(['documents.read'], DOC_A)
    const b = await detail(['documents.read'], DOC_B)
    expect(b.params[0]).toBe(DOC_B)
    expect(b.params[0]).not.toBe(a.params[0])
    expect(b.sql).not.toContain(DOC_B)
  })

  it('a crafted id never reaches the statement as text', async () => {
    // The route validates the uuid before calling, but the query must not depend
    // on that: even a hostile string is bound, so it cannot terminate the value.
    const q = await detail(['documents.read'], "' OR 1=1 --")
    expect(q.params[0]).toBe("' OR 1=1 --")
    expect(q.sql).not.toContain('1=1')
  })
})
