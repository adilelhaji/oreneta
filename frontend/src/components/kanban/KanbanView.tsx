import { useEffect, useMemo, useState } from 'react'
import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { Columns3, Plus, SquarePen } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { clearBulkSelection, focusGlobalSearch, ui$ } from '../../states/ui'
import { mail$, ensureAccountFolders } from '../../states/mail'
import { openComposeTab } from '../../states/compose'
import type { Folder } from '../../types'
import {
  addKanbanColumn,
  getKanbanColumns,
  kanbanBoardColumnKey,
  kanbanColumnKey,
  kanban$,
  removeKanbanColumn,
  setGlobalKanbanFilter,
  setKanbanSearchScope,
  type KanbanColumn,
} from '../../states/kanban'
import { settings$ } from '../../states/settings'
import { EmptyState } from '../empty-state/EmptyState'
import { IconButton } from '../button/IconButton'
import { AddColumnDialog, type AccountGroup } from './AddColumnDialog'
import { SortableColumn } from './KanbanBoardColumn'
import { KanbanDragPreview } from './KanbanThreadCard'
import { useThreadContextMenu } from '../threads/ThreadContextMenu'
import { BoardMenu, FilterSwitch } from './KanbanBoardMenu'
import { isRSSAccount, loadKanbanColumn, resolveKanbanMove, useFoldersByAccount } from '../../lib/kanbanData'
import { wallpaperCss } from '../../lib/wallpapers'
import { useKanbanBoardSync, useKanbanDnd } from './useKanbanBoard'

export function KanbanView({ boardId }: { boardId: string }) {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  const foldersByAccount = useFoldersByAccount()
  const boards = useValue(settings$.kanbanBoards)
  const globalFilter = useValue(kanban$.globalFilter)
  const searchQuery = useValue(kanban$.searchQuery)
  const searchScope = useValue(kanban$.searchScope)
  const board = boards.find((item) => item.id === boardId)
  // No layer at all when unset, so the default board keeps the plain theme surface.
  const boardWallpaper = board?.wallpaper ? wallpaperCss(board.wallpaper) : null
  const [dialogOpen, setDialogOpen] = useState(false)
  const hasSendableAccount = accounts.some(isSendableAccount)
  const visibleColumns = useMemo(() => getKanbanColumns(boardId), [boards, boardId])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const selectedKeys = useMemo(() => visibleColumns.map((column) => kanbanColumnKey(column)), [visibleColumns])
  // Derived from the folder cache rather than snapshotted when the dialog opens,
  // so a folder LIST that finishes while it is open shows up without reopening.
  const dialogGroups = useMemo<AccountGroup[]>(
    () =>
      accounts.map((account) => ({
        accountId: account.id,
        label: account.display_name || account.email || account.id,
        email: account.email,
        avatarUrl: account.avatar_url,
        isRSS: isRSSAccount(account.id, accounts),
        folders: foldersByAccount[account.id] ?? [],
      })),
    [accounts, foldersByAccount],
  )

  useKanbanBoardSync(boardId, visibleColumns, accounts)
  const { dragPreview, setDragPreview, moveThread, handleDragStart, handleDragEnd } = useKanbanDnd(boardId, accounts)
  // One controller for the whole board so a right-click in one column closes any
  // menu open in another (only one thread menu can be open at a time).
  const threadMenu = useThreadContextMenu(accounts)
  // Only a thread drag sets a preview (a column reorder clears it), so this is
  // empty while columns are being rearranged.
  const dropRejections = useMemo<Record<string, string>>(() => {
    if (!dragPreview) return {}
    const rejections: Record<string, string> = {}
    for (const column of visibleColumns) {
      const resolution = resolveKanbanMove(dragPreview.column, column, dragPreview.thread, accounts)
      if (resolution.kind === 'blocked') rejections[kanbanColumnKey(column)] = t(resolution.reasonKey)
    }
    return rejections
  }, [accounts, dragPreview, t, visibleColumns])

  useEffect(() => {
    clearBulkSelection()
  }, [boardId])

  useEffect(() => {
    clearBulkSelection()
  }, [globalFilter, searchQuery, searchScope])

  function openDialog() {
    // Kick a real folder LIST per account and open immediately on the cache. The
    // sync is async and deduped in core; its mail.synced({folders:true}) refreshes
    // foldersByAccount, and because the groups below are derived from that cache
    // the open dialog repaints with folders added on the server since last sync.
    for (const account of accounts) {
      void ensureAccountFolders(account.id, {
        forceRefresh: !isRSSAccount(account.id, accounts),
        waitForRefresh: true,
      })
    }
    setDialogOpen(true)
  }

  // A column's «Search this column»: the board's search, in the top band
  // (ADR-0068 §2, #344), scoped to that column.
  function searchColumn(column: KanbanColumn) {
    setKanbanSearchScope(boardId, kanbanColumnKey(column))
    focusGlobalSearch()
  }

  function applyColumns(nextKeys: string[]) {
    const next = new Set(nextKeys)
    const current = new Set(selectedKeys)

    for (const key of nextKeys) {
      if (current.has(key)) continue
      const [accountId, folderId] = key.split('\n')
      if (!accountId || !folderId) continue
      kanban$.threads[key].set([])
      kanban$.loading[key].set(true)
      addKanbanColumn(boardId, { accountId, folderId })
      void loadKanbanColumn({ accountId, folderId }, true)
    }

    for (const key of selectedKeys) {
      if (next.has(key)) continue
      const [accountId, folderId] = key.split('\n')
      if (accountId && folderId) removeKanbanColumn(boardId, { accountId, folderId })
    }

    setDialogOpen(false)
  }

  async function createDialogFolder(accountId: string, name: string): Promise<Folder> {
    const result = await invoke<{ folders: Folder[] }>('mail.folderCreate', { account_id: accountId, name })
    const folder = result.folders?.[0]
    if (!folder) throw new Error(t('folders.createdMissing'))

    const mergeFolders = (items: Folder[]) => {
      const byId = new Map(items.map((item) => [item.id, item]))
      byId.set(folder.id, folder)
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
    }

    const nextFolders = mergeFolders(mail$.foldersByAccount[accountId].peek() ?? [])
    mail$.foldersByAccount[accountId].set(nextFolders)
    if (ui$.selectedAccount.peek() === accountId) {
      mail$.folders.set(mergeFolders(mail$.folders.peek() ?? []))
    }
    return folder
  }

  if (accounts.length === 0) {
    return (
      <section data-region="content" className="flex flex-1 border-e border-border bg-chats">
        <EmptyState title={t('empty.welcomeTitle')} text={t('empty.kanbanSetupText')} />
      </section>
    )
  }

  return (
    <section
      data-region="content"
      className="flex flex-1 min-w-0 flex-col border-e border-border bg-chats max-[600px]:w-full"
    >
      <div className="@container relative z-30 flex min-h-16 shrink-0 items-center gap-3 border-b border-border/50 bg-header px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {board?.avatarUrl ? (
            <img
              src={board.avatarUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded-control object-cover border border-accent/10"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-control bg-accent/10 text-accent-fg shrink-0 border border-accent/10">
              <Columns3 size={16} strokeWidth={1.75} />
            </div>
          )}
          <h2 className="truncate text-sm font-bold text-primary">{board?.name || t('kanban.board.defaultName')}</h2>
        </div>
        <FilterSwitch value={globalFilter} onChange={setGlobalKanbanFilter} />
        {hasSendableAccount && (
          <IconButton
            icon={SquarePen}
            label={t('composer.actions.newMessage')}
            onClick={() => {
              const id = openComposeTab()
              if (!id) return
              ui$.mobilePane.set('conversation')
            }}
          />
        )}
        <BoardMenu filterMode={globalFilter} onFilterChange={setGlobalKanbanFilter} onAddColumn={openDialog} />
      </div>
      {dialogOpen && (
        <AddColumnDialog
          groups={dialogGroups}
          initialSelected={selectedKeys}
          // One unified entry, not one per unified folder: the column's own
          // header switches it to Starred/Sent/… once it is on the board, the
          // same way a single-account column is retargeted.
          specialOptions={[
            {
              key: kanbanColumnKey({ accountId: 'unified', folderId: 'inbox' }),
              label: t('kanban.columns.unifiedInbox'),
              icon: 'inbox',
            },
          ]}
          onClose={() => setDialogOpen(false)}
          onApply={applyColumns}
          onCreateFolder={createDialogFolder}
        />
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragPreview(null)}
      >
        <div className="relative flex flex-1 min-h-0">
          {boardWallpaper && (
            <div className={`absolute inset-0 ${boardWallpaper.className}`} style={boardWallpaper.style} />
          )}
          <div className="relative flex flex-1 min-h-0 gap-2 overflow-x-auto p-2">
            {visibleColumns.length === 0 ? (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState title={t('empty.noColumns')} text={t('empty.noColumnsText')} />
              </div>
            ) : (
              <SortableContext
                items={visibleColumns.map((column) => kanbanBoardColumnKey(boardId, column))}
                strategy={horizontalListSortingStrategy}
              >
                {visibleColumns.map((column) => (
                  <SortableColumn
                    key={kanbanColumnKey(column)}
                    boardId={boardId}
                    column={column}
                    // While a card is in the air, every column that would refuse
                    // it says so up front instead of only after the drop.
                    dropRejection={dropRejections[kanbanColumnKey(column)]}
                    onMoveThread={moveThread}
                    onSearchColumn={searchColumn}
                    threadMenu={threadMenu}
                  />
                ))}
              </SortableContext>
            )}
            <button
              type="button"
              className="group flex h-full w-11 shrink-0 cursor-pointer items-center justify-center rounded-control-sm border border-dashed border-border/80 bg-chats/45 text-secondary transition-colors hover:border-accent/50 hover:bg-chats/75 hover:text-accent-fg focus-visible:border-accent-fg focus-visible:ring-2 focus-visible:ring-accent/30"
              title={t('kanban.actions.addColumn')}
              aria-label={t('kanban.actions.addColumn')}
              onClick={() => void openDialog()}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-chats/80 shadow-sm transition-colors group-hover:bg-accent/10">
                <Plus size={16} strokeWidth={1.75} />
              </span>
            </button>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragPreview ? <KanbanDragPreview thread={dragPreview.thread} column={dragPreview.column} /> : null}
        </DragOverlay>
      </DndContext>
    </section>
  )
}
