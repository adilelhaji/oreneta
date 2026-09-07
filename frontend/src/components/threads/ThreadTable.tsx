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
  { key: 'sender', labelKey: 'table.sender', className: 'w-[22%]' },
  { key: 'subject', labelKey: 'table.subject', className: '' },
  { key: 'date', labelKey: 'table.date', className: 'w-[7.5rem]' },
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
}: {
  threads: Message[]
  accounts: Account[]
  selectedThread: string
  showAccount: boolean
  onSelect: (thread: Message, event: MouseEvent<HTMLElement>) => void
  onContextMenu: (thread: Message, event: MouseEvent) => void
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
                    'flex w-full items-center gap-1 px-3 py-1.5 text-caption font-bold uppercase tracking-wide transition-colors cursor-pointer hover:bg-hover',
                    active ? 'text-accent' : 'text-secondary',
                  )}
                >
                  <span className="min-w-0 truncate">{t(column.labelKey)}</span>
                  {active && <Arrow size={11} className="shrink-0" />}
                </button>
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {threads.map((thread) => {
          const active = thread.thread_id === selectedThread
          const account = accounts.find((candidate) => candidate.id === thread.account_id)
          return (
            <tr
              key={thread.id}
              onClick={(event) => onSelect(thread, event)}
              onContextMenu={(event) => onContextMenu(thread, event)}
              // A row of a table is not a button, so it says what it is and
              // answers the keyboard itself.
              tabIndex={0}
              role="button"
              aria-current={active}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelect(thread, event as unknown as MouseEvent<HTMLElement>)
              }}
              className={clsx(
                'cursor-pointer border-b border-border/50 transition-colors',
                active ? 'bg-accent/20 dark:bg-accent/30' : thread.unread ? 'bg-accent/[0.07] hover:bg-accent/[0.12]' : 'hover:bg-hover',
              )}
            >
              <td className="max-w-0 truncate px-3 py-1.5">
                <span className={clsx('truncate', thread.unread ? 'font-bold text-primary' : 'text-primary/85')}>
                  {thread.from_name || thread.from_addr}
                </span>
                {showAccount && account && (
                  <span className="ml-1 text-2xs text-secondary">{account.display_name || account.email}</span>
                )}
              </td>
              <td className="max-w-0 px-3 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {thread.priority && <Sparkle size={11} className="shrink-0 text-accent" />}
                  {thread.starred && <Star size={11} className="shrink-0 fill-amber-500 text-amber-500" />}
                  <LabelChips ids={thread.labels} max={2} />
                  <span className={clsx('min-w-0 truncate', thread.unread ? 'font-semibold text-primary' : 'text-primary/85')}>
                    {thread.subject || t('sendLater.noSubject')}
                  </span>
                  {thread.preview && (
                    <span className="min-w-0 truncate text-secondary/75">{thread.preview}</span>
                  )}
                  {thread.has_attachments && <Paperclip size={11} className="ml-auto shrink-0 text-secondary/70" />}
                </span>
              </td>
              <td
                className={clsx(
                  'px-3 py-1.5 text-right text-caption tabular-nums',
                  thread.unread ? 'text-accent' : 'text-secondary/65',
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
