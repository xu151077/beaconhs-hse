import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A bundled worker process cannot resolve `@beaconhs/storage` at runtime: the
 * specifier points at raw TypeScript under `node_modules`, and Node refuses to
 * type-strip files there
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
 *
 * `bootstrapStorageFreezeGate()` without an explicit module therefore fails
 * closed *and silently*: it logs, leaves the gate unregistered, and every
 * controlled storage mutation in the worker is then refused with
 * `STORAGE_FREEZE_STATE_UNKNOWN` — forever. Every call site must pass the
 * statically imported module (the web app does the same in
 * `apps/web/src/instrumentation.ts`).
 *
 * This guards the call sites, not the callee: the callee's own contract (an
 * empty module registers nothing and never throws) is covered by
 * `packages/db/src/storage-freeze-operations.test.ts`.
 */

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      found.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(full)
    }
  }
  return found
}

describe('worker storage freeze gate bootstrap', () => {
  it('passes a statically imported storage module at every call site', () => {
    const offenders: string[] = []
    let callSites = 0

    for (const file of sourceFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('bootstrapStorageFreezeGate')) continue
      callSites += 1
      if (/bootstrapStorageFreezeGate\(\s*\)/.test(source)) {
        offenders.push(`${file}: called with no module argument`)
      }
      if (!source.includes("from '@beaconhs/storage'")) {
        offenders.push(`${file}: no static '@beaconhs/storage' import to pass`)
      }
    }

    expect(callSites).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
