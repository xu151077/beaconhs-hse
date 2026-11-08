import { describe, expect, it } from 'vitest'
import { WIDGETS } from './_widget-registry'
import {
  canPermissionSetPublishInsights,
  canPermissionSetSeeWidget,
  canPermissionSetViewInsights,
  canSeeOrgAggregates,
  canSeeWidget,
} from './_widget-access'

function context(permissions: string[], isSuperAdmin = false) {
  return {
    isSuperAdmin,
    permissions: new Set(permissions),
  } as Parameters<typeof canSeeWidget>[0]
}

describe('dashboard widget access', () => {
  const worker = context([
    'incidents.read.self',
    'ca.read.self',
    'journals.read.self',
    'forms.response.read.self',
    'inspections.read.self',
    'hazid.read.self',
    'training.read.self',
    'documents.read',
  ])
  const manager = context([
    'incidents.read.all',
    'ca.read.all',
    'training.read.all',
    'ppe.read.all',
    'forms.response.read.all',
    'inspections.read.all',
    'documents.manage',
    'admin.org.manage',
    // The built-in `safety_manager` role holds `journals.read.all` (iam.ts), so a
    // safety manager sees the safety-observations widget. Without this the fixture
    // understated the role and failed to see an org widget it really may see.
    'journals.read.all',
    'reports.read',
    'insights.read',
  ])

  it('limits self-tier users to personal widgets', () => {
    for (const id of Object.keys(WIDGETS)) {
      expect(canSeeWidget(worker, id), id).toBe(id.startsWith('personal-'))
    }
    expect(canSeeOrgAggregates(worker)).toBe(false)
  })

  it('allows managers to see registry and Insights widgets', () => {
    for (const id of Object.keys(WIDGETS)) {
      expect(canSeeWidget(manager, id), id).toBe(true)
    }
    expect(canSeeWidget(manager, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
    expect(canSeeOrgAggregates(manager)).toBe(true)
  })

  it('allows super-admins to see every widget', () => {
    const superAdmin = context([], true)
    expect(canSeeWidget(superAdmin, 'kpi-open-cas')).toBe(true)
    expect(canSeeWidget(superAdmin, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
  })

  it('fails closed for an unknown non-UUID widget id', () => {
    // Only a placed Insights card (a UUID) may use the analytics fallback. A
    // typo or a future custom id must not be treated as "personal".
    expect(canSeeWidget(context([], true), 'kpi-not-registered')).toBe(false)
    expect(canSeeWidget(manager, 'kpi-not-registered')).toBe(false)
    expect(canPermissionSetSeeWidget(new Set(['insights.read']), 'kpi-not-registered')).toBe(false)
  })

  it('does not treat report or dashboard permissions as Insights access', () => {
    expect(canPermissionSetViewInsights(['reports.read'])).toBe(false)
    expect(canPermissionSetViewInsights(['dashboards.read'])).toBe(false)
    expect(canPermissionSetViewInsights(['insights.read'])).toBe(true)
    expect(canPermissionSetPublishInsights(['reports.builder'])).toBe(false)
    expect(canPermissionSetPublishInsights(['insights.publish'])).toBe(true)
  })

  // 15B-3C — widget eligibility must equal the KPI's real authorization.
  //
  // `op-submissions-today` and `op-monitored-sessions-active` render as the
  // Insights system cards that read the tenant-wide `app_responses` aggregate.
  // That data is released by `canReadAppResponses`, which is
  // `forms.response.read.all` ALONE — so a viewer admitted here by any other
  // permission reaches a card that then refuses to run and renders empty. These
  // assertions drive the real `canSeeWidget`, not a source string, and they
  // cover BOTH widgets so neither can drift back on its own.
  describe('15B-3C — the two trusted response KPI widgets', () => {
    const KPI_WIDGETS = ['op-submissions-today', 'op-monitored-sessions-active'] as const

    it.each(KPI_WIDGETS)('%s is allowed for forms.response.read.all (Cases A/D)', (id) => {
      expect(canSeeWidget(context(['forms.response.read.all']), id)).toBe(true)
    })

    it.each(KPI_WIDGETS)('%s is denied for forms.response.read.site (Cases B/E)', (id) => {
      expect(canSeeWidget(context(['forms.response.read.site']), id)).toBe(false)
    })

    it.each(KPI_WIDGETS)('%s is denied for forms.response.read.self (Cases C/F)', (id) => {
      expect(canSeeWidget(context(['forms.response.read.self']), id)).toBe(false)
    })

    it.each(KPI_WIDGETS)('%s is denied with no response permission at all', (id) => {
      expect(canSeeWidget(context([]), id)).toBe(false)
    })

    it.each(KPI_WIDGETS)('%s is not admitted by analytics access alone', (id) => {
      // The second former admission path. A `foreman` holds all three, so
      // narrowing only `FORMS` would have left the error tile in place.
      expect(canSeeWidget(context(['insights.read', 'reports.read', 'dashboards.read']), id)).toBe(
        false,
      )
    })

    it.each(KPI_WIDGETS)('%s still reaches a super-admin', (id) => {
      expect(canSeeWidget(context([], true), id)).toBe(true)
    })
  })

  it('does not narrow the header tenant summary, which is a different question', () => {
    // `FORMS` is shared with `canSeeOrgAggregates`, and a KPI decision must not
    // reach it. A site-tier forms reader still counts as seeing an org aggregate.
    expect(canSeeOrgAggregates(context(['forms.response.read.site']))).toBe(true)
    expect(canSeeOrgAggregates(context(['forms.response.read.self']))).toBe(false)
  })
})
