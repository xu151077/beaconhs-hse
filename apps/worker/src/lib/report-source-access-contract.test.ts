import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(new URL('../workers/reports.ts', import.meta.url), 'utf8')

describe('scheduled report source authorization contract', () => {
  it('rebuilds the Insights source inventory for the run-as member', () => {
    expect(workerSource).toContain('resolveMembershipAccess')
    expect(workerSource).toContain(
      "canAccessTemplate(requestCtx, template, resolved.roleKeys, 'operate')",
    )
    expect(workerSource).toContain('discoverEntitiesWithScopedApps')
    expect(workerSource).toContain('loadBeaconReportCatalog(tx, sources)')
  })

  it('does not fall back to the static report-only source inventory', () => {
    expect(workerSource).not.toMatch(/loadBeaconReportCatalog\(tx\)(?!,)/)
  })

  it('applies the run-as member row scope to the sources, not just the app list', () => {
    // `canAccessTemplate` only gates which Builder apps are visible. Without
    // this call the run would compile against a tenant-wide source inventory
    // and report rows the impersonated member cannot read by hand.
    expect(workerSource).toContain('scopeReportSourcesForRunAs(')
  })

  it('resolves and passes the run-as member Project Scope', () => {
    // 15B-3B. Two restrictions now apply to a scheduled run, not one: the read
    // tier AND the personnel placement. The scope must be resolved from the same
    // resolver the web app uses, inside the run's own tenant transaction, and
    // passed in — omitting it fails closed and would silently return no rows.
    expect(workerSource).toContain('resolveProjectScopeIn')
    expect(workerSource).toContain('await resolveProjectScopeIn(requestCtx, tx)')
    // The worker must not reach into the web app for it.
    expect(workerSource).not.toMatch(/from '@\/lib\/|from ['"]\.\.\/\.\.\/apps\/web/)
  })
})
