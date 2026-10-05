import type { MouseEvent } from 'react'
import { ArrowDown, ArrowUp, Paperclip, Sparkle, Star } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { formatThreadDate } from '../../lib/date'
import { settings$, type ListSort, type SortKey } from '../../states/settings'
import type { Account, Message } from '../../types'
import { LabelChips } from './LabelChips'

const COLUMNS: { key: SortKey; labelKey: string; className: string }[] = [
  { key: 'sender', labelKey: 'table.sender', className: 'w-[27%]' },
  { key: 'subject', labelKey: 'table.subject', className: '' },
  { key: 'date', labelKey: 'table.date', className: 'w-20' },
]

/**
 * The mailbox as a list of facts rather than a conversation.
 *
 * The other view someone arriving from Outlook or Thunderbird expects, and the
 * one that answers "who wrote most recently about X" — which the card list, by
 * putting the sender and the subject on different lines, does not.
 *
 * Sorting is done by the core, in the query, with the position it pages from
 * carrying the ordering key. Ordering the rows that happen to be loaded would
 * put them in order among themselves and in no order at all with respect to
 * the mailbox: it looks like sorting and is not.
 */
export function ThreadTable({
  threads,
  accounts,
  selectedThread,
  showAccount,
  onSelect,
  onContextMenu,
  isBulkSelected,
  onToggleSelect,
}: {
  threads: Message[]
  accounts: Account[]
  selectedThread: string
  showAccount: boolean
  onSelect: (thread: Message, event: MouseEvent<HTMLElement>) => void
  onContextMenu: (thread: Message, event: MouseEvent) => void
  isBulkSelected?: (thread: Message) => boolean
  onToggleSelect?: (thread: Message) => void
}) {
  const { t } = useTranslation()
  const sort = useValue(settings$.listSort)

  const reorder = (key: SortKey) => {
    const next: ListSort =
      sort.key === key
        ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : // A first click on a column asks for the reading that column is
          // usually wanted in: newest first for a date, A to Z for words.
          { key, dir: key === 'date' ? 'desc' : 'asc' }
    settings$.listSort.set(next)
  }

  return (
    <table className="w-full table-fixed border-collapse text-ui">
      <thead className="sticky top-0 z-10 bg-chats">
        <tr>
          {onToggleSelect && (
            <th scope="col" className="w-8 border-b border-border">
              <span className="sr-only">{t('threads.actions.selectThread')}</span>
            </th>
          )}
          {COLUMNS.map((column) => {
            const active = sort.key === column.key
            const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown
            return (
              <th
                key={column.key}
                scope="col"
                aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={clsx('border-b border-border p-0 text-left font-normal', column.className)}
              >
                <button
                  type="button"
                  onClick={() => reorder(column.key)}
                  className={clsx(
                    'flex min-h-8 w-full items-center gap-1 px-2 py-1.5 text-caption font-semibold transition-colors cursor-pointer hover:bg-hover',
                    active ? 'text-accent' : 'text-secondary',
                  )}
                >
                  <span className="min-w-0 truncate">{t(column.labelKey)}</span>
                  {active && <Arrow size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />}
                </button>
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {threads.map((thread) => {
          const active = thread.thread_id === selectedThread
          const bulkSelected = isBulkSelected?.(thread) ?? false
          const subject = thread.subject || t('sendLater.noSubject')
          const account = accounts.find((candidate) => candidate.id === thread.account_id)
          return (
            <tr
              key={thread.id}
              onClick={(event) => onSelect(thread, event)}
              onContextMenu={(event) => onContextMenu(thread, event)}
              data-opened={active || undefined}
              data-bulk-selected={bulkSelected || undefined}
              className={clsx(
                'cursor-pointer border-b border-border/50 transition-colors',
                bulkSelected ? 'bg-accent/15' : active ? 'bg-active' : 'hover:bg-hover',
              )}
            >
              {onToggleSelect && (
                <td className="p-0 text-center">
                  <input
                    type="checkbox"
                    checked={bulkSelected}
                    aria-label={`${t('threads.actions.selectThread')}: ${subject}`}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleSelect(thread)}
                    className="h-4 w-4 align-middle accent-accent cursor-pointer"
                  />
                </td>
              )}
              <td
                title={thread.from_name || thread.from_addr}
                className={clsx(
                  'max-w-0 truncate border-l-2 px-2 py-1.5',
                  active ? 'border-l-accent' : 'border-l-transparent',
                )}
              >
                <span className={clsx('truncate', thread.unread ? 'font-bold text-primary' : 'text-primary/85')}>
                  {thread.from_name || thread.from_addr}
                </span>
                {showAccount && account && (
                  <span className="ml-1 text-2xs text-secondary">{account.display_name || account.email}</span>
                )}
              </td>
              <td className="max-w-0 p-0">
                <button
                  type="button"
                  aria-current={active}
                  title={subject}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelect(thread, event)
                  }}
                  className="flex min-h-8 w-full min-w-0 items-center gap-1 px-2 py-1.5 text-left cursor-pointer focus-visible:-outline-offset-2"
                >
                  {thread.unread && <span className="sr-only">{t('common.unread')}: </span>}
                  {thread.priority && (
                    <Sparkle size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-accent" />
                  )}
                  {thread.starred && (
                    <Star
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="shrink-0 fill-warning text-warning"
                    />
                  )}
                  <span
                    className={clsx(
                      'min-w-0 flex-1 truncate',
                      thread.unread ? 'font-semibold text-primary' : 'text-primary/85',
                    )}
                  >
                    {subject}
                  </span>
                  {thread.labels?.length ? (
                    <span className="max-w-[25%] overflow-hidden">
                      <LabelChips ids={thread.labels} max={1} />
                    </span>
                  ) : null}
                  {thread.has_attachments && (
                    <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-secondary" />
                  )}
                </button>
              </td>
              <td
                className={clsx(
                  'px-2 py-1.5 text-right text-caption tabular-nums',
                  thread.unread ? 'font-semibold text-primary' : 'text-secondary',
                )}
              >
                {formatThreadDate(thread.date)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
