import { AlertTriangle, Clock } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { scheduled$ } from '../../states/scheduledSends'
import { outgoing$ } from '../../states/outgoingAttempts'
import { ui$ } from '../../states/ui'

/**
 * A line above the list saying how many messages are waiting to go.
 *
 * Here because this is where the reader already looks. A message put off for
 * Monday should not depend on remembering that it was: it says so, above the
 * inbox, until it goes. A message the server took without answering for
 * says so here too, ahead of the rest: it is the one thing on this line
 * that cannot be left to sort itself out.
 */
export function ScheduledSendsBar() {
  const { t } = useTranslation()
  const messages = useValue(scheduled$.messages)
  const attempts = useValue(outgoing$.attempts)
  // A scheduled message of unknown outcome is listed once, as itself, not
  // again as the attempt it made.
  const scheduledIds = new Set(messages.map((message) => message.id))
  const undecided =
    messages.filter((message) => message.uncertain).length +
    attempts.filter((attempt) => !scheduledIds.has(attempt.id)).length
  if (messages.length === 0 && undecided === 0) return null

  const failed = undecided > 0 || messages.some((message) => message.gaveUp)
  const Icon = undecided > 0 ? AlertTriangle : Clock
  return (
    <button
      type="button"
      onClick={() => ui$.scheduledSendsOpen.set(true)}
      className={`flex w-full shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-left text-caption font-medium transition-colors cursor-pointer ${
        failed ? 'bg-danger-soft text-danger hover:bg-danger-soft' : 'text-secondary hover:bg-hover'
      }`}
    >
      <Icon size={14} className="shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate">
        {undecided > 0
          ? t('outgoing.waiting', { count: undecided })
          : t('sendLater.waiting', { count: messages.length })}
      </span>
    </button>
  )
}
