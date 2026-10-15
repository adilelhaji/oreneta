import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { PaneResizer } from './PaneResizer'

afterEach(cleanup)

function Harness({ edge, initial = 340 }: { edge: 'start' | 'end'; initial?: number }) {
  const [size, setSize] = useState(initial)
  return (
    <PaneResizer
      label="Resize pane"
      value={size}
      limits={{ min: 280, max: 560 }}
      edge={edge}
      // A pane whose far edge is at x = 1000 (start) or whose near edge is at x = 0 (end).
      sizeAt={(x) => (edge === 'start' ? 1000 - x : x)}
      onResize={setSize}
    />
  )
}

const separator = (screen: ReturnType<typeof render>) => screen.getByRole('separator', { name: 'Resize pane' })

describe('pane resizer (#212)', () => {
  it('is a focusable vertical separator that states its size and limits', () => {
    const screen = render(<Harness edge="end" />)
    const handle = separator(screen)
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-valuenow')).toBe('340')
    expect(handle.getAttribute('aria-valuemin')).toBe('280')
    expect(handle.getAttribute('aria-valuemax')).toBe('560')
    expect(handle.tabIndex).toBe(0)
  })

  it('resizes with the arrow keys, Shift for larger steps, and clamps to the limits', () => {
    const screen = render(<Harness edge="end" />)
    const handle = separator(screen)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('356')
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(handle.getAttribute('aria-valuenow')).toBe('292')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe('560')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(handle.getAttribute('aria-valuenow')).toBe('560')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
  })

  it('grows a pane on its start edge with ArrowLeft', () => {
    const screen = render(<Harness edge="start" />)
    const handle = separator(screen)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('356')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(handle.getAttribute('aria-valuenow')).toBe('292')
  })

  it('leaves other keys alone', () => {
    const screen = render(<Harness edge="end" />)
    const handle = separator(screen)
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    handle.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(handle.getAttribute('aria-valuenow')).toBe('340')
  })

  it('follows the pointer while it is held, clamped, and stops when it is released', () => {
    const screen = render(<Harness edge="start" />)
    const handle = separator(screen)
    fireEvent.pointerDown(handle, { button: 0, clientX: 660 })
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.pointerMove(window, { clientX: 600 })
    expect(handle.getAttribute('aria-valuenow')).toBe('400')
    fireEvent.pointerMove(window, { clientX: 100 })
    expect(handle.getAttribute('aria-valuenow')).toBe('560')
    fireEvent.pointerMove(window, { clientX: 900 })
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
    fireEvent.pointerUp(window)
    expect(document.body.style.cursor).toBe('')
    fireEvent.pointerMove(window, { clientX: 600 })
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
  })

  it('ignores a secondary button', () => {
    const screen = render(<Harness edge="start" />)
    const handle = separator(screen)
    fireEvent.pointerDown(handle, { button: 2, clientX: 660 })
    fireEvent.pointerMove(window, { clientX: 600 })
    expect(handle.getAttribute('aria-valuenow')).toBe('340')
  })
})
