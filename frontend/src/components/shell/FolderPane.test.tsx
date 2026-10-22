import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { FolderPane } from './FolderPane'
import { hydrateSettings, settings$ } from '../../states/settings'

let writes: { key: string; value: unknown }[] = []
// Another file may have left its own measuring function on HTMLElement's
// prototype; it is put back exactly as it was found.
const ownRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
const realRect = HTMLElement.prototype.getBoundingClientRect

beforeEach(() => {
  writes = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') writes.push(payload)
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  if (ownRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', ownRect)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
  settings$.folderPaneWidth.set(260)
})

const written = (key: string) => writes.filter((w) => w.key === key).map((w) => w.value)

// happy-dom lays nothing out, so the pane says where it is: its start edge,
// the one that stays put (60 px in after the rail in left to right, 1380 px
// in right to left), for the pointer; and a drawn width of 0, which is "not
// measured" as without layout, unless the test says what is drawn.
function drawPane({ rtl = false, drawn = 0 }: { rtl?: boolean; drawn?: number } = {}) {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.hasAttribute('data-folder-pane')) return realRect.call(this)
    const set = settings$.folderPaneWidth.peek()
    const left = rtl ? 1380 - set : 60
    return { left, right: left + set, width: drawn, top: 0, bottom: 900, height: 900, x: left, y: 0 } as DOMRect
  }
}

function Pane({ rtl = false, footer, modules }: { rtl?: boolean; footer?: string; modules?: string }) {
  return (
    <div style={{ direction: rtl ? 'rtl' : 'ltr' }}>
      <FolderPane title="Accounts and folders" footer={footer} modules={modules}>
        <button type="button">Inbox</button>
      </FolderPane>
    </div>
  )
}

const separator = (screen: ReturnType<typeof render>) => screen.getByRole('separator', { name: 'Resize folder pane' })
const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Accounts and folders' })

describe('common folder pane (ADR-0068 §4, #317)', () => {
  it('is the "folders" region: a navigation named by its title row, around what the module puts in it', () => {
    const screen = render(<Pane />)
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    const title = screen.getByRole('heading', { level: 2, name: 'Accounts and folders' })
    // A title that does not fit ends in "…" and is whole in its tooltip.
    expect(title.getAttribute('title')).toBe('Accounts and folders')
    expect(title.className.split(' ')).toContain('truncate')
    expect(nav.contains(screen.getByRole('button', { name: 'Inbox' }))).toBe(true)
    // Not drawn at 1024 px and below, where the list's folder switcher stands in.
    expect(nav.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'min-[1025px]:flex']))
  })

  it('keeps an optional footer, and the place for the module switcher at the very foot', () => {
    const plain = render(<Pane />)
    expect(pane(plain).textContent).toBe('Accounts and foldersInbox')
    cleanup()
    const screen = render(<Pane footer="Month" modules="Modules" />)
    const text = pane(screen).textContent ?? ''
    expect(text).toBe('Accounts and foldersInboxMonthModules')
  })

  it('draws its width in px, 260 by default and never under 200, and follows the stored width', () => {
    const screen = render(<Pane />)
    const nav = pane(screen)
    expect(nav.style.width).toBe('260px')
    expect(nav.style.minWidth).toBe('200px')
    // It gives way before the list when the row runs short.
    expect(Number(nav.style.flexShrink)).toBeGreaterThan(1)
    act(() => settings$.folderPaneWidth.set(320))
    expect(nav.style.width).toBe('320px')
  })

  it('resizes from the keyboard within 200–400 px and saves each width', () => {
    const screen = render(<Pane />)
    const handle = separator(screen)
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
    expect(handle.getAttribute('aria-valuemin')).toBe('200')
    expect(handle.getAttribute('aria-valuemax')).toBe('400')
    // On the pane's end edge: moving the separator towards the end widens it.
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('276')
    expect(pane(screen).style.width).toBe('276px')
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(handle.getAttribute('aria-valuenow')).toBe('212')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    fireEvent.keyDown(handle, { key: 'End' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('400')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    expect(written('folder_pane_width')).toEqual([276, 212, 200, 400, 200])
  })

  it('follows the pointer while it is held, clamped, and saves the width', () => {
    drawPane()
    const screen = render(<Pane />)
    const handle = separator(screen)
    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400 })
    expect(handle.getAttribute('aria-valuenow')).toBe('340')
    expect(pane(screen).style.width).toBe('340px')
    fireEvent.pointerMove(window, { clientX: 900 })
    expect(handle.getAttribute('aria-valuenow')).toBe('400')
    fireEvent.pointerMove(window, { clientX: 100 })
    expect(handle.getAttribute('aria-valuenow')).toBe('200')
    fireEvent.pointerMove(window, { clientX: 360 })
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.pointerUp(window)
    fireEvent.pointerMove(window, { clientX: 400 })
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    expect(written('folder_pane_width')).toEqual([340, 400, 200, 300])
  })

  it('follows the reading direction: in right to left it grows towards the left', () => {
    drawPane({ rtl: true })
    const screen = render(<Pane rtl />)
    const handle = separator(screen)
    expect(getComputedStyle(handle).direction).toBe('rtl')
    // Its end edge is on the left, at 1120 px.
    fireEvent.pointerDown(handle, { button: 0, clientX: 1120, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 1060 })
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
    fireEvent.pointerUp(window)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('336')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(handle.getAttribute('aria-valuenow')).toBe('272')
    expect(settings$.folderPaneWidth.get()).toBe(272)
  })

  it('states the width it is drawn at where the folders give way, not the one remembered', () => {
    settings$.folderPaneWidth.set(260)
    drawPane({ drawn: 230 })
    const screen = render(<Pane />)
    const handle = separator(screen)
    expect(handle.getAttribute('aria-valuenow')).toBe('230')
    expect(handle.getAttribute('aria-valuemax')).toBe('230')
    // Narrowing it from there is narrowing what is on screen.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(settings$.folderPaneWidth.get()).toBe(214)
  })

  it('restores the stored width at boot, clamped to 200–400 px', () => {
    hydrateSettings({ folder_pane_width: 333 })
    const screen = render(<Pane />)
    expect(separator(screen).getAttribute('aria-valuenow')).toBe('333')
    expect(pane(screen).style.width).toBe('333px')
    act(() => hydrateSettings({ folder_pane_width: 5000 }))
    expect(separator(screen).getAttribute('aria-valuenow')).toBe('400')
    act(() => hydrateSettings({ folder_pane_width: 12 }))
    expect(separator(screen).getAttribute('aria-valuenow')).toBe('200')
    expect(pane(screen).style.width).toBe('200px')
    // Restoring is not resizing: nothing is written back.
    expect(written('folder_pane_width')).toEqual([])
  })
})
