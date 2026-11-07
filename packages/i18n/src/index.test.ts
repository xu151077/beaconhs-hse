import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE,
  LOCALE_OPTIONS,
  SUPPORTED_LOCALES,
  localeFromAcceptLanguage,
  localizeText,
  normalizeLocalePolicy,
  resolveLocale,
  resolveLocalePreferences,
} from './index'

describe('locale policy', () => {
  it('adds the default locale to the enabled set and rejects unknown locales', () => {
    expect(
      normalizeLocalePolicy({ defaultLocale: 'fr', enabledLocales: ['en', 'xx', 'en'] }),
    ).toEqual({ defaultLocale: 'fr', enabledLocales: ['en', 'fr'] })
  })

  it('uses an enabled user override', () => {
    expect(
      resolveLocale({ defaultLocale: 'en', enabledLocales: ['en', 'fr'], userLocale: 'fr' }),
    ).toBe('fr')
  })

  it('falls back to the tenant default for a disabled or invalid override', () => {
    expect(resolveLocale({ defaultLocale: 'fr', enabledLocales: ['fr'], userLocale: 'es' })).toBe(
      'fr',
    )
    expect(resolveLocale({ defaultLocale: 'wat', enabledLocales: [], userLocale: 'wat' })).toBe(
      'en',
    )
  })

  it('exposes only an enabled membership override in request preferences', () => {
    expect(
      resolveLocalePreferences({
        defaultLocale: 'fr',
        enabledLocales: ['fr'],
        userLocale: 'es',
      }),
    ).toEqual({
      locale: 'fr',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      localeOverride: null,
    })
  })
})

describe('localeFromAcceptLanguage', () => {
  it('selects the highest-quality supported language and ignores unknown tags', () => {
    expect(localeFromAcceptLanguage('de-DE, fr-CA;q=0.8, en;q=0.6')).toBe('fr')
    expect(localeFromAcceptLanguage('es-MX;q=0.7, fr;q=0.9')).toBe('fr')
    expect(localeFromAcceptLanguage('fr;q=0, es;q=0.5')).toBe('es')
    expect(localeFromAcceptLanguage('de')).toBe('en')
  })

  it('negotiates Simplified Chinese from regional and script tags', () => {
    expect(localeFromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(localeFromAcceptLanguage('zh-SG')).toBe('zh')
    expect(localeFromAcceptLanguage('zh-Hans-CN')).toBe('zh')
    expect(localeFromAcceptLanguage('zh-MY,en;q=0.5')).toBe('zh')
    expect(localeFromAcceptLanguage('zh')).toBe('zh')
  })

  it('refuses to serve Simplified text to a Traditional-Chinese preference', () => {
    // `zh` is Simplified only, so a Hant/TW/HK/MO request must fall through to
    // the default rather than render the wrong script.
    expect(localeFromAcceptLanguage('zh-TW')).toBe('en')
    expect(localeFromAcceptLanguage('zh-HK')).toBe('en')
    expect(localeFromAcceptLanguage('zh-MO')).toBe('en')
    expect(localeFromAcceptLanguage('zh-Hant')).toBe('en')
    // …but it must still fall through to a supported lower-priority tag.
    expect(localeFromAcceptLanguage('zh-TW, en;q=0.5')).toBe('en')
    expect(localeFromAcceptLanguage('zh-TW;q=0.9, es;q=0.8')).toBe('es')
  })
})

describe('supported locale registry', () => {
  it('exposes every locale as a switcher option carrying its native name', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'fr', 'es', 'zh'])
    expect(LOCALE_OPTIONS.map((option) => option.value)).toEqual([...SUPPORTED_LOCALES])
    expect(LOCALE_OPTIONS.find((option) => option.value === 'zh')).toEqual({
      value: 'zh',
      label: 'Chinese',
      nativeLabel: '简体中文',
    })
  })

  it('keeps the default locale first and in the enabled set', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(normalizeLocalePolicy({ defaultLocale: 'en', enabledLocales: [] })).toEqual({
      defaultLocale: 'en',
      enabledLocales: ['en'],
    })
  })

  it('honours a Chinese tenant default and a Chinese user override', () => {
    expect(
      resolveLocale({ defaultLocale: 'zh', enabledLocales: ['zh'], userLocale: undefined }),
    ).toBe('zh')
    expect(
      resolveLocale({ defaultLocale: 'en', enabledLocales: ['en', 'zh'], userLocale: 'zh' }),
    ).toBe('zh')
    expect(
      resolveLocalePreferences({
        defaultLocale: 'zh',
        enabledLocales: ['en', 'zh'],
        userLocale: 'zh',
      }),
    ).toEqual({
      locale: 'zh',
      defaultLocale: 'zh',
      enabledLocales: ['en', 'zh'],
      localeOverride: 'zh',
    })
  })

  it('still prefers English copy when Chinese tenant content is absent', () => {
    expect(localizeText({ en: 'Inspection', zh: '检查' }, 'zh', 'field')).toBe('检查')
    expect(localizeText({ en: 'Inspection' }, 'zh', 'field')).toBe('Inspection')
    expect(localizeText({ zh: '检查' }, 'en', 'field')).toBe('检查')
  })
})

describe('localizeText', () => {
  it('uses effective locale, tenant default, English, then another supported translation', () => {
    expect(localizeText({ en: 'Inspection', fr: 'Inspection' }, 'fr', 'field')).toBe('Inspection')
    expect(localizeText({ es: 'Inspección' }, 'fr', 'field', 'es')).toBe('Inspección')
    expect(localizeText({ en: 'Inspection' }, 'es', 'field', 'fr')).toBe('Inspection')
    expect(localizeText({ fr: 'Inspection' }, 'es', 'field', 'en')).toBe('Inspection')
  })

  it('returns the explicit fallback for empty content', () => {
    expect(localizeText({ en: ' ' }, 'en', 'field')).toBe('field')
    expect(localizeText(null, 'en', 'field')).toBe('field')
  })
})
