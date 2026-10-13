import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, FolderInput, Star, StarOff } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { FOLDER_COLORS } from '../../lib/folderColors'
import { FOLDER_MOVE_BLOCK_TEXT, folderMoveSourceBlock } from '../../lib/folderMoves'
import { folderPrefs$, moveFavorite, setFolderColor, toggleFavorite, type FolderRef } from '../../states/folderPrefs'
import type { Account, Folder } from '../../types'
import { RailContextMenu, RailMenuItem } from './RailContextMenu'

const secondary = 'text-secondary'

// Right-click (or Shift+F10 / Menu key) menu for a folder in mail navigation
// and in Favorites (ADR-0050): favorite on/off, its place among favorites,
// a color from the named palette, and "Move folder to…".
export function FolderContextMenu({
  folder,
  folders,
  account,
  x,
  y,
  inFavorites = false,
  onMoveTo,
  onClose,
}: {
  folder: Folder
  folders: Folder[]
  account: Account | undefined
  x: number
  y: number
  /** Opened on a Favorites entry: adds Move up / Move down. */
  inFavorites?: boolean
  onMoveTo: (folder: Folder) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref: FolderRef = { accountId: folder.account_id, folderId: folder.id }
  const favorites = useValue(folderPrefs$.favorites)
  const colors = useValue(folderPrefs$.colors)
  const index = favorites.findIndex((item) => item.accountId === ref.accountId && item.folderId === ref.folderId)
  const favorite = index !== -1
  const current = colors.find((item) => item.accountId === ref.accountId && item.folderId === ref.folderId)?.color
  const block = folderMoveSourceBlock(folder, folders, account)
  const reason = block ? t(FOLDER_MOVE_BLOCK_TEXT[block].key, { defaultValue: FOLDER_MOVE_BLOCK_TEXT[block].text }) : ''
  const root = useRef<HTMLDivElement | null>(null)

  // Opened from the keyboard, focus has to land inside the menu.
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [])

  const close = (action: () => void) => () => {
    action()
    onClose()
  }

  return (
    <RailContextMenu x={x} y={y} onClose={onClose}>
      <div
        ref={root}
        aria-label={t('folders.menu.label', { folder: folder.name, defaultValue: 'Actions for {folder}' })}
        role="group"
      >
        <RailMenuItem
          icon={
            favorite ? (
              <StarOff size={14} className={secondary} strokeWidth={1.75} />
            ) : (
              <Star size={14} className={secondary} strokeWidth={1.75} />
            )
          }
          label={
            favorite
              ? t('folders.favorite.remove', { defaultValue: 'Remove from favorites' })
              : t('folders.favorite.add', { defaultValue: 'Add to favorites' })
          }
          onClick={close(() => toggleFavorite(ref))}
        />
        {inFavorites && favorite && (
          <>
            <RailMenuItem
              disabled={index === 0}
              icon={<ArrowUp size={14} className={secondary} strokeWidth={1.75} />}
              label={t('folders.favorite.moveUp', { defaultValue: 'Move up' })}
              trailing={<kbd className="text-caption text-secondary">Alt+↑</kbd>}
              onClick={close(() => moveFavorite(ref, -1))}
            />
            <RailMenuItem
              disabled={index === favorites.length - 1}
              icon={<ArrowDown size={14} className={secondary} strokeWidth={1.75} />}
              label={t('folders.favorite.moveDown', { defaultValue: 'Move down' })}
              trailing={<kbd className="text-caption text-secondary">Alt+↓</kbd>}
              onClick={close(() => moveFavorite(ref, 1))}
            />
          </>
        )}
        <RailMenuItem
          disabled={!!block}
          title={reason || undefined}
          icon={<FolderInput size={14} className={secondary} strokeWidth={1.75} />}
          label={
            <>
              {t('folders.move.action', { defaultValue: 'Move folder to…' })}
              {reason && <small className="block text-caption text-secondary">{reason}</small>}
            </>
          }
          onClick={close(() => onMoveTo(folder))}
        />
        <div
          role="group"
          aria-label={t('folders.color.menu', { defaultValue: 'Folder color' })}
          className="mt-1 border-t border-border px-2 pt-2 pb-1"
        >
          <p className="pb-1 text-caption text-secondary" aria-hidden="true">
            {t('folders.color.menu', { defaultValue: 'Folder color' })}
          </p>
          <div className="flex flex-wrap gap-1">
            {FOLDER_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                className="folder-color-swatch"
                data-folder-color={color.id}
                aria-pressed={current === color.id}
                aria-label={t(color.labelKey, { defaultValue: color.label })}
                title={t(color.labelKey, { defaultValue: color.label })}
                onClick={close(() => setFolderColor(ref, color.id))}
              >
                <span className="mail-folder-dot" aria-hidden="true" />
              </button>
            ))}
            <button
              type="button"
              className="folder-color-swatch"
              aria-pressed={!current}
              aria-label={t('folders.color.none', { defaultValue: 'No color' })}
              title={t('folders.color.none', { defaultValue: 'No color' })}
              onClick={close(() => setFolderColor(ref, null))}
            >
              <span className="mail-folder-dot mail-folder-dot-none" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </RailContextMenu>
  )
}
