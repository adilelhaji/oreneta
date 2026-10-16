import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import {
  assistant$,
  cancelAssistantExecution,
  executeAssistantAction,
  parseAssistantResponse,
  previewAssistantAction,
  type AssistantContextItem,
  type AssistantPreview,
  type AssistantRewrite,
} from '../../states/assistant'
import { Dialog } from '../dialog/Dialog'
import { Button } from '../button/Button'

/**
 * Rewriting one's own draft with the assistant (#52, ADR-0032): proofread,
 * a tone, or a length. Only the draft's text is sent, after the exact
 * request is shown and confirmed; the result is read first and used only
 * when asked, with an undo.
 */
export function AssistantRewriteDialog({
  accountId,
  rich,
  text,
  onApply,
  onClose,
}: {
  accountId: string
  /** The draft has formatting, which a rewrite does not keep. */
  rich: boolean
  text: string
  onApply: (text: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [how, setHow] = useState<AssistantRewrite>('proofread')
  const [preview, setPreview] = useState<AssistantPreview | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [authorization, setAuthorization] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const running = useRef('')
  const provider = assistant$.get()
  // Only the draft, under a name that is not a message of anyone's.
  const context: AssistantContextItem[] = [{ message_id: 'draft', account_id: accountId, body: text }]

  useEffect(() => {
    let current = true
    setPreview(null)
    setReviewed(false)
    setResult('')
    setError('')
    void previewAssistantAction('rewrite', context, provider, how).then(
      (next) => current && setPreview(next),
      (reason) => current && setError(reason instanceof Error ? reason.message : String(reason)),
    )
    return () => {
      current = false
    }
    // The draft is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [how])

  const run = async () => {
    if (!preview || !reviewed) return
    const id = `rewrite-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    running.current = id
    setBusy(true)
    setError('')
    try {
      const response = await executeAssistantAction(
        'rewrite',
        context,
        true,
        preview.preview_token,
        id,
        authorization,
        provider,
        how,
      )
      if (running.current !== id) return
      setResult(parseAssistantResponse(response.response).text.trim())
    } catch (reason) {
      if (running.current === id) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (running.current === id) {
        running.current = ''
        setBusy(false)
      }
    }
  }

  const stop = () => {
    const id = running.current
    running.current = ''
    setBusy(false)
    if (id) void cancelAssistantExecution(id).catch(() => {})
  }

  const options: { value: AssistantRewrite; label: string }[] = [
    { value: 'proofread', label: t('assistant.rewrite.proofread', { defaultValue: 'Fix spelling and grammar' }) },
    { value: 'formal', label: t('assistant.rewrite.formal', { defaultValue: 'More formal' }) },
    { value: 'friendly', label: t('assistant.rewrite.friendly', { defaultValue: 'Friendlier' }) },
    { value: 'shorter', label: t('assistant.rewrite.shorter', { defaultValue: 'Shorter' }) },
    { value: 'longer', label: t('assistant.rewrite.longer', { defaultValue: 'Longer' }) },
  ]

  return (
    <Dialog
      title={t('assistant.rewrite.title', { defaultValue: 'Rewrite with the assistant' })}
      icon={Sparkles}
      width="lg"
      onClose={() => {
        stop()
        onClose()
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          {busy ? (
            <Button variant="secondary" onClick={stop}>
              {t('assistant.stop', { defaultValue: 'Stop' })}
            </Button>
          ) : result ? (
            <Button onClick={() => onApply(result)}>
              {t('assistant.rewrite.use', { defaultValue: 'Use instead of what I wrote' })}
            </Button>
          ) : (
            <Button disabled={!preview || !reviewed} onClick={() => void run()}>
              {t('assistant.rewrite.run', { defaultValue: 'Rewrite' })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-caption">
        <label className="flex items-center gap-2 text-secondary">
          {t('assistant.rewrite.how', { defaultValue: 'How' })}
          <select
            value={how}
            onChange={(e) => setHow(e.target.value as AssistantRewrite)}
            className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {preview && (
          <>
            <p className="text-secondary">
              {preview.will_transmit
                ? t('assistant.rewrite.remote', {
                    destination: preview.provider.endpoint,
                    defaultValue: 'Your draft’s text will be sent over HTTPS to {destination}. Nothing else is sent.',
                  })
                : t('assistant.rewrite.local', {
                    destination: preview.provider.endpoint,
                    defaultValue: 'Your draft’s text goes to the model on this computer ({destination}).',
                  })}
            </p>
            <details>
              <summary className="cursor-pointer text-secondary">
                {t('assistant.exactRequest', {
                  destination: preview.provider.endpoint,
                  defaultValue: 'Exact request sent to {destination}',
                })}
              </summary>
              <pre
                dir="ltr"
                className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-control-sm bg-app p-2 font-mono text-2xs text-primary"
              >
                {preview.request_body}
              </pre>
            </details>
            {preview.will_transmit && (
              <label className="flex flex-col gap-1 text-secondary">
                {t('assistant.token', { defaultValue: 'Provider token (used once, never saved)' })}
                <input
                  type="password"
                  value={authorization}
                  autoComplete="off"
                  onChange={(e) => setAuthorization(e.target.value)}
                  className="rounded-control border border-border bg-raised px-2.5 py-2 text-xs text-primary"
                />
              </label>
            )}
            <label className="flex items-start gap-2 text-secondary">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
                className="mt-0.5 accent-accent"
              />
              {t('assistant.rewrite.confirm', { defaultValue: 'I reviewed what will be sent and want to send it.' })}
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {result && (
          <section aria-label={t('assistant.rewrite.result', { defaultValue: 'Rewritten text' })}>
            <p className="mb-1 text-secondary">
              {t('assistant.rewrite.reviewHint', {
                defaultValue: 'Read it before using it. Nothing in your message has changed yet.',
              })}
              {rich &&
                ` ${t('assistant.rewrite.formatting', { defaultValue: 'Using it replaces the draft’s formatting with plain paragraphs.' })}`}
            </p>
            <div
              dir="auto"
              className="bidi-plaintext max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-control-sm border border-border/60 bg-app px-3 py-2 text-sm text-primary"
            >
              {result}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  )
}
