import { Mail, Pencil, Plus, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { groupRecipients, people$ } from '../../states/people'
import type { ContactGroup } from '../../types'
import { IconButton } from '../button/IconButton'

/// The address book's groups, as the body of the common folder pane (ADR-0068
/// §4, #326): "All contacts" and each group with how many people it holds,
/// and what could be done to the group on show, as the row beside the list's
/// filter could (ADR-0052). It is the body of the "folders" region, which
/// names it, so it is not a landmark of its own.
///
/// What it does is what that row did: choosing sets `people$.groupFilter`,
/// "New group" opens `GroupDialog`, and the others act on the group on show.
/// Only the groups a book can write offer a rename and a delete. The actions
/// sit above the list, so each names the group it acts on.
export function PeopleGroups({
  onWrite,
  onDelete,
}: {
  onWrite: (group: ContactGroup) => void
  onDelete: (group: ContactGroup) => void
}) {
  const { t } = useTranslation()
  const groups = useValue(people$.groups)
  const groupFilter = useValue(people$.groupFilter)
  const shown = groups.find((group) => group.id === groupFilter) ?? null

  const option = (group: ContactGroup) =>
    t('people.groupOption', { name: group.name, count: group.members.length, defaultValue: '{name} ({count})' })

  const row = (active: boolean) =>
    clsx(
      'flex w-full min-w-0 items-center gap-2 rounded-control-sm px-2 py-1.5 text-start text-ui text-primary transition-colors cursor-pointer',
      active ? 'bg-accent/20 font-semibold dark:bg-accent/30' : 'hover:bg-hover',
    )

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <IconButton
          icon={Plus}
          iconSize={14}
          size="sm"
          label={t('people.newGroup', { defaultValue: 'New group' })}
          onClick={() => people$.groupEditing.set({ name: '', book: '', members: [] })}
        />
        {shown && (
          <IconButton
            icon={Mail}
            iconSize={14}
            size="sm"
            label={t('people.writeToGroup', { name: shown.name, defaultValue: 'Write to everyone in {name}' })}
            disabled={groupRecipients(shown).length === 0}
            onClick={() => onWrite(shown)}
          />
        )}
        {shown?.editable && (
          <>
            <IconButton
              icon={Pencil}
              iconSize={14}
              size="sm"
              label={t('people.renameGroupNamed', { name: shown.name, defaultValue: 'Rename {name}' })}
              onClick={() =>
                people$.groupEditing.set({
                  id: shown.id,
                  version: shown.version,
                  name: shown.name,
                  book: shown.book,
                  members: shown.members.map((member) => member.id),
                })
              }
            />
            <IconButton
              icon={Trash2}
              iconSize={14}
              size="sm"
              label={t('people.deleteGroupNamed', { name: shown.name, defaultValue: 'Delete {name}' })}
              onClick={() => onDelete(shown)}
            />
          </>
        )}
      </div>
      <ul className="flex flex-col">
        <li>
          <button
            type="button"
            aria-current={!shown ? 'true' : undefined}
            onClick={() => people$.groupFilter.set('')}
            className={row(!shown)}
          >
            <span className="min-w-0 flex-1 truncate">{t('people.allContacts', { defaultValue: 'All contacts' })}</span>
          </button>
        </li>
        {groups.map((group) => {
          const active = group.id === shown?.id
          return (
            <li key={group.id}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                // The name can end in "…" in a narrow pane: the tooltip has it
                // whole, with how many it holds (ADR-0068 §4), and the
                // accessible name reads the same, as the filter's option did.
                aria-label={option(group)}
                title={option(group)}
                onClick={() => people$.groupFilter.set(group.id)}
                className={row(active)}
              >
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {group.name}
                </span>
                {/* On the tinted row the secondary colour falls under 4.5:1. */}
                <span
                  className={clsx('shrink-0 text-caption tabular-nums', active ? 'text-primary' : 'text-secondary')}
                >
                  {group.members.length}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {groups.length === 0 && (
        <p className="px-2 py-1 text-caption text-secondary">
          {t('people.groupsNone', { defaultValue: 'No groups yet' })}
        </p>
      )}
    </div>
  )
}
