import { afterEach, describe, expect, it } from 'bun:test'
import i18n, {
  DEFAULT_I18N_LANGUAGE,
  SYSTEM_LANGUAGE_CHOICE,
  languageChoiceFromStore,
  intlLocale,
  regionalLocale,
  languageNativeNames,
  resolveI18nLanguageFromWebLocale,
  resolveInterfaceLanguage,
  supportedI18nLanguages,
  t,
} from './i18n'
import { formatThreadDate } from './date'
import { formatQuoteDate } from './replyForward'

describe('i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('resolves web locales to supported catalog ids', () => {
    expect(resolveI18nLanguageFromWebLocale('pt-BR')).toBe('pt_BR')
    expect(resolveI18nLanguageFromWebLocale('zh-TW')).toBe('zh_Hant')
    expect(resolveI18nLanguageFromWebLocale('zh-Hans-CN')).toBe('zh_Hans')
  })

  it('formats ICU plurals from the generated catalog', async () => {
    await i18n.changeLanguage('en')
    expect(t('chat.showImages', { count: 1 })).toBe('Show image')
    expect(t('chat.showImages', { count: 3 })).toBe('Show 3 images')

    await i18n.changeLanguage('de')
    expect(t('chat.showImages', { count: 2 })).toBe('2 Bilder anzeigen')
  })

  it('uses defaultValue for compatibility when a key is missing', () => {
    expect(t('missing.key', { defaultValue: 'Fallback' })).toBe('Fallback')
  })

  it('offers Catalan, named in Catalan, and resolves a Catalan system to it', () => {
    expect(supportedI18nLanguages).toContain('ca')
    expect(languageNativeNames.ca).toBe('Català')
    expect(resolveI18nLanguageFromWebLocale('ca-ES')).toBe('ca')
    expect(resolveI18nLanguageFromWebLocale('ca-ES-valencia')).toBe('ca')
  })

  it('formats Catalan messages, plurals and dates', async () => {
    await i18n.changeLanguage('ca')
    expect(t('notify.newMessageCount', { count: 1 })).toBe('1 missatge nou')
    expect(t('notify.newMessageCount', { count: 3 })).toBe('3 missatges nous')
    // Dates follow the interface language: Catalan month names.
    const date = Date.UTC(2026, 9, 16, 9, 5) / 1000
    const formatted = formatQuoteDate(date, { timeZone: 'UTC' })
    expect(formatted).toBe(
      new Intl.DateTimeFormat('ca', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date * 1000),
    )
    expect(formatted).toContain('oct')
    // The mail list too, whatever the system's own locale.
    expect(intlLocale()).toBe('ca')
    expect(formatThreadDate(new Date(2020, 9, 16, 9).getTime() / 1000)).toMatch(/oct\..*2020/)
  })
})

describe('the interface language a profile shows (ADR-0062)', () => {
  it('is Catalan until someone chooses, whatever the system speaks', () => {
    expect(DEFAULT_I18N_LANGUAGE).toBe('ca')
    for (const system of ['en-US', 'es-ES', 'ja-JP', 'nl-NL', undefined]) {
      expect(resolveInterfaceLanguage(null, system)).toBe('ca')
    }
  })

  it('is the chosen language once chosen', () => {
    expect(resolveInterfaceLanguage('es', 'en-US')).toBe('es')
    expect(resolveInterfaceLanguage('en', 'ca-ES')).toBe('en')
  })

  it('for "System" walks the system languages in order', () => {
    expect(resolveInterfaceLanguage(SYSTEM_LANGUAGE_CHOICE, ['nl-NL', 'pt-PT', 'en-US'])).toBe('pt')
    expect(resolveInterfaceLanguage(SYSTEM_LANGUAGE_CHOICE, ['nl-NL', 'fy'])).toBe('en')
    expect(resolveInterfaceLanguage(SYSTEM_LANGUAGE_CHOICE, [])).toBe('en')
  })

  it('writes dates in the system locale when it speaks the interface language', () => {
    // English on en-GB keeps day-month order; the same for pt-PT and es-MX.
    expect(regionalLocale('en', ['en-GB', 'ca-ES'])).toBe('en-GB')
    expect(regionalLocale('en', ['en-IN'])).toBe('en-IN')
    expect(regionalLocale('es', ['es-MX'])).toBe('es-MX')
    expect(regionalLocale('de', ['de-CH'])).toBe('de-CH')
    expect(regionalLocale('pt', ['pt-PT'])).toBe('pt-PT')
    // Brazilian interface on a Portuguese system: the interface's own.
    expect(regionalLocale('pt_BR', ['pt-PT'])).toBe('pt-BR')
    // Catalan interface on an English system: Catalan dates.
    expect(regionalLocale('ca', ['en-US'])).toBe('ca')
    expect(regionalLocale('ca', ['ca-ES'])).toBe('ca-ES')
    expect(regionalLocale('en', [])).toBe('en')
    const date = new Date(2026, 9, 16)
    expect(date.toLocaleDateString(regionalLocale('en', ['en-GB']), { day: 'numeric', month: 'short' })).toBe('16 Oct')
  })

  it('follows the system for "System", in English when the catalog lacks it', () => {
    expect(resolveInterfaceLanguage(SYSTEM_LANGUAGE_CHOICE, 'es-ES')).toBe('es')
    expect(resolveInterfaceLanguage(SYSTEM_LANGUAGE_CHOICE, 'ca-ES')).toBe('ca')
    expect(resolveInterfaceLanguage(SYSTEM_LANGUAGE_CHOICE, 'nl-NL')).toBe('en')
  })

  it('reads a stored row: none is unchosen, any row is a choice', () => {
    expect(languageChoiceFromStore(false, undefined)).toBeNull()
    expect(languageChoiceFromStore(true, 'pt_BR')).toBe('pt_BR')
    expect(languageChoiceFromStore(true, 'system')).toBe('system')
    // What choosing "System" wrote before ADR-0062.
    expect(languageChoiceFromStore(true, null)).toBe('system')
    // A language a newer version wrote that this one lacks.
    expect(languageChoiceFromStore(true, 'ru')).toBe('system')
    expect(languageChoiceFromStore(true, 42)).toBe('system')
  })
})
