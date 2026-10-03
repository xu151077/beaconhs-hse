// Contract: every manual article string must resolve in all three shipped locales.
//
// The runtime looks a translation up by `systemMessageKey(resolvedSource)` — the
// hash of the ENGLISH text, with interpolations already applied. If a body gains a
// `${CSV_EXPORT_LIMIT_GUIDANCE}` suffix, an apostrophe, or a reworded sentence and
// nobody re-keys it, the page still renders: it silently falls back to English.
// That failure is invisible in English and only surfaces for a Spanish or French
// reader, so it is asserted here instead.
//
// This covers the two Phase 11-E register articles. `systemMessageKey` is
// imported, never reimplemented, so the test and the runtime can never disagree.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { systemMessageKey } from '@beaconhs/i18n/key'
import { CSV_EXPORT_LIMIT_GUIDANCE } from './content/_shared'

const repoRead = (...segments: string[]) =>
  readFileSync(
    new URL(['..', '..', '..', '..', '..', ...segments].join('/'), import.meta.url),
    'utf8',
  )

const frontline = repoRead('apps', 'web', 'src', 'lib', 'manual', 'content', 'frontline.ts')

const catalogs = (['en', 'es', 'fr'] as const).map(
  (locale) =>
    [
      locale,
      (
        JSON.parse(
          readFileSync(
            new URL(`../../../../../packages/i18n/src/messages/${locale}.json`, import.meta.url),
            'utf8',
          ),
        ) as { Generated: Record<string, string> }
      ).Generated,
    ] as const,
)

/** The three strings the runtime translates for each article. */
const articleStrings = (slug: string) => {
  const start = frontline.indexOf(`slug: '${slug}'`)
  expect(start, `article ${slug} must exist in the manual`).toBeGreaterThan(-1)
  // Header fields only — the body is a multi-line template literal.
  const closeAt = frontline.indexOf('\n  },\n', start)
  const header = frontline.slice(start, closeAt > 0 ? closeAt : start + 4000)
  // The body runs to the first `,\n` after its opening backtick.
  const bodyStart = frontline.indexOf('body: `', start) + 'body: `'.length
  const bodyEnd = frontline.indexOf('`,\n', bodyStart)
  const body = frontline
    .slice(bodyStart, bodyEnd)
    .replaceAll('${CSV_EXPORT_LIMIT_GUIDANCE}', CSV_EXPORT_LIMIT_GUIDANCE)
  // Prettier wraps a long single-quoted value onto the next line, hence `\s*`.
  const field = (name: string) => {
    const m = new RegExp(`${name}:\\s*'([^']*)'`).exec(header)
    expect(m, `${slug} must declare ${name}`).not.toBeNull()
    return m![1]!
  }
  return { title: field('title'), summary: field('summary'), body }
}

const PHASE_11_E_ARTICLES = ['environmental-monitoring', 'statutory-register']

describe('manual articles resolve in every shipped locale', () => {
  it.each(PHASE_11_E_ARTICLES)(
    '%s — title, summary and body are translated in en/es/fr',
    (slug) => {
      for (const [part, value] of Object.entries(articleStrings(slug))) {
        const key = systemMessageKey(value)
        for (const [locale, generated] of catalogs) {
          expect(
            generated[key],
            `${slug} / ${part} has no ${locale} translation (key ${key})`,
          ).toBeTruthy()
          // A translation that is the English source verbatim is an untranslated stub.
          if (locale !== 'en') expect(generated[key]).not.toBe(value)
        }
      }
    },
  )

  it.each(PHASE_11_E_ARTICLES)('%s — body translations carry the shared CSV block', (slug) => {
    // Every list article ends with the same English CSV guidance, appended
    // verbatim to all three locales. If a translation omits it, the article
    // silently loses the export-limit warning.
    const { body } = articleStrings(slug)
    const key = systemMessageKey(body)
    for (const [, generated] of catalogs) {
      expect(generated[key]).toContain('CSV exports')
      expect(generated[key]).toContain('10,000 matching records')
    }
  })

  it('the two Phase 11-E articles are permission-gated on the response read ladder', () => {
    for (const slug of PHASE_11_E_ARTICLES) {
      const start = frontline.indexOf(`slug: '${slug}'`)
      const header = frontline.slice(start, frontline.indexOf('\n  },\n', start))
      for (const permission of [
        'forms.response.read.all',
        'forms.response.read.site',
        'forms.response.read.self',
      ]) {
        expect(header).toContain(permission)
      }
      // An icon key that does not exist in the ICONS map renders a silent Gauge.
      const icon = /iconKey: '([^']*)'/.exec(header)?.[1]
      const sidebar = repoRead('apps', 'web', 'src', 'components', 'sidebar-nav.tsx')
      expect(icon, `${slug} must declare an iconKey`).toBeTruthy()
      expect(sidebar).toMatch(new RegExp(`^\\s*${icon}: `, 'm'))
    }
  })

  it('no superseded guidance-less body key is left behind in the catalogs', () => {
    // Orphan catalog entries are dead weight: they can never be looked up again
    // because the runtime now computes the resolved hash.
    const superseded = ['m_02f41098bad391', 'm_0f339fafa81ea9']
    for (const key of superseded) {
      for (const [locale, generated] of catalogs) {
        expect(generated[key], `${key} must not linger in ${locale}.json`).toBeUndefined()
      }
    }
  })
})
