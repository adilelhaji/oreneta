import { Clock } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { scheduled$ } from '../../states/scheduledSends'
import { ui$ } from '../../states/ui'

/**
 * A line above the list saying how many messages are waiting to go.
 *
 * Here because this is where the reader already looks. A message put off for
 * Monday should not depend on remembering that it was: it says so, above the
 * inbox, until it goes.
 */
export function ScheduledSendsBar() {
  const { t } = useTranslation()
  const messages = useValue(scheduled$.messages)
  if (messages.length === 0) return null

  const failed = messages.some((message) => message.gaveUp)
  return (
    <button
      type="button"
      onClick={() => ui$.scheduledSendsOpen.set(true)}
      className={`flex w-full shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-left text-caption font-medium transition-colors cursor-pointer ${
        failed ? 'bg-rose-500/10 text-rose-500 hover:bg-rose-500/15' : 'text-secondary hover:bg-hover'
      }`}
    >
      <Clock size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{t('sendLater.waiting', { count: messages.length })}</span>
    </button>
  )
}
