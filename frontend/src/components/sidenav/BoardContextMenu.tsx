import { Settings, Trash2 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { removeKanbanBoard } from '../../states/kanban'
import { confirmAction, ui$ } from '../../states/ui'
import { RailContextMenu, RailMenuItem } from './RailContextMenu'

// Right-click menu for a kanban board in the rail: settings or delete.
export function BoardContextMenu({
  board,
  x,
  y,
  onClose,
}: {
  board: { id: string; name: string }
  x: number
  y: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <RailContextMenu x={x} y={y} onClose={onClose}>
      <RailMenuItem
        icon={<Settings size={14} className="text-secondary" strokeWidth={1.75} />}
        label={t('kanban.board.settings')}
        onClick={() => {
          ui$.accountSettingsId.set(board.id)
          ui$.settingsOpen.set(true)
          onClose()
        }}
      />
      <RailMenuItem
        icon={<Trash2 size={14} strokeWidth={1.75} />}
        label={t('kanban.board.delete')}
        danger
        onClick={() => {
          onClose()
          void (async () => {
            if (
              await confirmAction({
                title: t('kanban.board.deleteTitle'),
                message: t('kanban.board.deleteMessage', { name: board.name }),
                confirmLabel: t('buttons.delete'),
                tone: 'danger',
              })
            ) {
              removeKanbanBoard(board.id)
            }
          })()
        }}
      />
    </RailContextMenu>
  )
}
