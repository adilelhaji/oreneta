// Offline translation (#106, ADR-0031): which models are here, downloads the
// person agreed to, and the translations shown in place of a message's text.
//
// A message's own text is never changed: a translation is kept beside it, for
// as long as the app is open, and the original is one click away.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import i18n from '../lib/i18n'
import { formatFileSize } from '../components/chat/messageHelpers'
import {
  appTranslator,
  guessLanguage,
  pairKey,
  plainTextOf,
  route,
  type ModelPair,
  type TranslationStatus,
  type Translator,
} from '../lib/translation'
import { confirmAction } from './ui'

export const translationStatus$ = observable<TranslationStatus | null>(null)

export async function refreshTranslationStatus(): Promise<TranslationStatus | null> {
  try {
    const status = await invoke<TranslationStatus>('translation.status', {})
    translationStatus$.set(status)
    return status
  } catch {
    return null
  }
}

/** A language's name in the app's language, e.g. "Spanish" or "español". */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([i18n.language], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---- Downloads --------------------------------------------------------------------

type DownloadError = { message: string; detail?: { code: string; needed?: number; allowed?: number; file?: string } }

/** What went wrong with a download, said for a person rather than a log. */
export function downloadErrorText(
  error: DownloadError | undefined,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (error?.detail?.code) {
    case 'cancelled':
      return t('translation.error.cancelled', { defaultValue: 'The download was cancelled.' })
    case 'quota':
      return t('translation.error.quota', {
        needed: formatFileSize(error.detail.needed ?? 0),
        allowed: formatFileSize(error.detail.allowed ?? 0),
        defaultValue: 'Models would take {needed}; {allowed} is allowed. Remove a language first.',
      })
    case 'diskFull':
      return t('translation.error.diskFull', { defaultValue: 'The disk is full. Nothing was kept.' })
    case 'integrity':
      return t('translation.error.integrity', {
        defaultValue: 'What arrived did not match the published model, so it was not kept.',
      })
    case 'network':
      return t('translation.error.network', {
        defaultValue: 'The model could not be fetched. Check the connection and try again.',
      })
    default:
      return error?.message ?? ''
  }
}
const finished = new Map<string, ((error: DownloadError | null) => void)[]>()

/** Called for the core's `translation.progress` and `translation.done`. */
export function onTranslationEvent(
  name: string,
  detail: { key: string; done?: number; total?: number; error?: DownloadError | null },
) {
  const status = translationStatus$.peek()
  if (name === 'translation.progress' && status) {
    translationStatus$.downloading.set({
      ...status.downloading,
      [detail.key]: { done: detail.done ?? 0, total: detail.total ?? 0 },
    })
  }
  if (name === 'translation.done') {
    for (const resolve of finished.get(detail.key) ?? []) resolve(detail.error ?? null)
    finished.delete(detail.key)
    void refreshTranslationStatus()
  }
}

/**
 * Asks before downloading anything, saying what, how large and from where;
 * resolves when the models are in place, or with why not.
 */
export async function downloadModels(
  pairs: ModelPair[],
  t: (key: string, values?: Record<string, unknown>) => string,
): Promise<{ ok: true } | { ok: false; reason: 'declined' | 'failed'; error?: DownloadError }> {
  const missing = pairs.filter((p) => !p.installed)
  if (missing.length === 0) return { ok: true }
  const source = hostOf(translationStatus$.peek()?.source ?? '')
  const ok = await confirmAction({
    title: t('translation.downloadTitle', { defaultValue: 'Download a translation model?' }),
    message: t('translation.downloadMessage', {
      models: missing.map((p) => `${languageName(p.from)} → ${languageName(p.to)}`).join(', '),
      size: formatFileSize(missing.reduce((n, p) => n + p.size, 0)),
      source,
      defaultValue:
        '{models}: {size}, from {source}. It is checked before use, and after that translating happens on this computer: no text is sent anywhere.',
    }),
    confirmLabel: t('translation.downloadConfirm', { defaultValue: 'Download' }),
    cancelLabel: t('buttons.cancel'),
  })
  if (!ok) return { ok: false, reason: 'declined' }
  for (const pair of missing) {
    const done = new Promise<DownloadError | null>((resolve) => {
      finished.set(pairKey(pair), [...(finished.get(pairKey(pair)) ?? []), resolve])
    })
    try {
      await invoke('translation.download', { from: pair.from, to: pair.to })
    } catch (error) {
      finished.delete(pairKey(pair))
      return { ok: false, reason: 'failed', error: { message: error instanceof Error ? error.message : String(error) } }
    }
    void refreshTranslationStatus()
    const error = await done
    if (error) return { ok: false, reason: 'failed', error }
  }
  return { ok: true }
}

export async function cancelDownload(pair: { from: string; to: string }) {
  await invoke('translation.cancel', { from: pair.from, to: pair.to })
}

export async function removeModel(pair: { from: string; to: string }) {
  await invoke('translation.remove', { from: pair.from, to: pair.to })
  await refreshTranslationStatus()
}

// ---- Translating a message ------------------------------------------------------------

export type MessageTranslation =
  | { state: 'choose'; from: string; to: string }
  | { state: 'working'; from: string; to: string }
  | { state: 'done'; from: string; to: string; html?: string; text: string; showing: 'translation' | 'original' }
  | { state: 'failed'; from: string; to: string; message: string }

export const messageTranslations$ = observable<Record<string, MessageTranslation>>({})

/** What to translate into: the app's language when a model covers it. */
export function defaultTarget(languages: string[]): string {
  const app = i18n.language.split('-')[0]
  return languages.includes(app) ? app : 'en'
}

/** What a message is probably written in, among the languages there are models for. */
export function guessSource(message: { body?: string; subject?: string }, languages: string[]): string | null {
  return guessLanguage(`${message.subject ?? ''}\n${message.body ?? ''}`, languages)
}

/**
 * Translates a message's text, downloading its models first if the person
 * agrees. The HTML version keeps its markup and is shown in the same
 * sandboxed frame as the original.
 */
export async function translateMessage(
  message: { id: string; body?: string; body_html?: string },
  from: string,
  to: string,
  t: (key: string, values?: Record<string, unknown>) => string,
  translator: Translator = appTranslator(),
): Promise<void> {
  const fail = (text: string) => messageTranslations$[message.id].set({ state: 'failed', from, to, message: text })
  const status = translationStatus$.peek() ?? (await refreshTranslationStatus())
  const models = status && route(status.pairs, from, to)
  if (!models) {
    fail(
      t('translation.unsupported', {
        from: languageName(from),
        to: languageName(to),
        defaultValue: 'There is no model to translate {from} into {to}.',
      }),
    )
    return
  }
  const downloaded = await downloadModels(models, t)
  if (!downloaded.ok) {
    if (downloaded.reason === 'failed') fail(downloadErrorText(downloaded.error, t))
    return
  }
  const ready = (await refreshTranslationStatus()) ?? status
  const installed = route(ready.pairs, from, to)!
  messageTranslations$[message.id].set({ state: 'working', from, to })
  try {
    // Only what is shown is translated: the HTML when there is one, its
    // text read from the translation for the plain view.
    const result = message.body_html
      ? await translator.translate(message.body_html, installed, true)
      : await translator.translate(message.body ?? '', installed, false)
    if (result.state === 'stopped') {
      messageTranslations$[message.id].delete()
      return
    }
    if (result.state === 'tooLong') {
      fail(t('translation.tooLong', { defaultValue: 'This message is too long to translate here.' }))
      return
    }
    messageTranslations$[message.id].set({
      state: 'done',
      from,
      to,
      html: message.body_html ? result.text : undefined,
      text: message.body_html ? plainTextOf(result.text) : result.text,
      showing: 'translation',
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

/** Opens the choice of languages for a message, with likely ones picked. */
export async function startMessageTranslation(message: { id: string; body?: string; subject?: string }) {
  const status = translationStatus$.peek() ?? (await refreshTranslationStatus())
  const languages = status?.languages ?? []
  const to = defaultTarget(languages)
  const guessed = guessSource(message, languages)
  const from = guessed && guessed !== to ? guessed : (languages.find((l) => l !== to) ?? '')
  messageTranslations$[message.id].set({ state: 'choose', from, to })
}

export function stopTranslating(messageId: string, translator: Translator = appTranslator()) {
  translator.stop()
  messageTranslations$[messageId].delete()
}

export function showTranslation(messageId: string, showing: 'translation' | 'original') {
  const current = messageTranslations$[messageId].peek()
  if (current?.state === 'done') messageTranslations$[messageId].set({ ...current, showing })
}

export function clearTranslation(messageId: string) {
  messageTranslations$[messageId].delete()
}
