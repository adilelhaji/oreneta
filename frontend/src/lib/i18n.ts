import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import IntlMessageFormat from 'intl-messageformat'
import { languageNativeNames, messages, supportedI18nLanguages, type SupportedI18nLanguage } from '../generated/locales'

export { languageNativeNames, supportedI18nLanguages, type SupportedI18nLanguage }

type TranslationValues = Record<string, unknown> & { defaultValue?: string }
type Listener = () => void

const listeners = new Set<Listener>()
const formatterCache = new Map<string, IntlMessageFormat>()

const localeForIntl = (language: SupportedI18nLanguage) => language.replace('_', '-')

const isSupportedLanguage = (value?: string | null): value is SupportedI18nLanguage =>
  Boolean(value && supportedI18nLanguages.includes(value as any))

let currentLanguage: SupportedI18nLanguage = 'en'

function notify() {
  for (const listener of listeners) listener()
}

function messageFor(language: SupportedI18nLanguage, key: string, defaultValue?: string) {
  return messages[language]?.[key] ?? messages.en[key] ?? defaultValue ?? key
}

function formatMessage(language: SupportedI18nLanguage, key: string, values: TranslationValues = {}) {
  const source = messageFor(language, key, values.defaultValue)
  const cacheKey = `${language}\0${key}\0${source}`
  let formatter = formatterCache.get(cacheKey)
  if (!formatter) {
    formatter = new IntlMessageFormat(source, localeForIntl(language), undefined, { ignoreTag: false })
    formatterCache.set(cacheKey, formatter)
  }
  return formatter.format(values)
}

export const resolveI18nLanguageFromWebLocale = (localeStr?: string): SupportedI18nLanguage | undefined => {
  if (!localeStr) {
    return undefined
  }
  const normalized = localeStr.replace('_', '-')
  const parts = normalized.split('-')
  const lang = parts[0].toLowerCase()

  if (lang === 'zh') {
    if (parts.includes('Hans')) return 'zh_Hans'
    if (parts.includes('Hant')) return 'zh_Hant'
    const region = parts[1]?.toUpperCase()
    return region === 'TW' || region === 'HK' || region === 'MO' || region === 'CHT' ? 'zh_Hant' : 'zh_Hans'
  }

  if (lang === 'pt') {
    const region = parts[1]?.toUpperCase()
    return region === 'BR' ? 'pt_BR' : 'pt'
  }

  return isSupportedLanguage(lang) ? (lang as SupportedI18nLanguage) : undefined
}

export const normalizeI18nLanguage = (value?: string | null): SupportedI18nLanguage | null =>
  value == null ? null : isSupportedLanguage(value) ? value : null

/** The language a profile starts in until someone chooses another: Catalan (ADR-0062). */
export const DEFAULT_I18N_LANGUAGE: SupportedI18nLanguage = 'ca'

/** The Settings choice to follow the system's language, stored as itself (ADR-0062). */
export const SYSTEM_LANGUAGE_CHOICE = 'system'

/** What the language setting holds once chosen: a catalog language, or "follow the system". */
export type LanguageChoice = SupportedI18nLanguage | typeof SYSTEM_LANGUAGE_CHOICE

/**
 * The choice a stored `language` row stands for (ADR-0062).
 *
 * No row means nobody chose, and the profile gets the default language. A
 * row always means someone did: a language this version has is kept; the
 * null that choosing "System" wrote before ADR-0062, "system" itself, or a
 * language this version lacks (written by a newer one) follow the system.
 */
export function languageChoiceFromStore(present: boolean, value: unknown): LanguageChoice | null {
  if (!present) return null
  if (typeof value === 'string' && isSupportedLanguage(value)) return value
  return SYSTEM_LANGUAGE_CHOICE
}

/**
 * The interface language for a choice: the default when nothing was chosen,
 * the system's language (or English, the catalog's source, when the system
 * speaks one the catalog lacks) for "System", else the chosen one.
 */
export function resolveInterfaceLanguage(
  choice: LanguageChoice | null | undefined,
  systemLocale?: string,
): SupportedI18nLanguage {
  if (choice === SYSTEM_LANGUAGE_CHOICE) return resolveI18nLanguageFromWebLocale(systemLocale) ?? 'en'
  return normalizeI18nLanguage(choice) ?? DEFAULT_I18N_LANGUAGE
}

/**
 * The BCP 47 tag dates and numbers are written in: the interface language's,
 * so a Catalan interface on an English system says "16 d’oct." (#231).
 */
export function intlLocale(): string {
  return localeForIntl(currentLanguage)
}

export function t(key: string, values: TranslationValues = {}): string {
  const formatted = formatMessage(currentLanguage, key, values)
  return Array.isArray(formatted) ? formatted.join('') : String(formatted)
}

export function translationTemplate(key: string): string {
  return messageFor(currentLanguage, key)
}

export function useTranslation() {
  const [language, setLanguage] = useState(currentLanguage)

  useEffect(() => {
    const listener = () => setLanguage(currentLanguage)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])

  return useMemo(
    () => ({
      t: (key: string, values: TranslationValues = {}) => {
        const formatted = formatMessage(language, key, values)
        return Array.isArray(formatted) ? formatted.join('') : String(formatted)
      },
      i18n,
    }),
    [language],
  )
}

export function Trans({
  i18nKey,
  values = {},
  components = {},
}: {
  i18nKey: string
  values?: TranslationValues
  components?: Record<string, ReactElement>
}) {
  const [language, setLanguage] = useState(currentLanguage)

  useEffect(() => {
    const listener = () => setLanguage(currentLanguage)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])

  const richValues = useMemo(() => {
    const out: Record<string, unknown> = { ...values }
    for (const [name, component] of Object.entries(components)) {
      out[name] = (chunks: ReactNode[]) =>
        isValidElement(component) ? cloneElement(component, { key: name }, chunks) : chunks
    }
    return out
  }, [components, values])

  const formatted = formatMessage(language, i18nKey, richValues)
  return createElement(Fragment, null, formatted as ReactNode)
}

const i18n = {
  get language() {
    return currentLanguage
  },
  async changeLanguage(language: string) {
    const next = normalizeI18nLanguage(language) ?? 'en'
    if (next !== currentLanguage) {
      currentLanguage = next
      notify()
    }
    return next
  },
}

export default i18n
