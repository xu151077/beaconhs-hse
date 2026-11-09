import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(import.meta.dirname, '..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') ? [path] : []
  })
}

/**
 * SQL LIKE patterns are the one unparameterised place where a user string
 * still shapes the query: a stray `%` or `_` in a search box turns a
 * substring search into a wildcard match (a lone `%` matches every row in
 * scope), and an unescaped backslash can corrupt the pattern itself. Every
 * ILIKE pattern built in this app must therefore escape its term with the
 * shared `escapeIlike`.
 *
 * This test scans for every `%${…}%` template in app source (both direct
 * `ilike(col, \x60%${q}%\x60)` interpolations and `const term = \x60%${q}%\x60`
 * assignments feeding them) and fails if any inner expression does not call
 * the canonical escaper. New search widgets must use `escapeIlike` instead of
 * growing another local copy — the three copies that existed before this
 * contract is exactly the duplication it exists to prevent.
 */
describe('ILIKE pattern escaping', () => {
  it('every interpolated search pattern escapes its term', () => {
    const violations: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/`%\$\{([^}]+)\}%`/g)) {
        const expression = match[1]!.trim()
        if (
          expression.startsWith('escapeIlike(') ||
          expression.startsWith('escapeAiConversationSearch(')
        ) {
          continue
        }
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${file}:${line}: ${expression}`)
      }
    }
    expect(violations).toEqual([])
  })
})
