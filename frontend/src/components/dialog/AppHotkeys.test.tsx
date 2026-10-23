import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AppHotkeys } from './AppHotkeys'
import { SHORTCUT_SCHEMES, setShortcutOverrides, type ShortcutScheme } from '../../lib/shortcuts'
import { mail$ } from '../../states/mail'
import { ui$ } from '../../states/ui'
import { MenuList } from '../menu/Menu'
import { MenuItem } from '../menu/MenuItem'

// F6 and Shift+F6 as AppHotkeys dispatches them (ADR-0068 §6). happy-dom draws
// nothing, so every element counts as drawn here.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const originalCheck = Object.getOwnPropertyDescriptor(proto, 'checkVisibility')

beforeEach(() => {
  Object.defineProperty(proto, 'checkVisibility', { configurable: true, writable: true, value: () => true })
})

afterEach(() => {
  cleanup()
  setShortcutOverrides({})
  ui$.settingsOpen.set(false)
  ui$.paletteOpen.set(false)
  if (originalCheck) Object.defineProperty(proto, 'checkVisibility', originalCheck)
  else delete proto.checkVisibility
})

function shell(modal = false) {
  const view = render(
    <>
      <AppHotkeys />
      <nav data-region="folders">
        <button id="inbox">Inbox</button>
      </nav>
      <section data-region="content">
        <input id="search" />
      </section>
      {modal && (
        <section role="dialog" aria-modal="true" aria-label="Event">
          <button id="ok">OK</button>
        </section>
      )}
    </>,
  )
  const byId = (id: string) => view.container.querySelector<HTMLElement>(`#${id}`)!
  return { byId }
}

const focusedId = () => document.activeElement?.id

describe('F6 in AppHotkeys', () => {
  it('moves on from a text field without typing, and takes the key', () => {
    const { byId } = shell()
    byId('search').focus()
    expect(fireEvent.keyDown(byId('search'), { key: 'F6' })).toBe(false)
    expect(focusedId()).toBe('inbox')
    expect(fireEvent.keyDown(byId('inbox'), { key: 'F6', shiftKey: true })).toBe(false)
    expect(focusedId()).toBe('search')
  })

  it('does nothing while a modal dialog of a module is open', () => {
    const { byId } = shell(true)
    byId('ok').focus()
    fireEvent.keyDown(byId('ok'), { key: 'F6' })
    fireEvent.keyDown(byId('ok'), { key: 'F6', shiftKey: true })
    expect(focusedId()).toBe('ok')
  })

  it('does nothing while an app dialog such as Settings is open', () => {
    const { byId } = shell()
    ui$.settingsOpen.set(true)
    byId('search').focus()
    fireEvent.keyDown(byId('search'), { key: 'F6' })
    expect(focusedId()).toBe('search')
  })

  it('leaves the keys to the command palette while it is open', () => {
    const { byId } = shell()
    ui$.paletteOpen.set(true)
    byId('search').focus()
    expect(fireEvent.keyDown(byId('search'), { key: 'F6' })).toBe(true)
    expect(focusedId()).toBe('search')
  })

  it('rebound to a letter: typed in a field, a region step outside one', () => {
    setShortcutOverrides({ 'pane.next': { key: 'g' } })
    const { byId } = shell()
    byId('search').focus()
    expect(fireEvent.keyDown(byId('search'), { key: 'g' })).toBe(true)
    expect(focusedId()).toBe('search')
    byId('inbox').focus()
    fireEvent.keyDown(byId('inbox'), { key: 'g' })
    expect(focusedId()).toBe('search')
    // F6 is free again.
    fireEvent.keyDown(byId('search'), { key: 'F6' })
    expect(focusedId()).toBe('search')
  })

  it('a side-navigation slot on a function key stands down for a modal dialog of a module', () => {
    // Slot 1 is the unified inbox (shown by default), which would select it.
    const before = ui$.selectedAccount.peek()
    setShortcutOverrides({ 'view.rail1': { key: 'F8' } })
    const { byId } = shell(true)
    byId('ok').focus()
    expect(fireEvent.keyDown(byId('ok'), { key: 'F8' })).toBe(false)
    expect(ui$.selectedAccount.peek()).toBe(before)
    expect(focusedId()).toBe('ok')
  })

  it('rebound to another function key: works while typing, stands down for a modal', () => {
    setShortcutOverrides({ 'pane.next': { key: 'F8' } })
    const { byId } = shell()
    byId('search').focus()
    fireEvent.keyDown(byId('search'), { key: 'F8' })
    expect(focusedId()).toBe('inbox')
    ui$.settingsOpen.set(true)
    expect(fireEvent.keyDown(byId('inbox'), { key: 'F8' })).toBe(false)
    expect(focusedId()).toBe('inbox')
  })
})

// Keys typed in an open menu are the menu's (#348): none of them may delete,
// archive or mark the conversation selected behind it, in any shortcut scheme.
describe('keys inside an open menu', () => {
  const calls: { command: string; payload: unknown }[] = []
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const mailCalls = () => calls.filter((call) => call.command.startsWith('mail.'))

  beforeEach(() => {
    calls.length = 0
    mail$.threads.set([
      {
        id: 'acc:inbox:thread:1#101',
        account_id: 'acc',
        folder_id: 'inbox',
        thread_id: 'acc:inbox:thread:1',
        from_name: 'Sender',
        from_addr: 'sender@example.com',
        to: 'me@example.com',
        subject: 'Subject',
        preview: '',
        body: '',
        date: 1_780_000_000,
        unread: false,
        starred: false,
        has_attachments: false,
      },
    ])
    mail$.messages.set([])
    ui$.selectedAccount.set('acc')
    ui$.selectedFolder.set('inbox')
    ui$.selectedThread.set('acc:inbox:thread:1')
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: unknown) => {
            calls.push({ command, payload })
            return {}
          },
        },
      },
    }
  })

  afterEach(() => {
    delete (window as any).go
    ui$.selectedThread.set('')
  })

  function withMenu() {
    const view = render(
      <>
        <AppHotkeys />
        <div data-thread-list>
          <button id="row">Row</button>
        </div>
        <MenuList label="Test menu">
          <MenuItem label="First" />
          <MenuItem label="Second" />
        </MenuList>
      </>,
    )
    return {
      row: view.container.querySelector<HTMLElement>('#row')!,
      item: view.getByRole('menuitem', { name: 'First' }),
    }
  }

  const schemes = Object.keys(SHORTCUT_SCHEMES) as ShortcutScheme[]
  const keys = [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'e' }, { key: '#', shiftKey: true }]

  for (const scheme of schemes) {
    it(`leave the selected conversation alone: ${scheme} scheme`, async () => {
      setShortcutOverrides(SHORTCUT_SCHEMES[scheme])
      const { item } = withMenu()
      item.focus()
      for (const init of keys) fireEvent.keyDown(item, init)
      await nextTick()
      expect(mailCalls()).toEqual([])
      expect(ui$.selectedThread.peek()).toBe('acc:inbox:thread:1')
      expect(mail$.threads.peek()).toHaveLength(1)
    })
  }

  it('still delete from the conversation list (the control for the tests above)', async () => {
    setShortcutOverrides(SHORTCUT_SCHEMES.outlook)
    const { row } = withMenu()
    row.focus()
    fireEvent.keyDown(row, { key: 'Delete' })
    await nextTick()
    expect(mailCalls().map((call) => call.command)).toContain('mail.delete')
  })

  it('let Ctrl/Cmd+K through to the palette', () => {
    const { item } = withMenu()
    item.focus()
    const mac = navigator.platform.includes('Mac')
    fireEvent.keyDown(item, { key: 'k', ctrlKey: !mac, metaKey: mac })
    expect(ui$.paletteOpen.peek()).toBe(true)
  })
})
