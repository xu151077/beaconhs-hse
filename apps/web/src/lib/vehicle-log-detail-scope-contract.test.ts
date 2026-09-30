// Vehicle-log detail authorization contract.
//
// The register list gates on an equipment read tier and scopes rows through the
// PARENT VEHICLE (_equipment-policy.ts). The per-entry detail page must resolve
// the same decision, otherwise any user can read a log entry by guessing its
// id — the read-by-URL gap the equipment asset page already closes.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(
  new URL('../app/(app)/equipment/vehicle-log/[id]/page.tsx', import.meta.url),
  'utf8',
)

describe('vehicle-log detail authorization', () => {
  it('gates the page component on the same read tier as the register list', () => {
    const component = PAGE.slice(PAGE.indexOf('export default async function TruckLogDetailPage'))
    expect(component).toContain("!can(ctx, 'equipment.read.all')")
    expect(component).toContain("!can(ctx, 'equipment.read.site')")
    expect(component).toContain("!can(ctx, 'equipment.manage')")
    expect(component).toContain("redirect('/dashboard')")
    // The gate must be reachable before any record is fetched.
    expect(component.indexOf("!can(ctx, 'equipment.read.all')")).toBeLessThan(
      component.indexOf('await ctx.db('),
    )
  })

  it('keeps the narrower ?tab=edit capability gate', () => {
    expect(PAGE).toContain("const canManage = can(ctx, 'equipment.manage')")
    expect(PAGE).toContain("if (active === 'edit' && !canManage) redirect")
  })

  it("re-checks the loaded entry with canSeeRecord on the parent vehicle's columns", () => {
    expect(PAGE).toContain("import { canSeeRecord } from '@/lib/visibility'")
    const call = PAGE.slice(PAGE.indexOf('const visible = await canSeeRecord'))
    expect(call).toContain("prefix: 'equipment',")
    expect(call).toContain('siteId: row.truck?.currentSiteOrgUnitId ?? null')
    expect(call).toContain('personId: row.truck?.currentHolderPersonId ?? null')
    // Not the entry's own site column — that is the whole point of the fix.
    expect(call).not.toContain('row.entry.siteOrgUnitId')
    expect(PAGE).toContain('if (!visible) return null')
  })

  it('applies the check inside the same RLS-bounded transaction as the fetch', () => {
    const db = PAGE.slice(PAGE.indexOf('const data = await ctx.db('))
    const fetch = db.slice(0, db.indexOf('const visible = await canSeeRecord'))
    expect(fetch).toContain('from(truckLogEntries)')
    expect(fetch).toContain(
      'leftJoin(equipmentItems, eq(equipmentItems.id, truckLogEntries.equipmentItemId))',
    )
  })
})
