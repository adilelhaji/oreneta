import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { FloatingContextMenu } from './FloatingContextMenu'
import { MenuGroup, MenuList, MenuSeparator } from './Menu'
import { MenuItem } from './MenuItem'
import { SubmenuItem } from './SubmenuItem'

afterEach(() => {
  cleanup()
  document.documentElement.dir = ''
})

// Focus goes back in a microtask after the menu is gone.
const settle = () => act(async () => await Promise.resolve())

const active = () => document.activeElement as HTMLElement | null

function ContextMenuHarness({
  onAction = () => {},
  onParentKey = () => {},
}: {
  onAction?: (name: string) => void
  onParentKey?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div onKeyDown={onParentKey}>
      <button type="button">Before</button>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      <button type="button">Next</button>
      {open && (
        <FloatingContextMenu x={0} y={0} label="Thread" onClose={() => setOpen(false)} className="fixed">
          <MenuItem label="Archive" onClick={() => onAction('archive')} />
          <MenuItem label="Delete" disabled onClick={() => onAction('delete')} />
          <MenuSeparator />
          <MenuItem label="Apply label" onClick={() => onAction('label')} />
          <SubmenuItem label="Move to">
            <MenuItem label="Inbox" onClick={() => onAction('inbox')} />
            <MenuItem label="Sent" onClick={() => onAction('sent')} />
          </SubmenuItem>
          <MenuItem label="After" onClick={() => onAction('after')} />
        </FloatingContextMenu>
      )}
    </div>
  )
}

function openHarness(props: Parameters<typeof ContextMenuHarness>[0] = {}) {
  const view = render(<ContextMenuHarness {...props} />)
  const opener = view.getByRole('button', { name: 'Opener' })
  opener.focus()
  fireEvent.click(opener)
  return { view, opener }
}

const key = (target: Element, name: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(target, { key: name, ...init })

describe('a context menu (#289)', () => {
  it('is a named menu of items and separators, and takes focus when it opens', () => {
    const { view } = openHarness()
    const menu = view.getByRole('menu', { name: 'Thread' })
    expect(menu.getAttribute('aria-orientation')).toBe('vertical')
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Archive',
      'Delete',
      'Apply label',
      'Move to',
      'After',
    ])
    expect(view.getByRole('separator')).toBeTruthy()
    expect(active()?.textContent).toBe('Archive')
    for (const item of view.getAllByRole('menuitem')) expect(item.tabIndex).toBe(-1)
  })

  it('moves with the arrows, wrapping, and with Home and End, through disabled items too', () => {
    const { view } = openHarness()
    const menu = view.getByRole('menu', { name: 'Thread' })
    key(menu.querySelector('[role="menuitem"]')!, 'ArrowDown')
    expect(active()?.textContent).toBe('Delete')
    expect(active()?.getAttribute('aria-disabled')).toBe('true')
    key(active()!, 'ArrowUp')
    key(active()!, 'ArrowUp')
    expect(active()?.textContent).toBe('After')
    key(active()!, 'ArrowDown')
    expect(active()?.textContent).toBe('Archive')
    key(active()!, 'End')
    expect(active()?.textContent).toBe('After')
    key(active()!, 'Home')
    expect(active()?.textContent).toBe('Archive')
  })

  it('jumps by typeahead and cycles on a repeated letter', () => {
    const { view } = openHarness()
    const first = view.getByRole('menuitem', { name: 'Archive' })
    key(first, 'a')
    expect(active()?.textContent).toBe('Apply label')
    key(active()!, 'a')
    expect(active()?.textContent).toBe('After')
    key(active()!, 'm')
    // "aam" matches nothing: focus stays.
    expect(active()?.textContent).toBe('After')
  })

  it('keeps its keys to itself: an enclosing handler and the app shortcuts never see them', () => {
    const parent = mock(() => {})
    const { view } = openHarness({ onParentKey: parent })
    key(view.getByRole('menuitem', { name: 'Archive' }), 'ArrowDown')
    key(active()!, 'e')
    key(active()!, 'Enter')
    expect(parent).not.toHaveBeenCalled()
  })

  it('does nothing on a disabled item', () => {
    const actions: string[] = []
    const { view } = openHarness({ onAction: (name) => actions.push(name) })
    fireEvent.click(view.getByRole('menuitem', { name: 'Delete' }))
    expect(actions).toEqual([])
    fireEvent.click(view.getByRole('menuitem', { name: 'Archive' }))
    expect(actions).toEqual(['archive'])
  })

  it('closes on Escape and gives focus back to the opener', async () => {
    const { view, opener } = openHarness()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()
    await settle()
    expect(active()).toBe(opener)
  })

  it('closes on Tab and moves on from the opener, not from where the menu was', async () => {
    const { view } = openHarness()
    key(view.getByRole('menuitem', { name: 'Archive' }), 'Tab')
    expect(view.queryByRole('menu')).toBeNull()
    await settle()
    expect(active()?.textContent).toBe('Next')
  })

  it('goes back from the opener on Shift+Tab', async () => {
    const { view } = openHarness()
    key(view.getByRole('menuitem', { name: 'Archive' }), 'Tab', { shiftKey: true })
    await settle()
    expect(active()?.textContent).toBe('Before')
  })

  it('finds icon-only items by their accessible name when typing', () => {
    const view = render(
      <MenuList label="Colour" autoFocus>
        <MenuItem label="First" />
        <button type="button" role="menuitemradio" aria-checked={false} tabIndex={-1} aria-label="Teal" />
      </MenuList>,
    )
    key(view.getByRole('menuitem', { name: 'First' }), 't')
    expect(active()?.getAttribute('aria-label')).toBe('Teal')
  })

  it('does not take focus back from a surface that took it meanwhile', async () => {
    const { view } = openHarness()
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    elsewhere.focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()
    expect(active()).toBe(elsewhere)
    elsewhere.remove()
  })
})

describe('a submenu (#289)', () => {
  const submenuOf = (trigger: HTMLElement) => document.getElementById(trigger.getAttribute('aria-controls') ?? '')

  it('opens with the arrow towards the end of the line, focuses its first item, and closes back', async () => {
    const { view } = openHarness()
    const trigger = view.getByRole('menuitem', { name: 'Move to' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    key(trigger, 'ArrowRight')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const submenu = submenuOf(trigger)!
    expect(submenu.getAttribute('role')).toBe('menu')
    expect(submenu.getAttribute('aria-labelledby')).toBe(trigger.id)
    expect(active()?.textContent).toBe('Inbox')
    key(active()!, 'ArrowDown')
    expect(active()?.textContent).toBe('Sent')
    key(active()!, 'ArrowLeft')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await settle()
    expect(active()).toBe(trigger)
    // The outer menu stayed open.
    expect(view.getByRole('menu', { name: 'Thread' })).toBeTruthy()
  })

  it('mirrors the arrows in right to left', async () => {
    document.documentElement.dir = 'rtl'
    const { view } = openHarness()
    const trigger = view.getByRole('menuitem', { name: 'Move to' })
    trigger.focus()
    key(trigger, 'ArrowRight')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    key(trigger, 'ArrowLeft')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(active()?.textContent).toBe('Inbox')
    key(active()!, 'ArrowRight')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await settle()
    expect(active()).toBe(trigger)
  })

  it('opens with Enter, and Escape closes only the submenu', async () => {
    const { view } = openHarness()
    const trigger = view.getByRole('menuitem', { name: 'Move to' })
    trigger.focus()
    // A click with no pointer behind it, as Enter and Space produce.
    fireEvent.click(trigger, { detail: 0 })
    expect(active()?.textContent).toBe('Inbox')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(submenuOf(trigger)).toBeNull()
    expect(view.getByRole('menu', { name: 'Thread' })).toBeTruthy()
    await settle()
    expect(active()).toBe(trigger)
  })

  it('opens on hover without moving focus', () => {
    const { view } = openHarness()
    const trigger = view.getByRole('menuitem', { name: 'Move to' })
    fireEvent.mouseEnter(trigger.parentElement!)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(active()?.textContent).toBe('Archive')
    // Already open: the arrow goes into it.
    trigger.focus()
    key(trigger, 'ArrowRight')
    expect(active()?.textContent).toBe('Inbox')
  })

  it('closes every level on Tab from inside it, moving on from the opener', async () => {
    const actions: string[] = []
    const { view, opener } = openHarness({ onAction: (name) => actions.push(name) })
    const trigger = view.getByRole('menuitem', { name: 'Move to' })
    trigger.focus()
    key(trigger, 'ArrowRight')
    // Tab from inside the submenu closes every level.
    key(active()!, 'Tab')
    expect(view.queryByRole('menu')).toBeNull()
    await settle()
    expect(opener.nextElementSibling).toBe(active())
    expect(active()?.textContent).toBe('Next')
    expect(actions).toEqual([])
  })
})

describe('a submenu that reports whether it is open (#289)', () => {
  it('says it closed when the menu around it goes away while it is open', () => {
    const seen: boolean[] = []
    const view = render(
      <FloatingContextMenu x={0} y={0} label="Thread" className="fixed">
        <SubmenuItem label="Copy to" onOpenChange={(open) => seen.push(open)}>
          <MenuItem label="Inbox" />
        </SubmenuItem>
      </FloatingContextMenu>,
    )
    const trigger = view.getByRole('menuitem', { name: 'Copy to' })
    fireEvent.mouseEnter(trigger.parentElement!)
    expect(seen.at(-1)).toBe(true)
    view.unmount()
    expect(seen.at(-1)).toBe(false)
  })
})

describe('menu lists, groups and checkable items (#289)', () => {
  it('names groups by their caption and describes them', () => {
    const view = render(
      <MenuList label="Filters">
        <MenuGroup label="Show" description="Which conversations">
          <MenuItem role="menuitemradio" checked label="All" />
          <MenuItem role="menuitemradio" checked={false} label="Unread" />
        </MenuGroup>
        <MenuItem role="menuitemcheckbox" checked={false} label="Work" />
      </MenuList>,
    )
    const group = view.getByRole('group', { name: 'Show' })
    expect(group.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('Which conversations')
    expect(view.getByRole('menuitemradio', { name: 'All' }).getAttribute('aria-checked')).toBe('true')
    expect(view.getByRole('menuitemradio', { name: 'Unread' }).getAttribute('aria-checked')).toBe('false')
    expect(view.getByRole('menuitemcheckbox', { name: 'Work' }).getAttribute('aria-checked')).toBe('false')
    // The caption names the group; it is not an item of the menu.
    expect(view.queryByRole('menuitem', { name: 'Show' })).toBeNull()
  })

  it('leaves focus alone unless it is a popup that takes it', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    render(
      <MenuList label="Static">
        <MenuItem label="One" />
      </MenuList>,
    )
    expect(active()).toBe(outside)
    render(
      <MenuList label="Popup" autoFocus>
        <MenuItem label="Two" />
      </MenuList>,
    )
    expect(active()?.textContent).toBe('Two')
    outside.remove()
  })

  it('moves a horizontal menu with the horizontal arrows', () => {
    const view = render(
      <MenuList label="Colour" orientation="horizontal" autoFocus>
        <MenuItem role="menuitemradio" checked label="Red" />
        <MenuItem role="menuitemradio" checked={false} label="Blue" />
      </MenuList>,
    )
    expect(view.getByRole('menu', { name: 'Colour' }).getAttribute('aria-orientation')).toBe('horizontal')
    key(active()!, 'ArrowRight')
    expect(active()?.textContent).toBe('Blue')
    key(active()!, 'ArrowDown')
    expect(active()?.textContent).toBe('Blue')
    key(active()!, 'ArrowLeft')
    expect(active()?.textContent).toBe('Red')
  })

  it('skips items hidden by a responsive class', () => {
    const view = render(
      <MenuList label="Board" autoFocus>
        <div role="none" style={{ display: 'none' }}>
          <MenuItem label="Hidden" />
        </div>
        <MenuItem label="Shown" />
        <MenuItem label="Also shown" />
      </MenuList>,
    )
    expect(active()?.textContent).toBe('Shown')
    key(active()!, 'ArrowUp')
    expect(active()?.textContent).toBe('Also shown')
    expect(view.getAllByRole('menuitem', { hidden: true }).length).toBe(3)
  })
})
