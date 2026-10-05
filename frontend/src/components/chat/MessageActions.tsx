import { Archive, ExternalLink, Forward, Mail, MailOpen, MoreHorizontal, Star, Trash2 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { archiveMessage, deleteMessage, markMessageReadState, starMessage } from '../../states/mail'
import type { Message } from '../../types'
import { useReadOnlyMail } from '../../lib/useReadOnlyMail'
import { forwardMessage } from '../../states/compose'
import { formatFullTimestamp } from './messageHelpers'
import { Button } from '../button/Button'

/**
 * What can be done to one message, above the message itself.
 *
 * Above it rather than only in the header at the top of the pane: a
 * conversation is often a dozen messages long, and the header can only act on
 * the whole of it. The reply worth keeping and the eleven "thanks" above it do
 * not belong in the same place, and deciding that is a per-message act.
 *
 * Shown, not hidden behind a hover. A control that only exists once the
 * pointer finds it is a control most readers never learn about, and the cost
 * here is a row of small icons the eye skips over.
 */
export function MessageActions({
  message,
  isDraft,
  isRSS,
  onOpen,
  onMore,
  variant = 'floating',
}: {
  message: Message
  isDraft: boolean
  isRSS: boolean
  onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void
  /**
   * `floating` rides the top edge of a chat bubble; `inline` sits in the
   * header line of a stacked message, which has a row for it already.
   */
  variant?: 'floating' | 'inline'
}) {
  const { t } = useTranslation()
  const readOnly = useReadOnlyMail(message.account_id)

  const button = (
    key: string,
    Icon: typeof Star,
    label: string,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void,
    tone?: 'danger' | 'on',
  ) => (
    <button
      key={key}
      type="button"
      disabled={readOnly && ((key !== 'open' && key !== 'more') || (key === 'open' && isDraft))}
      title={label}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-control-sm transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'inline' ? 'h-8 w-8' : 'h-6 w-6',
        tone === 'danger'
          ? 'enabled:hover:bg-danger-soft enabled:hover:text-danger'
          : tone === 'on'
            ? 'text-warning enabled:hover:bg-hover'
            : 'enabled:hover:bg-hover enabled:hover:text-primary',
      )}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" className={clsx(tone === 'on' && 'fill-current')} />
    </button>
  )

  return (
    <div
      role="group"
      aria-label={`${t('chat.moreMessageActions')} — ${message.from_name || message.from_addr} — ${formatFullTimestamp(message.date)}`}
      className={clsx(
        'flex items-center gap-0.5 text-secondary',
        variant === 'floating'
          ? 'absolute right-2 -top-3.5 z-20 rounded-full border border-border/40 bg-header/95 p-0.5 shadow-sm'
          : 'min-w-0 flex-wrap',
      )}
    >
      {variant === 'inline' && !isDraft && !isRSS && (
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Forward}
          disabled={readOnly}
          onClick={() => void forwardMessage(message)}
        >
          {t('chat.actions.forward')}
        </Button>
      )}
      {button('open', ExternalLink, isDraft ? t('chat.actions.openDraft') : t('threads.actions.openInNewTab'), onOpen)}
      {/* A feed item is not mail: it cannot be starred on a server, marked
          read for anyone else, or filed anywhere. */}
      {!isRSS && !isDraft && (
        <>
          {button(
            'star',
            Star,
            message.starred ? t('chat.unstar') : t('chat.star'),
            () => void starMessage(message, !message.starred),
            message.starred ? 'on' : undefined,
          )}
          {button(
            'read',
            message.unread ? MailOpen : Mail,
            message.unread ? t('threads.actions.markAsRead') : t('threads.actions.markAsUnread'),
            () => void markMessageReadState(message, message.unread),
          )}
          {button('archive', Archive, t('chat.actions.archiveMessage'), () => void archiveMessage(message))}
        </>
      )}
      {button(
        'delete',
        Trash2,
        isDraft ? t('chat.actions.discardDraft') : t('chat.actions.deleteMessage'),
        () => void deleteMessage(message),
        'danger',
      )}
      {button('more', MoreHorizontal, t('chat.moreMessageActions'), onMore)}
    </div>
  )
}
