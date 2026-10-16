import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { messages } from '../generated/locales'
import i18n, { t } from '../lib/i18n'
import { applyInterfaceLanguage, targetInterfaceLanguage } from './interfaceLanguage'
import { applyDocumentLanguage, bootstrapLanguage, hydrateSettings, languageLoaded$, settings$ } from './settings'

const ca = messages.ca

// The first-run language (#231, ADR-0062): Catalan on a fresh profile,
// whatever the system speaks; a saved choice, "System" included, wins.

const calls: Array<{ command: string; payload: any }> = []
const systemLanguage = Object.getOwnPropertyDescriptor(navigator, 'language')

function systemSpeaks(locale: string) {
  Object.defineProperty(navigator, 'language', { value: locale, configurable: true })
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
  hydrateSettings({})
  await i18n.changeLanguage('en')
  applyDocumentLanguage('en')
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
})

describe('before the stored choice is read', () => {
  it('shows the language the last run showed (Catalan on a fresh profile)', () => {
    expect(targetInterfaceLanguage(null, false)).toBe(bootstrapLanguage)
    expect(targetInterfaceLanguage('es', false)).toBe(bootstrapLanguage)
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
