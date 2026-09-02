import { useEffect } from 'react'
import { X, Clock, Send, AlertTriangle } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { formatDeferredWhen } from '../../lib/date'
import { ui$ } from '../../states/ui'
import {
  scheduled$,
  cancelAndReopen,
  refreshScheduledSends,
  sendScheduledNow,
} from '../../states/scheduledSends'
import { IconButton } from '../button/IconButton'

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
  useEscapeKey(onClose, true)

  // Read again on opening: the hour may have come while the dialog was closed,
  // and a list showing a message that has already gone is worse than no list.
  useEffect(() => {
    void refreshScheduledSends()
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[3px] select-none animate-fade-in dark:bg-black/60">
      <div className="flex w-full max-w-lg flex-col gap-5 rounded-3xl border border-border bg-chats p-6 text-primary shadow-2xl animate-slide-up">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Clock size={17} />
            </div>
            <h2 className="text-title font-bold leading-tight tracking-tight">{t('sendLater.title')}</h2>
          </div>
          <IconButton icon={X} iconSize={16} label={t('buttons.close')} radius="xl" onClick={onClose} />
        </div>

        {messages.length === 0 ? (
          <p className="py-6 text-center text-ui text-secondary">{t('sendLater.empty')}</p>
        ) : (
          <ul className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
            {messages.map((message) => (
              <li
                key={message.id}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-panel px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-ui font-semibold">
                    {message.subject || t('sendLater.noSubject')}
                  </p>
                  <p className="mt-0.5 truncate text-caption text-secondary">{message.to}</p>
                </div>
                {message.gaveUp ? (
                  <p className="flex items-start gap-1.5 text-caption font-medium text-rose-500">
                    <AlertTriangle size={12} className="mt-px shrink-0" />
                    <span className="min-w-0">
                      {t('sendLater.failedReason', { reason: message.lastError })}
                    </span>
                  </p>
                ) : (
                  <p className="text-caption text-secondary">
                    {t('sendLater.willSend', { when: formatDeferredWhen(message.dueAt) })}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void sendScheduledNow(message.id)}
                    className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer"
                  >
                    <Send size={11} />
                    {t('sendLater.sendNow')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      void cancelAndReopen(message.id)
                    }}
                    className="rounded-xl px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer"
                  >
                    {t('sendLater.cancelSend')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
