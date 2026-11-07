import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { getAppMessages, systemMessageKey } from '@beaconhs/i18n/messages'
import { findRuntimeUserFacingLiterals } from '../../scripts/i18n-runtime-audit'
import { findSourceAudit, findUserFacingSourceLiterals } from '../../scripts/i18n-source-audit'
import { FRONTLINE_ARTICLES } from '../lib/manual/content/frontline'
import { GETTING_STARTED_ARTICLES } from '../lib/manual/content/getting-started'
import { KNOWLEDGE_ASSETS_ARTICLES } from '../lib/manual/content/knowledge-assets'
import { OVERSIGHT_ADMIN_ARTICLES } from '../lib/manual/content/oversight-admin'
import { MANUAL_GROUP_ORDER } from '../lib/manual/types'
import { WALKTHROUGHS } from '../lib/walkthroughs/registry'

const SOURCE_ROOT = resolve(import.meta.dirname, '..')
const UI_SOURCE_ROOT = resolve(SOURCE_ROOT, '../../../packages/ui/src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry)
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')
        ? [path]
        : []
  })
}

function uiTranslationSources(): string[] {
  const sources: string[] = []
  for (const file of sourceFiles(UI_SOURCE_ROOT)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't'
      ) {
        const source = node.arguments[0]
        if (source && (ts.isStringLiteral(source) || ts.isNoSubstitutionTemplateLiteral(source))) {
          sources.push(source.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sources
}

describe('i18n source coverage', () => {
  const generated = getAppMessages('en').Generated
  // The catalogues are typed off the concrete key union, so indexing them with a
  // freshly hashed key needs the widened view. Indexing by `in` first is what
  // actually asserts presence; the widened index is only for the assertions below.
  const catalogueOf = (locale: 'en' | 'fr' | 'es' | 'zh') =>
    getAppMessages(locale).Generated as Record<string, string | undefined>
  const runtimeCandidates = findRuntimeUserFacingLiterals()
  const sourceAudit = findSourceAudit()

  it('contains no untranslated JSX or user-facing attributes', () => {
    expect(sourceAudit.violations).toEqual([])
    expect(findUserFacingSourceLiterals({ roots: [UI_SOURCE_ROOT], base: UI_SOURCE_ROOT })).toEqual(
      [],
    )
  }, 20_000)

  it('catalogs every <option> label so Select can translate it at render time', () => {
    const missing = sourceAudit.optionLabels.filter(
      (label) => !(systemMessageKey(label.source) in generated),
    )
    expect(missing).toEqual([])
  }, 20_000)

  it('catalogs every programmatic label, prompt, message, and error', () => {
    const missing = runtimeCandidates.filter(
      (candidate) => !(systemMessageKey(candidate.source) in generated),
    )
    expect(missing).toEqual([])
  }, 20_000)

  it('contains every generated key referenced by application source', () => {
    const missing: Array<{ file: string; key: string }> = []
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/["'](m_[a-f0-9]{14})["']/g)) {
        const key = match[1]!
        if (!(key in generated)) missing.push({ file, key })
      }
    }
    expect(missing).toEqual([])
  })

  it('uses request-aware metadata instead of static English metadata', () => {
    const offenders = sourceFiles(resolve(SOURCE_ROOT, 'app')).filter((file) =>
      /export const metadata\b/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
    expect(
      runtimeCandidates.filter((candidate) => candidate.container === 'generateMetadata'),
    ).toEqual([])
  })

  it('catalogs prose passed through GeneratedValue props', () => {
    // A second instance of the same blind spot. The source audit's
    // USER_FACING_ATTRIBUTES deliberately omits `value`, because ~189 enum
    // tokens (`list`, `daily`, `source_wins`, …) legitimately reach
    // `<GeneratedValue value={row.kind} />` and MUST pass through untranslated.
    // The cost is that real PROSE in a `value` prop escapes the audit too — five
    // Builder/Admin strings shipped untranslated in every locale before this.
    //
    // So enumerate the prose explicitly rather than widening the audit.
    const prose = [
      '= computed',
      'A specific person',
      'Specific email address(es)',
      'Attached files',
      'All active people',
    ]
    for (const source of prose) {
      const key = systemMessageKey(source)
      expect(key in generated, `${source} is not in the English catalogue`).toBe(true)
      for (const locale of ['fr', 'es', 'zh'] as const) {
        const entry = catalogueOf(locale)[key]
        expect(entry, `${source} is missing from ${locale}`).toBeTypeOf('string')
        expect(entry, `${source} renders in English under ${locale}`).not.toBe(source)
      }
    }
  })

  it('catalogs the user-guide group headings', () => {
    // Regression guard. `/help` renders its group headings with
    // `<GeneratedValue value={group} />`, so they reach the catalogue only if a
    // literal EQUALS a catalogue entry. The AST audit scans JSX attributes and
    // literals at the render site, and `MANUAL_GROUP_ORDER` is an exported
    // constant consumed through a prop — a blind spot that let all six headings
    // ship untranslated in EVERY locale (en/fr/es/zh).
    //
    // So assert on the constant itself rather than on the render site.
    const missing = MANUAL_GROUP_ORDER.filter((group) => !(systemMessageKey(group) in generated))
    expect(missing, 'these /help group headings are not in any message catalogue').toEqual([])

    // And assert the Chinese catalogue actually translates them, not merely
    // contains them — a key present but equal to English still renders English.
    const untranslated = MANUAL_GROUP_ORDER.filter((group) => {
      const entry = catalogueOf('zh')[systemMessageKey(group)]
      return entry === undefined || entry === group
    })
    expect(untranslated, 'these /help group headings render in English under zh').toEqual([])
  })

  it('catalogs built-in user-guide articles and guided-tour steps', () => {
    const articles = [
      ...GETTING_STARTED_ARTICLES,
      ...FRONTLINE_ARTICLES,
      ...KNOWLEDGE_ASSETS_ARTICLES,
      ...OVERSIGHT_ADMIN_ARTICLES,
    ]
    const longFormCopy = [
      ...articles.map((article) => article.body),
      ...WALKTHROUGHS.flatMap((walkthrough) => walkthrough.steps.map((step) => step.body)),
    ]
    expect(longFormCopy.filter((copy) => !(systemMessageKey(copy) in generated))).toEqual([])
  })

  it('catalogs every framework-agnostic UI primitive string', () => {
    expect(uiTranslationSources().filter((copy) => !(systemMessageKey(copy) in generated))).toEqual(
      [],
    )
  })
})
