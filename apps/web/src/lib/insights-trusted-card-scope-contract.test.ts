// 15B-3C — authorization contract for the Insights TRUSTED SYSTEM KPI path.
//
// THE PRODUCT DECISION THIS FILE PINS
//
// Two built-in Overview cards read the `app_responses` entity:
//
//   kpi-submissions                  count(app_responses) where submitted_at since_today
//   kpi-monitored-sessions-active   count(app_responses) where monitor_status = 'active'
//
// Each is a single scalar `count`. No `groupBy`, no person field, no site field,
// no row-level output. They are therefore tenant-wide SYSTEM METRICS by design,
// not Project-Scope-scoped views, and `app_responses` stays on the analytics
// `ALWAYS_ALLOWED` list.
//
// The permission that unlocks them is `forms.response.read.all` — and ONLY that.
// `forms.response.read.site` deliberately does not authorize them, which is the
// point of this file: before the decision, `read.site` was accepted, so a foreman
// saw a tenant-wide total on a KPI that is a system metric.
//
// WHY THE PERMISSION HALF LIVES HERE AND NOT IN THE ANALYTICS SUITE
//
// `scopeAnalyticsEntities` short-circuits on `ALWAYS_ALLOWED` before it ever reads
// a permission, so it cannot distinguish `read.all` from `read.site` — by design,
// and the analytics suite documents that as "granted, caller gate is separate".
// The gate is `canReadAppResponses`, so the permission cases are asserted HERE,
// against the real function, rather than as a source string.
//
// The behavioural assertions import the real module. `analytics-access.ts` opens
// with `import 'server-only'`, which throws under vitest, so that one import is
// stubbed — no production code is altered and no logic is re-implemented here.
//
// NOT ASSERTED, AND DELIBERATELY SO
//
//   • that the two cards' queries aggregate — that is `_widgets.ts`'s own concern
//     and `_widgets.test.ts` already compiles every built-in query
//   • anything about ordinary form-response records, which keep their normal
//     Project Scope narrowing; the analytics suite pins that boundary directly
//   • source line numbers or Prettier wrapping — no line slicing anywhere here

import { describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '@beaconhs/tenant'

vi.mock('server-only', () => ({}))

const { canReadAppResponses } = await import('./analytics-access')

const READ_ALL = 'forms.response.read.all'
const READ_SITE = 'forms.response.read.site'
const READ_SELF = 'forms.response.read.self'

const ctx = (...permissions: string[]) =>
  ({ permissions: new Set(permissions) }) as unknown as RequestContext

// ---------------------------------------------------------------------------
// 1. The permission matrix
// ---------------------------------------------------------------------------

describe('15B-3C — the trusted KPI is authorized by read.all alone', () => {
  it('read.all is authorized (Case A/B/G/H all depend on this)', () => {
    expect(canReadAppResponses(ctx(READ_ALL))).toBe(true)
  })

  it('read.site does NOT authorize it (Case C/D)', () => {
    // The regression this change exists to prevent. A site-scoped reader sees
    // the tenant-wide total nowhere else in the product.
    expect(canReadAppResponses(ctx(READ_SITE))).toBe(false)
  })

  it('read.self does not authorize it (Case E)', () => {
    expect(canReadAppResponses(ctx(READ_SELF))).toBe(false)
  })

  it('no response read permission does not authorize it (Case F)', () => {
    expect(canReadAppResponses(ctx())).toBe(false)
    expect(canReadAppResponses(ctx('incidents.read.all'))).toBe(false)
  })

  it('a site-tier reader holding OTHER module permissions is still denied', () => {
    // Narrowing the check to one key must not become "any read.all anywhere".
    expect(
      canReadAppResponses(
        ctx(READ_SITE, 'incidents.read.all', 'ppe.read.all', 'journals.read.all'),
      ),
    ).toBe(false)
  })

  it('read.all wins even when a narrower tier is also held', () => {
    // Holding all three is still all-tier; the KPI stays authorized.
    expect(canReadAppResponses(ctx(READ_SELF, READ_SITE, READ_ALL))).toBe(true)
  })

  it('the tenant-wide capability is a permission, not a scope', () => {
    // `canReadAppResponses` reads no Project Scope at all, which is precisely
    // why an `empty` or unresolved scope cannot block it (analytics Cases G/H).
    // This is the documented exception; it must not be mistaken for a fail-open,
    // because the permission above is unconditional.
    expect(canReadAppResponses(ctx(READ_ALL))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. The exemption is scoped to the KPI alias, not to the records
// ---------------------------------------------------------------------------

describe('15B-3C — the tenant-wide grant does not spread to form responses', () => {
  it('a site-tier reader is denied here but keeps their scope elsewhere', () => {
    // The two facts that must not be conflated, asserted together:
    //
    //   Apps Responses (ordinary records) -> Project Scope applies
    //   Insights trusted KPI               -> DENIED without read.all
    //
    // Only `canReadAppResponses` is narrowed by this decision.
    // `moduleScopeWhere` and `projectScopePredicate` are untouched, so a
    // `read.site` holder is still narrowed on the records themselves — the
    // analytics suite asserts that half against the same underlying table.
    expect(canReadAppResponses(ctx(READ_SITE))).toBe(false)
  })

  it('narrowing the gate did not turn it into a different permission', () => {
    // If someone re-broadened it, or swapped it for another key, these fail.
    expect(canReadAppResponses(ctx(READ_ALL))).toBe(true)
    expect(canReadAppResponses(ctx(READ_ALL, READ_SITE))).toBe(true)
    expect(canReadAppResponses(ctx(READ_SITE, READ_SELF))).toBe(false)
  })
})
