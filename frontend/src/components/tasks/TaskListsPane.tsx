import { useState } from 'react'
import { Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { MAIL_LIST, createTaskList, listName, tasks$ } from '../../states/tasks'
import { IconButton } from '../button/IconButton'
import { AddAccountListMenu } from './AccountTaskLists'

/// The task lists, as the body of the common folder pane (ADR-0068 §4, #329):
/// "All" and each list with its open tasks, the lists the tabs showed, in the
/// same order and with the same counts, and what could be done to the lists,
/// as the row beside the tabs could. It is the body of the "folders" region,
/// which names it, so it is not a landmark of its own.
///
/// What it does is what the tabs did: choosing sets `tasks$.selectedList`,
/// "New list" asks for a name, "CalDAV task list…" opens the module's dialog,
/// "Add a list" offers the account lists that were declined (ADR-0070), and
/// the rename and the delete act on the list on show, which they name. The
/// notices of the account lists (ADR-0070) and a list's sync status are not
/// lists: they stay above the tasks, where they were.
export function TaskListsPane({
  onRename,
  onDelete,
  onAddCalDav,
}: {
  onRename: () => void
  onDelete: () => void
  onAddCalDav: () => void
}) {
  const { t } = useTranslation()
  const lists = useValue(tasks$.lists)
  const selectedList = useValue(tasks$.selectedList)
  const accountLists = useValue(tasks$.accountLists)
  const [newList, setNewList] = useState<string | null>(null)
  const current = lists.find((list) => list.id === selectedList)

  const entries = [
    { id: 'all', label: t('tasks.allLists', { defaultValue: 'All' }), open: -1 },
    ...lists.map((list) => ({ id: list.id, label: listName(list), open: list.open })),
  ]

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
          label={t('tasks.newList', { defaultValue: 'New list' })}
          onClick={() => setNewList('')}
        />
        <IconButton
          icon={Server}
          iconSize={14}
          size="sm"
          label={t('tasks.addCalDavList', { defaultValue: 'CalDAV task list…' })}
          onClick={onAddCalDav}
        />
        {current && current.id !== MAIL_LIST && (
          <>
            <IconButton
              icon={Pencil}
              iconSize={14}
              size="sm"
              label={t('tasks.renameListNamed', { name: listName(current), defaultValue: 'Rename {name}' })}
              onClick={onRename}
            />
            <IconButton
              icon={Trash2}
              iconSize={14}
              size="sm"
              label={t('tasks.deleteListNamed', { name: listName(current), defaultValue: 'Delete {name}' })}
              onClick={onDelete}
            />
          </>
        )}
      </div>
      {newList !== null && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (newList.trim()) void createTaskList(newList)
            setNewList(null)
          }}
        >
          <input
            autoFocus
            value={newList}
            aria-label={t('tasks.newListName', { defaultValue: 'New list name' })}
            onChange={(event) => setNewList(event.target.value)}
            onBlur={() => !newList.trim() && setNewList(null)}
            className="w-full min-w-0 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
          />
        </form>
      )}
      <ul className="flex flex-col">
        {entries.map((entry) => {
          const active = selectedList === entry.id
          const named =
            entry.open > 0
              ? t('tasks.listOption', { name: entry.label, count: entry.open, defaultValue: '{name} ({count})' })
              : entry.label
          return (
            <li key={entry.id}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                // The name can end in "…" in a narrow pane: the tooltip has it
                // whole, with its open tasks (ADR-0068 §4), and the accessible
                // name reads the same.
                aria-label={named}
                title={named}
                onClick={() => tasks$.selectedList.set(entry.id)}
                className={row(active)}
              >
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {entry.label}
                </span>
                {entry.open > 0 && (
                  // On the tinted row the secondary colour falls under 4.5:1.
                  <span
                    className={clsx('shrink-0 text-caption tabular-nums', active ? 'text-primary' : 'text-secondary')}
                  >
                    {entry.open}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <AddAccountListMenu entries={accountLists} inline />
    </div>
  )
}
