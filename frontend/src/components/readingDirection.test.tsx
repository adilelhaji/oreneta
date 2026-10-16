import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { AccountProviderGrid } from './dialog/AccountProviderGrid'
import { Gallery } from './chat/Gallery'
import { FloatingContextMenu } from './menu/FloatingContextMenu'
import type { SetupMode } from '../states/ui'
import { handleGroupArrowKeys } from '../lib/direction'

// Keyboard and placement in the reading direction (#226, ADR-0061). The
// document direction is what the interface language sets on <html>.
afterEach(() => {
  cleanup()
  document.documentElement.dir = ''
})

function ProviderTabs({ dir }: { dir: 'ltr' | 'rtl' }) {
  const [mode, setMode] = useState<SetupMode>('custom')
  return (
    <div dir={dir}>
      <AccountProviderGrid mode={mode} setMode={setMode} isSetup />
    </div>
  )
}

const selectedTab = (view: ReturnType<typeof render>) =>
  view.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent

describe('tabs follow the reading direction', () => {
  it('moves to the next tab with the right arrow in left to right', () => {
    const view = render(<ProviderTabs dir="ltr" />)
    const current = view.getByRole('tab', { name: /IMAP/ })
    current.focus()
    fireEvent.keyDown(current, { key: 'ArrowRight' })
    expect(selectedTab(view)).toContain('Exchange')
    expect(document.activeElement?.textContent).toContain('Exchange')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(selectedTab(view)).toContain('IMAP')
  })

  it('moves to the next tab with the left arrow in right to left', () => {
    const view = render(<ProviderTabs dir="rtl" />)
    const current = view.getByRole('tab', { name: /IMAP/ })
    current.focus()
    fireEvent.keyDown(current, { key: 'ArrowLeft' })
    expect(selectedTab(view)).toContain('Exchange')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(selectedTab(view)).toContain('OAuth')
    expect(document.activeElement?.textContent).toContain('OAuth')
  })

  it('goes to the first and last tab with Home and End, and leaves the vertical arrows alone', () => {
    const view = render(<ProviderTabs dir="rtl" />)
    const current = view.getByRole('tab', { name: /IMAP/ })
    current.focus()
    fireEvent.keyDown(current, { key: 'End' })
    expect(selectedTab(view)).toContain('RSS')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(selectedTab(view)).toContain('Microsoft Graph')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(selectedTab(view)).toContain('Microsoft Graph')
  })
})

describe('a group reached with focus on none of its items', () => {
  it('moves focus to an item without picking it', () => {
    const picked: string[] = []
    const view = render(
      <div dir="rtl">
        <div
          role="radiogroup"
          tabIndex={-1}
          aria-label="Colour"
          onKeyDown={(event) => handleGroupArrowKeys(event, '[role="radio"]')}
        >
          {['red', 'green', 'blue'].map((colour) => (
            <button key={colour} type="button" role="radio" aria-checked={false} onClick={() => picked.push(colour)}>
              {colour}
            </button>
          ))}
        </div>
      </div>,
    )
    const group = view.getByRole('radiogroup')
    group.focus()
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(document.activeElement?.textContent).toBe('red')
    expect(picked).toEqual([])
    // From there the arrows pick, in reading order.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(picked).toEqual(['green'])
  })
})

describe('the image viewer pages in the reading direction', () => {
  const items = ['a', 'b', 'c'].map((name) => ({ src: `/${name}.png`, filename: `${name}.png` }))

  function Viewer() {
    const [index, setIndex] = useState(1)
    return (
      <>
        <output data-testid="index">{index}</output>
        <Gallery items={items} index={index} onIndexChange={setIndex} onClose={() => undefined} />
      </>
    )
  }

  it('goes forward with the right arrow in left to right', () => {
    const view = render(<Viewer />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(view.getByTestId('index').textContent).toBe('2')
  })

  it('goes forward with the left arrow in right to left', () => {
    document.documentElement.dir = 'rtl'
    const view = render(<Viewer />)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(view.getByTestId('index').textContent).toBe('2')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(view.getByTestId('index').textContent).toBe('0')
  })
})

describe('a context menu opens towards the end of the line', () => {
  // happy-dom lays nothing out: give the menu a size to place.
  function withMenuSize<T>(run: () => T): T {
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON() {} } as DOMRect
    }
    try {
      return run()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
    }
  }

  const leftOf = (x: number) =>
    withMenuSize(() => {
      const view = render(
        <FloatingContextMenu x={x} y={50} className="fixed">
          <button type="button">Item</button>
        </FloatingContextMenu>,
      )
      const menu = view.getByRole('button', { name: 'Item' }).parentElement!
      return parseFloat(menu.style.left)
    })

  it('extends rightwards from the pointer in left to right', () => {
    expect(leftOf(400)).toBe(400)
  })

  it('extends leftwards from the pointer in right to left', () => {
    document.documentElement.dir = 'rtl'
    expect(leftOf(400)).toBe(200)
  })
})
