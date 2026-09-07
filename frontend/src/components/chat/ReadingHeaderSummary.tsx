import type { MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from '../../lib/i18n'
import { formatThreadDate } from '../../lib/date'
import { clsx } from '../../lib/utils'
import { Avatar } from '../avatar/Avatar'
import type { ReadingSummary } from './readingHeader'

/** How many faces fit before the rest become a number. */
const FACES = 3
/** How many names read as a list before the rest become a number. */
const NAMES = 3

/**
 * The line under the subject that describes the conversation rather than its
 * newest message: who is in it, how much of it there is, and when it last
 * moved.
 *
 * The whole strip is a button. Everything it summarises — the full cast, every
 * message, the attachments — is in the details panel, so the summary opens it
 * rather than duplicating it. A reader who wants the fourth participant's
 * address should not have to find a different affordance.
 *
 * When older messages have not been fetched, the faces are marked as an
 * incomplete cast instead of being presented as everyone. The count beside them
 * still comes from the core, which counted the whole thread, so the two do not
 * contradict each other: it can honestly say "nine messages" while showing
 * three of the people in them.
 */
export function ReadingHeaderSummary({
  summary,
  onOpenDetails,
  onSenderMenu,
  detailsOpen,
}: {
  summary: ReadingSummary
  onOpenDetails: () => void
  /** Right-click: the things one says about the most recent sender, which the
   * plain sender line offered and which this replaces. */
  onSenderMenu: (event: ReactMouseEvent<HTMLElement>) => void
  detailsOpen: boolean
}) {
  const { t } = useTranslation()

  const shown = summary.participants.slice(0, NAMES)
  const hidden = summary.participants.length - shown.length
  const names = shown.map((person) => (person.self ? t('reading.you') : person.name)).join(', ')

  const facts: string[] = []
  if (summary.messageCount !== null && summary.messageCount > 1) {
    facts.push(t('reading.messages', { count: summary.messageCount }))
  }
  if (summary.unreadCount !== null && summary.unreadCount > 0) {
    facts.push(t('reading.unread', { count: summary.unreadCount }))
  }
  if (summary.lastDate !== null) facts.push(formatThreadDate(summary.lastDate))

  return (
    <button
      type="button"
      onClick={onOpenDetails}
      onContextMenu={onSenderMenu}
      aria-expanded={detailsOpen}
      aria-label={t('chat.conversationDetails')}
      className="mt-0.5 flex min-w-0 max-w-full items-center gap-2 rounded-sm text-left outline-none transition-colors cursor-pointer hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {/* Overlapping faces, oldest of the shown behind. Small enough to read
          as one object rather than as a row of controls. */}
      <span className="flex shrink-0 -space-x-1.5">
        {summary.participants.slice(0, FACES).map((person) => (
          <Avatar
            key={person.address}
            name={person.name}
            email={person.address}
            size={18}
            className="ring-1 ring-header"
          />
        ))}
      </span>
      <span
        className={clsx('min-w-0 truncate text-xs font-medium text-secondary')}
        title={summary.participants.map((person) => person.address).join(', ')}
      >
        {names}
        {hidden > 0 && <span className="opacity-70"> {t('reading.andMore', { count: hidden })}</span>}
        {/* Said, not implied. A cast that might be short must look short. */}
        {summary.partial && (
          <span className="opacity-70" title={t('reading.partialHint')}>
            {' '}
            {t('reading.partial')}
          </span>
        )}
        {facts.length > 0 && <span className="opacity-70"> · {facts.join(' · ')}</span>}
      </span>
    </button>
  )
}
