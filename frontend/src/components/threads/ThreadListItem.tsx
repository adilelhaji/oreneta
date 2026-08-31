import type { DragEvent, MouseEvent, Ref } from 'react'
import { useValue } from '@legendapp/state/react'
import { Archive, Check, Clock, Mail, MailOpen, Star, Trash2 } from 'lucide-react'
import type { Account, Message } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { formatThreadDate } from '../../lib/date'
import { clsx } from '../../lib/utils'
import { useTranslation } from '../../lib/i18n'
import { isDraftFolder } from '../../states/mail'
import { settings$ } from '../../states/settings'
import { densityStyle } from './listDensity'
import { LabelChips } from './LabelChips'

/** What a row offers without being opened. */
export type QuickRowAction = 'archive' | 'trash' | 'snooze' | 'read'

export function ThreadListItem({
  thread,
  accounts,
  selectedAccount,
  selectedThread,
  active,
  onSelect,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  className = '',
  rootRef,
  showAccountBadge,
  bulkSelectable = false,
  bulkSelected = false,
  onQuickAction,
  onToggleSelect,
}: {
  thread: Message
  accounts: Account[]
  selectedAccount: string
  selectedThread: string
  active?: boolean
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void
  onContextMenu?: (event: MouseEvent) => void
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void
  className?: string
  rootRef?: Ref<HTMLDivElement>
  showAccountBadge?: boolean
  bulkSelectable?: boolean
  bulkSelected?: boolean
  /** Triage from the row itself. Omitted where the actions do not apply. */
  onQuickAction?: (action: QuickRowAction) => void
  /** Starts selecting from this row. Omitted where selecting is not offered. */
  onToggleSelect?: () => void
}) {
  const { t } = useTranslation()
  const density = densityStyle(useValue(settings$.listDensity))
  const isActive = active ?? thread.thread_id === selectedThread
  const threadAccount = accounts.find((acc) => acc.id === thread.account_id)
  const badgeLabel = threadAccount ? threadAccount.display_name || threadAccount.email : ''
  const accountBadgeVisible = showAccountBadge ?? selectedAccount === 'unified'
  const threadTitle = thread.subject || '(no subject)'
  // RSS feed rows carry a feed_url (and, once cached, a feed_icon). For those,
  // skip the email-based gravatar/favicon resolution and use the feed's icon.
  const isRSS = !!thread.feed_url
  const unread = thread.unread
  const hasDraft = !isRSS && (thread.has_draft || isDraftFolder(thread.folder_id, thread.account_id))

  // The row's own actions, built here so the markup below stays a loop. Read
  // and unread are one control that says which it will do, not two.
  const quickActions: { key: QuickRowAction; icon: typeof Star; label: string; danger?: boolean }[] = isRSS
    ? []
    : [
        {
          key: 'read',
          icon: unread ? MailOpen : Mail,
          label: unread ? t('threads.actions.markAsRead') : t('threads.actions.markAsUnread'),
        },
        { key: 'snooze', icon: Clock, label: t('threads.actions.snoozeTomorrow') },
        { key: 'archive', icon: Archive, label: t('threads.actions.archiveThread') },
        { key: 'trash', icon: Trash2, label: t('threads.actions.moveToTrash'), danger: true },
      ]

  // Built once and placed by density: compact puts them on the sender's line,
  // the others on a line below. Two copies of this markup would be two things
  // to keep in step for no gain.
  const subjectLine = (
    <p className={clsx('flex-1 truncate text-[0.75rem] leading-snug', unread ? 'font-semibold' : 'font-normal')}>
      {/* Before the subject, where they read as what this conversation is
          rather than as an afterthought at the end of a line that truncates. */}
      {!!thread.labels?.length && (
        <span className="mr-1 inline-flex align-middle">
          <LabelChips ids={thread.labels} max={density.singleLine ? 1 : 2} />
        </span>
      )}
      {hasDraft && <span className="mr-1 font-normal text-rose-500">{t('chat.draft')}</span>}
      <span className={clsx(unread ? 'text-primary' : 'text-primary/85')}>{threadTitle}</span>
      {/* The preview trails the subject unless it has been given its own line,
          where repeating it here would show it twice. */}
      {!!thread.preview && !density.previewOnOwnLine && (
        <span className={clsx(unread ? 'text-secondary/90 font-medium' : 'text-secondary/75 font-normal')}>
          {' - '}
          {thread.preview}
        </span>
      )}
    </p>
  )

  const unreadBadge =
    unread && bulkSelectable ? (
      <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
    ) : unread ? (
      <span className="h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-accent text-white text-[0.625rem] font-bold shadow-sm shadow-accent/20 leading-none shrink-0">
        {thread.unread_count ?? 1}
      </span>
    ) : null

  return (
    <div
      ref={rootRef}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={clsx(
        'group relative border-b border-border/50 last:border-b-0',
        draggable && 'cursor-grab active:cursor-grabbing',
        className,
      )}
    >
      <button
        className={clsx(
          'relative w-full px-2 transition-all duration-150 flex items-center gap-2 cursor-pointer select-none text-left',
          density.rowPadding,
          bulkSelectable
            ? bulkSelected
              ? 'bg-accent/[0.13] text-primary'
              : 'bg-chats hover:bg-hover text-primary'
            : isActive
              ? 'bg-accent/20 dark:bg-accent/30 text-primary'
              : unread
                ? 'bg-accent/[0.07] hover:bg-accent/[0.12] text-primary'
                : 'bg-chats hover:bg-hover text-primary',
        )}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        title={threadTitle}
      >
        {!bulkSelectable && isActive && (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
        )}
        {bulkSelectable ? (
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center justify-center"
            style={{ width: density.avatarSize, height: density.avatarSize }}
          >
            <span
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-full transition-colors',
                bulkSelected
                  ? 'bg-accent text-white shadow-sm shadow-accent/20'
                  : 'border border-secondary/30 text-secondary/35',
              )}
            >
              <Check size={17} strokeWidth={2.6} />
            </span>
          </span>
        ) : (
          <div className="group/avatar relative shrink-0">
            {/* The avatar turns into a checkbox under the pointer. Selecting
                several conversations was reachable only by Ctrl- or
                Shift-clicking, which is a feature nobody finds unless they
                already knew it was there. Here it is where the eye already
                goes, and it costs the row nothing when the pointer is
                elsewhere. */}
            {onToggleSelect && (
              <span
                role="checkbox"
                aria-checked={false}
                aria-label={t('threads.actions.selectThread')}
                title={t('threads.actions.selectThread')}
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleSelect()
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  onToggleSelect()
                }}
                className="absolute inset-0 z-10 hidden items-center justify-center rounded-full bg-chats cursor-pointer group-hover/avatar:flex focus-visible:flex"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-secondary/40 text-secondary/50 transition-colors hover:border-accent hover:text-accent">
                  <Check size={17} strokeWidth={2.6} />
                </span>
              </span>
            )}
            <Avatar
              name={thread.from_name || thread.from_addr}
              email={isRSS ? undefined : thread.from_addr}
              src={isRSS && thread.feed_icon ? `/media/${thread.feed_icon}` : undefined}
              size={density.avatarSize}
            />
            {accountBadgeVisible && threadAccount && (
              <div className="absolute -bottom-1 -left-1 rounded-full ring-2 ring-chats overflow-hidden">
                <Avatar name={badgeLabel} src={threadAccount.avatar_url} size={16} />
              </div>
            )}
          </div>
        )}

        <div className={clsx('flex-1 min-w-0 flex flex-col justify-center', density.rowGap)}>
          <div className="flex items-center gap-2 min-w-0">
            <div className={clsx('flex min-w-0 items-center gap-1', density.singleLine && 'max-w-[40%] shrink-0')}>
              <span
                className={clsx('text-[0.8125rem] font-semibold truncate', unread ? 'text-primary' : 'text-primary/85')}
              >
                {thread.from_name || thread.from_addr.split('@')[0]}
                {!!thread.recipient_overflow && (
                  <span className="ml-1 font-normal text-secondary/80">+{thread.recipient_overflow}</span>
                )}
              </span>
              {/* Gmail-style thread size, muted and only once a thread has a
                  reply. It sits right after the sender rather than in the
                  trailing badge slot so it never competes with the unread
                  count, and outside the truncating span so a long sender
                  ellipsises itself instead of clipping the count. */}
              {(thread.message_count ?? 0) > 1 && (
                <span className="shrink-0 text-[0.75rem] font-normal text-secondary/70">{thread.message_count}</span>
              )}
            </div>
            {/* Compact folds the subject onto the sender's line: one row per
                thread is the whole point of it. The star comes with it — a
                thread does not stop being starred because the list is tight. */}
            {density.singleLine && !bulkSelectable && thread.starred && (
              <Star size={11} className="fill-amber-500 text-amber-500 shrink-0" />
            )}
            {density.singleLine && subjectLine}
            <time
              className={clsx(
                'ml-auto shrink-0 text-[0.6875rem] font-normal',
                unread ? 'text-accent' : 'text-secondary/65',
              )}
            >
              {formatThreadDate(thread.date)}
            </time>
            {density.singleLine && unreadBadge}
          </div>

          {!density.singleLine && (
            <div className="flex items-center gap-1.5 min-w-0">
              {!bulkSelectable && thread.starred && (
                <Star size={11} className="fill-amber-500 text-amber-500 shrink-0" />
              )}
              {subjectLine}
              {unreadBadge}
            </div>
          )}

          {/* Relaxed gives the preview a line of its own — two of them — so a
              subject and the message under it stop competing for one line. */}
          {density.previewOnOwnLine && !!thread.preview && (
            <p className="line-clamp-2 text-[0.75rem] leading-snug text-secondary/75">{thread.preview}</p>
          )}
        </div>
      </button>

      {/* Triage without opening anything. Thunderbird has no equivalent — it
          is a Gmail and Outlook habit — but going through a conversation is
          most of what a morning at a mailbox is, and a menu per message is a
          poor way to spend it.

          Outside the row's own button, not inside it: a button within a
          button is invalid markup, and clicking Archive must not also open
          the conversation on its way past. Hidden while selecting, where the
          gesture belongs to the selection, and in compact rows, where there
          is no room that is not already the subject's. */}
      {!bulkSelectable && !density.singleLine && onQuickAction && (
        <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border/60 bg-chats/95 p-0.5 shadow-sm group-hover:flex">
          {quickActions.map(({ key, icon: Icon, label, danger }) => (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              onClick={(event) => {
                event.stopPropagation()
                onQuickAction(key)
              }}
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer',
                danger
                  ? 'text-secondary hover:bg-rose-500/10 hover:text-rose-500'
                  : 'text-secondary hover:bg-hover hover:text-primary',
              )}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
