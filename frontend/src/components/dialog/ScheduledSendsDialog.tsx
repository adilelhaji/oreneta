import { useEffect } from 'react'
import { Clock, Send, AlertTriangle } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { formatDeferredWhen } from '../../lib/date'
import { ui$ } from '../../states/ui'
import {
  scheduled$,
  cancelAndReopen,
  refreshScheduledSends,
  sendScheduledNow,
} from '../../states/scheduledSends'
import { Button } from '../button/Button'
import { Dialog } from './Dialog'

/**
 * What is still waiting to go.
 *
 * A message put off can be let go early, or called off and reopened. Nothing
 * here is only informational: every row is a message the reader can still
 * decide about, which is the whole point of having somewhere to see them.
 */
export function ScheduledSendsDialog() {
  const { t } = useTranslation()
  const messages = useValue(scheduled$.messages)

  const onClose = () => ui$.scheduledSendsOpen.set(false)

  // Read again on opening: the hour may have come while the dialog was closed,
  // and a list showing a message that has already gone is worse than no list.
  useEffect(() => {
    void refreshScheduledSends()
  }, [])

  return (
    <Dialog title={t('sendLater.title')} icon={Clock} width="lg" onClose={onClose}>
      {messages.length === 0 ? (
        <p className="py-6 text-center text-ui text-secondary">{t('sendLater.empty')}</p>
      ) : (
        <ul className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
          {messages.map((message) => (
            <li key={message.id} className="flex flex-col gap-2 rounded-panel border border-border bg-raised px-3.5 py-3">
              <div className="min-w-0">
                <p className="truncate text-ui font-semibold">{message.subject || t('sendLater.noSubject')}</p>
                <p className="mt-0.5 truncate text-caption text-secondary">{message.to}</p>
              </div>
              {message.gaveUp ? (
                <p className="flex items-start gap-1.5 text-caption font-medium text-rose-500">
                  <AlertTriangle size={12} className="mt-px shrink-0" />
                  <span className="min-w-0">{t('sendLater.failedReason', { reason: message.lastError })}</span>
                </p>
              ) : (
                <p className="text-caption text-secondary">
                  {t('sendLater.willSend', { when: formatDeferredWhen(message.dueAt) })}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button size="sm" leftIcon={Send} onClick={() => void sendScheduledNow(message.id)}>
                  {t('sendLater.sendNow')}
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
    </Dialog>
  )
}
