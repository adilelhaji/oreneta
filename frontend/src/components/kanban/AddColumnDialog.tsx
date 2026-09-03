import { useMemo, useState } from 'react'
import { Columns3, Inbox, Star } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { Folder } from '../../types'
import { Button } from '../button/Button'
import { Checkbox } from '../field/Checkbox'
import { Dialog } from '../dialog/Dialog'
import { AccountSection } from './AccountSection'
import { buildFolderTree, type AccountGroup } from '../../lib/folderTree'

export type { AccountGroup } from '../../lib/folderTree'

export function AddColumnDialog({
  groups,
  initialSelected,
  inboxOption,
  specialOptions,
  onClose,
  onApply,
  onCreateFolder,
}: {
  groups: AccountGroup[]
  initialSelected: string[]
  /** Optional toggle for the board's pinned inbox column, shown above the folders. */
  inboxOption?: { key: string; label: string }
  /** Optional non-folder columns shown above account folders. */
  specialOptions?: { key: string; label: string; icon?: 'inbox' | 'star' }[]
  onClose: () => void
  onApply: (selectedKeys: string[]) => void
  onCreateFolder?: (accountId: string, name: string) => Promise<Folder>
}) {
  const { t } = useTranslation()
  const trees = useMemo(() => groups.map((group) => ({ ...group, tree: buildFolderTree(group.folders) })), [groups])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected))

  function toggle(keys: string[], next: boolean) {
    setSelected((prev) => {
      const updated = new Set(prev)
      for (const key of keys) {
        if (next) updated.add(key)
        else updated.delete(key)
      }
      return updated
    })
  }

  const hasFolders = groups.some((group) => group.folders.length > 0)
  const topOptions = specialOptions ?? (inboxOption ? [{ ...inboxOption, icon: 'inbox' as const }] : [])

  return (
    <Dialog
      title={t('kanban.actions.addColumns')}
      subtitle={t('kanban.addColumnsHint')}
      icon={Columns3}
      onClose={onClose}
      className="max-h-[80vh]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => onApply([...selected])}>
            {t('buttons.done')}
          </Button>
        </>
      }
    >
      <div className="-mx-2">
        {topOptions.map((option) => {
          const Icon = option.icon === 'star' ? Star : Inbox
          return (
            <label
              key={option.key}
              className="mb-1 flex cursor-pointer items-center gap-2 rounded-control-sm px-2 py-1.5 hover:bg-hover"
            >
              <Checkbox checked={selected.has(option.key)} onChange={(event) => toggle([option.key], event.target.checked)} />
              <Icon size={14} className="shrink-0 text-secondary" />
              <span className="truncate text-xs font-semibold text-primary">{option.label}</span>
            </label>
          )
        })}
        {!hasFolders && !onCreateFolder ? (
          <div className="px-3 py-8 text-center text-xs font-medium text-secondary">{t('folders.noneAvailable')}</div>
        ) : (
          trees.map((group) => (
            <AccountSection key={group.accountId} group={group} selected={selected} onToggle={toggle} onCreateFolder={onCreateFolder} />
          ))
        )}
      </div>
    </Dialog>
  )
}
