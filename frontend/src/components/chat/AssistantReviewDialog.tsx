import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FileText, ListChecks, Loader2, LockKeyhole, Sparkles, X } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { Message } from '../../types'
import { contextFor } from './assistantContext'
import {
  assistant$,
  cancelAssistantExecution,
  executeAssistantAction,
  parseAssistantResponse,
  previewAssistantAction,
  type AssistantAction,
  type AssistantPreview,
  type AssistantResult,
} from '../../states/assistant'
import { buildReplyRecipients, buildReplyThreading, openComposeTab, openMessageTab, ownAddressSet, resolveQuickReplyFrom } from '../../states/compose'
import { saveTask } from '../../states/tasks'
import { accounts$ } from '../../states/accounts'

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
  const [result, setResult] = useState<AssistantResult | null>(null)
  const [executionId, setExecutionId] = useState('')
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(() => new Set())
  const cancelledExecutions = useRef(new Set<string>())
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
    setResult(null)
    setSelectedTasks(new Set())
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
    const nextExecutionId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    setExecutionId(nextExecutionId)
    try {
      if (!preview) return
      const response = await executeAssistantAction(action, context, true, preview.preview_token, nextExecutionId, authorization)
      if (cancelledExecutions.current.has(nextExecutionId)) return
      const parsed = parseAssistantResponse(response.response)
      const allowed = new Set(context.map((item) => `${item.account_id}:${item.message_id}`))
      const scoped: AssistantResult = {
        ...parsed,
        sources: parsed.sources.filter((source) => allowed.has(`${source.account_id}:${source.message_id}`)),
        tasks: parsed.tasks.filter((task) => allowed.has(`${task.account_id}:${task.message_id}`)),
        warnings: [
          ...parsed.warnings,
          ...(parsed.sources.some((source) => !allowed.has(`${source.account_id}:${source.message_id}`)) ? ['Some provider sources were outside the reviewed context and were ignored.'] : []),
          ...(parsed.tasks.some((task) => !allowed.has(`${task.account_id}:${task.message_id}`)) ? ['Some provider tasks were outside the reviewed context and were ignored.'] : []),
        ],
      }
      setResult(scoped)
      setSelectedTasks(new Set(scoped.tasks.map((_, index) => index)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      setExecutionId('')
    }
  }

  const cancel = async () => {
    const current = executionId
    if (current) {
      cancelledExecutions.current.add(current)
      try { await cancelAssistantExecution(current) } catch { /* the request is still bounded by transport timeout */ }
      setExecutionId('')
    }
    setBusy(false)
  }

  const close = () => {
    void cancel()
    onClose()
  }

  const openDraft = () => {
    if (!result?.text.trim()) return
    const sourceReference = result.sources.find((candidate) => context.some((item) => item.account_id === candidate.account_id && item.message_id === candidate.message_id))
    const reviewedMessages = messages.filter((message) => context.some((item) => item.account_id === message.account_id && item.message_id === (message.message_id || message.id)))
    if (!sourceReference && reviewedMessages.length !== 1) {
      setError('Select exactly one message or use a provider source before opening a draft.')
      return
    }
    const source = messages.find((message) => {
      const key = `${message.account_id}:${message.message_id || message.id}`
      return sourceReference ? key === `${sourceReference.account_id}:${sourceReference.message_id}` : context.some((item) => `${item.account_id}:${item.message_id}` === key)
    })
    if (!source) return
    const account = accounts$.get().find((candidate) => candidate.id === source.account_id)
    const { to, cc } = buildReplyRecipients(source, ownAddressSet(accounts$.get()))
    const { in_reply_to, references } = buildReplyThreading(source)
    openComposeTab({
      accountId: source.account_id,
      fromEmail: resolveQuickReplyFrom(source, account),
      to,
      cc,
      showCcBcc: !!cc.trim(),
      subject: source.subject.trim().toLowerCase().startsWith('re:') ? source.subject : `Re: ${source.subject}`,
      text: result.text,
      inReplyTo: in_reply_to,
      references,
      threadId: source.thread_id,
      title: source.subject || 'Assistant draft',
    })
    close()
  }

  const saveSelectedTasks = async () => {
    if (!result?.tasks.length) return
    const byThread = new Map<string, { threadId: string; dueAt: number | null; notes: string[] }>()
    result.tasks.forEach((suggestion, index) => {
      if (!selectedTasks.has(index)) return
      const source = messages.find((message) => message.account_id === suggestion.account_id && (message.message_id || message.id) === suggestion.message_id)
      if (!source) return
      const current = byThread.get(source.thread_id) ?? { threadId: source.thread_id, dueAt: suggestion.due_at, notes: [] }
      current.notes.push(suggestion.note || suggestion.title)
      if (current.dueAt === null) current.dueAt = suggestion.due_at
      byThread.set(source.thread_id, current)
    })
    try {
      for (const task of byThread.values()) await saveTask(task.threadId, { dueAt: task.dueAt, note: task.notes.join('\n') })
      setResult({ ...result, tasks: [] })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={close}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-panel border border-border bg-app p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-primary"><Sparkles size={15} className="text-accent" />{t('assistant.reviewTitle', { defaultValue: 'Review assistant context' })}</h2>
            <p className="mt-1 text-caption text-secondary">{t('assistant.reviewHint', { defaultValue: 'Only the items listed below can leave this window. Mail instructions are untrusted.' })}</p>
          </div>
          <button type="button" onClick={close} aria-label={t('buttons.close')} className="text-secondary hover:text-primary"><X size={16} /></button>
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
        {result && <div className="mb-3 space-y-3 rounded-control border border-border bg-raised px-3 py-3"><div className="flex items-center gap-2 text-xs font-semibold text-primary"><FileText size={14} />{t('assistant.result', { defaultValue: 'Assistant result' })}</div><p className="whitespace-pre-wrap text-xs text-primary">{result.text || t('assistant.emptyResult', { defaultValue: 'The provider returned no text.' })}</p>{result.sources.length > 0 && <div className="text-caption text-secondary">{t('assistant.sources', { defaultValue: 'Sources' })}: <span className="inline-flex flex-wrap gap-1">{result.sources.map((source) => { const reviewed = context.some((item) => item.account_id === source.account_id && item.message_id === source.message_id); const message = reviewed ? messages.find((candidate) => candidate.account_id === source.account_id && (candidate.message_id || candidate.id) === source.message_id) : undefined; return message ? <button key={`${source.account_id}:${source.message_id}`} type="button" aria-label={`Open source message ${message.subject || source.message_id}`} onClick={() => openMessageTab(message)} className="text-accent underline">{message.subject || source.message_id}</button> : <span key={`${source.account_id}:${source.message_id}`}>{source.message_id}</span> })}</span></div>}{result.warnings.length > 0 && <p className="text-caption text-amber-700 dark:text-amber-300">{result.warnings.join(' ')}</p>}{action === 'draft' && result.text.trim() && <button type="button" onClick={openDraft} className="rounded-control bg-accent px-2.5 py-1.5 text-xs font-semibold text-white"><FileText size={13} className="mr-1 inline" />{t('assistant.openDraft', { defaultValue: 'Open editable draft' })}</button>}{result.tasks.length > 0 && <div className="space-y-2"><div className="flex items-center gap-2 text-xs font-semibold text-primary"><ListChecks size={14} />{t('assistant.taskSuggestions', { defaultValue: 'Suggested tasks' })}</div>{result.tasks.map((task, index) => <label key={`${task.account_id}:${task.message_id}:${index}`} className="flex items-start gap-2 text-xs text-secondary"><input type="checkbox" checked={selectedTasks.has(index)} onChange={() => setSelectedTasks((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })} className="mt-0.5 accent-accent" /><span>{task.title}{task.note && task.note !== task.title ? ` — ${task.note}` : ''}</span></label>)}<button type="button" onClick={() => void saveSelectedTasks()} disabled={selectedTasks.size === 0} className="rounded-control bg-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t('assistant.saveTasks', { defaultValue: 'Create selected tasks' })}</button></div>}</div>}
        <div className="flex justify-end gap-2"><button type="button" onClick={busy ? () => void cancel() : close} className="rounded-control px-3 py-2 text-xs font-semibold text-secondary hover:bg-hover">{busy ? t('assistant.cancelRequest', { defaultValue: 'Cancel request' }) : t('buttons.cancel')}</button><button type="button" disabled={!preview || !reviewed || busy} onClick={() => void run()} className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy && <Loader2 size={13} className="animate-spin" />}{!busy && <Check size={13} />}{t('assistant.activate', { defaultValue: 'Activate' })}</button></div>
      </div>
    </div>
  )
}
