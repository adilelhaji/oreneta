import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AppHotkeys } from './AppHotkeys'
import { setShortcutOverrides } from '../../lib/shortcuts'
import { ui$ } from '../../states/ui'

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
