import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { messages } from '../generated/locales'
import i18n, { t } from '../lib/i18n'
import { applyInterfaceLanguage, targetInterfaceLanguage } from './interfaceLanguage'
import {
  applyDocumentLanguage,
  bootstrapLanguage,
  hydrateSettings,
  languageLoaded$,
  readPaintLanguage,
  readStoredPrefs,
  settings$,
} from './settings'

const ca = messages.ca

// The first-run language (#231, ADR-0062): Catalan on a fresh profile,
// whatever the system speaks; a saved choice, "System" included, wins.

const calls: Array<{ command: string; payload: any }> = []
const systemLanguage = Object.getOwnPropertyDescriptor(navigator, 'language')
const systemLanguages = Object.getOwnPropertyDescriptor(navigator, 'languages')

/** The system's preferred locales, most wanted first. */
function systemSpeaks(...locales: string[]) {
  Object.defineProperty(navigator, 'language', { value: locales[0], configurable: true })
  Object.defineProperty(navigator, 'languages', { value: locales, configurable: true })
}

/** What the app shows once the profile's stored preferences are read. */
function startWith(prefs: Record<string, unknown>) {
  hydrateSettings(prefs)
  return targetInterfaceLanguage(settings$.language.peek(), languageLoaded$.peek())
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  calls.length = 0
  ;(window as any).go = {
    main: { App: { Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), { ok: true }) } },
  }
})

afterEach(async () => {
  if (systemLanguage) Object.defineProperty(navigator, 'language', systemLanguage)
  else delete (navigator as any).language
  if (systemLanguages) Object.defineProperty(navigator, 'languages', systemLanguages)
  else delete (navigator as any).languages
  hydrateSettings({})
  await i18n.changeLanguage('en')
  applyDocumentLanguage('en')
  localStorage.setItem('meron-language-cache', 'en')
  delete (window as any).go
})

describe('a fresh profile', () => {
  it('starts in Catalan whatever the system speaks', () => {
    for (const system of ['en-US', 'es-ES', 'ja-JP', 'ar-EG', 'nl-NL']) {
      systemSpeaks(system)
      expect(startWith({})).toBe('ca')
      expect(settings$.language.peek()).toBeNull()
    }
  })

  it('does not write the default as if someone had chosen it', async () => {
    startWith({})
    await flush()
    expect(calls.filter((call) => call.command === 'app.prefsSet')).toEqual([])
  })

  it('shows the interface, the document and the native labels in Catalan', () => {
    systemSpeaks('en-US')
    applyInterfaceLanguage(startWith({}))
    expect(i18n.language).toBe('ca')
    expect(t('notify.newMessage')).toBe(ca['notify.newMessage'])
    expect(document.documentElement.lang).toBe('ca')
    expect(document.documentElement.dir).toBe('ltr')
    const labels = calls.find((call) => call.command === 'i18n.setNativeLabels')?.payload
    expect(labels.trayQuit).toBe(ca['tray.quitOreneta'])
    expect(labels.newMessageCount).toBe(ca['notify.newMessageCount'])
    expect(labels.reminderStarted).toBe(ca['notify.reminderStarted'])
  })
})

describe('a saved choice wins', () => {
  it('keeps a chosen language', () => {
    systemSpeaks('ca-ES')
    expect(startWith({ language: 'es' })).toBe('es')
    expect(startWith({ language: 'en' })).toBe('en')
  })

  it('follows the system for "System", as saved now and as saved before ADR-0062', () => {
    systemSpeaks('es-ES')
    expect(startWith({ language: 'system' })).toBe('es')
    expect(startWith({ language: null })).toBe('es')
    systemSpeaks('nl-NL')
    expect(startWith({ language: 'system' })).toBe('en')
  })

  it('follows the system for a language this version lacks', () => {
    systemSpeaks('de-DE')
    expect(startWith({ language: 'ru' })).toBe('de')
  })

  it('for "System" takes the first of the system languages the catalog has', () => {
    systemSpeaks('nl-NL', 'fr-FR', 'en-US')
    expect(startWith({ language: 'system' })).toBe('fr')
  })
})

describe('before the stored choice is read', () => {
  const storage = (value: string | null) => ({ getItem: () => value })

  it('paints in the language the last run showed, Catalan on a fresh profile', () => {
    expect(readPaintLanguage(storage(null))).toBe('ca')
    expect(readPaintLanguage(storage('es'))).toBe('es')
    expect(readPaintLanguage(storage('pt_BR'))).toBe('pt_BR')
    // A language this version lacks, or storage that cannot be read: fresh.
    expect(readPaintLanguage(storage('ru'))).toBe('ca')
    expect(readPaintLanguage({ getItem: () => { throw new Error('denied') } })).toBe('ca')
  })

  it('has the strings in that language before any effect runs', () => {
    // The suite's setup leaves a profile that last showed English; settings.ts
    // applied it to the strings when it loaded, with no effect involved.
    expect(bootstrapLanguage).toBe('en')
    expect(targetInterfaceLanguage(null, false)).toBe(bootstrapLanguage)
    expect(targetInterfaceLanguage('es', false)).toBe(bootstrapLanguage)
  })
})

describe('a failed read of the stored preferences', () => {
  const failing = () => {
    ;(window as any).go = {
      main: { App: { Invoke: async (command: string) => { if (command === 'app.prefsGet') throw new Error('core down'); return {} } } },
    }
  }

  it('is told apart from a profile without rows', async () => {
    failing()
    expect(await readStoredPrefs(['language'])).toEqual({ prefs: {}, read: false })
    ;(window as any).go.main.App.Invoke = async () => ({ prefs: {} })
    expect(await readStoredPrefs(['language'])).toEqual({ prefs: {}, read: true })
  })

  it('at start-up keeps the paint-time language and leaves its cache alone', async () => {
    languageLoaded$.set(false)
    settings$.language.set(null)
    localStorage.setItem('meron-language-cache', 'es')
    const { prefs, read } = await (failing(), readStoredPrefs(['language']))
    hydrateSettings(prefs, { languageRead: read })
    expect(languageLoaded$.peek()).toBe(false)
    const target = targetInterfaceLanguage(settings$.language.peek(), languageLoaded$.peek())
    expect(target).toBe(bootstrapLanguage)
    applyInterfaceLanguage(target, languageLoaded$.peek())
    expect(localStorage.getItem('meron-language-cache')).toBe('es')
  })

  it('on a re-boot keeps the language already chosen', async () => {
    systemSpeaks('en-US')
    expect(startWith({ language: 'es' })).toBe('es')
    const { prefs, read } = await (failing(), readStoredPrefs(['language']))
    hydrateSettings(prefs, { languageRead: read })
    expect(settings$.language.peek()).toBe('es')
    expect(languageLoaded$.peek()).toBe(true)
    expect(targetInterfaceLanguage(settings$.language.peek(), languageLoaded$.peek())).toBe('es')
  })
})

describe('switching language', () => {
  it('is saved and shown, "System" included', async () => {
    systemSpeaks('es-ES')
    startWith({})
    settings$.language.set('en')
    await flush()
    expect(calls).toContainEqual({ command: 'app.prefsSet', payload: { key: 'language', value: 'en' } })
    applyInterfaceLanguage(targetInterfaceLanguage(settings$.language.peek(), true))
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')

    settings$.language.set('system')
    await flush()
    expect(calls).toContainEqual({ command: 'app.prefsSet', payload: { key: 'language', value: 'system' } })
    expect(targetInterfaceLanguage(settings$.language.peek(), true)).toBe('es')

    settings$.language.set('ca')
    applyInterfaceLanguage(targetInterfaceLanguage(settings$.language.peek(), true))
    expect(i18n.language).toBe('ca')
  })
})
