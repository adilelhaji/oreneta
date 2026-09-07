import { Columns3 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { createKanbanBoard } from '../../states/kanban'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'
import { Dialog } from '../dialog/Dialog'

export type BoardDialogState = { mode: 'create'; name: string }

// Modal for creating a kanban board. Renaming, image, and background live in
// the board's settings panel (Settings → Kanban Boards).
export function BoardDialog({
  state,
  onChange,
  onClose,
}: {
  state: BoardDialogState
  onChange: (state: BoardDialogState) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const submit = () => {
    const name = state.name.trim()
    if (!name) return
    createKanbanBoard(name)
    onClose()
  }

  return (
    <Dialog
      title={t('kanban.actions.addBoard')}
      icon={Columns3}
      width="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!state.name.trim()}>
            {t('kanban.actions.addBoardShort')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label htmlFor="board-name" className="text-caption font-bold uppercase tracking-wide text-secondary">
          {t('kanban.board.name')}
        </label>
        <TextInput
          id="board-name"
          autoFocus
          value={state.name}
          onChange={(event) => onChange({ ...state, name: event.target.value })}
          fieldSize="md"
          surface="app"
          className="w-full font-semibold"
        />
      </form>
    </Dialog>
  )
}
