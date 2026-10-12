import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import {
  accountGroups$,
  createGroup,
  deleteGroup,
  groupAccounts,
  updateGroup,
  type AccountGroup,
} from '../../states/accountGroups'
import { confirmAction, showToast } from '../../states/ui'
import { SettingsGroup } from './AccountSettingsRows'

const action =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'

type Draft = { id: string | null; name: string; accounts: string[] }

/**
 * Account groups (#99, ADR-0040): named views over chosen accounts, shown
 * under the unified inbox. Nothing is moved or copied; deleting a group
 * leaves its accounts as they are.
 */
export function AccountGroupsGroup() {
  const { t } = useTranslation()
  const groups = useValue(accountGroups$.groups)
  const accounts = useValue(accounts$)
  const [draft, setDraft] = useState<Draft | null>(null)

  const save = () => {
    if (!draft) return
    const ok = draft.id
      ? updateGroup(draft.id, { name: draft.name, accounts: draft.accounts })
      : !!createGroup(draft.name, draft.accounts)
    if (!ok) {
      showToast(
        t('accountGroups.nameTaken', { defaultValue: 'A group needs a name that no other group has.' }),
        'error',
      )
      return
    }
    setDraft(null)
  }

  const remove = async (group: AccountGroup) => {
    const confirmed = await confirmAction({
      title: t('accountGroups.deleteTitle', { defaultValue: 'Delete group?' }),
      message: t('accountGroups.deleteText', {
        name: group.name,
        defaultValue: 'Only the group {name} is deleted. Its accounts and their mail stay as they are.',
      }),
      confirmLabel: t('buttons.delete'),
      tone: 'danger',
    })
    if (confirmed) deleteGroup(group.id)
  }

  const toggle = (id: string) =>
    draft &&
    setDraft({
      ...draft,
      accounts: draft.accounts.includes(id) ? draft.accounts.filter((a) => a !== id) : [...draft.accounts, id],
    })

  return (
    <SettingsGroup title={t('accountGroups.title', { defaultValue: 'Account groups' })}>
      <p className="px-3.5 py-2 text-caption text-secondary">
        {t('accountGroups.hint', {
          defaultValue:
            'A group shows the mail of the accounts you choose together, under the unified inbox. An account can be in several groups. Nothing is moved or copied.',
        })}
      </p>
      {groups.length > 0 && (
        <ul aria-label={t('accountGroups.title', { defaultValue: 'Account groups' })}>
          {groups.map((group) => {
            const members = groupAccounts(group, accounts)
            return (
              <li key={group.id} className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2">
                <span className="min-w-0 truncate text-xs text-primary">
                  {group.name}
                  <span className="ml-2 text-2xs text-secondary">
                    {members.length
                      ? members.map((a) => a.display_name || a.email).join(', ')
                      : t('accountGroups.empty', { defaultValue: 'No accounts' })}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    className={action}
                    aria-label={t('accountGroups.editNamed', { name: group.name, defaultValue: 'Edit {name}' })}
                    onClick={() => setDraft({ id: group.id, name: group.name, accounts: group.accounts })}
                  >
                    <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={action}
                    aria-label={t('accountGroups.deleteNamed', { name: group.name, defaultValue: 'Delete {name}' })}
                    onClick={() => void remove(group)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {draft ? (
        <form
          className="flex flex-col gap-2 border-t border-border/40 px-3.5 py-3 text-caption"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <input
            autoFocus
            value={draft.name}
            maxLength={60}
            aria-label={t('accountGroups.name', { defaultValue: 'Group name' })}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent"
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-secondary">
              {t('accountGroups.accounts', { defaultValue: 'Accounts in this group' })}
            </legend>
            {accounts.map((account) => (
              <label key={account.id} className="flex items-center gap-2 text-primary">
                <input
                  type="checkbox"
                  checked={draft.accounts.includes(account.id)}
                  onChange={() => toggle(account.id)}
                />
                {account.display_name || account.email}
              </label>
            ))}
          </fieldset>
          <div className="flex items-center gap-2">
            <button type="submit" className={action} disabled={!draft.name.trim()}>
              {t('buttons.save')}
            </button>
            <button type="button" className={action} onClick={() => setDraft(null)}>
              {t('buttons.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="px-3.5 py-2">
          <button type="button" className={action} onClick={() => setDraft({ id: null, name: '', accounts: [] })}>
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('accountGroups.new', { defaultValue: 'New group' })}
          </button>
        </div>
      )}
    </SettingsGroup>
  )
}
