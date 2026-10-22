import { useState } from 'react'
import { AlertTriangle, Info, Loader2, Plus } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import {
  acknowledgeAccountList,
  addAccountListAgain,
  collectionName,
  declineAccountList,
  declinedAccountLists,
  listName,
  syncTaskLists,
  upgradeNotices,
  waitingAccountLists,
  type AccountTaskList,
  type TaskList,
} from '../../states/tasks'
import { Button } from '../button/Button'

// The task lists that come with an account (#281, ADR-0070): what waits for
// a read, the notice of a list the upgrade added on its own, and «Afegeix una
// llista» for the ones declined.

/** An account as the person knows it: its address. */
function useAccountName() {
  const accounts = useValue(accounts$)
  return (id: string) => accounts.find((account) => account.id === id)?.email || id
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The accounts' lists still waiting for a read: being read, or why the
 * last read failed, with «Torna-ho a provar» and «No l'afegeixis». Never
 * left looking like a list with no tasks.
 */
export function WaitingAccountLists({ entries, syncing }: { entries: AccountTaskList[]; syncing: boolean }) {
  const { t } = useTranslation()
  const accountName = useAccountName()
  const waiting = waitingAccountLists(entries)
  if (waiting.length === 0) return null
  return (
    <ul className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-header px-4 py-2">
      {waiting.map((entry) => {
        const account = accountName(entry.account)
        const failed = !!entry.last_error
        const text =
          entry.kind === 'caldav-server'
            ? failed
              ? t('tasks.serverRescanFailed', {
                  origin: host(entry.url),
                  error: entry.last_error,
                  defaultValue: 'The server {origin} could not be listed again: {error}',
                })
              : t('tasks.serverRescanning', {
                  origin: host(entry.url),
                  defaultValue: 'Reading the task lists of {origin}…',
                })
            : failed
              ? t('tasks.accountReadFailed', {
                  account,
                  error: entry.last_error,
                  defaultValue: 'The tasks of {account} could not be read: {error}',
                })
              : t('tasks.accountReading', { account, defaultValue: 'Reading the tasks of {account}…' })
        return (
          <li
            key={`${entry.account}\u0000${entry.source}`}
            role={failed ? 'alert' : 'status'}
            className="flex flex-wrap items-center gap-2 text-caption text-primary"
          >
            {failed ? (
              <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <Loader2 size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-secondary" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 wrap-anywhere">{text}</span>
            {failed && (
              <Button variant="secondary" size="sm" disabled={syncing} onClick={() => void syncTaskLists()}>
                {t('tasks.retry', { defaultValue: 'Try again' })}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void declineAccountList(entry)}>
              {t('tasks.dontAdd', { defaultValue: 'Don’t add it' })}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The notice of a list the upgrade added on its own (ADR-0070, §4): it stays
 * until «Treu-la» or «D'acord», and the answer is kept in the profile.
 */
export function AccountListNotices({
  entries,
  lists,
  compact = false,
}: {
  entries: AccountTaskList[]
  lists: TaskList[]
  compact?: boolean
}) {
  const { t } = useTranslation()
  const accountName = useAccountName()
  const notices = upgradeNotices(entries)
  if (notices.length === 0) return null
  return (
    <ul className={compact ? 'flex flex-col gap-1.5 px-4 pt-3' : 'flex shrink-0 flex-col gap-1.5 border-b border-border bg-header px-4 py-2'}>
      {notices.map((entry) => {
        const list = lists.find((candidate) => candidate.id === entry.list_id)
        const name = list ? listName(list) : entry.kind === 'ews' ? accountName(entry.account) : collectionName(entry.url)
        return (
          <li
            key={`${entry.account}\u0000${entry.source}`}
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-control-sm bg-raised px-2.5 py-1.5 text-caption text-primary"
          >
            <Info size={14} strokeWidth={1.75} className="shrink-0 text-info" aria-hidden="true" />
            <span className="min-w-0 flex-1 wrap-anywhere">
              {t('tasks.upgradeNotice', {
                name,
                account: accountName(entry.account),
                defaultValue: 'The list {name} of {account} was added on its own when Oreneta was updated.',
              })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void declineAccountList(entry)}>
              {t('tasks.removeIt', { defaultValue: 'Remove it' })}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void acknowledgeAccountList(entry)}>
              {t('tasks.okay', { defaultValue: 'OK' })}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * «Afegeix una llista»: the accounts' declined lists, added again on
 * request. Shown only when there is one. A CalDAV one with no calendar of
 * the same server and user to sign in with asks for the password.
 */
export function AddAccountListMenu({ entries, inline = false }: { entries: AccountTaskList[]; inline?: boolean }) {
  const { t } = useTranslation()
  const accountName = useAccountName()
  const declined = declinedAccountLists(entries)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<{ source: string; message: string } | null>(null)
  const [password, setPassword] = useState('')
  if (declined.length === 0) return null

  const add = async (entry: AccountTaskList) => {
    setBusy(entry.source)
    setError(null)
    try {
      await addAccountListAgain(entry, password || undefined)
      setPassword('')
      setOpen(false)
    } catch (failure) {
      setError({ source: entry.source, message: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      setBusy('')
    }
  }

  // In the folder pane the menu is a block in the flow; beside the tabs, an inline popup anchor.
  const Wrapper = inline ? 'div' : 'span'
  return (
    <Wrapper className={inline ? undefined : 'relative'}>
      <button
        type="button"
        data-focus-key="add-account-list"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={
          inline
            ? 'w-full rounded-control-sm px-2 py-1.5 text-start text-ui text-secondary hover:bg-hover cursor-pointer'
            : 'rounded-control-sm px-2 py-1 text-caption text-secondary hover:bg-hover cursor-pointer'
        }
      >
        + {t('tasks.addList', { defaultValue: 'Add a list' })}
      </button>
      {open && (
        <ul
          className={
            inline
              ? // In the folder pane the list opens in the flow: a popup would be cut by the pane's edge.
                'mt-1 flex flex-col gap-1 rounded-panel border border-border bg-chats p-2'
              : 'absolute start-0 top-full z-20 mt-1 flex min-w-64 flex-col gap-1 rounded-panel border border-border bg-chats p-2 shadow-md'
          }
        >
          {declined.map((entry) => {
            const account = accountName(entry.account)
            const label =
              entry.kind === 'ews'
                ? t('tasks.addExchangeList', { email: account, defaultValue: 'Exchange tasks of {email}' })
                : t('tasks.accountCalDavList', {
                    name: collectionName(entry.url),
                    account,
                    defaultValue: '{name} ({account})',
                  })
            const failed = error?.source === entry.source ? error.message : ''
            return (
              <li key={entry.source + entry.account} className="flex flex-col gap-1">
                <button
                  type="button"
                  disabled={!!busy}
                  aria-busy={busy === entry.source}
                  onClick={() => void add(entry)}
                  className="flex items-center gap-1.5 rounded-control-sm px-2 py-1 text-start text-caption text-primary hover:bg-hover cursor-pointer disabled:cursor-wait disabled:opacity-50"
                >
                  <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                  {label}
                </button>
                {failed && (
                  <>
                    <p role="alert" className="px-2 text-caption text-danger wrap-anywhere">
                      {failed}
                    </p>
                    {entry.kind === 'caldav' && (
                      <label className="flex items-center gap-1.5 px-2 text-caption text-secondary">
                        {t('tasks.passwordFor', { host: host(entry.url), defaultValue: 'Password for {host}' })}
                        <input
                          type="password"
                          value={password}
                          autoComplete="current-password"
                          onChange={(event) => setPassword(event.target.value)}
                          className="min-w-0 flex-1 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
                        />
                      </label>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Wrapper>
  )
}
