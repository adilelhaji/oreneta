import { ArrowDown, ArrowUp, Eye, EyeOff, FolderInput, Star, StarOff } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { FOLDER_COLORS } from '../../lib/folderColors'
import { FOLDER_MOVE_BLOCK_TEXT, folderMoveSourceBlock } from '../../lib/folderMoves'
import { FOLDER_HIDE_BLOCK_TEXT, folderHideBlock } from '../../lib/folderHiding'
import {
  folderPrefs$,
  hideFolder,
  moveFavorite,
  setFolderColor,
  toggleFavorite,
  unhideFolder,
  type FolderRef,
} from '../../states/folderPrefs'
import type { Account, Folder } from '../../types'
import { MenuGroup } from '../menu/Menu'
import { RailContextMenu, RailMenuItem } from './RailContextMenu'

const secondary = 'text-secondary'

// Right-click (or Shift+F10 / Menu key) menu for a folder in mail navigation
// and in Favorites (ADR-0050): favorite on/off, its place among favorites,
// a color from the named palette, "Move folder to…", and hiding the folder
// from the tree or showing it again (#273).
export function FolderContextMenu({
  folder,
  folders,
  account,
  x,
  y,
  inFavorites = false,
  onMoveTo,
  onHiddenChange = () => {},
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
  /** Told after the folder was hidden or shown again, to announce it. */
  onHiddenChange?: (folder: Folder, hidden: boolean) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref: FolderRef = { accountId: folder.account_id, folderId: folder.id }
  const favorites = useValue(folderPrefs$.favorites)
  const colors = useValue(folderPrefs$.colors)
  const index = favorites.findIndex((item) => item.accountId === ref.accountId && item.folderId === ref.folderId)
  const favorite = index !== -1
  const current = colors.find((item) => item.accountId === ref.accountId && item.folderId === ref.folderId)?.color
  const hidden = useValue(folderPrefs$.hidden)
  const hiddenHere = hidden.some((item) => item.accountId === ref.accountId && item.folderId === ref.folderId)
  const hideBlock = hiddenHere ? null : folderHideBlock(folder, folders, hidden)
  // Hidden itself and under a hidden parent too: its own mark can go, but the
  // folder stays out of the tree, and the row says so.
  const others = hidden.filter((item) => item.accountId !== ref.accountId || item.folderId !== ref.folderId)
  const staysHidden = hiddenHere && folderHideBlock(folder, folders, others) === 'parentHidden'
  const hideNote = hideBlock ?? (staysHidden ? 'parentHidden' : null)
  const hideReason = hideNote
    ? t(FOLDER_HIDE_BLOCK_TEXT[hideNote].key, { defaultValue: FOLDER_HIDE_BLOCK_TEXT[hideNote].text })
    : ''
  const block = folderMoveSourceBlock(folder, folders, account)
  const reason = block ? t(FOLDER_MOVE_BLOCK_TEXT[block].key, { defaultValue: FOLDER_MOVE_BLOCK_TEXT[block].text }) : ''
  // Opened from the keyboard too (Shift+F10, the Menu key): the menu itself
  // moves focus to its first item and gives it back to the folder on close.

  const close = (action: () => void) => () => {
    action()
    onClose()
  }

  return (
    <RailContextMenu
      x={x}
      y={y}
      label={t('folders.menu.label', { folder: folder.name, defaultValue: 'Actions for {folder}' })}
      onClose={onClose}
    >
      <div role="none">
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
        <RailMenuItem
          disabled={!!hideBlock}
          title={hideReason || undefined}
          icon={
            hiddenHere ? (
              <Eye size={14} className={secondary} strokeWidth={1.75} />
            ) : (
              <EyeOff size={14} className={secondary} strokeWidth={1.75} />
            )
          }
          label={
            <>
              {hiddenHere
                ? t('folders.hide.show', { defaultValue: 'Show folder again' })
                : t('folders.hide.action', { defaultValue: 'Hide folder' })}
              {hideReason && <small className="block text-caption text-secondary">{hideReason}</small>}
            </>
          }
          onClick={close(() => {
            if (hiddenHere) unhideFolder(ref)
            else hideFolder(ref)
            // Still hidden through its parent: nothing to announce as shown.
            if (!staysHidden) onHiddenChange(folder, !hiddenHere)
          })}
        />
        {/* One choice of several: radio items, the chosen one checked. */}
        <MenuGroup
          label={t('folders.color.menu', { defaultValue: 'Folder color' })}
          labelClassName="pb-1 text-caption text-secondary"
          className="mt-1 border-t border-border px-2 pt-2 pb-1"
        >
          <div role="none" className="flex flex-wrap gap-1">
            {FOLDER_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                className="folder-color-swatch"
                data-folder-color={color.id}
                aria-checked={current === color.id}
                aria-label={t(color.labelKey, { defaultValue: color.label })}
                title={t(color.labelKey, { defaultValue: color.label })}
                onClick={close(() => setFolderColor(ref, color.id))}
              >
                <span className="mail-folder-dot" aria-hidden="true" />
              </button>
            ))}
            <button
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              className="folder-color-swatch"
              aria-checked={!current}
              aria-label={t('folders.color.none', { defaultValue: 'No color' })}
              title={t('folders.color.none', { defaultValue: 'No color' })}
              onClick={close(() => setFolderColor(ref, null))}
            >
              <span className="mail-folder-dot mail-folder-dot-none" aria-hidden="true" />
            </button>
          </div>
        </MenuGroup>
      </div>
    </RailContextMenu>
  )
}
