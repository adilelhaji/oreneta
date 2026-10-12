import { useEffect } from 'react'
import { Hourglass } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  awaiting$,
  loadAwaiting,
  ruleOnAnswer,
  settleAwaiting,
  type AwaitingEvidence,
  type AwaitingItem,
} from '../../states/awaiting'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Everything the person is waiting on a reply to (#45, ADR-0025): what
 * answered it and how that is known, what may have, and what is late. A
 * doubtful answer is never counted until the person says so.
 */
export function AwaitingDialog() {
  const { t } = useTranslation()
  const open = useValue(awaiting$.open)
  const items = useValue(awaiting$.items)

  useEffect(() => {
    if (open) void loadAwaiting()
  }, [open])

  if (!open) return null

  const how = (evidence: AwaitingEvidence) =>
    evidence.link === 'direct'
      ? t('awaiting.direct', {
          from: evidence.from,
          when: day(evidence.date),
          defaultValue: '{from} replied to it on {when}',
        })
      : t('awaiting.conversation', {
          from: evidence.from,
          when: day(evidence.date),
          defaultValue: '{from} wrote in the same conversation on {when}',
        })
  const doubt = (evidence: AwaitingEvidence) =>
    evidence.doubt === 'automated'
      ? t('awaiting.doubtAutomated', { defaultValue: 'It comes from an address that sends automatic messages.' })
      : t('awaiting.doubtStranger', { defaultValue: 'It comes from someone the message was not sent to.' })
  const status = (item: AwaitingItem) =>
    item.status === 'answered'
      ? t('awaiting.answered', { defaultValue: 'Answered' })
      : item.status === 'possible'
        ? t('awaiting.possible', { defaultValue: 'Maybe answered' })
        : item.overdue
          ? t('awaiting.overdue', { defaultValue: 'No reply yet, past its reminder' })
          : t('awaiting.waiting', { defaultValue: 'Waiting' })

  return (
    <Dialog
      title={t('awaiting.title', { defaultValue: 'Waiting for replies' })}
      icon={Hourglass}
      width="lg"
      onClose={() => awaiting$.open.set(false)}
      footer={<Button onClick={() => awaiting$.open.set(false)}>{t('common.close')}</Button>}
    >
      <p className="text-caption text-secondary">
        {t('awaiting.hint', {
          defaultValue:
            'Replies are recognised by what they answer and who sent them, never by the subject. Nothing is sent for you; reminders only appear here.',
        })}
      </p>
      {items.length === 0 ? (
        <p className="py-4 text-caption text-secondary">
          {t('awaiting.empty', {
            defaultValue: 'Nothing yet. Choose “Wait for a reply” on a conversation you have written in.',
          })}
        </p>
      ) : (
        <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
          {items.map((item) => (
            <li key={`${item.account}:${item.messageId}`} className="rounded-control border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-ui font-semibold text-primary">
                  {item.subject || t('awaiting.noSubject', { defaultValue: '(no subject)' })}
                </p>
                <span
                  className={`text-2xs font-semibold ${item.status === 'answered' ? 'text-accent' : item.overdue ? 'text-danger' : 'text-secondary'}`}
                >
                  {status(item)}
                </span>
              </div>
              <p className="text-2xs text-secondary">
                {t('awaiting.sentTo', {
                  to: item.recipients.join(', '),
                  when: day(item.sentAt),
                  defaultValue: 'To {to}, sent {when}',
                })}
                {item.remindAt
                  ? ` · ${t('awaiting.remindAt', { when: day(item.remindAt), defaultValue: 'reminder {when}' })}`
                  : ''}
              </p>
              {item.answer && <p className="mt-1 text-caption text-primary">{how(item.answer)}</p>}
              {item.possible.map((evidence) => (
                <div key={evidence.messageId} className="mt-1.5 rounded-control-sm bg-hover px-2 py-1.5 text-caption">
                  <p className="text-primary">{how(evidence)}</p>
                  <p className="text-secondary">{doubt(evidence)}</p>
                  <div className="mt-1 flex gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void ruleOnAnswer(item, evidence.messageId, true)}
                    >
                      {t('awaiting.isAnswer', { defaultValue: 'That is the answer' })}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void ruleOnAnswer(item, evidence.messageId, false)}
                    >
                      {t('awaiting.notAnswer', { defaultValue: 'Not an answer' })}
                    </Button>
                  </div>
                </div>
              ))}
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => void settleAwaiting(item, 'done')}>
                  {t('awaiting.done', { defaultValue: 'Done' })}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void settleAwaiting(item, 'cancelled')}>
                  {t('awaiting.stop', { defaultValue: 'Stop waiting' })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
