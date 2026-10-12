import { useEffect } from 'react'
import { Clock, Send, AlertTriangle, Check } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { formatDeferredWhen } from '../../lib/date'
import { ui$ } from '../../states/ui'
import { scheduled$, cancelAndReopen, refreshScheduledSends, sendScheduledNow } from '../../states/scheduledSends'
import {
  outgoing$,
  refreshOutgoingAttempts,
  resendOutgoingAttempt,
  settleOutgoingAttempt,
  type OutgoingAttempt,
} from '../../states/outgoingAttempts'
import { Button } from '../button/Button'
import { Dialog } from './Dialog'

/**
 * What is still waiting to go, and what went without an answer.
 *
 * A message put off can be let go early, or called off and reopened. Nothing
 * here is only informational: every row is a message the reader can still
 * decide about, which is the whole point of having somewhere to see them.
 *
 * The second kind of row is a decision nobody else can make: the server
 * took the message in full and never said whether it accepted it. Sending
 * again may deliver it twice; not sending may lose it. Both choices are
 * offered, with what they mean, and neither is made on the reader's behalf.
 */
export function ScheduledSendsDialog() {
  const { t } = useTranslation()
  const messages = useValue(scheduled$.messages)
  const attempts = useValue(outgoing$.attempts)

  const onClose = () => ui$.scheduledSendsOpen.set(false)

  // Read again on opening: the hour may have come while the dialog was closed,
  // and a list showing a message that has already gone is worse than no list.
  useEffect(() => {
    void refreshScheduledSends()
    void refreshOutgoingAttempts()
  }, [])

  // A scheduled message of unknown outcome shows as itself, with its own
  // choices; the attempt it made is the same thing and is not listed twice.
  const scheduledIds = new Set(messages.map((message) => message.id))
  const undecided = attempts.filter((attempt) => !scheduledIds.has(attempt.id))

  return (
    <Dialog title={t('sendLater.title')} icon={Clock} width="lg" onClose={onClose}>
      {messages.length === 0 && undecided.length === 0 ? (
        <p className="py-6 text-center text-ui text-secondary">{t('sendLater.empty')}</p>
      ) : (
        <div className="flex max-h-[24rem] flex-col gap-4 overflow-y-auto">
          {undecided.length > 0 && (
            <section aria-labelledby="outgoing-undecided-title" className="flex flex-col gap-2">
              <h3
                id="outgoing-undecided-title"
                className="flex items-center gap-1.5 text-caption font-semibold text-danger"
              >
                <AlertTriangle size={14} strokeWidth={1.75} />
                {t('outgoing.title')}
              </h3>
              <ul className="flex flex-col gap-2">
                {undecided.map((attempt) => (
                  <UndecidedRow key={attempt.id} attempt={attempt} />
                ))}
              </ul>
            </section>
          )}
          {messages.length > 0 && (
            <ul className="flex flex-col gap-2">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className="flex flex-col gap-2 rounded-panel border border-border bg-raised px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-ui font-semibold">{message.subject || t('sendLater.noSubject')}</p>
                    <p className="mt-0.5 truncate text-caption text-secondary">{message.to}</p>
                  </div>
                  {message.uncertain ? (
                    <div className="flex flex-col gap-1 text-caption">
                      <p className="flex items-start gap-1.5 font-medium text-danger">
                        <AlertTriangle size={14} className="mt-px shrink-0" strokeWidth={1.75} />
                        <span className="min-w-0">{t('outgoing.uncertainReason', { reason: message.lastError })}</span>
                      </p>
                      <p className="text-secondary">{t('outgoing.sendAgainWarning')}</p>
                    </div>
                  ) : message.gaveUp ? (
                    <p className="flex items-start gap-1.5 text-caption font-medium text-danger">
                      <AlertTriangle size={14} className="mt-px shrink-0" strokeWidth={1.75} />
                      <span className="min-w-0">{t('sendLater.failedReason', { reason: message.lastError })}</span>
                    </p>
                  ) : (
                    <p className="text-caption text-secondary">
                      {t('sendLater.willSend', { when: formatDeferredWhen(message.dueAt) })}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      leftIcon={Send}
                      onClick={() => void sendScheduledNow(message.id, message.uncertain === true)}
                    >
                      {message.uncertain ? t('outgoing.sendAgain') : t('sendLater.sendNow')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onClose()
                        void cancelAndReopen(message.id)
                      }}
                    >
                      {t('sendLater.cancelSend')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  )
}

/** One send the reader has to settle: handed over without an answer, or
 * sent without a copy in Sent. */
function UndecidedRow({ attempt }: { attempt: OutgoingAttempt }) {
  const { t } = useTranslation()
  const unanswered = attempt.state === 'uncertain'
  return (
    <li className="flex flex-col gap-2 rounded-panel border border-danger/40 bg-raised px-3.5 py-3">
      <div className="min-w-0">
        <p className="truncate text-ui font-semibold">{attempt.subject || t('sendLater.noSubject')}</p>
        <p className="mt-0.5 truncate text-caption text-secondary">{attempt.to}</p>
      </div>
      <div className="flex flex-col gap-1 text-caption">
        <p className="flex items-start gap-1.5 font-medium text-danger">
          <AlertTriangle size={14} className="mt-px shrink-0" strokeWidth={1.75} />
          <span className="min-w-0">
            {unanswered
              ? t('outgoing.uncertainReason', { reason: attempt.error })
              : t('outgoing.unfiledReason', { reason: attempt.archiveError })}
          </span>
        </p>
        {unanswered && attempt.message && <p className="text-secondary">{t('outgoing.sendAgainWarning')}</p>}
      </div>
      <div className="flex items-center gap-2">
        {unanswered && attempt.message && (
          <Button size="sm" leftIcon={Send} onClick={() => void resendOutgoingAttempt(attempt.id)}>
            {t('outgoing.sendAgain')}
          </Button>
        )}
        <Button size="sm" variant="ghost" leftIcon={Check} onClick={() => void settleOutgoingAttempt(attempt.id)}>
          {t('outgoing.markSettled')}
        </Button>
      </div>
    </li>
  )
}
