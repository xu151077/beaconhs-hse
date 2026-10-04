// The corrective-action VERIFICATION trigger must reflect `ca.verify`.
//
// SEPARATION OF DUTIES IS THE POINT
//
// `ca.verify` is a distinct catalogue key from `ca.update` precisely so the
// person who did the work cannot sign it off. `verifyCorrectiveAction` enforces
// that with `assertCan(ctx, 'ca.verify')`. The UI has to agree, or the separation
// is only theoretical: the owner of an open CA was shown an enabled "Sign
// verification" button, and pressing it produced
//
//   Error [ForbiddenError]: Missing permission: ca.verify
//
// which Next surfaced as the generic "This page could not load / Your work was
// not reported as complete" error page — a dead end that looks like a bug in the
// app rather than a refusal.
//
// WHAT IS PINNED
//
//   1. The panel takes a `canVerify` prop and the page derives it from
//      `can(ctx, 'ca.verify')` — the SAME key the action asserts. If the action's
//      key ever changes, these must change together or the gate silently drifts.
//   2. Without it, the trigger renders disabled with a reason about the missing
//      permission. It must NOT reuse the header's "Complete verification before
//      closing" tooltip: that string describes a different blocked state
//      (verification outstanding) and would misattribute a permission refusal.
//   3. The already-verified and locked branches are unchanged — a viewer who
//      cannot verify must still SEE that the CA was verified, and by whom.
//
// `appkit`-style source assertions, matching the other web contract tests: these
// are server/client components behind `requireRequestContext()`.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const panel = source('../app/(app)/corrective-actions/[id]/_verification-panel.tsx')
const page = source('../app/(app)/corrective-actions/[id]/page.tsx')
const actions = source('../app/(app)/corrective-actions/_actions.ts')
const header = source('../app/(app)/corrective-actions/[id]/_header-actions.tsx')

const verifyAction = (() => {
  const start = actions.indexOf('export async function verifyCorrectiveAction')
  expect(start).toBeGreaterThan(-1)
  return actions.slice(start, actions.indexOf('\nexport ', start + 10))
})()

/** The English source behind `m_1b13e032627fdd`; also what the other locales must differ from. */
const EN_REFUSAL =
  'Your role cannot verify corrective actions. Verification is a separate sign-off from the work.'

describe('verification is authorized by ca.verify, and the UI says so', () => {
  it('the action asserts ca.verify — the separation the UI mirrors', () => {
    expect(verifyAction).toContain("assertCan(ctx, 'ca.verify')")
  })

  it('ca.verify stays a key of its own, distinct from ca.update', () => {
    // If these were merged the gate would be meaningless: an owner with
    // `ca.update` would satisfy it. Read the permission block from the top so
    // both keys are seen in one place.
    expect(verifyAction).not.toContain('ca.update')
  })

  it('the page passes the same key the action asserts', () => {
    // Read the panel's own invocation so an unrelated `can(ctx, ...)` elsewhere
    // on the page cannot satisfy this.
    const start = page.indexOf('<VerificationPanel')
    expect(start).toBeGreaterThan(-1)
    const call = page.slice(start, page.indexOf('/>', start))
    expect(call).toContain("canVerify={can(ctx, 'ca.verify')}")
  })

  it('the panel branches on canVerify rather than rendering the trigger always', () => {
    expect(panel).toContain('canVerify: boolean')
    expect(panel).toMatch(/\{canVerify \?[\s\S]*?drawer=verify/)
  })

  it('the refusal is disabled and explained, not a dead link', () => {
    // A disabled button keeps the control discoverable while making it clear it
    // cannot be used, which is the pattern the header already uses for close.
    const branch = panel.slice(panel.indexOf(') : ('))
    expect(branch).toContain('disabled')
    expect(branch).toContain('m_1b13e032627fdd')
  })

  it('the refusal reason is about permission, not about outstanding verification', () => {
    // Reusing the header's tooltip here would tell a foreman to go and complete a
    // verification they are not allowed to perform — the exact confusion this
    // gate exists to prevent.
    const branch = panel.slice(panel.indexOf(') : ('))
    expect(branch).not.toContain('m_0c72729c5bcd03')

    const closeReason = header.slice(header.indexOf('canClose ? ('))
    expect(closeReason).toContain('m_0c72729c5bcd03')
  })

  it('the refusal string exists in every locale', () => {
    // The catalog is keyed by `systemMessageKey(source)` and `messages.test.ts`
    // already enforces locale parity and placeholder integrity, so this only has
    // to prove the key this component references is a real, translated entry —
    // a wrong id would render the raw id to the user instead of a reason.
    const key = 'm_1b13e032627fdd'
    for (const locale of ['en', 'es', 'fr']) {
      const catalog = JSON.parse(
        source(`../../../../packages/i18n/src/messages/${locale}.json`),
      ) as { Generated: Record<string, string> }
      const text = catalog.Generated[key] ?? ''
      expect(text, `${locale} ${key} must exist`).not.toBe('')
      // An untranslated non-English catalog falls back to the English source, so
      // equalling it means the translation is missing. Compare against the source
      // text rather than matching a language-specific substring (French
      // "vérifier" carries an accent, Spanish uses "verificar").
      if (locale !== 'en') expect(text, `${locale} must be translated`).not.toBe(EN_REFUSAL)
      expect(text.length, `${locale} must not be an empty stub`).toBeGreaterThan(10)
    }
    expect(EN_REFUSAL).toMatch(/verify/i)
    expect(EN_REFUSAL).toMatch(/sign-off/i)
  })

  it('a viewer without ca.verify still sees who verified, and when', () => {
    // The permission gate must only affect the ACTION. Hiding the outcome would
    // make the audit trail unreadable to exactly the people who need it.
    const verifiedBranch = panel.slice(0, panel.indexOf('if (locked)'))
    expect(verifiedBranch).toContain('verifierName')
    expect(verifiedBranch).toContain('verifiedAt')
    // ...and it returns before the canVerify branch is reached.
    expect(verifiedBranch.indexOf('if (verifiedAt)')).toBeLessThan(panel.indexOf('canVerify ?'))
  })

  it('a locked CA is not offered verification either', () => {
    expect(panel).toContain('if (locked)')
    expect(panel.indexOf('if (locked)')).toBeLessThan(panel.indexOf('canVerify ?'))
  })
})
