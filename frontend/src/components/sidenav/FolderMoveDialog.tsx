import { useState } from 'react'
import { FolderInput } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { folderMoveTargets, parentFolderId } from '../../lib/folderMoves'
import type { Account, Folder } from '../../types'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

// The keyboard way to move a folder (ADR-0050): pick where it goes from the
// folders it may go into — never itself, its own subfolders, or another
// account — or the top level. Choosing a place still asks to confirm.
export function FolderMoveDialog({
  folder,
  folders,
  account,
  onMove,
  onClose,
}: {
  folder: Folder
  folders: Folder[]
  account: Account | undefined
  onMove: (parentId: string | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const currentParent = parentFolderId(folder, folders)
  const targets = folderMoveTargets(folder, folders, account)
  const topLevel = currentParent !== null
  const [choice, setChoice] = useState<string | null | undefined>(undefined)
  const options: Array<{ id: string | null; label: string }> = [
    ...(topLevel ? [{ id: null, label: t('folders.move.topLevel', { defaultValue: 'Top level' }) }] : []),
    ...targets.map((target) => ({ id: target.id, label: target.name })),
  ]
  const submit = () => {
    if (choice === undefined) return
    onMove(choice)
  }
  return (
    <Dialog
      title={t('folders.move.dialogTitle', { folder: folder.name, defaultValue: 'Move {folder} to…' })}
      icon={FolderInput}
      width="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={choice === undefined}>
            {t('folders.move.choose', { defaultValue: 'Move here' })}
          </Button>
        </>
      }
    >
      {options.length ? (
        <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          <legend className="sr-only">{t('folders.move.destination', { defaultValue: 'Destination folder' })}</legend>
          {options.map((option) => (
            <label
              key={option.id ?? ''}
              className="flex cursor-pointer items-center gap-2 rounded-control-sm px-2 py-1.5 hover:bg-hover"
            >
              <input
                type="radio"
                name="folder-move-destination"
                checked={choice === option.id}
                onChange={() => setChoice(option.id)}
              />
              <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-secondary">
          {t('folders.move.noTargets', { defaultValue: 'There is no folder this one can move into.' })}
        </p>
      )}
    </Dialog>
  )
}
