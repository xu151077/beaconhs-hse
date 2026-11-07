import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Portrait-phone contract: shared chrome must wrap instead of overflowing.
 *
 * Measured on a 390px viewport, the page header's action group and the
 * module/tab strips pushed pills and buttons past the right edge (up to
 * 496px), so controls were cut off with no way to reach them. These
 * assertions pin the wrapping so a future edit cannot silently restore the
 * horizontal-overflow layout.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('portrait phone wrapping', () => {
  it('page header moves actions below the title on phones', () => {
    const header = source('../../../../packages/ui/src/page-header.tsx')
    expect(header).toContain('w-full flex-wrap items-center justify-start gap-2 sm:w-auto')
    expect(header).toContain('basis-40')
  })

  it.each([
    '../components/module-admin/module-sub-nav.tsx',
    '../components/section-nav.tsx',
    '../components/tab-nav.tsx',
  ])('tab strip wraps at every breakpoint: %s', (path) => {
    const strip = source(path)
    expect(strip).toContain('flex-wrap')
    expect(strip).not.toContain('flex-nowrap')
    expect(strip).not.toContain('overflow-x-auto')
  })
})
