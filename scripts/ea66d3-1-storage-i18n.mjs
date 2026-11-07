// Add the first-run object-storage gateway copy to the four catalogues.
//
// The upload gateway returns short, specific messages for a rejected upload.
// They are catalogued so the browser sees the operator's language rather than
// an English server string.
//
// The key is derived from the English source with the same `systemMessageKey`
// the runtime uses.
//
// Usage: node scripts/ea66d3-1-storage-i18n.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { systemMessageKey } from '../packages/i18n/src/system-key.ts'

/** name -> [en, es, fr, zh]. The en value IS the source string. */
const TRANSLATIONS = {
  invalidContentLength: [
    'Invalid Content-Length',
    'Content-Length no válido',
    'Content-Length non valide',
    'Content-Length 无效',
  ],
  contentLengthRequired: [
    'Content-Length is required',
    'Se requiere Content-Length',
    'Content-Length est requis',
    '需要 Content-Length',
  ],
  fileTooLarge: [
    'File is too large',
    'El archivo es demasiado grande',
    'Le fichier est trop volumineux',
    '文件过大',
  ],
}

const LOCALES = ['en', 'es', 'fr', 'zh']
const base = new URL('../packages/i18n/src/messages/', import.meta.url)
const checkOnly = process.argv.includes('--check')

let written = 0
let unchanged = 0
const conflicts = []

for (const [name, values] of Object.entries(TRANSLATIONS)) {
  const key = systemMessageKey(values[0])
  LOCALES.forEach((locale, index) => {
    const file = new URL(`${locale}.json`, base)
    const catalogue = JSON.parse(readFileSync(file, 'utf8'))
    catalogue.Generated ??= {}
    const existing = catalogue.Generated[key]
    if (existing !== undefined) {
      if (existing !== values[index]) {
        conflicts.push(`${name} [${locale}] ${key}: catalogue holds a different value`)
      } else {
        unchanged += 1
      }
      return
    }
    if (!checkOnly) {
      catalogue.Generated[key] = values[index]
      writeFileSync(file, `${JSON.stringify(catalogue, null, 2)}\n`)
    }
    written += 1
  })
  console.log(`${name} -> ${key}`)
}

console.log('')
console.log(`entries: ${written} ${checkOnly ? 'would be written' : 'written'}, ${unchanged} already present`)
if (conflicts.length > 0) {
  console.log('')
  console.log('CONFLICTS (left untouched):')
  for (const conflict of conflicts) console.log(`  ${conflict}`)
  process.exitCode = 1
}
