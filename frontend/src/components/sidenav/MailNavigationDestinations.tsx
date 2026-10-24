import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BellOff, Columns3, KeyRound, Mail, Pause } from 'lucide-react'
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { useTranslation } from '../../lib/i18n'
import { documentDirection } from '../../lib/direction'
import { moveShownAccount } from '../../states/accounts'
import { reorderKanbanBoards } from '../../states/kanban'
import type { Account } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { AccountContextMenu } from './AccountContextMenu'
import { BoardContextMenu } from './BoardContextMenu'
import { UnifiedInboxContextMenu } from './UnifiedInboxContextMenu'
import { sortableStyle } from './SortableRailItems'
import { accountStatus, feedDragOver, feedDrop, useAccountUnread, type AccountStatus } from './accountNav'

// What «Comptes i carpetes» took over from the vertical rail (ADR-0068 §5,
// piece 14a): the unified inbox's menu, the «Taulers» section, and accounts
// that reorder, open their menu, count their unread mail, say their state and
// take a dropped feed. The rail shows the same order and the same menus until
// it goes (piece 14b).

/** Shift+F10 or the context menu key: the keyboard's right click. */
export function menuKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/** Where a menu opened from the keyboard goes: a little in from the row's start edge, under it. */
export function keyboardMenuPoint(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  return { x: documentDirection() === 'rtl' ? rect.right - 16 : rect.left + 16, y: rect.bottom }
}

/** Alt+↑ or Alt+↓, which move a row one place, as in Favorites (ADR-0050); 0 for any other key. */
function moveStep(event: KeyboardEvent<HTMLElement>): -1 | 0 | 1 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
}

const MOVE_KEYS = 'Alt+ArrowUp Alt+ArrowDown'

/** The attribute that names a row of the pane, so the focus can find it again after a change. */
const ROW = 'data-nav-row'

/**
 * Puts the focus back on a row once a change is drawn. A row that moves is
 * taken out of the page and put back, and one that is hidden or deleted goes,
 * so the focus would fall to the page. The first key still drawn wins: the row
 * itself, or one near it; a key ending in `*` stands for the first row whose
 * key starts with what comes before it. `gone` is said only when the row
 * itself is no longer drawn: an account that is open stays in the pane when it
 * is hidden, and then nothing has gone. The change and the request are drawn
 * together (React batches them), so the effect runs once, after both.
 */
export function useNavRowFocus(announce: (text: string) => void) {
  const pending = useRef<{ keys: string[]; gone?: string } | null>(null)
  const [request, setRequest] = useState(0)
  useLayoutEffect(() => {
    const wanted = pending.current
    if (!wanted) return
    pending.current = null
    const drawn = [...document.querySelectorAll<HTMLElement>(`[${ROW}]`)]
    const keyOf = (element: HTMLElement) => element.getAttribute(ROW) ?? ''
    for (const [index, key] of wanted.keys.entries()) {
      const row = key.endsWith('*')
        ? drawn.find((element) => keyOf(element).startsWith(key.slice(0, -1)))
        : drawn.find((element) => keyOf(element) === key)
      if (!row) continue
      row.focus()
      if (index > 0 && wanted.gone) announce(wanted.gone)
      return
    }
    if (wanted.gone) announce(wanted.gone)
  }, [request])
  return (keys: string[], gone?: string) => {
    pending.current = { keys, gone }
    setRequest((count) => count + 1)
  }
}

/** The row itself, then the one after it, then the one before: where the focus goes if it is hidden. */
function rowAndNeighbours(row: HTMLElement): string[] {
  const rows = [...(row.closest('.mail-navigation') ?? document).querySelectorAll<HTMLElement>(`[${ROW}]`)]
  const index = rows.indexOf(row)
  return [row, rows[index + 1], rows[index - 1]].flatMap((element) => {
    const key = element?.getAttribute(ROW)
    return key ? [key] : []
  })
}

/** A board's row, then the next board's, then the one before. */
function boardAndNeighbours(row: HTMLElement): string[] {
  const rows = [...(row.closest('ul') ?? document).querySelectorAll<HTMLElement>(`[${ROW}]`)]
  const index = rows.indexOf(row)
  return [row, rows[index + 1], rows[index - 1]].flatMap((element) => {
    const key = element?.getAttribute(ROW)
    return key ? [key] : []
  })
}

type MenuAt = { x: number; y: number; trigger: HTMLElement }

/** A menu's trigger takes the focus back when the menu closes, if it is still there. */
function giveFocusBack(menu: MenuAt | null) {
  if (menu?.trigger.isConnected) menu.trigger.focus()
}

/**
 * The pointer drags a row, through dnd-kit, and says so in the language of the
 * interface. A list of one has nothing to reorder, and is drawn without it.
 */
function SortableNavList({
  ids,
  nameOf,
  onMove,
  children,
}: {
  ids: string[]
  nameOf: (id: string) => string
  onMove: (from: number, to: number) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const name = (id: UniqueIdentifier) => nameOf(String(id))
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('mailNavigation.drag.picked', { name: name(active.id) }),
    onDragOver: () => undefined,
    onDragEnd: ({ active, over }) => {
      const to = over ? ids.indexOf(String(over.id)) : -1
      return over && over.id !== active.id && to !== -1
        ? t('mailNavigation.moved', { name: name(active.id), position: to + 1, count: ids.length })
        : t('mailNavigation.drag.unchanged', { name: name(active.id) })
    },
    onDragCancel: ({ active }) => t('mailNavigation.drag.unchanged', { name: name(active.id) }),
  }
  if (ids.length < 2) return <>{children}</>
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      // The rows are buttons that keep their own role and keys: no
      // instructions to point them at (the keyboard moves them with Alt+↑/↓).
      accessibility={{ announcements, screenReaderInstructions: { draggable: '' } }}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return
        const from = ids.indexOf(String(active.id))
        const to = ids.indexOf(String(over.id))
        if (from !== -1 && to !== -1) onMove(from, to)
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

export function UnifiedInboxRow({
  current,
  onOpen,
  onShowGroup,
  refocus,
}: {
  current: boolean
  onOpen: () => void
  onShowGroup: (groupId: string) => void
  refocus: (keys: string[], gone?: string) => void
}) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const name = t('kanban.columns.unifiedInbox')
  return (
    <>
      <button
        type="button"
        className="mail-account-destination"
        {...{ [ROW]: 'unified' }}
        title={name}
        aria-current={current ? 'true' : undefined}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, trigger: event.currentTarget })
        }}
        onKeyDown={(event) => {
          if (!menuKey(event)) return
          event.preventDefault()
          setMenu({ ...keyboardMenuPoint(event.currentTarget), trigger: event.currentTarget })
        }}
      >
        <Mail size={16} strokeWidth={1.75} />
        <span>{name}</span>
      </button>
      {menu && (
        <UnifiedInboxContextMenu
          x={menu.x}
          y={menu.y}
          label={name}
          hideLabel={t('mailNavigation.actions.hideUnified')}
          onShowGroup={onShowGroup}
          onHidden={() => refocus(rowAndNeighbours(menu.trigger), t('mailNavigation.hidden', { name }))}
          onClose={() => {
            giveFocusBack(menu)
            setMenu(null)
          }}
        />
      )}
    </>
  )
}

export type NavBoard = { id: string; name: string; avatarUrl?: string }

/**
 * «Taulers» (ADR-0068 §4 and §5): the kanban boards, in their order, between
 * the unified inbox and the account groups. A group named by its label, not a
 * heading or a landmark: under «Comptes», whose heading still leads to the
 * groups and the accounts after it.
 */
export function BoardsSection({
  boards,
  activeBoard,
  onOpen,
  refocus,
  announce,
}: {
  boards: NavBoard[]
  activeBoard: string
  onOpen: (id: string) => void
  refocus: (keys: string[], gone?: string) => void
  announce: (text: string) => void
}) {
  const { t } = useTranslation()
  const labelId = useId()
  const [menu, setMenu] = useState<(MenuAt & { id: string }) | null>(null)
  const menuBoard = menu ? boards.find((board) => board.id === menu.id) : undefined
  if (!boards.length) return null
  const ids = boards.map((board) => board.id)
  const move = (from: number, to: number, keyboard = false) => {
    if (to < 0 || to >= boards.length || from === to) return
    const board = boards[from]
    if (keyboard) refocus([`board:${board.id}`])
    reorderKanbanBoards(from, to)
    if (keyboard) announce(t('mailNavigation.moved', { name: board.name, position: to + 1, count: boards.length }))
  }
  return (
    <div role="group" className="mail-navigation-boards" aria-labelledby={labelId}>
      <p id={labelId} className="mail-navigation-label">
        {t('mailNavigation.boards')}
      </p>
      <SortableNavList
        ids={ids}
        nameOf={(id) => boards.find((board) => board.id === id)?.name ?? id}
        onMove={(from, to) => move(from, to)}
      >
        <ul>
          {boards.map((board, index) => (
            <BoardRow
              key={board.id}
              board={board}
              movable={boards.length > 1}
              current={board.id === activeBoard}
              onOpen={() => onOpen(board.id)}
              onMenu={(at) => setMenu({ ...at, id: board.id })}
              onStep={(step) => move(index, index + step, true)}
            />
          ))}
        </ul>
      </SortableNavList>
      {menu && menuBoard && (
        <BoardContextMenu
          board={menuBoard}
          x={menu.x}
          y={menu.y}
          // The next board, else the one before, else whichever board is
          // there (deleting the last one leaves a new, empty one).
          onDelete={() => refocus([...boardAndNeighbours(menu.trigger), 'board:*'])}
          onClose={() => {
            giveFocusBack(menu)
            setMenu(null)
          }}
        />
      )}
    </div>
  )
}

function BoardRow({
  board,
  movable,
  current,
  onOpen,
  onMenu,
  onStep,
}: {
  board: NavBoard
  movable: boolean
  current: boolean
  onOpen: () => void
  onMenu: (at: MenuAt) => void
  onStep: (step: -1 | 1) => void
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: board.id })
  return (
    <li>
      <button
        ref={setNodeRef}
        style={sortableStyle(transform, transition, isDragging)}
        {...listeners}
        type="button"
        className="mail-account-destination"
        {...{ [ROW]: `board:${board.id}` }}
        title={board.name}
        aria-current={current ? 'true' : undefined}
        aria-keyshortcuts={movable ? MOVE_KEYS : undefined}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault()
          onMenu({ x: event.clientX, y: event.clientY, trigger: event.currentTarget })
        }}
        onKeyDown={(event) => {
          if (menuKey(event)) {
            event.preventDefault()
            onMenu({ ...keyboardMenuPoint(event.currentTarget), trigger: event.currentTarget })
            return
          }
          const step = moveStep(event)
          if (!step) return
          event.preventDefault()
          onStep(step)
        }}
      >
        {/* The name is the row's text: the picture says nothing more. */}
        <span className="mail-board-mark" aria-hidden="true">
          {board.avatarUrl ? (
            <Avatar name={board.name} src={board.avatarUrl} size={16} className="!rounded-control-sm" />
          ) : (
            <Columns3 size={16} strokeWidth={1.75} />
          )}
        </span>
        <span>{board.name}</span>
      </button>
    </li>
  )
}

/** The accounts the pane shows, in the saved order, which is the rail's (ADR-0068 §5). */
export function AccountRows({
  accounts,
  isCurrent,
  onOpen,
  refocus,
  announce,
}: {
  accounts: Account[]
  isCurrent: (account: Account) => boolean
  onOpen: (id: string) => void
  refocus: (keys: string[], gone?: string) => void
  announce: (text: string) => void
}) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<(MenuAt & { id: string }) | null>(null)
  const menuAccount = menu ? accounts.find((account) => account.id === menu.id) : undefined
  const ids = accounts.map((account) => account.id)
  const nameOf = (account: Account) => account.display_name || account.email || account.id
  const move = (from: number, to: number, keyboard = false) => {
    if (to < 0 || to >= accounts.length || from === to) return
    const account = accounts[from]
    if (keyboard) {
      refocus([`account:${account.id}`])
      announce(t('mailNavigation.moved', { name: nameOf(account), position: to + 1, count: accounts.length }))
    }
    void moveShownAccount(ids, account.id, accounts[to].id)
  }
  return (
    <>
      <SortableNavList
        ids={ids}
        nameOf={(id) => {
          const account = accounts.find((item) => item.id === id)
          return account ? nameOf(account) : id
        }}
        onMove={(from, to) => move(from, to)}
      >
        {accounts.map((account, index) => (
          <AccountRow
            key={account.id}
            account={account}
            movable={accounts.length > 1}
            current={isCurrent(account)}
            onOpen={() => onOpen(account.id)}
            onMenu={(at) => setMenu({ ...at, id: account.id })}
            onStep={(step) => move(index, index + step, true)}
          />
        ))}
      </SortableNavList>
      {menu && menuAccount && (
        <AccountContextMenu
          account={menuAccount}
          x={menu.x}
          y={menu.y}
          hideLabel={t('mailNavigation.actions.hideAccount')}
          onHidden={() =>
            refocus(rowAndNeighbours(menu.trigger), t('mailNavigation.hidden', { name: nameOf(menuAccount) }))
          }
          onClose={() => {
            giveFocusBack(menu)
            setMenu(null)
          }}
        />
      )}
    </>
  )
}

function statusText(t: ReturnType<typeof useTranslation>['t'], status: AccountStatus): string {
  if (status === 'reconnect') return t('mailNavigation.status.reconnect')
  if (status === 'paused') return t('connectivity.health.paused')
  return t('mailNavigation.status.muted')
}

const STATUS_ICON = { reconnect: KeyRound, paused: Pause, muted: BellOff } as const

function AccountRow({
  account,
  movable,
  current,
  onOpen,
  onMenu,
  onStep,
}: {
  account: Account
  movable: boolean
  current: boolean
  onOpen: () => void
  onMenu: (at: MenuAt) => void
  onStep: (step: -1 | 1) => void
}) {
  const { t } = useTranslation()
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: account.id })
  const unread = useAccountUnread(account.id)
  const status = accountStatus(account)
  const state = status ? statusText(t, status) : ''
  const StatusIcon = status ? STATUS_ICON[status] : null
  const [feedOver, setFeedOver] = useState(false)
  // Both lines can end in "…" in a narrow pane: the tooltip has them whole, and the state.
  const names =
    account.display_name && account.email && account.display_name !== account.email
      ? `${account.display_name} — ${account.email}`
      : account.email || account.display_name
  return (
    <button
      ref={setNodeRef}
      style={sortableStyle(transform, transition, isDragging)}
      {...listeners}
      type="button"
      className="mail-account-destination"
      {...{ [ROW]: `account:${account.id}` }}
      data-drop-target={feedOver ? 'ok' : undefined}
      title={state ? `${names} — ${state}` : names}
      aria-current={current ? 'true' : undefined}
      aria-keyshortcuts={movable ? MOVE_KEYS : undefined}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu({ x: event.clientX, y: event.clientY, trigger: event.currentTarget })
      }}
      onKeyDown={(event) => {
        if (menuKey(event)) {
          event.preventDefault()
          onMenu({ ...keyboardMenuPoint(event.currentTarget), trigger: event.currentTarget })
          return
        }
        const step = moveStep(event)
        if (!step) return
        event.preventDefault()
        onStep(step)
      }}
      // A feed from the list of an RSS account moves to the one it is dropped on.
      onDragOver={(event) => setFeedOver(feedDragOver(event, account))}
      onDragLeave={() => setFeedOver(false)}
      onDrop={(event) => {
        setFeedOver(false)
        feedDrop(event, account)
      }}
    >
      <Mail size={16} strokeWidth={1.75} />
      <span>
        <strong>{account.display_name || account.email}</strong>
        {account.email && <small>{account.email}</small>}
      </span>
      {StatusIcon && (
        <>
          <StatusIcon size={14} strokeWidth={1.75} className="mail-account-status" aria-hidden="true" />
          <span className="sr-only">{state}</span>
        </>
      )}
      {unread > 0 && <small className="mail-account-unread">{unread}</small>}
    </button>
  )
}
