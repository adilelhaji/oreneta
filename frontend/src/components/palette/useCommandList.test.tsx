import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { messages } from '../../generated/locales'
import i18n from '../../lib/i18n'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { notificationClock } from '../../states/notifications'
import { settings$, type KanbanBoard } from '../../states/settings'
import { currentSidebarShown, sidebar$ } from '../../states/sidebar'
import { ui$ } from '../../states/ui'
import type { Account, Folder } from '../../types'
import { COMMAND_AREAS } from './paletteCommands'
import { useCommandList } from './useCommandList'

// The one list the palette and the app menu show (ADR-0068 §2, #343).

// Two IMAP accounts, as the production-entry tests have (src never imports the baseline).
const account: Account = {
  id: 'synthetic-account',
  email: 'alex@example.test',
  display_name: 'Alex · Demo',
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
  paused: true,
  conversation_html: false,
  load_remote_images: false,
}
const second: Account = {
  ...account,
  id: 'second-account',
  display_name: 'Second account',
  email: 'second@example.test',
}
const realNow = notificationClock.now
const folder = (id: string, name: string): Folder => ({ id, name, account_id: account.id, role: '', unread: 0 })
const board = { id: 'board-review', name: 'Review', columns: [{ accountId: account.id, folderId: 'INBOX' }] }
let savedBoards: KanbanBoard[] = []

beforeEach(async () => {
  await i18n.changeLanguage('en')
  ;(window as any).go = { main: { App: { Invoke: async () => ({ ok: true }) } } }
  notificationClock.now = () => new Date(2026, 9, 22, 12)
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  accounts$.set([account, second])
  ui$.selectedAccount.set(account.id)
  ui$.selectedThread.set('')
  ui$.module.set('mail')
  ui$.paletteOpen.set(false)
  ui$.aboutOpen.set(false)
  kanban$.activeBoardId.set('')
  compose$.tabs.set([])
  compose$.activeTab.set('')
  savedBoards = settings$.kanbanBoards.peek()
  settings$.kanbanBoards.set([board])
  mail$.folders.set([folder('INBOX', 'Inbox'), folder('Sent', 'Sent')])
  ui$.selectedFolder.set('INBOX')
})

afterEach(() => {
  cleanup()
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  ui$.module.set('mail')
  ui$.selectedThread.set('')
  ui$.paletteOpen.set(false)
  ui$.aboutOpen.set(false)
  kanban$.activeBoardId.set('')
  settings$.kanbanBoards.set(savedBoards)
  mail$.folders.set([])
  delete (window as any).go
})

const list = () => renderHook(useCommandList).result
const byId = (commands: ReturnType<typeof useCommandList>, id: string) => commands.find((command) => command.id === id)!

describe('the areas of the commands (#343)', () => {
  it('gives every command one of the areas, and every id once, with a conversation open too', () => {
    ui$.selectedThread.set('synthetic-account#INBOX#1')
    const commands = list().current
    expect(commands.some((command) => command.id === 'thread.archive')).toBe(true)
    expect(commands.filter((command) => !COMMAND_AREAS.includes(command.area))).toEqual([])
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length)
  })

  it('files each command where the menu shows it', () => {
    ui$.selectedThread.set('synthetic-account#INBOX#1')
    const commands = list().current
    const area = (id: string) => byId(commands, id).area
    expect(area('view.mail')).toBe('modules')
    expect(area('module.calendar')).toBe('modules')
    expect(area('compose.new')).toBe('mail')
    expect(area('filter.unread')).toBe('mail')
    expect(area('thread.archive')).toBe('conversation')
    expect(area('account.add')).toBe('accounts')
    expect(area(`account.${second.id}`)).toBe('accounts')
    expect(area('kanban.create')).toBe('boards')
    expect(area('theme.oreneta-light')).toBe('theme')
    expect(area('notifications.pause.off')).toBe('notifications')
    expect(area('settings.open')).toBe('settings')
    expect(area('settings.section.appearance')).toBe('settings')
    expect(area('shortcuts.help')).toBe('app')
    expect(area('palette.open')).toBe('app')
    expect(area('app.about')).toBe('app')
  })
})

describe("what the rail's More menu had and the palette lacked (#343)", () => {
  it('goes to each module, and says which one is on screen', () => {
    const result = list()
    const modules = result.current.filter((command) => command.area === 'modules')
    expect(modules.map((command) => command.label)).toEqual([
      'Go to: Mail',
      'Go to: Calendar',
      'Go to: People',
      'Go to: Tasks',
      'Go to: Notes',
      'Go to: Chat',
      'Go to: Attachments',
    ])
    expect(modules.filter((command) => command.active).map((command) => command.id)).toEqual(['view.mail'])
    act(() => byId(result.current, 'module.people').run())
    expect(ui$.module.peek()).toBe('people')
    expect(
      result.current.filter((command) => command.area === 'modules' && command.active).map((command) => command.id),
    ).toEqual(['module.people'])
    // "Go to: Mail" goes back to mail from another module, and closes a board.
    kanban$.activeBoardId.set('some-board')
    act(() => byId(result.current, 'view.mail').run())
    expect(ui$.module.peek()).toBe('mail')
    expect(kanban$.activeBoardId.peek()).toBe('')
  })

  it('opens the palette and About', () => {
    const result = list()
    act(() => byId(result.current, 'palette.open').run())
    expect(ui$.paletteOpen.peek()).toBe(true)
    expect(byId(result.current, 'palette.open').shortcut).toBe('palette.open')
    act(() => byId(result.current, 'app.about').run())
    expect(ui$.aboutOpen.peek()).toBe(true)
  })

  it('offers the pauses, then Resume, as the More menu does', async () => {
    const result = list()
    expect(
      result.current.filter((command) => command.area === 'notifications').map((command) => command.label),
    ).toEqual(['Do not disturb for 1 hour', 'Do not disturb until tomorrow', 'Do not disturb until turned off'])
    await act(async () => byId(result.current, 'notifications.pause.tomorrow').run())
    expect(settings$.notifications.peek().pause).toEqual({ until: new Date(2026, 9, 23, 8).getTime() })
    expect(result.current.filter((command) => command.area === 'notifications').map((command) => command.id)).toEqual([
      'notifications.resume',
    ])
    await act(async () => byId(result.current, 'notifications.resume').run())
    expect(settings$.notifications.peek().pause).toBeNull()
  })

  it('finds the new commands in English and in the interface language', async () => {
    const result = list()
    const keywords = (id: string) => byId(result.current, id).keywords ?? ''
    expect(keywords('module.calendar')).toContain('calendar')
    expect(keywords('notifications.pause.off')).toContain('do not disturb')
    await act(async () => {
      await i18n.changeLanguage('ca')
    })
    expect(byId(result.current, 'module.calendar').label).toBe('Ves a: Calendari')
    expect(keywords('module.calendar')).toContain('mòdul')
    expect(keywords('notifications.pause.off')).toContain('no molestis')
    // The palette does not list "Command palette", so nothing searches its
    // synonyms: it has none in the catalogs.
    expect(keywords('palette.open')).toBe('command palette commands')
    expect(Object.keys(messages.ca).filter((key) => key.startsWith('commands.aliases.palette'))).toEqual([])
    expect(keywords('app.about')).toContain('quant a')
    // No alias key is left for a command to read as its own words.
    expect(result.current.filter((command) => command.keywords?.includes('commands.aliases.module'))).toEqual([])
  })
})

describe('mail destinations from another module (#343)', () => {
  it('go back to mail, as the rail does, so the change is seen', () => {
    ui$.module.set('calendar')
    const result = list()
    act(() => byId(result.current, `account.${second.id}`).run())
    expect(ui$.module.peek()).toBe('mail')
    expect(ui$.selectedAccount.peek()).toBe(second.id)
    ui$.module.set('notes')
    act(() => byId(result.current, 'account.unified').run())
    expect(ui$.module.peek()).toBe('mail')
    expect(ui$.selectedAccount.peek()).toBe('unified')
  })
})

describe('mail destinations from another module, continued (#343)', () => {
  it('opens a board or a folder in mail, as the rail does', () => {
    ui$.module.set('notes')
    const result = list()
    act(() => byId(result.current, `kanban.${board.id}`).run())
    expect(ui$.module.peek()).toBe('mail')
    expect(kanban$.activeBoardId.peek()).toBe(board.id)
    kanban$.activeBoardId.set('')
    ui$.module.set('people')
    act(() => byId(result.current, 'folder.Sent').run())
    expect(ui$.module.peek()).toBe('mail')
    expect(ui$.selectedFolder.peek()).toBe('Sent')
  })

  it('creates a board at once, with the default name, and shows it in mail', () => {
    ui$.module.set('calendar')
    const result = list()
    act(() => byId(result.current, 'kanban.create').run())
    expect(ui$.module.peek()).toBe('mail')
    const boards = settings$.kanbanBoards.peek()
    expect(boards).toHaveLength(2)
    expect(boards[1].name).toBe('Kanban board')
    expect(kanban$.activeBoardId.peek()).toBe(boards[1].id)
  })

  it('checks none of them while another module is on screen', () => {
    const checked = () =>
      list()
        .current.filter((command) => command.active && /^(account|folder|kanban|view)\./.test(command.id))
        .map((command) => command.id)
    // In mail: the account and its folder, or the board over them.
    expect(checked()).toEqual(['view.mail', `account.${account.id}`, 'folder.INBOX'])
    kanban$.activeBoardId.set(board.id)
    expect(checked()).toEqual([`kanban.${board.id}`])
    ui$.selectedAccount.set('unified')
    kanban$.activeBoardId.set('')
    expect(checked()).toEqual(['view.mail', 'account.unified', 'folder.INBOX'])
    // From Calendar, with the same selection and with a board kept open, none.
    ui$.module.set('calendar')
    expect(checked()).toEqual([])
    kanban$.activeBoardId.set(board.id)
    expect(checked()).toEqual([])
    ui$.selectedAccount.set(account.id)
    expect(checked()).toEqual([])
    expect(byId(list().current, 'module.calendar').active).toBe(true)
  })
})

describe('the palette and the app menu (#343)', () => {
  it('leaves "Command palette" to the menu: the palette does not list itself', () => {
    const commands = list().current
    expect(commands.filter((command) => command.menuOnly).map((command) => command.id)).toEqual(['palette.open'])
  })
})

describe('with no account, on the setup screen (#343)', () => {
  it('offers only what needs none: the settings, the themes and the app', () => {
    accounts$.set([])
    const commands = list().current
    expect([...new Set(commands.map((command) => command.area))].sort()).toEqual(['app', 'settings', 'theme'])
    const ids = commands.map((command) => command.id)
    for (const id of [
      'settings.open',
      'settings.section.appearance',
      'theme.oreneta-light',
      'palette.open',
      'shortcuts.help',
      'design.catalogue',
      'app.about',
    ])
      expect(ids, id).toContain(id)
    for (const id of [
      'account.add',
      'compose.new',
      'mail.sync',
      'view.mail',
      'module.calendar',
      'kanban.create',
      `kanban.${board.id}`,
      'folder.INBOX',
      'notifications.pause.off',
      'filter.all',
    ])
      expect(ids, id).not.toContain(id)
    expect(commands.filter((command) => command.disabled)).toEqual([])
    // The first account brings the rest back.
    accounts$.set([account])
    const back = list().current.map((command) => command.id)
    expect(back).toContain('account.add')
    expect(back).toContain('compose.new')
  })
})

// Under the app sidebar's overlay the module is inert (ADR-0069 §2, #361): a
// command that brings something of the module forward closes the overlay
// first; one that acts outside <main>, or on data as its hotkey does, leaves
// it as it is; the sidebar's own command decides about it.
describe("the app sidebar's overlay (#361)", () => {
  afterEach(() => {
    sidebar$.set({ fits: false, strip: false, conversationOpen: false, overlay: false })
    settings$.appSidebarState.set('minimized')
    compose$.tabs.set([])
    compose$.activeTab.set('')
    ui$.filters.set([])
    ui$.settingsOpen.set(false)
    ui$.shortcutsOpen.set(false)
    ui$.catalogueOpen.set(false)
    ui$.setupOpen.set(false)
  })
  const command = (id: string) => list().current.find((entry) => entry.id === id)!
  const runOverOverlay = (id: string) => {
    ui$.module.set('mail')
    ui$.selectedFolder.set('Sent')
    sidebar$.set({ fits: false, strip: true, conversationOpen: false, overlay: true })
    const entry = command(id)
    expect(entry, id).toBeTruthy()
    act(() => entry.run())
    return sidebar$.overlay.get()
  }

  it('closes the overlay before a command that brings the module forward', () => {
    for (const id of [
      'compose.new',
      'filter.unread',
      'folder.INBOX',
      'account.unified',
      `kanban.${board.id}`,
      'module.calendar',
    ])
      expect(runOverOverlay(id), id).toBe(false)
  })

  it('leaves the overlay open for a command that acts outside the module, or on data as its hotkey does', () => {
    for (const id of [
      'settings.open',
      'theme.oreneta-light',
      'notifications.pause.off',
      'app.about',
      'palette.open',
      'shortcuts.help',
      'design.catalogue',
      'account.add',
      'search.global',
      'mail.sync',
      'mail.markAllRead',
    ])
      expect(runOverOverlay(id), id).toBe(true)
  })

  it("leaves the overlay to the sidebar's own command, which closes it and hides nothing", () => {
    sidebar$.set({ fits: false, strip: true, conversationOpen: false, overlay: true })
    const entry = command('view.sidebar')
    expect(entry.label).toBe('Hide sidebar')
    act(() => entry.run())
    expect(currentSidebarShown()).toBe('strip')
    expect(settings$.appSidebarState.get()).toBe('minimized')
  })
})

describe('thread commands under a reader or compose tab (#374)', () => {
  const THREAD_COMMANDS = [
    'reply.focus',
    'compose.replyFull',
    'thread.archive',
    'thread.star',
    'thread.unread',
    'thread.delete',
  ]
  const tab = (kind: 'reader' | 'compose' | 'thread') => ({
    id: `${kind}-1`,
    kind,
    messageId: '',
    threadId: kind === 'thread' ? 'acc:inbox:thread:1' : 'rss:feed:item-1',
    subject: '',
    from: '',
    body: '',
    viewMode: 'plain' as const,
  })
  const ids = () => list().current.map((entry) => entry.id)
  const open = (kind: 'reader' | 'compose' | 'thread' | '') => {
    ui$.selectedThread.set('acc:inbox:thread:1')
    compose$.tabs.set(kind ? [tab(kind) as never] : [])
    compose$.activeTab.set(kind ? `${kind}-1` : '')
  }
  afterEach(() => {
    compose$.tabs.set([])
    compose$.activeTab.set('')
  })

  it('offers them for the selected conversation with no tab or a thread tab', () => {
    for (const kind of ['', 'thread'] as const) {
      open(kind)
      expect(ids()).toEqual(expect.arrayContaining(THREAD_COMMANDS))
    }
  })

  it('does not offer them while a reader or compose tab covers the conversation', () => {
    for (const kind of ['reader', 'compose'] as const) {
      open(kind)
      const offered = ids()
      for (const id of THREAD_COMMANDS) expect(offered, `${kind} ${id}`).not.toContain(id)
      expect(offered).toContain('tab.close')
    }
  })
})
