import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$, isSendableAccount } from '../../states/accounts'
import {
  cancelMerge,
  merge$,
  previewMerge,
  refreshMerges,
  resumeMerge,
  startMerge,
  tally,
  type MergeBatch,
  type MergeInput,
  type MergePreview,
} from '../../states/merge'
import { confirmAction } from '../../states/ui'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

const field =
  'w-full rounded-control-sm border border-border bg-app px-2 py-1.5 text-caption text-primary outline-none focus:border-accent'

/**
 * A personalized mailing (#90, ADR-0026): one message per recipient, each
 * addressed to that recipient alone, every one of them shown before anything
 * is sent, and what happened to each kept afterwards.
 */
export function MergeDialog() {
  const { t } = useTranslation()
  const open = useValue(merge$.open)
  const batches = useValue(merge$.batches)
  const accounts = useValue(accounts$).filter(isSendableAccount)
  const [input, setInput] = useState<MergeInput>({
    account: '',
    from: '',
    meName: '',
    recipients: '',
    subject: '',
    body: '',
  })
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [watching, setWatching] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void refreshMerges()
    const account = accounts[0]
    if (account && !input.account)
      setInput((was) => ({ ...was, account: account.id, from: account.email, meName: account.display_name ?? '' }))
    const eventsOn = (window as any).runtime?.EventsOn
    const off = eventsOn?.('merge.changed', () => void refreshMerges())
    return () => {
      if (typeof off === 'function') off()
    }
    // Asked once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const change = (partial: Partial<MergeInput>) => {
    setInput((was) => ({ ...was, ...partial }))
    // Anything changed is a different mailing: it is reviewed again.
    setPreview(null)
  }
  const problemText = (problem: string) => {
    const [kind, name] = problem.split(':')
    switch (kind) {
      case 'invalidAddress':
        return t('merge.problem.invalid', { defaultValue: 'not an address' })
      case 'duplicate':
        return t('merge.problem.duplicate', { defaultValue: 'already in the list' })
      case 'missing':
        return t('merge.problem.missing', { name: `{{${name}}}`, defaultValue: 'nothing for {name}' })
      case 'unknown':
        return t('merge.problem.unknown', {
          name: `{{${name}}}`,
          defaultValue: '{name} is not a column or placeholder',
        })
      case 'noRecipients':
        return t('merge.problem.noRecipients', { defaultValue: 'No recipients' })
      case 'tooMany':
        return t('merge.problem.tooMany', { defaultValue: 'More than 500 recipients' })
      case 'noSubject':
        return t('merge.problem.noSubject', { defaultValue: 'No subject' })
      default:
        return problem
    }
  }

  const review = async () => {
    setBusy(true)
    setError('')
    try {
      setPreview(await previewMerge(input))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!preview?.ready) return
    const count = preview.messages.length
    const confirmed = await confirmAction({
      title: t('merge.confirmTitle', { count, defaultValue: 'Send {count} separate messages?' }),
      message: t('merge.confirmMessage', {
        defaultValue:
          'Each recipient gets their own message, addressed to them alone. They go one at a time; you can stop at any moment, and what was sent stays sent.',
      }),
      confirmLabel: t('merge.confirm', { count, defaultValue: 'Send {count} messages' }),
      cancelLabel: t('buttons.cancel'),
    })
    if (!confirmed) return
    setBusy(true)
    try {
      setWatching(await startMerge(input, count))
      setPreview(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const stateText = (state: string) =>
    ({
      pending: t('merge.state.pending', { defaultValue: 'waiting' }),
      sending: t('merge.state.sending', { defaultValue: 'sending' }),
      accepted: t('merge.state.accepted', { defaultValue: 'sent' }),
      rejected: t('merge.state.rejected', { defaultValue: 'refused' }),
      uncertain: t('merge.state.uncertain', { defaultValue: 'unknown whether it went' }),
      cancelled: t('merge.state.cancelled', { defaultValue: 'not sent' }),
    })[state] ?? state

  const watched: MergeBatch | undefined = batches.find((b) => b.id === watching) ?? undefined

  return (
    <Dialog
      title={t('merge.title', { defaultValue: 'Personalized mailing' })}
      icon={Users}
      width="lg"
      onClose={() => merge$.open.set(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => merge$.open.set(false)}>
            {t('common.close')}
          </Button>
          {!watched && (
            <>
              <Button variant="secondary" disabled={busy || !input.account} onClick={() => void review()}>
                {t('merge.preview', { defaultValue: 'Preview every message' })}
              </Button>
              <Button disabled={busy || !preview?.ready} onClick={() => void send()}>
                {t('merge.send', { count: preview?.messages.length ?? 0, defaultValue: 'Send {count} messages' })}
              </Button>
            </>
          )}
        </>
      }
    >
      {watched ? (
        <BatchView batch={watched} stateText={stateText} onBack={() => setWatching(null)} />
      ) : (
        <div className="flex flex-col gap-2.5 text-caption">
          <label className="flex flex-col gap-1 text-secondary">
            {t('merge.from', { defaultValue: 'From' })}
            <select
              className={field}
              value={input.account}
              onChange={(e) => {
                const account = accounts.find((a) => a.id === e.target.value)
                change({ account: e.target.value, from: account?.email ?? '', meName: account?.display_name ?? '' })
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('merge.recipients', { defaultValue: 'Recipients' })}
            <textarea
              className={`${field} h-28 font-mono`}
              value={input.recipients}
              onChange={(e) => change({ recipients: e.target.value })}
              placeholder={'email,name,company\nann@example.com,Ann Lee,Acme'}
            />
            <span className="text-2xs">
              {t('merge.recipientsHint', {
                defaultValue:
                  'One per line, or a table whose first line names its columns (one called email). Columns become placeholders.',
              })}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('merge.subject', { defaultValue: 'Subject' })}
            <input className={field} value={input.subject} onChange={(e) => change({ subject: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('merge.body', { defaultValue: 'Message (plain text)' })}
            <textarea
              className={`${field} h-32`}
              value={input.body}
              onChange={(e) => change({ body: e.target.value })}
            />
          </label>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          {preview && (
            <section aria-label={t('merge.previewLabel', { defaultValue: 'Every message, as it would go' })}>
              {preview.problems.map((p) => (
                <p key={p} className="text-danger">
                  {problemText(p)}
                </p>
              ))}
              <p className="text-secondary">
                {preview.ready
                  ? t('merge.ready', {
                      count: preview.messages.length,
                      defaultValue: '{count} messages, each to one recipient. Nothing is sent until you press Send.',
                    })
                  : t('merge.notReady', { defaultValue: 'Fix what is marked before sending.' })}
              </p>
              <ol className="mt-1.5 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {preview.messages.map((m) => (
                  <li key={m.index} className="rounded-control-sm border border-border px-2 py-1.5">
                    <p className="font-semibold text-primary">
                      {m.to} · {m.subject}
                    </p>
                    {m.problems.length > 0 && (
                      <p className="text-danger">
                        {t('merge.line', { line: m.line, defaultValue: 'Line {line}' })}:{' '}
                        {m.problems.map(problemText).join(', ')}
                      </p>
                    )}
                    <pre className="whitespace-pre-wrap font-sans text-secondary">{m.body}</pre>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {batches.length > 0 && (
            <section aria-label={t('merge.earlier', { defaultValue: 'Earlier mailings' })}>
              <p className="mt-1 font-semibold text-primary">
                {t('merge.earlier', { defaultValue: 'Earlier mailings' })}
              </p>
              <ul className="flex flex-col gap-1">
                {batches.map((b) => {
                  const counts = tally(b)
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        className="text-start text-accent underline"
                        onClick={() => setWatching(b.id)}
                      >
                        {b.subject} —{' '}
                        {t('merge.sentOf', {
                          sent: counts.accepted,
                          total: b.items.length,
                          defaultValue: '{sent} of {total} sent',
                        })}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  )
}

function BatchView({
  batch,
  stateText,
  onBack,
}: {
  batch: MergeBatch
  stateText: (state: string) => string
  onBack: () => void
}) {
  const { t } = useTranslation()
  const counts = tally(batch)
  return (
    <div className="flex flex-col gap-2 text-caption">
      <p className="text-primary">
        {t('merge.progress', {
          sent: counts.accepted,
          total: batch.items.length,
          defaultValue: '{sent} of {total} sent',
        })}
        {counts.uncertain > 0 &&
          ` · ${t('merge.uncertainCount', { count: counts.uncertain, defaultValue: '{count} unknown, never sent again on their own' })}`}
        {counts.rejected > 0 &&
          ` · ${t('merge.rejectedCount', { count: counts.rejected, defaultValue: '{count} refused' })}`}
      </p>
      {batch.reason && <p className="text-secondary">{batch.reason}</p>}
      <div className="flex flex-wrap gap-1.5">
        {batch.state === 'sending' && (
          <Button size="sm" variant="secondary" onClick={() => void cancelMerge(batch.id)}>
            {t('merge.stop', { defaultValue: 'Stop sending' })}
          </Button>
        )}
        {batch.state === 'paused' && (
          <Button size="sm" variant="secondary" onClick={() => void resumeMerge(batch.id, false)}>
            {t('merge.resume', { defaultValue: 'Carry on' })}
          </Button>
        )}
        {(batch.state === 'paused' || batch.state === 'done') && counts.rejected > 0 && (
          <Button size="sm" variant="secondary" onClick={() => void resumeMerge(batch.id, true)}>
            {t('merge.retryRejected', { defaultValue: 'Try the refused ones again' })}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onBack}>
          {t('merge.back', { defaultValue: 'Back' })}
        </Button>
      </div>
      <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {batch.items.map((item) => (
          <li key={item.index} className="flex justify-between gap-2 rounded-control-sm border border-border px-2 py-1">
            <span className="min-w-0 truncate text-primary">{item.to}</span>
            <span
              className={item.state === 'rejected' || item.state === 'uncertain' ? 'text-danger' : 'text-secondary'}
            >
              {stateText(item.state)}
              {item.error ? `: ${item.error}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
