import {
  BookUser,
  CalendarDays,
  Columns3,
  Info,
  ListTodo,
  Mail,
  Plus,
  RefreshCw,
  Settings,
  SquareChevronRight,
} from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { syncMail } from '../../states/mail'
import { openCommandPalette, ui$ } from '../../states/ui'
import { formatShortcut, isMac, type ShortcutId } from '../../lib/shortcuts'
import { MenuItem } from '../menu/MenuItem'

/** The chord a menu row triggers, so the keystroke is learnable from the menu. */
function Hint({ id }: { id: ShortcutId }) {
  return (
    <kbd className="shrink-0 text-2xs font-normal text-secondary/60">{formatShortcut(id).join(isMac ? '' : '+')}</kbd>
  )
}

/**
 * Popover with common app actions. Shared by the desktop side navigation 3-dot menu and
 * the narrow-window thread-list header. `placement` flips the panel above
 * ("up") or below ("down") the anchor.
 */
export function QuickSettingsMenu({
  anchor,
  onAddKanbanBoard,
  onClose,
}: {
  anchor: { x: number; y: number; placement: 'up' | 'down' }
  onAddKanbanBoard?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const busy = useValue(ui$.busy)
  useEscapeKey(onClose)
  // Anchors are visual pixels; fixed positions use CSS pixels under root zoom.
  const rootStyle = getComputedStyle(document.documentElement)
  const zoom = parseFloat(rootStyle.zoom) || 1
  const viewportWidth = window.innerWidth / zoom
  const viewportHeight = window.innerHeight / zoom
  const menuWidth = Math.min(15 * (parseFloat(rootStyle.fontSize) || 16), viewportWidth - 16)
  const edge = Math.max(
    8,
    Math.min(
      anchor.placement === 'up' ? viewportHeight - anchor.y / zoom + 4 : anchor.y / zoom + 4,
      viewportHeight / 2,
    ),
  )

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-50 overflow-y-auto rounded-control border border-border bg-chats p-2 shadow-overlay animate-fade-in text-primary"
        style={{
          width: menuWidth,
          maxHeight: Math.max(0, viewportHeight - edge - 8),
          left: Math.max(8, Math.min(anchor.x / zoom, viewportWidth - menuWidth - 8)),
          ...(anchor.placement === 'up' ? { bottom: edge } : { top: edge }),
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {[
          { key: 'mail', label: t('chat.backToChats'), icon: Mail },
          { key: 'calendar', label: t('calendar.title'), icon: CalendarDays },
          { key: 'people', label: t('people.title'), icon: BookUser },
          { key: 'tasks', label: t('tasks.title'), icon: ListTodo },
        ].map(({ key, label, icon: Icon }) => (
          <MenuItem
            key={key}
            icon={<Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
            label={label}
            onClick={() => {
              ui$.calendarOpen.set(key === 'calendar')
              ui$.peopleOpen.set(key === 'people')
              ui$.tasksOpen.set(key === 'tasks')
              onClose()
            }}
          />
        ))}
        <div className="my-1 border-t border-border" />
        <MenuItem
          icon={<SquareChevronRight size={14} className="text-secondary" strokeWidth={1.75} />}
          label={t('palette.label')}
          trailing={<Hint id="palette.open" />}
          onClick={() => {
            onClose()
            openCommandPalette()
          }}
        />
        <MenuItem
          icon={<Plus size={14} className="text-secondary" strokeWidth={1.75} />}
          label={t('accounts.actions.addAccount')}
          onClick={() => {
            ui$.setupOpen.set(true)
            onClose()
          }}
        />
        {onAddKanbanBoard && (
          <MenuItem
            icon={<Columns3 size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('kanban.actions.addBoard')}
            onClick={() => {
              onAddKanbanBoard()
              onClose()
            }}
          />
        )}
        <MenuItem
          icon={
            <RefreshCw size={14} className={busy ? 'animate-spin text-accent' : 'text-secondary'} strokeWidth={1.75} />
          }
          label={busy ? t('connectivity.health.pending') : t('threads.actions.syncMailbox')}
          disabled={busy}
          trailing={<Hint id="mail.sync" />}
          onClick={() => syncMail()}
        />
        <MenuItem
          icon={<Settings size={14} className="text-secondary" strokeWidth={1.75} />}
          label={t('settings.label')}
          trailing={<Hint id="settings.open" />}
          onClick={() => {
            ui$.settingsOpen.set(true)
            onClose()
          }}
        />
        <MenuItem
          icon={<Info size={14} className="text-secondary" strokeWidth={1.75} />}
          label={t('about.title')}
          onClick={() => {
            ui$.aboutOpen.set(true)
            onClose()
          }}
        />
      </div>
    </>
  )
}
