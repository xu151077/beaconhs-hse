// WHICH built-in Insights cards are "trusted system cards".
//
// This is a different axis from `insights-trusted-card-scope-contract.test.ts`,
// which pins WHICH PERMISSION unlocks the trusted KPI. That file answers "may
// this viewer read it"; this one answers "is this card trusted at all". Both
// halves must be right, and they were independently broken.
//
// TRUST means exactly one thing: `app_responses` is withheld from
// `scopeAnalyticsEntities` and only re-admitted for a trusted card, which
// `canReadAppResponses` then gates on `forms.response.read.all`. A card that
// never reads that source gains nothing from trust, so classifying it as trusted
// only makes `runCardCached` refuse it — the viewer is entitled to the data and
// gets an error tile instead.
//
// THE DEFECTS THIS PINS
//
//   1. Trust was inferred from "is a seeded built-in". `ensureSystemCards` and
//      the dashboards path both stamped `trustedSystemCard: true` on every
//      system card. A site-scoped foreman is entitled to the corrective-action
//      and inspection counts, but was refused with "Not authorized to read app
//      responses", so three tiles of the default foreman dashboard rendered as
//      errors. `analytics-access.ts` states the intended scope: "Tenant-wide
//      covers exactly two built-in cards".
//
//   2. `isTrustedSystemCard` compared queries with `JSON.stringify`. A card's
//      `query` is `jsonb`, and Postgres reorders object keys (by length, then
//      bytewise) and the parser materialises optionals the literal omits
//      (`limit: null`). So the comparison could never succeed, the function
//      returned false for EVERY seeded card, and `/insights/cards/[id]` reported
//      `Unknown source entity "app_responses"` for the two real KPI cards — for
//      every viewer, including a super-admin.
//
// Assertions import the real module and evaluate the real built-in table, so
// adding a built-in that reads `app_responses` is covered automatically rather
// than needing this file edited.

import { describe, expect, it, vi } from 'vitest'
import type { BhqlQuery } from '@beaconhs/db/schema'

// `_system-cards.ts` opens with `import 'server-only'`, which throws under vitest.
vi.mock('server-only', () => ({}))

const { isTrustedSystemCard, queryUsesAppResponses } =
  await import('../app/(app)/insights/_system-cards')
const { BUILTIN_QUERIES, INSIGHT_WIDGET_MAP } = await import('../app/(app)/insights/_widgets')

/** The only two cards `analytics-access.ts` documents as tenant-wide. */
const TENANT_WIDE = ['kpi-submissions', 'kpi-monitored-sessions-active'] as const

const usesAppResponses = Object.entries(BUILTIN_QUERIES)
  .filter(([, b]) => queryUsesAppResponses(b.query))
  .map(([key]) => key)
  .sort()

describe('only the app_responses built-ins are trusted', () => {
  it('exactly the two documented cards read the withheld source', () => {
    // The premise of the whole fix. If a third built-in ever starts reading
    // app_responses, it joins the trusted set automatically and this pins it.
    expect(usesAppResponses).toEqual([...TENANT_WIDE].sort())
  })

  it('the trusted set is exactly the app_responses set', () => {
    // The invariant: trust exists ONLY to re-admit the withheld source. Any card
    // marked trusted that does not read it is a card that can only error.
    for (const [key, builtin] of Object.entries(BUILTIN_QUERIES)) {
      const card = {
        name: INSIGHT_WIDGET_MAP.get(key)?.label ?? key,
        query: builtin.query,
        createdBy: null,
      }
      const expected = queryUsesAppResponses(builtin.query)
      expect(isTrustedSystemCard(card), `${key} trust classification`).toBe(expected)
    }
  })

  it('the corrective-action and inspection KPIs a foreman owns are NOT trusted', () => {
    // The three tiles that rendered as errors on the default foreman dashboard.
    // Each reads its own module, so the `ca` / `inspections` ladder — not the
    // tenant-wide response gate — is what authorizes it.
    for (const key of ['kpi-open-cas', 'kpi-overdue-cas', 'kpi-inspections']) {
      const builtin = BUILTIN_QUERIES[key]!
      expect(queryUsesAppResponses(builtin.query), `${key} must not read app_responses`).toBe(false)
      expect(
        isTrustedSystemCard({
          name: INSIGHT_WIDGET_MAP.get(key)!.label,
          query: builtin.query,
          createdBy: null,
        }),
        `${key} must not be trusted`,
      ).toBe(false)
    }
  })
})

describe('a user-authored card is never trusted', () => {
  it('is refused even when its query is byte-identical to a built-in', () => {
    // `createdBy` is the authorship marker. Trust must not be reachable by
    // copying a built-in's query into a card you own.
    expect(
      isTrustedSystemCard({
        name: INSIGHT_WIDGET_MAP.get('kpi-submissions')!.label,
        query: BUILTIN_QUERIES['kpi-submissions']!.query,
        createdBy: 'a-user-id',
      }),
    ).toBe(false)
  })

  it('a card whose query differs from every built-in is not trusted', () => {
    expect(
      isTrustedSystemCard({
        name: 'Submissions today',
        query: { version: 'bhql/1', display: 'table', stages: [{ source: 'incidents' }] },
        createdBy: null,
      }),
    ).toBe(false)
  })
})

describe('the built-in match survives how the query is stored', () => {
  const query = BUILTIN_QUERIES['kpi-submissions']!.query
  const name = INSIGHT_WIDGET_MAP.get('kpi-submissions')!.label

  it('matches when jsonb has reordered the keys', () => {
    // Postgres `jsonb` does not preserve key order, so a row read back from the
    // database never stringifies like the literal that produced it. This is what
    // made the match — and the whole card page — dead before the canonical
    // comparison. The nested reorder below is what jsonb actually produces for
    // this query (length, then bytewise).
    const reordered = JSON.parse(
      '{"pivot":null,"stages":[{"limit":null,"filter":{"rules":[{"op":"since_today","field":"submitted_at"}],"combinator":"and"},"source":"app_responses","aggregations":[{"fn":"count","alias":"count"}]}],"display":"table","version":"bhql/1"}',
    ) as BhqlQuery
    expect(Object.keys(reordered)).not.toEqual(Object.keys(query))
    expect(isTrustedSystemCard({ name, query: reordered, createdBy: null })).toBe(true)
  })

  it('matches when the parser materialised optional keys the literal omitted', () => {
    const withDefaults = JSON.parse(JSON.stringify(query)) as BhqlQuery
    withDefaults.stages[0]!.limit = null
    expect(isTrustedSystemCard({ name, query: withDefaults, createdBy: null })).toBe(true)
  })

  it('still refuses a genuinely different query that reuses the built-in name', () => {
    // Key order and optionality are noise; the query itself is the identity.
    expect(
      isTrustedSystemCard({
        name,
        query: {
          version: 'bhql/1',
          display: 'table',
          stages: [{ source: 'app_responses', filter: { combinator: 'and', rules: [] } }],
        },
        createdBy: null,
      }),
    ).toBe(false)
  })
})

describe('queryUsesAppResponses covers every place a source can be named', () => {
  const q = (stage: Record<string, unknown>): BhqlQuery =>
    ({ version: 'bhql/1', display: 'table', stages: [stage] }) as unknown as BhqlQuery

  it('finds a primary stage source', () => {
    expect(queryUsesAppResponses(q({ source: 'app_responses' }))).toBe(true)
  })

  it('finds a joined source', () => {
    expect(
      queryUsesAppResponses(
        q({ source: 'corrective_actions', joinedSources: [{ source: 'app_responses' }] }),
      ),
    ).toBe(true)
  })

  it('finds a spine dimension and a spine fact', () => {
    expect(
      queryUsesAppResponses(
        q({ source: 'x', spine: { dimensions: [{ alias: 'd', source: 'app_responses' }] } }),
      ),
    ).toBe(true)
    expect(
      queryUsesAppResponses(
        q({ source: 'x', spine: { facts: [{ alias: 'f', source: 'app_responses' }] } }),
      ),
    ).toBe(true)
  })

  it('reports false for a query that touches other modules only', () => {
    expect(
      queryUsesAppResponses(
        q({
          source: 'corrective_actions',
          joinedSources: [{ source: 'people' }],
          spine: { dimensions: [{ alias: 'd', source: 'incidents' }] },
        }),
      ),
    ).toBe(false)
  })
})
