import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Columns3, Rss } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { accounts$ } from '../../states/accounts'
import { mail$ } from '../../states/mail'
import { kanbanColumnKey, type KanbanColumn } from '../../states/kanban'
import { accountLabel, folderLabel, mergeLabelFolders, useFoldersByAccount } from '../../lib/kanbanData'
import { isRssAccount } from '../../lib/threadActions'
import { Avatar } from '../avatar/Avatar'
import { MenuItem } from '../menu/MenuItem'
import { MenuList, MenuSeparator } from '../menu/Menu'
import { menuItemSelectedClass } from '../menu/menuStyles'

// The search scope selector: a menu button whose menu offers every column, the
// scope in force checked (radio items, #289).
export function SearchScopeDropdown({
  value,
  onChange,
  visibleColumns,
}: {
  value: string
  onChange: (value: string) => void
  visibleColumns: KanbanColumn[]
}) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const accounts = useValue(accounts$)
  const folderList = useValue(mail$.folders)
  const foldersByAccount = useFoldersByAccount()
  const folders = useMemo(() => mergeLabelFolders(folderList, foldersByAccount), [folderList, foldersByAccount])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEscapeKey(() => setIsOpen(false), isOpen)

  const selectedLabel = useMemo(() => {
    if (value === 'all') return t('kanban.searchScope.allColumns')
    const column = visibleColumns.find((c) => kanbanColumnKey(c) === value)
    if (!column) return t('kanban.searchScope.allColumns')
    return folderLabel(column, folders, accounts, t)
  }, [value, visibleColumns, folders, accounts, t])

  return (
    <div ref={containerRef} className="relative h-full shrink-0 border-s border-border/60">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-full items-center gap-1.5 px-3.5 text-caption font-semibold text-secondary hover:text-primary transition-colors cursor-pointer select-none rounded-e-xl outline-none border-0"
        title={t('kanban.searchScope.label')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="truncate max-w-[130px]">{selectedLabel}</span>
        <ChevronDown
          size={14}
          className={`text-secondary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          strokeWidth={1.75}
        />
      </button>
      {isOpen && (
        <MenuList
          label={t('kanban.searchScope.label')}
          autoFocus
          onClose={() => setIsOpen(false)}
          className="absolute end-0 mt-1.5 z-50 w-64 max-h-72 overflow-y-auto rounded-panel border border-border bg-chats p-1.5 shadow-overlay shadow-black/10 dark:shadow-black/35 animate-slide-up"
        >
          <MenuItem
            role="menuitemradio"
            checked={value === 'all'}
            appearance={value === 'all' ? menuItemSelectedClass : undefined}
            className="select-none"
            icon={
              <Columns3 size={14} className={value === 'all' ? 'text-accent' : 'text-secondary'} strokeWidth={1.75} />
            }
            label={<span className="font-semibold">{t('kanban.searchScope.allColumns')}</span>}
            onClick={() => {
              onChange('all')
              setIsOpen(false)
            }}
          />

          <MenuSeparator />

          {visibleColumns.map((column) => {
            const key = kanbanColumnKey(column)
            const isSelected = value === key
            const columnAccount =
              column.accountId !== 'unified' ? accounts.find((a) => a.id === column.accountId) : undefined
            const columnAccountLabel = columnAccount
              ? columnAccount.display_name || columnAccount.email || columnAccount.id
              : ''
            const columnIsRss = isRssAccount(columnAccount, column.accountId)

            return (
              <MenuItem
                key={key}
                role="menuitemradio"
                checked={isSelected}
                appearance={isSelected ? menuItemSelectedClass : undefined}
                className="select-none"
                icon={
                  <Avatar
                    name={columnAccountLabel || accountLabel(column.accountId, accounts)}
                    email={columnIsRss ? undefined : columnAccount?.email}
                    src={columnAccount?.avatar_url}
                    size={18}
                    fallback={columnIsRss ? <Rss size={14} strokeWidth={1.75} /> : undefined}
                  />
                }
                label={
                  <span className="block min-w-0 text-start">
                    <span className="block truncate font-semibold">{folderLabel(column, folders, accounts, t)}</span>
                    <span className="block truncate text-2xs text-secondary font-medium">
                      {column.accountId === 'unified' ? t('accounts.unified') : columnAccountLabel}
                    </span>
                  </span>
                }
                onClick={() => {
                  onChange(key)
                  setIsOpen(false)
                }}
              />
            )
          })}
        </MenuList>
      )}
    </div>
  )
}
