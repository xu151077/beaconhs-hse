import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { REPORT_ENTITY_MAP } from '@beaconhs/reports'
import type { RequestContext } from '@beaconhs/tenant'
import { DEFAULT_LIMIT, MAX_LIMIT, readEntityRows } from './query'

/**
 * Page-size policy for the public list endpoints.
 *
 * The bug these lock down shipped: `clampInt` fed the raw query value straight into
 * `Number()`, and `Number(null) === 0` is finite, so an ABSENT `?limit=` skipped the
 * fallback and was clamped up to `min`. Every `/api/v1/{entity}` list request that did
 * not spell out a page size therefore ran `LIMIT 1` — while `pagination.total`
 * reported the real row count and `hasMore` was true, so the response looked like a
 * legitimate first page of a long list rather than a truncated one.
 *
 * These assert on the SQL the production builder actually emits, through
 * `readEntityRows`, so the whole chain (parameter read -> clamp -> LIMIT) is covered.
 * Nothing here is re-implemented: the harness only records statements instead of
 * executing them.
 */
const dialect = new PgDialect()
const entity = REPORT_ENTITY_MAP['documents']!

function capture(query: string) {
  const executed: { sql: string; params: string[] }[] = []
  const tx = {
    execute: async (q: unknown) => {
      const compiled = dialect.sqlToQuery(q as never)
      executed.push({ sql: compiled.sql, params: compiled.params.map(String) })
      return { rows: [] }
    },
  }
  const ctx = {
    userId: 'api_key_probe',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: null,
    personId: null,
    permissions: new Set(['documents.read']),
    scopes: [{ type: 'tenant' }],
    activeRoleId: null,
    db: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as RequestContext
  return { ctx, executed }
}

/** The `LIMIT n OFFSET m` the builder emitted, as numbers. */
async function pageOf(query: string) {
  const { ctx, executed } = capture(query)
  await readEntityRows(ctx, entity, new URLSearchParams(query))
  const data = executed.find((q) => !q.sql.includes('COUNT(*)'))!
  const match = data.sql.match(/LIMIT (\d+) OFFSET (\d+)/)
  expect(match, `no LIMIT in: ${data.sql}`).not.toBeNull()
  return { limit: Number(match![1]), offset: Number(match![2]) }
}

describe('an omitted limit takes DEFAULT_LIMIT, not the range minimum', () => {
  it('defaults to 50 when no limit parameter is supplied', async () => {
    expect((await pageOf('')).limit).toBe(50)
    expect(DEFAULT_LIMIT).toBe(50)
  })

  it('defaults to 50 for an explicitly empty limit parameter', async () => {
    // `?limit=` carries no value. It is absent, not zero, so it takes the default.
    expect((await pageOf('limit=')).limit).toBe(50)
  })

  it('defaults to 50 for a whitespace-only limit parameter', async () => {
    expect((await pageOf('limit=%20%20')).limit).toBe(50)
  })

  it('is the regression: an omitted limit must not collapse to a single row', async () => {
    // Guard the exact failure. `min` for limit is 1, so the old code produced
    // LIMIT 1 here and every list endpoint returned one row regardless of size.
    const { limit } = await pageOf('')
    expect(limit).not.toBe(1)
    expect(limit).toBe(DEFAULT_LIMIT)
  })
})

describe('a supplied limit is honoured within the legal range', () => {
  it('uses an in-range value verbatim', async () => {
    expect((await pageOf('limit=10')).limit).toBe(10)
  })

  it('takes the default for a non-numeric limit', async () => {
    expect((await pageOf('limit=abc')).limit).toBe(DEFAULT_LIMIT)
  })

  it('takes the default for a limit that is not a number at all', async () => {
    expect((await pageOf('limit=NaN')).limit).toBe(DEFAULT_LIMIT)
    expect((await pageOf('limit=Infinity')).limit).toBe(DEFAULT_LIMIT)
  })

  it('clamps a limit below the minimum up to 1', async () => {
    // 0 is a real supplied value, so it clamps to `min` rather than defaulting. This is
    // the pre-existing range behaviour and must not change.
    expect((await pageOf('limit=0')).limit).toBe(1)
    expect((await pageOf('limit=-5')).limit).toBe(1)
  })

  it('clamps a limit above the maximum down to MAX_LIMIT', async () => {
    expect((await pageOf('limit=99999')).limit).toBe(MAX_LIMIT)
    expect(MAX_LIMIT).toBe(1000)
  })

  it('truncates a fractional limit', async () => {
    expect((await pageOf('limit=10.9')).limit).toBe(10)
  })
})

describe('offset is unaffected', () => {
  it('defaults a missing offset to 0', async () => {
    // `offset`'s fallback and `min` are both 0, so the absent-value fix changes
    // nothing observable here — asserted so the two parameters cannot drift apart.
    expect((await pageOf('')).offset).toBe(0)
  })

  it('honours a supplied offset', async () => {
    expect((await pageOf('limit=10&offset=40')).offset).toBe(40)
  })

  it('clamps a negative offset to 0', async () => {
    expect((await pageOf('offset=-1')).offset).toBe(0)
  })

  it('applies limit and offset together', async () => {
    const { limit, offset } = await pageOf('limit=25&offset=50')
    expect([limit, offset]).toEqual([25, 50])
  })
})
