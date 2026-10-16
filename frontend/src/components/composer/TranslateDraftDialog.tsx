import { useEffect, useState } from 'react'
import { Languages } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { appTranslator, guessLanguage, plainTextOf, route, type Translator } from '../../lib/translation'
import {
  defaultTarget,
  downloadErrorText,
  downloadModels,
  languageName,
  refreshTranslationStatus,
  translationStatus$,
} from '../../states/translation'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'
import { formatFileSize } from '../chat/messageHelpers'

export type DraftTranslation = { html?: string; text: string }

/**
 * Translating what is being written (#106, ADR-0031). The translation is
 * shown first and changes nothing; the person then puts it in place of the
 * draft (with an undo) or below it, keeping what they wrote.
 */
export function TranslateDraftDialog({
  rich,
  html,
  text,
  onApply,
  onClose,
  translator = appTranslator(),
}: {
  rich: boolean
  html: string
  text: string
  onApply: (translation: DraftTranslation, how: 'replace' | 'below') => void
  onClose: () => void
  translator?: Translator
}) {
  const { t } = useTranslation()
  const status = useValue(translationStatus$)
  const languages = status?.languages ?? []
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DraftTranslation | null>(null)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    void refreshTranslationStatus()
  }, [])

  // One's own draft is usually in the app's language; the other side is a
  // guess the person can change.
  useEffect(() => {
    if (languages.length === 0 || from) return
    const guessed = guessLanguage(text, languages)
    const source = guessed ?? defaultTarget(languages)
    setFrom(source)
    setTo(source === 'en' ? (languages.find((l) => l !== 'en') ?? '') : 'en')
  }, [languages, from, text])

  const models = status && from && to ? route(status.pairs, from, to) : null
  const toDownload = models?.filter((p) => !p.installed).reduce((n, p) => n + p.size, 0) ?? 0

  const translate = async () => {
    if (!models) return
    setProblem('')
    setResult(null)
    const downloaded = await downloadModels(models, t)
    if (!downloaded.ok) {
      if (downloaded.reason === 'failed') setProblem(downloadErrorText(downloaded.error, t))
      return
    }
    const ready = await refreshTranslationStatus()
    const installed = ready && route(ready.pairs, from, to)
    if (!installed) return
    setBusy(true)
    try {
      const out = await translator.translate(rich ? html : text, installed, rich)
      if (out.state === 'tooLong')
        setProblem(t('translation.draftTooLong', { defaultValue: 'This is too long to translate here.' }))
      if (out.state === 'done') setResult(rich ? { html: out.text, text: plainTextOf(out.text) } : { text: out.text })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const stop = () => {
    translator.stop()
    setBusy(false)
  }

  const select = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex items-center gap-1.5 text-caption text-secondary">
      {label}
      <select
        value={value}
        onChange={(e) => {
          set(e.target.value)
          setResult(null)
        }}
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
    <Dialog
      title={t('translation.draftTitle', { defaultValue: 'Translate this message' })}
      icon={Languages}
      width="lg"
      onClose={() => {
        if (busy) stop()
        onClose()
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="secondary" disabled={!result} onClick={() => result && onApply(result, 'below')}>
            {t('translation.addBelow', { defaultValue: 'Add below what I wrote' })}
          </Button>
          <Button disabled={!result} onClick={() => result && onApply(result, 'replace')}>
            {t('translation.replace', { defaultValue: 'Use instead of what I wrote' })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {select(from, setFrom, t('translation.from', { defaultValue: 'From' }))}
          {select(to, setTo, t('translation.to', { defaultValue: 'into' }))}
          {busy ? (
            <Button size="sm" variant="secondary" onClick={stop}>
              {t('translation.stop', { defaultValue: 'Stop' })}
            </Button>
          ) : (
            <Button size="sm" disabled={!models || !text.trim()} onClick={() => void translate()}>
              {t('translation.translate', { defaultValue: 'Translate' })}
            </Button>
          )}
          <span className="text-caption text-secondary">
            {!models
              ? t('translation.noModel', { defaultValue: 'No model translates between these.' })
              : toDownload > 0
                ? t('translation.needsDownload', {
                    size: formatFileSize(toDownload),
                    defaultValue: 'Needs a {size} download first; asked before it starts.',
                  })
                : t('translation.ready', { defaultValue: 'Runs on this computer.' })}
          </span>
        </div>
        {problem && (
          <p role="alert" className="text-caption text-danger">
            {t('translation.failed', { reason: problem, defaultValue: 'Not translated: {reason}' })}
          </p>
        )}
        {busy && (
          <p role="status" className="text-caption text-secondary">
            {t('translation.working', {
              from: languageName(from),
              to: languageName(to),
              defaultValue: 'Translating from {from} into {to}…',
            })}
          </p>
        )}
        {result && (
          <section aria-label={t('translation.preview', { defaultValue: 'Translation' })}>
            <p className="mb-1 text-caption text-secondary">
              {t('translation.reviewHint', {
                defaultValue: 'Machine translation: read it before sending. Nothing in your message has changed yet.',
              })}
            </p>
            <div
              dir="auto"
              className="bidi-plaintext max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-control-sm border border-border/60 bg-app px-3 py-2 text-sm text-primary"
            >
              {result.text}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  )
}
