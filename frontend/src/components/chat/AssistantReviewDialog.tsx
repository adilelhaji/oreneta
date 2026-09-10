import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, LockKeyhole, Sparkles, X } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { Message } from '../../types'
import {
  assistant$,
  executeAssistantAction,
  previewAssistantAction,
  type AssistantAction,
  type AssistantContextItem,
  type AssistantPreview,
} from '../../states/assistant'

export function contextFor(messages: Message[]): AssistantContextItem[] {
  return messages.map((message) => ({
    message_id: message.message_id || message.id,
    account_id: message.account_id,
    sender: message.from_addr,
    subject: message.subject,
    body: message.body,
    attachments: (message.attachments ?? []).map((attachment) => ({
      name: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
    })),
  }))
}

export function AssistantReviewDialog({ messages, onClose }: { messages: Message[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [action, setAction] = useState<AssistantAction>('summary')
  const [preview, setPreview] = useState<AssistantPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const availableContext = useMemo(() => contextFor(messages), [messages])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [selectedAttachmentKeys, setSelectedAttachmentKeys] = useState<Set<string>>(() => new Set())
  const [authorization, setAuthorization] = useState('')
  const [response, setResponse] = useState('')
  useEffect(() => {
    setSelectedKeys(new Set(availableContext.map((item) => `${item.account_id}:${item.message_id}`)))
    setSelectedAttachmentKeys(new Set(availableContext.flatMap((item) => (item.attachments ?? []).map((_, index) => `${item.account_id}:${item.message_id}:attachment:${index}`))))
  }, [availableContext])
  const context = useMemo(
    () => availableContext.filter((item) => selectedKeys.has(`${item.account_id}:${item.message_id}`)).map((item) => ({
      ...item,
      attachments: (item.attachments ?? []).filter((_, index) => selectedAttachmentKeys.has(`${item.account_id}:${item.message_id}:attachment:${index}`)),
    })),
    [availableContext, selectedKeys, selectedAttachmentKeys],
  )
  const provider = assistant$.get()

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError('')
    setPreview(null)
    setResponse('')
    setReviewed(false)
    void previewAssistantAction(action, context)
      .then((next) => {
        if (!cancelled) setPreview(next)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [action, context])

  const run = async () => {
    if (!reviewed) return
    setBusy(true)
    setError('')
    try {
      if (!preview) return
      const result = await executeAssistantAction(action, context, true, preview.preview_token, authorization)
      setResponse(result.response)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-panel border border-border bg-app p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-primary"><Sparkles size={15} className="text-accent" />{t('assistant.reviewTitle', { defaultValue: 'Review assistant context' })}</h2>
            <p className="mt-1 text-caption text-secondary">{t('assistant.reviewHint', { defaultValue: 'Only the items listed below can leave this window. Mail instructions are untrusted.' })}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('buttons.close')} className="text-secondary hover:text-primary"><X size={16} /></button>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-secondary">{t('assistant.action', { defaultValue: 'Action' })}
            <select value={action} onChange={(event) => setAction(event.target.value as AssistantAction)} className="mt-1 w-full rounded-control border border-border bg-raised px-2.5 py-2 text-xs text-primary">
              <option value="summary">{t('assistant.summary', { defaultValue: 'Summarise' })}</option>
              <option value="draft">{t('assistant.draft', { defaultValue: 'Draft a reply' })}</option>
              <option value="task_suggestion">{t('assistant.task', { defaultValue: 'Suggest tasks' })}</option>
            </select>
          </label>
          <div className="rounded-control border border-border bg-raised px-3 py-2 text-xs text-secondary">
            <div className="font-semibold text-primary">{provider.mode === 'remote' ? 'Remote provider' : 'Local provider'}</div>
            <div className="mt-1 truncate" title={provider.endpoint}>{provider.endpoint || 'Not configured'}</div>
            <div className="truncate">{provider.model || 'Model not configured'}</div>
          </div>
        </div>
        <div className="mb-4 rounded-panel border border-border/70 bg-raised/60">
          {busy && !preview ? <div className="flex items-center gap-2 px-3 py-4 text-xs text-secondary"><Loader2 size={14} className="animate-spin" />{t('assistant.preparing', { defaultValue: 'Preparing review…' })}</div> : preview ? <>
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-xs text-secondary"><span>{preview.manifest.items.length} message(s) · {preview.manifest.total_bytes} bytes</span><span className="flex items-center gap-1"><LockKeyhole size={12} />{preview.will_transmit ? 'HTTPS after confirmation' : 'Stays on this device'}</span></div>
            <div className="border-b border-border/60 px-3 py-2 text-caption text-secondary">{t('assistant.selectHint', { defaultValue: 'Select the messages to include.' })}</div>
            {availableContext.map((candidate) => {
              const key = `${candidate.account_id}:${candidate.message_id}`
              const selected = selectedKeys.has(key)
              return <div key={key} className="flex gap-2 border-b border-border/40 px-3 py-2 last:border-b-0"><input type="checkbox" checked={selected} onChange={() => { setSelectedKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }); setReviewed(false) }} className="mt-0.5 accent-accent" /><span className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-primary">{candidate.subject || '(no subject)'}</div><div className="truncate text-caption text-secondary">{candidate.sender || 'Unknown sender'} · {candidate.body.length} bytes</div>{candidate.attachments && candidate.attachments.length > 0 && <div className="mt-1 space-y-1 text-caption text-secondary">{candidate.attachments.map((attachment, index) => { const attachmentKey = `${key}:attachment:${index}`; return <label key={attachmentKey} className="flex items-center gap-1"><input type="checkbox" checked={selectedAttachmentKeys.has(attachmentKey)} onChange={() => { setSelectedAttachmentKeys((current) => { const next = new Set(current); if (next.has(attachmentKey)) next.delete(attachmentKey); else next.add(attachmentKey); return next }); setReviewed(false) }} className="accent-accent" />{attachment.name}</label> })}</div>} {selected && <details className="mt-1"><summary className="cursor-pointer text-caption font-semibold text-accent">{t('assistant.viewExactContent', { defaultValue: 'View exact text sent' })}</summary><pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded-control bg-app px-2 py-1 text-caption text-primary">{candidate.body}</pre></details>}</span></div>
            })}
          </> : null}
        </div>
        {provider.mode === 'remote' && <label className="mb-3 block text-xs font-medium text-secondary">{t('assistant.token', { defaultValue: 'Provider token (used once, never saved)' })}<input type="password" value={authorization} onChange={(event) => setAuthorization(event.target.value)} className="mt-1 w-full rounded-control border border-border bg-raised px-2.5 py-2 text-xs text-primary" autoComplete="off" /></label>}
        <label className="mb-3 flex items-start gap-2 text-xs text-secondary"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} className="mt-0.5 accent-accent" /><span>{t('assistant.confirm', { defaultValue: 'I reviewed the listed context and want to activate this action.' })}</span></label>
        {error && <p className="mb-3 rounded-control bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{error}</p>}
        {response && <pre className="mb-3 max-h-40 overflow-auto rounded-control bg-raised px-3 py-2 text-xs text-primary whitespace-pre-wrap">{response}</pre>}
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-control px-3 py-2 text-xs font-semibold text-secondary hover:bg-hover">{t('buttons.cancel')}</button><button type="button" disabled={!preview || !reviewed || busy} onClick={() => void run()} className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy && <Loader2 size={13} className="animate-spin" />}{!busy && <Check size={13} />}{t('assistant.activate', { defaultValue: 'Activate' })}</button></div>
      </div>
    </div>
  )
}
