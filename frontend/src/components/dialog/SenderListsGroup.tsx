import { useEffect, useState } from 'react'
import { Ban, Check, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { showToast } from '../../states/ui'
import { Button } from '../button/Button'
import { SettingsGroup } from './AccountSettingsRows'

type Entry = { pattern: string; allow: boolean }

/**
 * Blocked and allowed senders (#50), per account, by address or domain. A
 * block makes the spam suggestion certain and says why; it still moves
 * nothing by itself. An allowed sender is never suggested as spam.
 */
export function SenderListsGroup() {
  const { t } = useTranslation()
  const accounts = useValue(accounts$).filter(isSendableAccount)
  const [account, setAccount] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [text, setText] = useState('')
  const chosen = account || accounts[0]?.id || ''

  const load = async (id: string) => {
    if (!id) return
    try {
      const res = await invoke<{ entries?: Entry[] }>('spam.lists', { account: id })
      setEntries(res?.entries ?? [])
    } catch {
      setEntries([])
    }
  }

  useEffect(() => {
    void load(chosen)
  }, [chosen])

  const set = async (pattern: string, allow: boolean | null) => {
    try {
      await invoke('spam.setListed', { account: chosen, pattern, ...(allow === null ? {} : { allow }) })
      setText('')
      await load(chosen)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  if (accounts.length === 0) return null

  return (
    <SettingsGroup title={t('senderLists.title', { defaultValue: 'Blocked and allowed senders' })}>
      <div className="flex flex-col gap-2 px-3.5 py-3 text-caption">
        <p className="text-secondary">
          {t('senderLists.hint', {
            defaultValue:
              'Mail from a blocked sender or domain is marked as spam, with the reason, and still moved only when you say. An allowed one is never marked.',
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('senderLists.account', { defaultValue: 'Account' })}
            value={chosen}
            onChange={(e) => setAccount(e.target.value)}
            className="rounded-control-sm border border-border bg-app px-2 py-1 text-primary"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={t('senderLists.pattern', { defaultValue: 'Address or domain' })}
            placeholder="name@example.com · @example.com"
            className="min-w-[12rem] flex-1 rounded-control-sm border border-border bg-app px-2 py-1 text-primary"
          />
          <Button size="sm" variant="secondary" disabled={!text.trim()} onClick={() => void set(text, false)}>
            {t('senderLists.block', { defaultValue: 'Block' })}
          </Button>
          <Button size="sm" variant="secondary" disabled={!text.trim()} onClick={() => void set(text, true)}>
            {t('senderLists.allow', { defaultValue: 'Allow' })}
          </Button>
        </div>
        {entries.length > 0 && (
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li key={entry.pattern} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-primary">
                  {entry.allow ? (
                    <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Ban size={14} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {entry.pattern}
                  <span className="text-2xs text-secondary">
                    {entry.allow
                      ? t('senderLists.allowed', { defaultValue: 'allowed' })
                      : t('senderLists.blocked', { defaultValue: 'blocked' })}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={t('senderLists.remove', {
                    pattern: entry.pattern,
                    defaultValue: 'Take {pattern} off the list',
                  })}
                  onClick={() => void set(entry.pattern, null)}
                  className="rounded-control-sm p-1 text-secondary hover:bg-hover cursor-pointer"
                >
                  <X size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  )
}
