import { useRef, useState } from 'react'
import { Inbox, Mail, MoreVertical, Plus, Star } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { FilterMode } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { MenuItem } from '../menu/MenuItem'
import { MenuGroup, MenuList, MenuSeparator } from '../menu/Menu'
import { menuItemSelectedClass } from '../menu/menuStyles'

// Inline board-wide filter, shown in the header only when there's room. On narrow
// widths it's hidden (@min-[640px]) and the same options live inside BoardMenu.
export function FilterSwitch({ value, onChange }: { value: FilterMode; onChange: (mode: FilterMode) => void }) {
  const { t } = useTranslation()
  const options: { mode: FilterMode; label: string; icon: React.ReactNode }[] = [
    { mode: 'all', label: t('filters.all'), icon: <Inbox size={14} strokeWidth={1.75} /> },
    { mode: 'unread', label: t('filters.unread'), icon: <Mail size={14} strokeWidth={1.75} /> },
    { mode: 'starred', label: t('filters.starred'), icon: <Star size={14} strokeWidth={1.75} /> },
  ]
  return (
    <div className="hidden @min-[640px]:flex h-9 shrink-0 items-center gap-0.5 rounded-control bg-active/70 p-[3px]">
      {options.map(({ mode, label, icon }) => (
        <button
          key={mode}
          className={`flex h-7 items-center gap-1.5 rounded-control-sm px-3 text-xs font-semibold cursor-pointer transition-all duration-200 ${
            value === mode ? 'bg-chats text-accent-fg shadow-sm' : 'text-secondary hover:bg-hover hover:text-primary'
          }`}
          onClick={() => onChange(mode)}
          title={t('kanban.actions.showFilterInAllColumns', { filter: label.toLowerCase() })}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

// Board overflow menu in the kanban header: the Add Column action, plus the
// board-wide filter options — but the filter section only renders on narrow
// widths (@min-[640px]:hidden), where the inline FilterSwitch is hidden.
export function BoardMenu({
  filterMode,
  onFilterChange,
  onAddColumn,
}: {
  filterMode: FilterMode
  onFilterChange: (mode: FilterMode) => void
  onAddColumn: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useDismissOnOutside(
    open,
    (target) => Boolean(rootRef.current?.contains(target as Node)),
    () => setOpen(false),
  )

  const filterActive = filterMode !== 'all'

  const filterItem = (mode: FilterMode, label: string, icon: React.ReactNode) => (
    <MenuItem
      role="menuitemradio"
      checked={filterMode === mode}
      appearance={filterMode === mode ? menuItemSelectedClass : undefined}
      className="flex-nowrap"
      icon={icon}
      label={<span className="whitespace-nowrap shrink-0">{label}</span>}
      onClick={() => {
        onFilterChange(mode)
        setOpen(false)
      }}
    />
  )

  return (
    <div ref={rootRef} className="relative shrink-0">
      <IconButton
        icon={MoreVertical}
        label={t('kanban.actions.boardOptions')}
        variant={filterActive ? 'accentSoft' : 'ghost'}
        active={!filterActive && open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      />
      {open && (
        <MenuList
          label={t('kanban.actions.boardOptions')}
          autoFocus
          onClose={() => setOpen(false)}
          className="absolute end-0 mt-1.5 z-50 min-w-[180px] w-max rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in select-none"
          onClick={(event) => event.stopPropagation()}
        >
          <div role="none" className="@min-[640px]:hidden">
            <MenuGroup
              label={t('filters.label')}
              labelClassName="px-3 pb-1 pt-1.5 text-2xs font-bold uppercase tracking-wider text-secondary"
            >
              {filterItem(
                'all',
                t('filters.all'),
                <Inbox size={14} className="text-secondary shrink-0" strokeWidth={1.75} />,
              )}
              {filterItem(
                'unread',
                t('filters.unread'),
                <Mail size={14} className="text-secondary shrink-0" strokeWidth={1.75} />,
              )}
              {filterItem(
                'starred',
                t('filters.starred'),
                <Star size={14} className="text-secondary shrink-0" strokeWidth={1.75} />,
              )}
            </MenuGroup>
            <MenuSeparator />
          </div>
          <MenuItem
            className="flex-nowrap"
            icon={<Plus size={14} className="text-secondary shrink-0" strokeWidth={1.75} />}
            label={<span className="whitespace-nowrap shrink-0">{t('kanban.actions.addColumn')}</span>}
            onClick={() => {
              onAddColumn()
              setOpen(false)
            }}
          />
        </MenuList>
      )}
    </div>
  )
}
