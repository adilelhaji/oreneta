import { Languages } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { route } from '../../lib/translation'
import {
  clearTranslation,
  languageName,
  messageTranslations$,
  showTranslation,
  stopTranslating,
  translateMessage,
  translationStatus$,
} from '../../states/translation'
import { formatFileSize } from './messageHelpers'
import { Button } from '../button/Button'
import type { Message } from '../../types'

/**
 * Translation of one message (#106, ADR-0031): the languages, chosen by the
 * person; then that the text shown is a translation made on this computer,
 * with the original one click away.
 */
export function TranslationNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  const translation = useValue(messageTranslations$[message.id])
  const status = useValue(translationStatus$)
  if (!translation) return null

  const languages = status?.languages ?? []
  const names = { from: languageName(translation.from), to: languageName(translation.to) }
  const box =
    'mb-2 flex flex-wrap items-center gap-2 rounded-control-sm border border-border/50 px-2.5 py-2 text-caption'
  const icon = <Languages size={14} strokeWidth={1.75} aria-hidden="true" className="text-accent-fg" />
  const close = (
    <button
      type="button"
      onClick={() => clearTranslation(message.id)}
      className="text-accent-fg underline cursor-pointer"
    >
      {t('buttons.close')}
    </button>
  )

  if (translation.state === 'choose') {
    const set = (side: 'from' | 'to', value: string) =>
      messageTranslations$[message.id].set({ ...translation, [side]: value })
    const models = status && route(status.pairs, translation.from, translation.to)
    const toDownload = models?.filter((p) => !p.installed).reduce((n, p) => n + p.size, 0) ?? 0
    const select = (side: 'from' | 'to', label: string) => (
      <label className="flex items-center gap-1.5 text-secondary">
        {label}
        <select
          value={translation[side]}
          onChange={(e) => set(side, e.target.value)}
          className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
        >
          {languages.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </select>
      </label>
    )
    return (
      <div role="group" aria-label={t('translation.title', { defaultValue: 'Translate' })} className={box}>
        {icon}
        {select('from', t('translation.from', { defaultValue: 'From' }))}
        {select('to', t('translation.to', { defaultValue: 'into' }))}
        <Button
          size="sm"
          disabled={!models}
          onClick={() => void translateMessage(message, translation.from, translation.to, t)}
        >
          {t('translation.translate', { defaultValue: 'Translate' })}
        </Button>
        <span className="text-secondary">
          {!models
            ? t('translation.noModel', { defaultValue: 'No model translates between these.' })
            : toDownload > 0
              ? t('translation.needsDownload', {
                  size: formatFileSize(toDownload),
                  defaultValue: 'Needs a {size} download first; asked before it starts.',
                })
              : t('translation.ready', { defaultValue: 'Runs on this computer.' })}
        </span>
        {close}
      </div>
    )
  }

  if (translation.state === 'working') {
    return (
      <div role="status" className={box}>
        {icon}
        <span className="text-secondary">
          {t('translation.working', { ...names, defaultValue: 'Translating from {from} into {to}…' })}
        </span>
        <button
          type="button"
          onClick={() => stopTranslating(message.id)}
          className="text-accent-fg underline cursor-pointer"
        >
          {t('translation.stop', { defaultValue: 'Stop' })}
        </button>
      </div>
    )
  }

  if (translation.state === 'failed') {
    return (
      <div role="alert" className={box}>
        {icon}
        <span className="text-secondary">
          {t('translation.failed', { reason: translation.message, defaultValue: 'Not translated: {reason}' })}
        </span>
        {close}
      </div>
    )
  }

  const showingTranslation = translation.showing === 'translation'
  return (
    <div role="status" className={box}>
      {icon}
      <span className="text-secondary">
        {showingTranslation
          ? t('translation.shown', {
              ...names,
              defaultValue: 'Machine translation from {from} into {to}, made on this computer.',
            })
          : t('translation.originalShown', { from: names.from, defaultValue: 'Showing the original ({from}).' })}
      </span>
      <button
        type="button"
        onClick={() => showTranslation(message.id, showingTranslation ? 'original' : 'translation')}
        className="text-accent-fg underline cursor-pointer"
      >
        {showingTranslation
          ? t('translation.showOriginal', { defaultValue: 'Show original' })
          : t('translation.showTranslation', { defaultValue: 'Show translation' })}
      </button>
      {close}
    </div>
  )
}

/** The message as it should be read now: its translation, when one is shown. */
export function useShownMessage(message: Message): Message {
  const translation = useValue(messageTranslations$[message.id])
  if (translation?.state !== 'done' || translation.showing !== 'translation') return message
  return { ...message, body: translation.text, body_html: translation.html ?? message.body_html }
}
