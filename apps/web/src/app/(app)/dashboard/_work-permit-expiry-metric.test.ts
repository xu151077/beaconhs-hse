// Phase 11-F Step 2 item A — Work Permit Expiry dashboard metric + widget.
//
// A monitored session is a `form_responses` row carrying a `monitor_status`, so this
// metric must NOT invent a permit module, a permit table, or a permit permission. It
// reuses the Builder response ladder the module already governs, and it must select
// exactly the rows the seeded `work_permit_expiry` report selects — otherwise the tile
// and the report would disagree about what is expiring.
//
// Structural assertions read the source; the scope predicate itself is proven against
// the live resolver in `_metrics-scope.test.ts`, and tenant binding rides `ctx.db` RLS.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = () => readFileSync(new URL('./_metrics.ts', import.meta.url), 'utf8')
const readRegistry = () => readFileSync(new URL('./_widget-registry.ts', import.meta.url), 'utf8')
const readViews = () => readFileSync(new URL('./_widget-views.tsx', import.meta.url), 'utf8')

describe('work permit expiry metric selects the same rows as the seeded report', () => {
  it('counts form_responses, not a permit table', () => {
    const source = readSource()
    expect(source).toContain('workPermitExpiry')
    expect(source).toContain('.from(formResponses)')
    // No parallel permit lifecycle.
    expect(source).not.toMatch(/work_permits|workPermits|permit_expiry_table/i)
  })

  it('keeps only sessions that can still expire', () => {
    const source = readSource()
    // `completed` and `cancelled` are closed out; only a live, missed or escalated
    // session can still need closing. Identical to the seeded report's filter.
    expect(source).toContain(
      "inArray(formResponses.monitorStatus, ['active', 'missed', 'escalated'])",
    )
    // A session with no expected end has nothing to expire against.
    expect(source).toContain('isNotNull(formResponses.expectedEndAt)')
  })

  it('looks ahead 7 days as an upper bound, so overdue sessions still surface', () => {
    const source = readSource()
    expect(source).toContain('permitExpiryHorizon')
    expect(source).toContain('const permitExpiryHorizon = new Date(now.getTime() + 7 * 86_400_000)')
    expect(source).toContain('lte(formResponses.expectedEndAt, permitExpiryHorizon)')
    // Upper bound only — matching `due_within_days`, which is also an upper bound.
    // Adding a lower bound would silently hide the most overdue rows.
    expect(source).not.toMatch(/gte\(formResponses\.expectedEndAt/)
    // The already-overdue subset is carried for the caption.
    expect(source).toContain('overdue: sql<number>')
  })

  it('reuses the forms.response ladder and Builder app access, adding no permission', () => {
    const source = readSource()
    // Same resolved scope the rest of the dashboard uses, so a site- or self-scoped
    // caller cannot see another site's sessions.
    expect(source).toContain('scopeFormResponses')
    // Builder app-level access, identical to `monitoredSessionsActive`.
    expect(source).toContain("templateAccessWhere(ctx, effectiveRoleKeys, 'browse-records')")
    // No new permission key and no new ladder for this metric.
    expect(source).not.toMatch(/prefix: 'permit|prefix: 'work_permit/)
  })

  it('excludes soft-deleted responses', () => {
    expect(readSource()).toContain('isNull(formResponses.deletedAt)')
  })

  it('reports zero rather than null when nothing is due', () => {
    // `0` means "nothing expiring"; a null would read as "not available to you", which
    // is the distinct meaning `peopleCount` uses. MIN() over no rows is SQL NULL, so
    // the coalesce has to be explicit.
    const source = readSource()
    expect(source).toContain('total: Number(permitExpiryRow?.total ?? 0)')
    expect(source).toContain('overdue: Number(permitExpiryRow?.overdue ?? 0)')
    expect(source).toContain('nextExpiryAt: permitExpiryRow?.nextExpiryAt ?? null')
  })
})

describe('work permit expiry widget is registered and rendered', () => {
  it('is declared in the widget registry', () => {
    const registry = readRegistry()
    expect(registry).toContain("'op-work-permit-expiry-7d': {")
    expect(registry).toContain("category: 'operations'")
    // Role-gated like the other operational tiles, not shown to everyone.
    expect(registry).toContain('rolesShown:')
  })

  it('is bound to the trusted-response permission group, like its sibling tiles', () => {
    // `canSeeWidget` keys off `WIDGET_PERMISSIONS`, NOT `rolesShown`. A widget absent
    // from that map falls through to "visible to everyone", which would have exposed a
    // tenant-wide expiry count to a self-tier worker. Reusing `TRUSTED_RESPONSE_KPI`
    // keeps it aligned with `op-monitored-sessions-active` and adds no new permission.
    const access = readFileSync(new URL('./_widget-access.ts', import.meta.url), 'utf8')
    expect(access).toContain("const TRUSTED_RESPONSE_KPI = ['forms.response.read.all']")
    expect(access).toContain("'op-work-permit-expiry-7d': TRUSTED_RESPONSE_KPI")
    // And the registry must therefore not be the only thing gating it.
    expect(access).not.toContain("'op-work-permit-expiry-7d': [")
  })

  it('renders a count tile linking to the monitored sessions list', () => {
    const views = readViews()
    expect(views).toContain("case 'op-work-permit-expiry-7d':")
    expect(views).toContain('value={data.workPermitExpiry.total}')
    expect(views).toContain('href="/apps/sessions"')
  })

  it('escalates the tone only when something is already overdue', () => {
    const views = readViews()
    expect(views).toContain("data.workPermitExpiry.overdue > 0 ? 'danger' : 'normal'")
  })

  it('uses localized strings for the label and both captions', () => {
    const views = readViews()
    expect(views).toContain("tGenerated('m_12d8f269bb53bc')")
    expect(views).toContain("tGenerated('m_10cb285ec490ee'")
    expect(views).toContain("tGenerated('m_0759b2c8e5c526')")
  })

  it('ships those strings in every enabled locale', () => {
    const locales = ['en', 'es', 'fr']
    const keys = ['m_12d8f269bb53bc', 'm_10cb285ec490ee', 'm_0759b2c8e5c526']
    for (const locale of locales) {
      const catalog = JSON.parse(
        readFileSync(
          new URL(`../../../../../../packages/i18n/src/messages/${locale}.json`, import.meta.url),
          'utf8',
        ),
      ) as { Generated: Record<string, string> }
      for (const key of keys) {
        expect(catalog.Generated[key], `${locale} is missing ${key}`).toBeTruthy()
      }
    }
  })
})
