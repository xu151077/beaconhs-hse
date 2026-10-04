// Two HSE UI defects found by driving the real app in a browser, both in the
// "the record cannot explain itself" family. Neither is a server bug: the server
// was correct in both cases.
//
// 1. CORRECTIVE ACTION → SOURCE RECORD NAVIGATION
//    `sourceEntityType` is polymorphic. Every module that can raise a CA writes
//    its own value (`incident`, `inspection_record`, `hazid_assessment`,
//    `equipment_inspection_record`, `ppe_inspection`, `journal_entry`,
//    `form_response`), but the detail page resolved a source ONLY for
//    `incident`. A CA auto-spawned by a High/Critical inspection finding — the
//    most common case — showed the free-text source CATEGORY dropdown and no way
//    back to the inspection that justified it.
//
// 2. INSPECTION SUBMIT VALIDATION SURFACED AS A CRASH
//    `assertInspectionStatusTransitionInTx` throws `InspectionTransitionError`
//    with a precise per-item list ("…: photo evidence"). Unhandled, it escaped
//    the server action and Next rendered its generic "This page could not load /
//    Your work was not reported as complete" boundary with a digest. A user who
//    had merely not finished the checklist was told the app had failed.
//
// Source assertions, matching the repo's web-test convention: these are server
// components behind `requireRequestContext()`, so behaviour is pinned at the
// wiring and at the shared helper both the guard and the banner call.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const caPage = source('../app/(app)/corrective-actions/[id]/page.tsx')
const inspPage = source('../app/(app)/inspections/records/[id]/page.tsx')
const inspLib = source('../app/(app)/inspections/_lib.ts')

describe('a corrective action links back to the record it was raised from', () => {
  const resolve = caPage.slice(
    caPage.indexOf('let source: { type: string'),
    caPage.indexOf('const photoRows'),
  )

  it('resolves more than just incidents', () => {
    // The defect in one assertion: an `incident`-only branch.
    expect(resolve).toContain("ca.sourceEntityType === 'incident'")
    expect(resolve).toContain("ca.sourceEntityType === 'inspection_record'")
  })

  it('links to the route each source module actually serves', () => {
    expect(resolve).toContain('href: `/incidents/${inc.id}`')
    expect(resolve).toContain('href: `/inspections/records/${insp.record.id}`')
  })

  it('gives the operator a human label, not a bare uuid', () => {
    expect(resolve).toContain('ref: insp.record.reference')
    expect(resolve).toContain('title: insp.type?.name')
  })

  it('leaves an unresolvable source null instead of rendering a dead link', () => {
    // `source` gates the whole `Linked source` block, including the <Link>, so a
    // missing record must not produce an href that 404s.
    expect(resolve).toMatch(/if \(insp\)\s*\n?\s*source = \{/)
    expect(caPage.slice(caPage.indexOf('source ? ('))).toContain('source.href')
  })

  it('only resolves when there is a source id to resolve', () => {
    expect(resolve).toContain('if (ca.sourceEntityId) {')
  })
})

describe('a refused inspection submit explains itself instead of crashing', () => {
  it('the guard still throws with its per-item detail', () => {
    // Unchanged behaviour at the source of truth: the refusal must remain a
    // hard guard, not a warning.
    expect(inspLib).toContain('export class InspectionTransitionError')
    expect(inspLib).toMatch(/Cannot submit: \$\{missing\.length\}/)
  })

  it('the guard list is reachable so the page can show the same items', () => {
    // One implementation for both, so the banner cannot disagree with the guard.
    expect(inspLib).toContain('export async function findIncompleteInspectionItems')
    expect(inspLib).toMatch(
      /findIncompleteInspectionItems[\s\S]*?findIncompleteCriteriaInTx\(tx, ctx\.tenantId, recordId\)/,
    )
  })

  it('toggleLock catches the refusal and redirects instead of throwing', () => {
    const toggle = inspPage.slice(
      inspPage.indexOf('async function toggleLock'),
      inspPage.indexOf('async function runLockTransition'),
    )
    expect(toggle).toContain('catch (error)')
    expect(toggle).toContain('error instanceof InspectionTransitionError')
    expect(toggle).toContain('redirect(`/inspections/records/${id}?incomplete=1`)')
    // Anything else must still propagate — swallowing every error would hide real
    // failures behind a friendly message.
    expect(toggle).toContain('throw error')
  })

  it('the banner renders the items and counts them', () => {
    expect(inspPage).toContain("sp.incomplete === '1'")
    expect(inspPage).toContain('await findIncompleteInspectionItems(ctx, id)')
    expect(inspPage).toContain('incompleteItems.map((item) =>')
    // The count line is localised, with singular and plural keyed separately so
    // the noun agrees with the number.
    expect(inspPage).toContain('m_13bad8fb8e6869')
    expect(inspPage).toContain('m_1962edc755ea9f')
  })

  it('the count strings are catalogued in every locale', () => {
    // `i18n-coverage.test.ts` owns the structural guarantee; this pins that these
    // two keys are real translated entries rather than ids that would render raw.
    for (const locale of ['en', 'es', 'fr']) {
      const catalog = JSON.parse(
        source(`../../../../packages/i18n/src/messages/${locale}.json`),
      ) as { Generated: Record<string, string> }
      const singular = catalog.Generated['m_13bad8fb8e6869'] ?? ''
      const plural = catalog.Generated['m_1962edc755ea9f'] ?? ''
      expect(singular, `${locale} singular`).not.toBe('')
      expect(plural, `${locale} plural`).not.toBe('')
      // The plural form carries a count, so the placeholder must survive translation.
      expect(plural, `${locale} placeholder`).toContain('{value0}')
    }
  })

  it('the banner is driven by the guard list, not a second query', () => {
    expect(inspPage).toMatch(/const incompleteItems =\s*\n?\s*sp\.incomplete/)
  })
})
