import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import { Bookmark, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { folderIcon } from '../../lib/folderIcon'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { ensureAccountFolders, mail$ } from '../../states/mail'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import { UNIFIED_ACCOUNT, unifiedFolderLabel, unifiedFolders } from '../../lib/unifiedFolders'
import { FloatingContextMenu } from './FloatingContextMenu'
import { MenuItem } from './MenuItem'
import { MenuGroup, MenuList, MenuSeparator } from './Menu'
import { buildFolderTree, type TreeNode } from '../../lib/folderTree'
import { startEdgeX } from '../../lib/direction'
import { focusMenuEdge } from '../../lib/menuKeyboard'

const FILTER_THRESHOLD = 8

// One folder in the picker tree: the folder row (its expander inside it) and,
// when expanded, its children. Structural nodes (a path segment with no folder
// of its own), the current folder and folders taken elsewhere are shown but
// not selectable: disabled radio items, the current one checked. The expander
// is for the pointer; the keyboard reaches every row, since all start open.
function FolderNodeRow({
  node,
  depth,
  currentFolderId,
  takenFolderIds,
  onPick,
}: {
  node: TreeNode
  depth: number
  currentFolderId: string
  takenFolderIds?: string[]
  onPick: (folderId: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0
  const current = !!node.folder && node.folder.id === currentFolderId
  const taken = !!node.folder && !current && !!takenFolderIds?.includes(node.folder.id)
  const selectable = !!node.folder && !current && !taken
  const Icon = folderIcon(node.folder)

  const appearance = selectable
    ? undefined
    : current
      ? 'cursor-default font-semibold text-accent'
      : !node.folder
        ? 'cursor-default text-secondary'
        : 'cursor-default text-primary opacity-40'

  return (
    <div role="none">
      <MenuItem
        role="menuitemradio"
        checked={current}
        disabled={!selectable}
        appearance={appearance}
        style={{ paddingInlineStart: depth * 14 + 2 }}
        icon={
          <>
            <span
              className={clsx(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded text-secondary',
                hasChildren ? 'cursor-pointer hover:text-primary' : 'invisible',
              )}
              onClick={(event) => {
                if (!hasChildren) return
                // Opens or closes the branch, and only that.
                event.stopPropagation()
                setExpanded((open) => !open)
              }}
            >
              <ChevronRight
                size={14}
                className={clsx('transition-transform', expanded && 'rotate-90')}
                strokeWidth={1.75}
              />
            </span>
            {current ? (
              <Check size={14} className="shrink-0 text-accent" strokeWidth={1.75} />
            ) : (
              <Icon size={14} strokeWidth={1.75} className="shrink-0 text-secondary" />
            )}
          </>
        }
        label={
          <span dir="auto" className="block min-w-0 truncate">
            {node.name}
          </span>
        }
        onClick={() => node.folder && onPick(node.folder.id)}
      />
      {hasChildren && expanded && (
        <div role="none">
          {node.children.map((child) => (
            <FolderNodeRow
              key={child.folder?.id ?? `${depth}-${child.name}`}
              node={child}
              depth={depth + 1}
              currentFolderId={currentFolderId}
              takenFolderIds={takenFolderIds}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// A folder name that doubles as a picker: clicking it lists the other folders of
// the same account so the surface showing it (a kanban column, the thread list)
// can be pointed elsewhere without being torn down and rebuilt.
export function FolderSwitcher({
  accountId,
  folderId,
  label,
  labelClassName,
  takenFolderIds,
  onSelect,
}: {
  accountId: string
  folderId: string
  label: string
  labelClassName?: string
  /** Folders already shown elsewhere (e.g. another column) and so not offered. */
  takenFolderIds?: string[]
  onSelect: (folderId: string) => void
}) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const isUnified = accountId === UNIFIED_ACCOUNT
  // Keep observing the shared cache: when it contains only the bootstrap Inbox,
  // ensureAccountFolders refreshes it in the background.
  const cachedFolders = useValue(mail$.foldersByAccount[accountId]) ?? []
  // The unified view has no folders of its own to fetch — its list is the fixed
  // set of roles, each resolved per account at read time. Building it here also
  // keeps the picker working on a Kanban board, where nothing has necessarily
  // populated the unified entry of the shared folder cache. The rows are named
  // "Unified inbox" rather than plain "Inbox" so the label they set on the
  // header says by itself whose mail is listed.
  const folders = useMemo(
    () =>
      isUnified
        ? unifiedFolders(t).map((folder) => ({ ...folder, name: unifiedFolderLabel(folder.id, t) }))
        : cachedFolders,
    [isUnified, t, cachedFolders],
  )
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const savedSearches = useValue(settings$.savedSearches)

  useEffect(() => {
    if (!menu || isUnified) return
    let cancelled = false
    setLoading(true)
    void ensureAccountFolders(accountId, { refreshIfBootstrapOnly: true }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [menu, accountId, isUnified])

  const close = () => {
    setMenu(null)
    setQuery('')
  }

  const open = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (menu) {
      close()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: startEdgeX(rect), y: rect.bottom })
  }

  const needle = query.trim().toLowerCase()
  // Filtering narrows the folder set, then the tree is rebuilt from what's left,
  // so matches keep the hierarchy they sit in.
  const tree = useMemo(
    () => buildFolderTree(folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle))),
    [folders, needle],
  )
  const showFilter = folders.length > FILTER_THRESHOLD

  return (
    <>
      <button
        type="button"
        // Sized well past the label's own line box: the headers hosting this are
        // 48px+ tall, so a text-height hit target left most of it dead. The padding
        // is the caller's to pull back with a negative margin if it wants the label
        // flush with the rest of the header.
        className={clsx('flex h-8 min-w-0 items-center gap-1 rounded px-2 hover:bg-hover', labelClassName)}
        title={t('kanban.actions.switchFolder')}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={open}
        // A kanban column header is a drag handle; keep the pointer gesture to ourselves.
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <span dir="auto" className="min-w-0 truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />
      </button>
      {menu && (
        <FloatingContextMenu
          surface="popover"
          x={menu.x}
          y={menu.y}
          offset={2}
          onClose={close}
          overlay
          className="fixed z-50 flex max-h-[min(420px,calc(100vh-1rem))] w-60 flex-col rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in text-primary"
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          {showFilter && (
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close()
                // Down from the field goes into the list.
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusMenuEdge(event.currentTarget.parentElement, 'first')
                }
              }}
              aria-label={t('folders.searchPlaceholder')}
              placeholder={t('folders.searchPlaceholder')}
              className="mb-1 h-8 w-full shrink-0 rounded-control-sm bg-hover px-2 text-ui text-primary outline-none placeholder-secondary focus:ring-1 focus:ring-accent/40"
            />
          )}
          <MenuList
            label={t('kanban.actions.switchFolder')}
            onClose={close}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {/* Saved searches, where someone goes looking for a place to go.
                Evolution calls these search folders and puts them beside the
                real ones; this app navigates by this menu rather than a
                permanent tree, so this is that same shelf. They are listed
                first because a search is chosen on purpose, while a folder is
                often just where you were. */}
            {savedSearches.length > 0 && !needle && (
              <>
                <MenuGroup
                  label={t('search.saved')}
                  labelClassName="px-2 pb-0.5 pt-1 text-2xs font-bold uppercase tracking-wide text-secondary"
                >
                  {savedSearches.map((search) => (
                    <MenuItem
                      key={search.id}
                      title={search.query}
                      icon={<Bookmark size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />}
                      label={
                        <span dir="auto" className="block min-w-0 truncate">
                          {search.name}
                        </span>
                      }
                      onClick={() => {
                        close()
                        ui$.query.set(search.query)
                      }}
                    />
                  ))}
                </MenuGroup>
                <MenuSeparator />
              </>
            )}
            {tree.length === 0 ? (
              // Said as a disabled item so the arrow keys reach it too.
              <MenuItem
                disabled
                appearance="cursor-default justify-center py-4 text-center text-xs font-medium text-secondary"
                label={loading ? t('folders.loading') : t('folders.noneAvailable')}
              />
            ) : (
              tree.map((node) => (
                <FolderNodeRow
                  key={node.folder?.id ?? node.name}
                  node={node}
                  depth={0}
                  currentFolderId={folderId}
                  takenFolderIds={takenFolderIds}
                  onPick={(picked) => {
                    close()
                    onSelect(picked)
                  }}
                />
              ))
            )}
          </MenuList>
        </FloatingContextMenu>
      )}
    </>
  )
}
