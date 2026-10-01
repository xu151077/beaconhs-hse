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

  it('takes every authorization input from the run-as context, with nothing to omit', () => {
    // The run's whole read boundary is `requestCtx`: the permission set, the
    // `{type:'sites'}` Role Scope, the person and the membership. There is no
    // second dimension to resolve and therefore nothing a caller can forget to
    // pass — which is the fail-open failure mode this replaced.
    const call = workerSource.slice(
      workerSource.indexOf('scopeReportSourcesForRunAs('),
      workerSource.indexOf(')', workerSource.indexOf('scopeReportSourcesForRunAs(')) + 1,
    )
    expect(call).toContain('requestCtx')
    expect(call).toContain('discovered')
    // No scope resolution on this path at all.
    expect(workerSource).not.toContain('resolveProjectScopeIn')
    expect(workerSource).not.toContain('ProjectScope')
    expect(workerSource).not.toContain('projectScope')
    // The worker must not reach into the web app for authorization either.
    expect(workerSource).not.toMatch(/from '@\/lib\/|from ['"]\.\.\/\.\.\/apps\/web/)
  })
})
