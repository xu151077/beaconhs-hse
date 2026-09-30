import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * F1 regression guard for the CSV/XLSX/PDF export path.
 *
 * The browser verification found the same tenant-wide rows leaking through the
 * export as through the on-screen table. That is expected: the export handler
 * and the report page both call `runReportForViewer`, which is one of three
 * call sites of `runBeaconReport`, and all three build the catalog through
 * `loadAuthorizedReportCatalogInTransaction` — the scoped one — inside the
 * caller's tenant executor.
 *
 * That is a structural property, and structural properties are what a later
 * change breaks silently. These tests assert the wiring of *every* call site, so
 * a new unscoped execution path cannot be added without turning a test red.
 */

// this file lives at apps/web/src/lib, so the reports tree is one level up
const REPORTS_DIR = join(import.meta.dirname, '..', 'app', '(app)', 'reports')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const files = walk(REPORTS_DIR)
const read = (path: string) => readFileSync(path, 'utf8')
const rel = (path: string) => path.replace(REPORTS_DIR, '')
const callers = files.filter((f) => read(f).includes('runBeaconReport('))

describe('every report execution path is scoped', () => {
  it('finds the reports source tree', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('enumerates the call sites so a new one cannot slip past this file', () => {
    // The on-screen page, the export handler, and the studio/viewer server actions.
    expect(callers.map(rel).sort()).toEqual([
      '/_run.ts',
      '/_studio/actions.ts',
      '/_viewer/actions.ts',
    ])
  })

  it.each(callers.map(rel))('%s builds the catalog through the scoped loader', (name) => {
    const source = read(join(REPORTS_DIR, name))
    expect(source, name).toContain('loadAuthorizedReportCatalogInTransaction')
  })

  it.each(callers.map(rel))('%s never imports the unscoped catalog loader', (name) => {
    const source = read(join(REPORTS_DIR, name))
    expect(source, name).not.toContain('loadBeaconReportCatalog')
  })

  it.each(callers.map(rel))('%s runs inside the caller tenant executor', (name) => {
    const source = read(join(REPORTS_DIR, name))
    const at = source.indexOf('runBeaconReport(')
    expect(at, name).toBeGreaterThan(-1)
    // The executor opened for this call must be the tenant-scoped one. A
    // `withSuperAdmin(db, …)` wrapper in that span would bypass tenant RLS.
    const opened = source.lastIndexOf('ctx.db(', at)
    expect(opened, `${name} does not open ctx.db before running the report`).toBeGreaterThan(-1)
    expect(
      source.slice(opened, at),
      `${name} wraps the run in a non-tenant executor`,
    ).not.toContain('withSuperAdmin')
  })

  it('routes the export handler and the report page through the shared helper', () => {
    for (const path of [
      join(REPORTS_DIR, 'definitions', '[id]', 'export', 'route.ts'),
      join(REPORTS_DIR, 'definitions', '[id]', 'page.tsx'),
    ]) {
      const source = read(path)
      expect(source, path).toContain('runReportForViewer')
      expect(source, path).not.toContain('runBeaconReport(')
    }
  })

  it('reaches the scoped catalog from every reports module that loads one', () => {
    const loaders = files.filter((f) =>
      read(f).includes('loadAuthorizedReportCatalogInTransaction'),
    )
    // On-screen page + export, the studio and viewer server actions, and the
    // schedule data/action pair that seeds the worker's run-as. None of them may
    // fall back to the raw catalog.
    expect(loaders.map(rel).sort()).toEqual([
      '/_run.ts',
      '/_studio/actions.ts',
      '/_viewer/actions.ts',
      '/schedules/_data.ts',
      '/schedules/actions.ts',
    ])
    for (const file of loaders) {
      expect(read(file), rel(file)).not.toContain('loadBeaconReportCatalog')
    }
  })
})
