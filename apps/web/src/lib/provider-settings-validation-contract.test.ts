import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getAppMessages, systemMessageKey } from '@beaconhs/i18n/messages'

const WEB_SRC = new URL('../', import.meta.url)

/**
 * The provider settings forms must surface expected validation failures in the
 * form. This guards the mechanism itself, independently of any single action's
 * behaviour tests: a regression back to `action={someRawFormDataAction}` would
 * silently reintroduce the generic error boundary for all three families.
 */
const FORMS = [
  'components/email-settings/settings-form.tsx',
  'components/ai-settings/settings-form.tsx',
  'components/sms-settings/settings-form.tsx',
]

const ACTIONS = [
  'lib/email-settings-actions.ts',
  'lib/ai-settings-actions.ts',
  'lib/sms-settings-actions.ts',
]

describe('provider settings in-form error contract', () => {
  for (const form of FORMS) {
    const source = readFileSync(new URL(form, WEB_SRC), 'utf8')

    it(`${form} renders the save action through useActionState`, () => {
      expect(source).toContain('useActionState')
      // The submit must use the bound action, not the raw prop: a raw
      // <form action={action}> posts FormData directly and can only throw.
      expect(source).toContain('<form action={formAction}')
      expect(source).not.toContain('<form action={action}')
    })

    it(`${form} renders a destructive Alert for the returned error`, () => {
      expect(source).toContain('state?.error')
      expect(source).toContain('<Alert variant="destructive"')
    })

    it(`${form} disables the submit while the action is pending`, () => {
      expect(source).toMatch(/<Button type="submit" disabled=\{pending\}/)
    })
  }

  for (const action of ACTIONS) {
    const source = readFileSync(new URL(action, WEB_SRC), 'utf8')

    it(`${action} returns expected validation instead of throwing it`, () => {
      // ValidationFailure is the marker for "the operator typed something the
      // form should show". It must be caught and returned as { error }.
      //
      // The email family declares the class in the SHARED core module
      // (lib/email-settings-core.ts) so the first-run setup flow can raise the
      // very same class without the core module having to import a
      // 'use server' file. The class must therefore exist in one of those two
      // modules, and the action must catch it.
      expect(source).toMatch(
        /if \(error instanceof ValidationFailure\) return \{ error: error\.message \}/,
      )
      // And it must re-throw everything else, so a broken system is not flattened
      // into an in-form message that hides the real failure.
      expect(source).toContain('throw error')
    })

    it(`${action} keeps its permission gate as a throw`, () => {
      expect(source).toContain('if (!ctx.isSuperAdmin)\n    throw new Error(')
      expect(source).toContain('assertCan')
    })
  }

  it('declares the email ValidationFailure class in exactly one module', () => {
    const emailCore = readFileSync(new URL('lib/email-settings-core.ts', WEB_SRC), 'utf-8')
    const emailActions = readFileSync(new URL('lib/email-settings-actions.ts', WEB_SRC), 'utf-8')
    const declarations = [
      emailCore.includes('class ValidationFailure') ? 'core' : null,
      emailActions.includes('class ValidationFailure') ? 'actions' : null,
    ].filter(Boolean)
    // Exactly one declaration: two classes with the same name would break the
    // `instanceof` check that decides whether a validation failure is shown in
    // the form or escalated to the route error boundary.
    expect(declarations).toHaveLength(1)
    // And the action must import that one class rather than declare its own.
    expect(emailActions).toMatch(/import \{[^}]*ValidationFailure[^}]*\} from/)
  })

  it('translates every validation message used by these actions', () => {
    const catalogue = getAppMessages('en')
    const required = [
      'invalidEmailProvider',
      'invalidAiProvider',
      'invalidSmsProvider',
      'invalidEmailPolicy',
      'invalidSmsPolicy',
      'fieldTooLong',
      'smtpHostNotPublic',
    ] as const

    for (const key of required) {
      const english = catalogue.ProviderSettings[key]
      expect(english, `ProviderSettings.${key} is missing from English`).toBeTruthy()
      for (const locale of ['fr', 'es', 'zh'] as const) {
        const translated = getAppMessages(locale).ProviderSettings[key]
        expect(translated, `ProviderSettings.${key} is missing from ${locale}`).toBeTruthy()
        expect(
          translated,
          `ProviderSettings.${key} is byte-identical to English in ${locale}`,
        ).not.toBe(english)
      }
    }
  })

  it('keeps the fieldTooLong placeholder shape in every locale', () => {
    // ICU placeholders must survive translation or the operator sees "{field}".
    const shape = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()
    const english = getAppMessages('en').ProviderSettings.fieldTooLong
    for (const locale of ['fr', 'es', 'zh'] as const) {
      expect(shape(getAppMessages(locale).ProviderSettings.fieldTooLong)).toEqual(shape(english))
    }
  })

  it('has no duplicate generated keys after the catalogue edits', () => {
    for (const locale of ['en', 'fr', 'es', 'zh'] as const) {
      const raw = readFileSync(
        new URL(`../../../../packages/i18n/src/messages/${locale}.json`, import.meta.url),
        'utf8',
      )
      const generated = raw.slice(raw.indexOf('"Generated": {'))
      const keys = [...generated.matchAll(/^    "(m_[0-9a-f]+)":/gm)].map((m) => m[1])
      expect(new Set(keys).size, `${locale} contains duplicate generated keys`).toBe(keys.length)
    }
  })

  it('keeps systemMessageKey stable for the ProviderSettings namespace shape', () => {
    // Guards the hash contract these catalogues rely on; a change here would
    // silently re-point every Generated lookup in the app.
    expect(systemMessageKey('Select a valid email provider.')).toMatch(/^m_[0-9a-f]{14}$/)
  })
})
