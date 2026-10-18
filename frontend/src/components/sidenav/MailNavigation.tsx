import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import { ChevronRight, Eye, EyeOff, Layers, Mail, X } from 'lucide-react'
import { accounts$ } from '../../states/accounts'
import { accountGroups$, inUnifiedScope, showAccountGroup, type AccountGroup } from '../../states/accountGroups'
import { folderList, mail$, inboxUnread, moveFolder } from '../../states/mail'
import {
  dismissDroppedNote,
  folderPrefs$,
  moveFavorite,
  pruneMissingFolders,
  reorderFavorite,
  type FolderRef,
} from '../../states/folderPrefs'
import { settings$ } from '../../states/settings'
import { clearBulkSelection, ui$ } from '../../states/ui'
import { openMailAccount } from '../../states/kanban'
import { buildFolderTree, type TreeNode } from '../../lib/folderTree'
import { folderIcon } from '../../lib/folderIcon'
import { unifiedFolders } from '../../lib/unifiedFolders'
import { useTranslation } from '../../lib/i18n'
import { folderColor, type FolderColorId } from '../../lib/folderColors'
import { FOLDER_MOVE_BLOCK_TEXT, folderMoveBlock, folderMoveSourceBlock } from '../../lib/folderMoves'
import { hiddenFolderIds } from '../../lib/folderHiding'
import type { Account, Folder } from '../../types'
import { FolderContextMenu } from './FolderContextMenu'
import { FolderMoveDialog } from './FolderMoveDialog'
import { documentDirection } from '../../lib/direction'

/** Drag payload types, for other windows and drop targets that read them. */
export const FOLDER_DRAG_TYPE = 'application/x-oreneta-folder'
export const FAVORITE_DRAG_TYPE = 'application/x-oreneta-favorite'

/** What the folder rows need from the navigation around them (ADR-0050). */
type FolderRowActions = {
  colorOf: (folder: Folder) => FolderColorId | undefined
  /** Hidden from the tree (#273): such a row is only drawn while hidden folders are shown, or while it is open. */
  isHidden: (folder: Folder) => boolean
  openMenu: (folder: Folder, at: { x: number; y: number }, trigger: HTMLElement | null, inFavorites?: boolean) => void
  /** Why the folder being dragged cannot land on `target`; null when it can, undefined when nothing is dragged. */
  dropBlock: (target: Folder | null) => string | null | undefined
  drop: (target: Folder | null) => void
  startDrag: (folder: Folder, event: DragEvent<HTMLElement>) => void
  endDrag: () => void
  canDrag: (folder: Folder) => boolean
}

function menuKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

function keyboardMenuPoint(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  // A little in from the row's start edge, whichever side that is.
  return { x: documentDirection() === 'rtl' ? rect.right - 16 : rect.left + 16, y: rect.bottom }
}

function ColorDot({ color }: { color: FolderColorId | undefined }) {
  const { t } = useTranslation()
  const entry = folderColor(color)
  if (!entry) return null
  return (
    <span
      className="mail-folder-dot"
      role="img"
      aria-label={t('folders.color.dot', {
        color: t(entry.labelKey, { defaultValue: entry.label }),
        defaultValue: 'Color: {color}',
      })}
    />
  )
}

/** Marks a hidden folder while hidden folders are shown (#273). */
function HiddenMark() {
  const { t } = useTranslation()
  return (
    <>
      <EyeOff size={14} strokeWidth={1.75} className="mail-folder-hidden-mark" aria-hidden="true" />
      <span className="sr-only">{t('folders.hide.mark', { defaultValue: 'Hidden' })}</span>
    </>
  )
}

function FolderBranch({
  node,
  selected,
  onSelect,
  actions,
}: {
  node: TreeNode
  selected: string
  onSelect: (id: string) => void
  actions?: FolderRowActions
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const [dropState, setDropState] = useState<'ok' | 'blocked' | null>(null)
  const [dropReason, setDropReason] = useState('')
  const Icon = folderIcon(node.folder)
  const current = node.folder?.id === selected || (node.folder?.role === 'inbox' && selected.toLowerCase() === 'inbox')
  const folder = node.folder
  const color = folder ? actions?.colorOf(folder) : undefined
  const hidden = folder ? !!actions?.isHidden(folder) : false
  const dropHandlers =
    folder && actions
      ? {
          onDragOver: (event: DragEvent<HTMLDivElement>) => {
            const block = actions.dropBlock(folder)
            if (block === undefined) return
            setDropState(block ? 'blocked' : 'ok')
            setDropReason(block ?? '')
            if (block) return
            event.preventDefault()
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          },
          onDragLeave: () => setDropState(null),
          onDrop: (event: DragEvent<HTMLDivElement>) => {
            setDropState(null)
            if (actions.dropBlock(folder) !== null) return
            event.preventDefault()
            actions.drop(folder)
          },
        }
      : {}
  return (
    <li>
      <div
        className="mail-folder-row"
        data-drop-target={dropState ?? undefined}
        title={dropState === 'blocked' ? dropReason : undefined}
        {...dropHandlers}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className="mail-folder-expander"
            aria-label={t(expanded ? 'mailNavigation.collapseFolder' : 'mailNavigation.expandFolder', {
              folder: node.name,
            })}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight size={14} strokeWidth={1.75} className={expanded ? 'rotate-90' : ''} />
          </button>
        ) : (
          <span className="mail-folder-spacer" />
        )}
        {node.folder ? (
          <button
            type="button"
            className="mail-folder-destination"
            title={node.folder.name}
            aria-current={current ? 'page' : undefined}
            data-folder-color={color}
            data-folder-hidden={hidden ? '' : undefined}
            draggable={!!actions && actions.canDrag(node.folder)}
            onDragStart={(event) => actions?.startDrag(node.folder!, event)}
            onDragEnd={() => actions?.endDrag()}
            onClick={() => onSelect(node.folder!.id)}
            onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
              if (!actions) return
              event.preventDefault()
              actions.openMenu(node.folder!, { x: event.clientX, y: event.clientY }, event.currentTarget)
            }}
            onKeyDown={(event) => {
              if (!actions || !menuKey(event)) return
              event.preventDefault()
              actions.openMenu(node.folder!, keyboardMenuPoint(event.currentTarget), event.currentTarget)
            }}
          >
            <Icon size={16} strokeWidth={1.75} />
            <span>{node.name}</span>
            <ColorDot color={color} />
            {hidden && <HiddenMark />}
            {node.folder.unread > 0 && <small>{node.folder.unread}</small>}
          </button>
        ) : (
          <span className="mail-folder-structural">{node.name}</span>
        )}
      </div>
      {expanded && node.children.length > 0 && (
        <ul className="mail-folder-children">
          {node.children.map((child) => (
            <FolderBranch
              key={child.folder?.id ?? child.name}
              node={child}
              selected={selected}
              onSelect={onSelect}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

type ResolvedFavorite = { ref: FolderRef; folder: Folder; account: Account | undefined }

function sameRef(a: FolderRef, b: FolderRef) {
  return a.accountId === b.accountId && a.folderId === b.folderId
}

function favoriteKey(ref: FolderRef) {
  return `${ref.accountId}\u0000${ref.folderId}`
}

/** Favorites (ADR-0050): folders from any account, in the order the person set. */
function FavoritesSection({
  favorites,
  favoriteCount,
  selectedAccount,
  selectedFolder,
  showAccount,
  dropped,
  actions,
  onOpen,
}: {
  favorites: ResolvedFavorite[]
  favoriteCount: number
  selectedAccount: string
  selectedFolder: string
  showAccount: boolean
  dropped: number
  actions: FolderRowActions
  onOpen: (accountId: string, folderId: string) => void
}) {
  const { t } = useTranslation()
  const [announcement, setAnnouncement] = useState('')
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragFrom = useRef<number | null>(null)
  const refocus = useRef<string | null>(null)
  const list = useRef<HTMLUListElement | null>(null)
  const all = useValue(folderPrefs$.favorites)

  // A reordered favorite keeps the focus it had, wherever it lands.
  useEffect(() => {
    if (!refocus.current) return
    const key = refocus.current
    refocus.current = null
    list.current?.querySelectorAll<HTMLButtonElement>('button[data-favorite-key]').forEach((button) => {
      if (button.dataset.favoriteKey === key) button.focus()
    })
  }, [all])

  const announceMove = (favorite: ResolvedFavorite) => {
    const position = folderPrefs$.favorites.peek().findIndex((item) => sameRef(item, favorite.ref)) + 1
    setAnnouncement(
      t('folders.favorite.moved', {
        folder: favorite.folder.name,
        position,
        count: favoriteCount,
        defaultValue: '{folder} moved to position {position} of {count}',
      }),
    )
  }

  if (!favorites.length && !dropped) return null
  return (
    <section className="mail-navigation-favorites" aria-labelledby="mail-navigation-favorites-title">
      <h2 id="mail-navigation-favorites-title">{t('mailNavigation.favorites', { defaultValue: 'Favorites' })}</h2>
      {dropped > 0 && (
        <div className="mail-navigation-note" role="status">
          <span>
            {t('folders.favorite.dropped', {
              count: dropped,
              defaultValue:
                '{count, plural, one {# favorite folder no longer exists and was removed.} other {# favorite folders no longer exist and were removed.}}',
            })}
          </span>
          <button
            type="button"
            aria-label={t('folders.favorite.dismiss', { defaultValue: 'Dismiss' })}
            onClick={dismissDroppedNote}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {favorites.length > 0 && (
        <ul className="mail-folder-tree" ref={list}>
          {favorites.map((favorite) => {
            const index = all.findIndex((item) => sameRef(item, favorite.ref))
            const Icon = folderIcon(favorite.folder)
            const color = actions.colorOf(favorite.folder)
            const key = favoriteKey(favorite.ref)
            const current = favorite.ref.accountId === selectedAccount && favorite.ref.folderId === selectedFolder
            return (
              <li
                key={key}
                className="mail-folder-row"
                data-dragging={draggingIndex === index ? '' : undefined}
                data-drop-target={dropIndex === index ? 'ok' : undefined}
                onDragOver={(event) => {
                  if (dragFrom.current !== null) {
                    event.preventDefault()
                    setDropIndex(index)
                    return
                  }
                  // A folder from the tree dropped on a favorite moves into it.
                  if (actions.dropBlock(favorite.folder) !== null) return
                  event.preventDefault()
                  setDropIndex(index)
                }}
                onDragLeave={() => setDropIndex(null)}
                onDrop={(event) => {
                  setDropIndex(null)
                  if (dragFrom.current !== null) {
                    event.preventDefault()
                    const from = dragFrom.current
                    dragFrom.current = null
                    setDraggingIndex(null)
                    if (reorderFavorite(from, index)) announceMove(favorite)
                    return
                  }
                  if (actions.dropBlock(favorite.folder) !== null) return
                  event.preventDefault()
                  actions.drop(favorite.folder)
                }}
              >
                <span className="mail-folder-spacer" />
                <button
                  type="button"
                  className="mail-folder-destination"
                  data-favorite-key={key}
                  data-folder-color={color}
                  title={
                    favorite.account
                      ? `${favorite.folder.name} — ${favorite.account.email || favorite.account.display_name}`
                      : favorite.folder.name
                  }
                  aria-current={current ? 'page' : undefined}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  draggable
                  onDragStart={(event) => {
                    dragFrom.current = index
                    setDraggingIndex(index)
                    event.dataTransfer?.setData(FAVORITE_DRAG_TYPE, String(index))
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null
                    setDraggingIndex(null)
                    setDropIndex(null)
                  }}
                  onClick={() => onOpen(favorite.ref.accountId, favorite.ref.folderId)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    actions.openMenu(favorite.folder, { x: event.clientX, y: event.clientY }, event.currentTarget, true)
                  }}
                  onKeyDown={(event) => {
                    if (menuKey(event)) {
                      event.preventDefault()
                      actions.openMenu(
                        favorite.folder,
                        keyboardMenuPoint(event.currentTarget),
                        event.currentTarget,
                        true,
                      )
                      return
                    }
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                    event.preventDefault()
                    refocus.current = key
                    if (moveFavorite(favorite.ref, event.key === 'ArrowUp' ? -1 : 1)) announceMove(favorite)
                    else refocus.current = null
                  }}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  <span>
                    {favorite.folder.name}
                    {showAccount && favorite.account && (
                      <small className="mail-favorite-account">
                        {favorite.account.display_name || favorite.account.email}
                      </small>
                    )}
                  </span>
                  <ColorDot color={color} />
                  {favorite.folder.unread > 0 && <small>{favorite.folder.unread}</small>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  )
}

export function MailNavigationView({
  accounts,
  folders,
  selectedAccount,
  selectedFolder,
  unifiedVisible,
  groups = [],
  activeGroup = null,
  onAccount,
  onFolder,
  onGroup = () => {},
  allAccounts,
  foldersByAccount,
  onOpenFolder,
  onMoveFolder = () => {},
}: {
  accounts: Account[]
  folders: Folder[]
  selectedAccount: string
  selectedFolder: string
  unifiedVisible: boolean
  groups?: AccountGroup[]
  activeGroup?: string | null
  onAccount: (id: string) => void
  onFolder: (id: string) => void
  onGroup?: (id: string) => void
  /** Every account, hidden ones included, for favorites and move rules. */
  allAccounts?: Account[]
  /** Folder lists by account, for favorites from other accounts. */
  foldersByAccount?: Record<string, Folder[] | undefined>
  /** Open a folder of any account (a favorite). */
  onOpenFolder?: (accountId: string, folderId: string) => void
  /** Move a folder under `parentId` (null: top level) after the rules allowed it. */
  onMoveFolder?: (accountId: string, folderId: string, parentId: string | null) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ folder: Folder; x: number; y: number; inFavorites: boolean } | null>(null)
  const [moving, setMoving] = useState<Folder | null>(null)
  const [dragged, setDragged] = useState<Folder | null>(null)
  const [rootDrop, setRootDrop] = useState(false)
  // Hidden folders (#273): shown again only on request, for as long as this
  // account stays open; the hidden marks themselves are kept in folderPrefs.
  const [showHiddenAsked, setShowHidden] = useState(false)
  const [hideAnnouncement, setHideAnnouncement] = useState('')
  const focusToggle = useRef(false)
  const showHiddenButton = useRef<HTMLButtonElement | null>(null)
  const draggedRef = useRef<Folder | null>(null)
  const menuTrigger = useRef<HTMLElement | null>(null)
  const favoriteRefs = useValue(folderPrefs$.favorites)
  const colors = useValue(folderPrefs$.colors)
  const hiddenRefs = useValue(folderPrefs$.hidden)
  const dropped = useValue(folderPrefs$.dropped)
  const hiddenIds = hiddenFolderIds(folders, hiddenRefs)
  const showHidden = showHiddenAsked && hiddenIds.size > 0
  const needle = query.trim().toLocaleLowerCase()
  // The open folder stays in the tree even when hidden, so the navigation
  // still shows where the list is; it leaves once another folder opens.
  const isOpen = (folder: Folder) => folder.id === selectedFolder
  const tree = buildFolderTree(
    folders.filter(
      (folder) =>
        (showHidden || !hiddenIds.has(folder.id) || isOpen(folder)) &&
        (!needle || folder.name.toLocaleLowerCase().includes(needle)),
    ),
  )

  // Nothing hidden any more: the next folder hidden goes out of sight again.
  // An empty list is a cache being reloaded, not the hidden folders going.
  useEffect(() => {
    if (!hiddenIds.size && folders.length) setShowHidden(false)
  }, [hiddenIds.size, folders.length])

  // A folder hidden from its own menu leaves the tree, and the focus with it:
  // it lands on the switch that brings hidden folders back.
  useEffect(() => {
    if (!focusToggle.current) return
    focusToggle.current = false
    showHiddenButton.current?.focus()
  })
  const active = accounts.find((account) => account.id === selectedAccount)
  const isRSS = active?.provider === 'rss' || active?.auth_type === 'rss'
  const everyAccount = allAccounts ?? accounts
  const accountOf = (id: string) => everyAccount.find((account) => account.id === id)
  const foldersOf = (id: string): Folder[] => foldersByAccount?.[id] ?? (id === selectedAccount ? folders : [])
  const favorites: ResolvedFavorite[] = favoriteRefs.flatMap((ref) => {
    const folder = foldersOf(ref.accountId).find((item) => item.id === ref.folderId)
    return folder ? [{ ref, folder, account: accountOf(ref.accountId) }] : []
  })
  const showAccount =
    new Set(favorites.map((favorite) => favorite.ref.accountId)).size > 1 ||
    favorites.some((favorite) => favorite.ref.accountId !== selectedAccount)

  const blockText = (block: keyof typeof FOLDER_MOVE_BLOCK_TEXT) =>
    t(FOLDER_MOVE_BLOCK_TEXT[block].key, { defaultValue: FOLDER_MOVE_BLOCK_TEXT[block].text })

  const actions: FolderRowActions = {
    colorOf: (folder) =>
      colors.find((item) => item.accountId === folder.account_id && item.folderId === folder.id)?.color,
    isHidden: (folder) => folder.account_id === selectedAccount && hiddenIds.has(folder.id),
    openMenu: (folder, at, trigger, inFavorites = false) => {
      if (folder.account_id === 'unified') return
      menuTrigger.current = trigger
      setMenu({ folder, x: at.x, y: at.y, inFavorites })
    },
    dropBlock: (target) => {
      const source = draggedRef.current
      if (!source) return undefined
      const block = folderMoveBlock(source, target, foldersOf(source.account_id), accountOf(source.account_id))
      return block ? blockText(block) : null
    },
    drop: (target) => {
      const source = draggedRef.current
      draggedRef.current = null
      setDragged(null)
      if (!source) return
      if (folderMoveBlock(source, target, foldersOf(source.account_id), accountOf(source.account_id))) return
      onMoveFolder(source.account_id, source.id, target?.id ?? null)
    },
    startDrag: (folder, event) => {
      draggedRef.current = folder
      setDragged(folder)
      event.dataTransfer?.setData(
        FOLDER_DRAG_TYPE,
        JSON.stringify({ accountId: folder.account_id, folderId: folder.id }),
      )
      event.dataTransfer?.setData('text/plain', folder.name)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    },
    endDrag: () => {
      draggedRef.current = null
      setDragged(null)
      setRootDrop(false)
    },
    canDrag: (folder) =>
      folder.account_id !== 'unified' &&
      folderMoveSourceBlock(folder, foldersOf(folder.account_id), accountOf(folder.account_id)) === null,
  }

  const closeMenu = () => {
    setMenu(null)
    const trigger = menuTrigger.current
    menuTrigger.current = null
    if (trigger?.isConnected) trigger.focus()
  }

  const rootBlock = dragged ? actions.dropBlock(null) : undefined
  return (
    <nav data-region="folders" className="mail-navigation" aria-label={t('mailNavigation.title')}>
      <FavoritesSection
        favorites={favorites}
        favoriteCount={favoriteRefs.length}
        selectedAccount={selectedAccount}
        selectedFolder={selectedFolder}
        showAccount={showAccount}
        dropped={dropped}
        actions={actions}
        onOpen={(accountId, folderId) => {
          if (onOpenFolder) onOpenFolder(accountId, folderId)
          else if (accountId === selectedAccount) onFolder(folderId)
        }}
      />
      <h2>{t('mailNavigation.accounts')}</h2>
      <div className="mail-navigation-accounts">
        {unifiedVisible && (
          <button
            type="button"
            className="mail-account-destination"
            aria-current={selectedAccount === 'unified' && !activeGroup ? 'true' : undefined}
            onClick={() => onAccount('unified')}
          >
            <Mail size={16} strokeWidth={1.75} />
            <span>{t('kanban.columns.unifiedInbox')}</span>
          </button>
        )}
        {/* Account groups (#99): each shows its own accounts together. */}
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className="mail-account-destination"
            title={t('accountGroups.showGroup', { name: group.name, defaultValue: 'Show {name} together' })}
            aria-current={selectedAccount === 'unified' && activeGroup === group.id ? 'true' : undefined}
            onClick={() => onGroup(group.id)}
          >
            <Layers size={16} strokeWidth={1.75} />
            <span>{group.name}</span>
          </button>
        ))}
        {accounts.map((account) => (
          <button
            key={account.id}
            type="button"
            className="mail-account-destination"
            title={account.email || account.display_name}
            aria-current={account.id === selectedAccount ? 'true' : undefined}
            onClick={() => onAccount(account.id)}
          >
            <Mail size={16} strokeWidth={1.75} />
            <span>
              <strong>{account.display_name || account.email}</strong>
              {account.email && <small>{account.email}</small>}
            </span>
          </button>
        ))}
      </div>
      {/* Dropping a dragged folder on the heading moves it to the top level. */}
      <h2
        data-drop-target={dragged && rootDrop ? (rootBlock ? 'blocked' : 'ok') : undefined}
        onDragOver={(event) => {
          if (rootBlock === undefined) return
          setRootDrop(true)
          if (rootBlock) return
          event.preventDefault()
        }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={(event) => {
          setRootDrop(false)
          if (actions.dropBlock(null) !== null) return
          event.preventDefault()
          actions.drop(null)
        }}
      >
        {t('mailNavigation.folders')}
      </h2>
      {isRSS ? (
        <button type="button" className="mail-account-destination" onClick={() => onFolder('inbox')}>
          {t('filters.allFeeds')}
        </button>
      ) : (
        <>
          <input
            type="search"
            aria-label={t('folders.searchPlaceholder')}
            placeholder={t('folders.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {hiddenIds.size > 0 && (
            <button
              ref={showHiddenButton}
              type="button"
              className="mail-folder-hidden-toggle"
              aria-pressed={showHidden}
              onClick={() => setShowHidden(!showHidden)}
            >
              {showHidden ? (
                <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
              <span>
                {t('folders.hide.toggle', {
                  count: hiddenIds.size,
                  defaultValue: 'Show hidden folders ({count})',
                })}
              </span>
            </button>
          )}
          {tree.length ? (
            <ul className="mail-folder-tree">
              {tree.map((node) => (
                <FolderBranch
                  key={node.folder?.id ?? node.name}
                  node={node}
                  selected={selectedFolder}
                  onSelect={onFolder}
                  actions={actions}
                />
              ))}
            </ul>
          ) : (
            <p className="mail-navigation-empty">{t(needle ? 'mailNavigation.noMatches' : 'folders.noneAvailable')}</p>
          )}
        </>
      )}
      {menu && (
        <FolderContextMenu
          folder={menu.folder}
          folders={foldersOf(menu.folder.account_id)}
          account={accountOf(menu.folder.account_id)}
          x={menu.x}
          y={menu.y}
          inFavorites={menu.inFavorites}
          onMoveTo={(folder) => {
            menuTrigger.current = null
            setMoving(folder)
          }}
          onHiddenChange={(folder, hidden) => {
            setHideAnnouncement(
              hidden
                ? t('folders.hide.hidden', { folder: folder.name, defaultValue: '{folder} hidden' })
                : t('folders.hide.shown', { folder: folder.name, defaultValue: '{folder} shown again' }),
            )
            // Out of sight now: its row is about to go, so the focus may not go back to it.
            if (
              hidden &&
              !showHidden &&
              folder.account_id === selectedAccount &&
              !isOpen(folder) &&
              !menu?.inFavorites
            ) {
              menuTrigger.current = null
              focusToggle.current = true
            }
          }}
          onClose={closeMenu}
        />
      )}
      {moving && (
        <FolderMoveDialog
          folder={moving}
          folders={foldersOf(moving.account_id)}
          account={accountOf(moving.account_id)}
          onClose={() => setMoving(null)}
          onMove={(parentId) => {
            setMoving(null)
            onMoveFolder(moving.account_id, moving.id, parentId)
          }}
        />
      )}
      <p className="sr-only" aria-live="polite">
        {hideAnnouncement}
      </p>
    </nav>
  )
}

export function MailNavigation() {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  const selectedAccount = useValue(ui$.selectedAccount)
  const groups = useValue(accountGroups$.groups)
  const activeGroup = useValue(accountGroups$.active)
  const selectedFolder = useValue(ui$.selectedFolder)
  const byAccount = useValue(mail$.foldersByAccount)
  const hidden = useValue(settings$.hiddenSideNavAccounts)
  const showUnified = useValue(settings$.showUnifiedInboxInSideNav)
  const favoriteRefs = useValue(folderPrefs$.favorites)
  const visibleAccounts = accounts.filter((account) => account.id === selectedAccount || !hidden.includes(account.id))
  const folders =
    selectedAccount === 'unified'
      ? unifiedFolders(
          t,
          accounts.filter(inUnifiedScope).reduce((total, account) => total + inboxUnread(byAccount[account.id]), 0),
        )
      : (byAccount[selectedAccount] ?? []).filter((folder) => folder.account_id === selectedAccount)

  // Favorites from accounts not open yet need their (cached) folder lists.
  const missing = [...new Set(favoriteRefs.map((ref) => ref.accountId))]
    .filter((id) => accounts.some((account) => account.id === id) && !byAccount[id])
    .join('\n')
  useEffect(() => {
    if (!missing) return
    for (const accountId of missing.split('\n')) {
      void folderList(accountId, false)
        .then((res) => {
          if (!mail$.foldersByAccount[accountId].peek()) mail$.foldersByAccount[accountId].set(res)
        })
        .catch(() => {})
    }
  }, [missing])

  // A favorite or color whose folder is gone from its account's list goes,
  // with a note saying so (renames the core reported were carried already).
  useEffect(() => {
    for (const account of accounts) {
      const list = byAccount[account.id]
      if (list)
        pruneMissingFolders(
          account.id,
          list.map((folder) => folder.id),
        )
    }
  }, [accounts, byAccount])

  function navigate(account: string, folder: string) {
    clearBulkSelection()
    ui$.selectedThread.set('')
    ui$.mobilePane.set('threads')
    openMailAccount(account, folder, false)
  }
  return (
    <MailNavigationView
      key={selectedAccount}
      accounts={visibleAccounts}
      allAccounts={accounts}
      folders={folders}
      foldersByAccount={byAccount}
      selectedAccount={selectedAccount}
      selectedFolder={selectedFolder}
      unifiedVisible={showUnified || selectedAccount === 'unified'}
      groups={groups}
      activeGroup={activeGroup}
      onAccount={(account) => {
        if (account === 'unified' && activeGroup) {
          showAccountGroup(null)
          return
        }
        if (account !== selectedAccount) navigate(account, 'inbox')
      }}
      onGroup={(group) => {
        if (selectedAccount === 'unified' && group === activeGroup) return
        clearBulkSelection()
        ui$.selectedThread.set('')
        if (selectedAccount !== 'unified') navigate('unified', 'inbox')
        showAccountGroup(group)
      }}
      onFolder={(folder) => {
        if (folder !== selectedFolder) navigate(selectedAccount, folder)
      }}
      onOpenFolder={(account, folder) => {
        if (account !== selectedAccount || folder !== selectedFolder) navigate(account, folder)
      }}
      onMoveFolder={(account, folder, parent) => void moveFolder(account, folder, parent)}
    />
  )
}
