import { useTranslation } from '../../lib/i18n'
import { settingsDestinations } from '../../lib/settingsDestinations'
import { messageChangesBlocked, readOnlyTarget, sendBlocked } from '../../lib/mailCapabilities'
import { useMemo } from 'react'
import {
  Archive,
  Bell,
  BellOff,
  BookUser,
  CalendarDays,
  Columns3,
  Inbox,
  Info,
  List,
  ListTodo,
  Mail,
  MailCheck,
  MailOpen,
  MessagesSquare,
  Moon,
  Paperclip,
  Pencil,
  Keyboard,
  Maximize2,
  Plus,
  Reply,
  RefreshCw,
  Search,
  SearchCheck,
  Settings,
  SquareChevronRight,
  Star,
  StickyNote,
  Sun,
  Trash2,
  Users,
  X,
  Palette,
} from 'lucide-react'
import { createElement } from 'react'
import { useValue } from '@legendapp/state/react'
import {
  ui$,
  closeCommandPalette,
  focusSettingsSection,
  facetsOf,
  focusGlobalSearch,
  focusQuickReply,
  openCommandPalette,
  type AppModule,
  type FilterMode,
} from '../../states/ui'
import { selectTheme, settings$ } from '../../states/settings'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { update$ } from '../../states/update'
import { BUILTIN_THEMES } from '../../lib/themes'
import {
  closeKanbanBoard,
  createKanbanBoard,
  kanban$,
  openMailAccount,
  selectKanbanBoard,
  setGlobalKanbanFilter,
} from '../../states/kanban'
import { thread$ } from '../../states/thread'
import {
  mail$,
  syncMail,
  markAllRead,
  archiveThread,
  deleteThread,
  toggleStarWithUndo,
  markUnreadWithUndo,
} from '../../states/mail'
import { compose$, openComposeTab, openReplyInFullEditor, closeMessageTab } from '../../states/compose'
import { RAIL_SHORTCUT_IDS, type ShortcutId } from '../../lib/shortcuts'
import type { Command } from './paletteCommands'
import { merge$ } from '../../states/merge'
import { awaiting$ } from '../../states/awaiting'
import { pauseNotifications, resumeNotifications, type PauseChoice } from '../../states/notifications'
import { useQuietState } from '../sidenav/QuietIndicator'

// The modules after mail, in the order of the module strip (ADR-0068 §5). Mail
// itself is "Go to: Mail" (view.mail).
const MODULES: { key: Exclude<AppModule, 'mail'>; title: string; icon: typeof Mail; keywords: string }[] = [
  { key: 'calendar', title: 'calendar.title', icon: CalendarDays, keywords: 'calendar events agenda' },
  { key: 'people', title: 'people.title', icon: BookUser, keywords: 'people contacts address book' },
  { key: 'tasks', title: 'tasks.title', icon: ListTodo, keywords: 'tasks to do lists' },
  { key: 'notes', title: 'notes.title', icon: StickyNote, keywords: 'notes' },
  { key: 'chat', title: 'messaging.title', icon: MessagesSquare, keywords: 'chat messaging xmpp' },
  { key: 'attachments', title: 'attachmentsView.title', icon: Paperclip, keywords: 'attachments files' },
]

// Builds the full, ordered command list from current app state: the one list
// the palette and the app menu both show (ADR-0068 §2). Each entry's `run`
// closes the palette first, then performs its action. Returns a memoized
// array recomputed only when the underlying selections change.
export function useCommandList(): Command[] {
  const { t } = useTranslation()
  const boards = useValue(settings$.kanbanBoards)
  const activeBoardId = useValue(kanban$.activeBoardId)
  const themeId = useValue(settings$.themeId)
  const customThemes = useValue(settings$.customThemes)
  const filters = useValue(ui$.filters)
  const kanbanFilterMode = useValue(kanban$.globalFilter)
  const selectedAccount = useValue(ui$.selectedAccount)
  const selectedFolder = useValue(ui$.selectedFolder)
  const selectedThread = useValue(ui$.selectedThread)
  const accounts = useValue(accounts$)
  const folders = useValue(mail$.folders)
  const activeTab = useValue(compose$.activeTab)
  const updatesSupported = useValue(update$.status.supported)
  const activeModule = useValue(ui$.module)
  const quiet = useQuietState().quiet

  return useMemo<Command[]>(() => {
    const run = (fn: () => void) => () => {
      closeCommandPalette()
      fn()
    }
    const icon = (component: typeof Mail) => createElement(component, { size: 15 })
    // The palette offers one narrowing at a time, which is what a command
    // list is for; the filter bar is where they are combined.
    const activeFilterMode: FilterMode = activeBoardId ? kanbanFilterMode : (filters[0] ?? 'all')
    const setActiveFilterMode = activeBoardId
      ? setGlobalKanbanFilter
      : (mode: FilterMode) => ui$.filters.set(facetsOf(mode))
    const railShortcut = (slot: number) => RAIL_SHORTCUT_IDS[slot - 1] as ShortcutId | undefined
    // Picking a mail destination leaves another module, as the rail does:
    // they share the window, so staying would change mail's selection unseen.
    const inMail = (fn: () => void) => () => {
      ui$.module.set('mail')
      fn()
    }

    const list: Command[] = [
      {
        id: 'compose.new',
        label: t('commands.compose.new'),
        area: 'mail',
        icon: icon(Pencil),
        keywords: 'write new email reply',
        shortcut: 'compose.new',
        run: run(() => openComposeTab()),
      },
      {
        id: 'compose.mailing',
        label: t('commands.compose.mailing', { defaultValue: 'Personalized mailing…' }),
        area: 'mail',
        icon: icon(Users),
        keywords: 'mail merge mass bulk personalized newsletter',
        run: run(() => merge$.open.set(true)),
      },
      {
        id: 'mail.awaiting',
        label: t('commands.mail.awaiting', { defaultValue: 'Waiting for replies…' }),
        area: 'mail',
        icon: icon(MailCheck),
        keywords: 'follow up pending answer reply reminder',
        run: run(() => awaiting$.open.set(true)),
      },
      {
        id: 'mail.sync',
        label: t('commands.mail.sync'),
        area: 'mail',
        icon: icon(RefreshCw),
        keywords: 'refresh fetch check',
        shortcut: 'mail.sync',
        run: run(() => void syncMail()),
      },
      {
        id: 'mail.markAllRead',
        label: t('commands.mail.markAllRead'),
        area: 'mail',
        icon: icon(MailCheck),
        keywords: 'clear unread',
        run: run(() => void markAllRead()),
      },
      {
        id: 'search.thread',
        label: t('commands.search.thread'),
        area: 'mail',
        icon: icon(Search),
        keywords: 'find conversation in',
        shortcut: 'search.thread',
        run: run(() => {
          const visible = !!selectedThread && (!activeBoardId || !!kanban$.paneThreadId.peek())
          if (visible) thread$.searchOpen.set(true)
          else focusGlobalSearch()
        }),
      },
      {
        id: 'search.global',
        label: t('commands.search.global'),
        area: 'mail',
        icon: icon(SearchCheck),
        keywords: 'find global mailbox',
        shortcut: 'search.global',
        run: run(() => focusGlobalSearch()),
      },
      {
        id: 'settings.open',
        label: t('commands.settings.open'),
        area: 'settings',
        icon: icon(Settings),
        keywords: 'preferences config',
        shortcut: 'settings.open',
        run: run(() => ui$.settingsOpen.set(true)),
      },
      {
        id: 'account.add',
        label: t('commands.account.add'),
        area: 'accounts',
        icon: icon(Plus),
        keywords: 'new mailbox connect',
        run: run(() => ui$.setupOpen.set(true)),
      },
      {
        id: 'palette.open',
        label: t('palette.label'),
        area: 'app',
        icon: icon(SquareChevronRight),
        keywords: 'command palette commands',
        shortcut: 'palette.open',
        run: run(() => openCommandPalette()),
      },
      {
        id: 'shortcuts.help',
        label: t('commands.shortcuts.help'),
        area: 'app',
        icon: icon(Keyboard),
        keywords: 'keys cheat sheet help bindings',
        shortcut: 'shortcuts.help',
        run: run(() => ui$.shortcutsOpen.set(true)),
      },
      {
        id: 'view.mail',
        label: t('commands.view.mail'),
        area: 'modules',
        icon: icon(List),
        keywords: 'layout list conversation account',
        active: activeModule === 'mail' && !activeBoardId,
        run: run(inMail(() => closeKanbanBoard())),
      },
      // The other modules (ADR-0068 §5: a "Go to: …" for each), as the rail's
      // More menu offered them.
      ...MODULES.map(
        ({ key, title, icon: component, keywords }): Command => ({
          id: `module.${key}`,
          label: t('commands.goTo', { name: t(title) }),
          area: 'modules',
          icon: icon(component),
          keywords: `module go to ${keywords}`,
          active: activeModule === key,
          run: run(() => ui$.module.set(key)),
        }),
      ),
      {
        id: 'design.catalogue',
        label: t('commands.design.catalogue'),
        area: 'app',
        icon: icon(Palette),
        keywords: 'components tokens library styleguide',
        run: run(() => ui$.catalogueOpen.set(true)),
      },
      {
        id: 'app.about',
        label: t('about.title'),
        area: 'app',
        icon: icon(Info),
        keywords: 'about version licence license credits',
        run: run(() => ui$.aboutOpen.set(true)),
      },
      {
        id: 'kanban.create',
        label: t('commands.kanban.create'),
        area: 'boards',
        icon: icon(Plus),
        keywords: 'new board columns',
        run: run(() => createKanbanBoard()),
      },
      ...boards.map(
        (board, boardIndex): Command => ({
          id: `kanban.${board.id}`,
          label: t('commands.goTo', { name: board.name }),
          area: 'boards',
          icon: icon(Columns3),
          keywords: 'kanban board columns',
          shortcut: railShortcut(boardIndex + 2),
          active: activeBoardId === board.id,
          run: run(inMail(() => selectKanbanBoard(board.id))),
        }),
      ),
      {
        id: 'filter.all',
        label: t('commands.filter.all'),
        area: 'mail',
        icon: icon(Mail),
        keywords: 'show everything',
        active: activeFilterMode === 'all',
        run: run(() => setActiveFilterMode('all')),
      },
      {
        id: 'filter.unread',
        label: t('commands.filter.unread'),
        area: 'mail',
        icon: icon(Inbox),
        active: activeFilterMode === 'unread',
        run: run(() => setActiveFilterMode('unread')),
      },
      {
        id: 'filter.starred',
        label: t('commands.filter.starred'),
        area: 'mail',
        icon: icon(Star),
        active: activeFilterMode === 'starred',
        run: run(() => setActiveFilterMode('starred')),
      },
      ...[...BUILTIN_THEMES, ...customThemes].map(
        (theme): Command => ({
          id: `theme.${theme.id}`,
          label: t('commands.theme', { name: theme.name }),
          area: 'theme',
          icon: icon(theme.appearance === 'light' ? Sun : Moon),
          active: themeId === theme.id,
          run: run(() => selectTheme(theme)),
        }),
      ),
      // Do not disturb (ADR-0049): the same choices as Settings, the tray and
      // the rail's More menu.
      ...(quiet
        ? [
            {
              id: 'notifications.resume',
              label: t('notifications.dnd.resume', { defaultValue: 'Resume notifications' }),
              area: 'notifications' as const,
              icon: icon(Bell),
              keywords: 'do not disturb resume notifications unmute',
              run: run(() => resumeNotifications()),
            },
          ]
        : (
            [
              ['hour', t('notifications.dnd.menuHour', { defaultValue: 'Do not disturb for 1 hour' })],
              ['tomorrow', t('notifications.dnd.menuTomorrow', { defaultValue: 'Do not disturb until tomorrow' })],
              ['off', t('notifications.dnd.menuOff', { defaultValue: 'Do not disturb until turned off' })],
            ] as [PauseChoice, string][]
          ).map(
            ([choice, label]): Command => ({
              id: `notifications.pause.${choice}`,
              label,
              area: 'notifications',
              icon: icon(BellOff),
              keywords: 'do not disturb quiet pause mute notifications',
              run: run(() => pauseNotifications(choice)),
            }),
          )),
    ]

    // Actions on the open conversation — only when one is on screen.
    if (selectedThread && (!activeBoardId || !!kanban$.paneThreadId.peek())) {
      list.push(
        {
          id: 'reply.focus',
          label: t('commands.reply.focus'),
          area: 'conversation',
          icon: icon(Reply),
          keywords: 'respond quick',
          shortcut: 'reply.focus',
          run: run(() => focusQuickReply()),
        },
        {
          id: 'compose.replyFull',
          label: t('commands.compose.replyFull'),
          area: 'conversation',
          icon: icon(Maximize2),
          keywords: 'expand compose respond editor',
          shortcut: 'compose.replyFull',
          run: run(() => openReplyInFullEditor()),
        },
        {
          id: 'thread.archive',
          label: t('commands.thread.archive'),
          area: 'conversation',
          icon: icon(Archive),
          keywords: 'remove inbox',
          shortcut: 'thread.archive',
          run: run(() => void archiveThread(selectedThread)),
        },
        {
          id: 'thread.star',
          label: t('commands.thread.star'),
          area: 'conversation',
          icon: icon(Star),
          keywords: 'flag favorite',
          shortcut: 'thread.star',
          run: run(() => toggleStarWithUndo(selectedThread)),
        },
        {
          id: 'thread.unread',
          label: t('commands.thread.unread'),
          area: 'conversation',
          icon: icon(MailOpen),
          keywords: 'seen',
          shortcut: 'thread.unread',
          run: run(() => markUnreadWithUndo(selectedThread)),
        },
        {
          id: 'thread.delete',
          label: t('commands.thread.delete'),
          area: 'conversation',
          icon: icon(Trash2),
          keywords: 'trash remove',
          shortcut: 'thread.delete',
          run: run(() => void deleteThread(selectedThread)),
        },
      )
    }

    // Close the active reader/compose tab when one is open.
    if (activeTab) {
      list.push({
        id: 'tab.close',
        label: t('commands.tab.close'),
        area: 'conversation',
        icon: icon(X),
        keywords: 'dismiss editor reader',
        shortcut: 'tab.close',
        run: run(() => void closeMessageTab(activeTab)),
      })
    }

    // Switch accounts (plus the unified inbox when more than one exists).
    if (accounts.length > 1) {
      list.push({
        id: 'account.unified',
        label: t('commands.account.unified'),
        area: 'accounts',
        icon: icon(Users),
        keywords: 'all accounts switch',
        shortcut: railShortcut(1),
        active: !activeBoardId && selectedAccount === 'unified',
        run: run(inMail(() => openMailAccount('unified'))),
      })
    }
    for (const [accountIndex, account] of accounts.entries()) {
      list.push({
        id: `account.${account.id}`,
        label: t('commands.goTo', { name: account.display_name || account.email }),
        area: 'accounts',
        icon: icon(Mail),
        keywords: `account switch ${account.email}`,
        shortcut: railShortcut(boards.length + accountIndex + 2),
        active: !activeBoardId && selectedAccount === account.id,
        run: run(inMail(() => openMailAccount(account.id))),
      })
    }

    // Jump to a folder in the current account.
    for (const folder of folders) {
      list.push({
        id: `folder.${folder.id}`,
        label: t('commands.folder', { name: folder.name }),
        area: 'folders',
        icon: icon(Inbox),
        keywords: 'open mailbox',
        active: selectedFolder === folder.id,
        run: run(inMail(() => ui$.selectedFolder.set(folder.id))),
      })
    }

    list.unshift(
      ...settingsDestinations(accounts, t, updatesSupported).map(
        (destination): Command => ({
          id: destination.id,
          label: destination.label,
          keywords: destination.keywords,
          kind: 'setting',
          area: 'settings',
          hint: t('palette.kind.setting'),
          icon: icon(Settings),
          run: run(() => {
            if (destination.accountId && !accounts$.peek().some((account) => account.id === destination.accountId))
              return
            focusSettingsSection(destination.section, destination.accountId)
          }),
        }),
      ),
    )
    // Sending and folder-wide changes are not supported on Microsoft Graph;
    // changing a message is, once the reader allowed it (#141).
    const writeCommands = new Set(['mail.markAllRead'])
    const sendCommands = new Set(['reply.focus', 'compose.replyFull'])
    const messageCommands = new Set(['thread.archive', 'thread.star', 'thread.unread', 'thread.delete'])
    return list.map((command) => {
      if (command.kind === 'setting') return command
      const keywordId = command.id.startsWith('theme.')
        ? 'theme'
        : command.id.startsWith('module.')
          ? 'module'
          : command.id.startsWith('notifications.')
            ? 'notifications'
            : command.id.startsWith('folder.')
              ? 'folder'
              : command.id.startsWith('account.') && !['account.add', 'account.unified'].includes(command.id)
                ? 'account'
                : command.id.startsWith('kanban.') && command.id !== 'kanban.create'
                  ? 'kanban'
                  : command.id
      const target =
        command.id.startsWith('thread.') || command.id.startsWith('reply.') || command.id === 'compose.replyFull'
          ? selectedThread
          : selectedAccount
      const unavailable = (currentAccounts: typeof accounts) =>
        command.id === 'compose.new'
          ? !currentAccounts.some(isSendableAccount)
          : (writeCommands.has(command.id) && readOnlyTarget(currentAccounts, target)) ||
            (sendCommands.has(command.id) && sendBlocked(currentAccounts, target)) ||
            (messageCommands.has(command.id) && messageChangesBlocked(currentAccounts, target))
      const disabled = unavailable(accounts)
      return {
        ...command,
        disabled,
        hint: disabled
          ? t(command.id === 'compose.new' ? 'commands.noSendableAccount' : 'accounts.graph.readOnly')
          : t('palette.kind.action'),
        keywords: (command.keywords ?? '') + ' ' + t('commands.aliases.' + keywordId),
        run: () => {
          if (unavailable(accounts$.peek())) return
          command.run()
        },
      }
    })
  }, [
    t,
    updatesSupported,
    boards,
    activeBoardId,
    themeId,
    customThemes,
    filters,
    kanbanFilterMode,
    selectedAccount,
    selectedFolder,
    selectedThread,
    accounts,
    folders,
    activeTab,
    activeModule,
    quiet,
  ])
}
