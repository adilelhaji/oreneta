import { useState } from 'react'
import { Mailbox, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$, addSharedMailbox, deleteAccount, sharedMailboxesOf } from '../../states/accounts'
import { showToast } from '../../states/ui'
import type { Account } from '../../types'
import { SettingsGroup } from './AccountSettingsRows'

/**
 * Shared mailboxes this Exchange account has been granted full-access
 * permission on. Each one is added as its own account — see
 * `states/accounts.ts`'s `addSharedMailbox` doc — so it appears in the
 * sidebar exactly like any other account, with its own folders and its own
 * place to read and send mail, rather than as extra folders bolted onto
 * this one.
 *
 * Only shown for a real Exchange account (not a shared mailbox itself —
 * one shared mailbox cannot grant access to another in this app).
 */
export function SharedMailboxesCard({ account }: { account: Account }) {
  const { t } = useTranslation()
  useValue(accounts$)
  const shared = sharedMailboxesOf(account.id)
  const [adding, setAdding] = useState(false)
  const [address, setAddress] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setBusy(true)
    try {
      await addSharedMailbox(account.id, address.trim(), displayName.trim())
      setAdding(false)
      setAddress('')
      setDisplayName('')
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('sharedMailboxes.addFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('sharedMailboxes.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('sharedMailboxes.addHint')}</p>

        {shared.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {shared.map((mailbox) => (
              <li
                key={mailbox.id}
                className="flex items-center gap-2 rounded-control border border-border bg-panel px-3 py-2"
              >
                <Mailbox size={15} className="shrink-0 text-secondary" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-semibold">{mailbox.display_name || mailbox.email}</span>
                  <span className="block truncate text-2xs text-secondary">{mailbox.email}</span>
                </div>
                <button
                  type="button"
                  title={t('sharedMailboxes.remove')}
                  aria-label={t('sharedMailboxes.remove')}
                  onClick={() => void deleteAccount(mailbox.id)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <input
              type="email"
              value={address}
              autoFocus
              onChange={(event) => setAddress(event.target.value)}
              placeholder={t('sharedMailboxes.addressPlaceholder')}
              aria-label={t('sharedMailboxes.addressPlaceholder')}
              className="w-full rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
            />
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t('sharedMailboxes.displayNamePlaceholder')}
              aria-label={t('sharedMailboxes.displayNamePlaceholder')}
              className="w-full rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
            />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={busy || !address.trim()}
                className="rounded-control bg-accent px-3 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:opacity-50"
              >
                {busy ? t('common.loading') : t('sharedMailboxes.add')}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded-control px-2 py-1.5 text-caption text-secondary hover:text-primary cursor-pointer"
              >
                {t('buttons.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer"
            >
              {t('sharedMailboxes.add')}
            </button>
          </div>
        )}
      </div>
    </SettingsGroup>
  )
}
