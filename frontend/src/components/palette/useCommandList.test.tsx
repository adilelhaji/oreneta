import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { notificationClock } from '../../states/notifications'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'
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
})

afterEach(() => {
  cleanup()
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  ui$.module.set('mail')
  ui$.selectedThread.set('')
  ui$.paletteOpen.set(false)
  ui$.aboutOpen.set(false)
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
    expect(keywords('palette.open')).toContain('paleta')
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
