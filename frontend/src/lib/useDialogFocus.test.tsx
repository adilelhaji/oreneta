import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useDialogFocus } from './useDialogFocus'

// The focus lifecycle of a modal dialog: it takes the focus when it opens and
// gives it back to its opener when it closes (#343).

afterEach(cleanup)

// Focus goes back in a microtask after the dialog is gone.
const settle = () => act(async () => await Promise.resolve())

function Dialog() {
  const ref = useRef<HTMLDivElement | null>(null)
  useDialogFocus(ref)
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
      <button type="button">Restore</button>
    </div>
  )
}

function Screen() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Elsewhere
      </button>
      {open && <Dialog />}
      <button type="button" data-close onClick={() => setOpen(false)} />
    </>
  )
}

// Identity as a boolean: a failed toBe between two elements hangs Bun's diff.
const focused = (element: Element) => document.activeElement === element

describe('useDialogFocus', () => {
  it('gives the focus back to the opener when the focus was in the dialog', async () => {
    const view = render(<Screen />)
    const opener = view.getByRole('button', { name: 'Open' })
    opener.focus()
    act(() => opener.click())
    const restore = view.getByRole('button', { name: 'Restore' })
    restore.focus()
    act(() => (view.container.querySelector('[data-close]') as HTMLElement).click())
    await settle()
    expect(focused(opener)).toBe(true)
  })

  it('gives it back too when the focus fell to the body while the dialog was open', async () => {
    const view = render(<Screen />)
    const opener = view.getByRole('button', { name: 'Open' })
    opener.focus()
    act(() => opener.click())
    // «Restore» disables itself while it works, and the browser drops the
    // focus to the body.
    view.getByRole('button', { name: 'Restore' }).focus()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement === document.body).toBe(true)
    act(() => (view.container.querySelector('[data-close]') as HTMLElement).click())
    await settle()
    expect(focused(opener)).toBe(true)
  })

  it('leaves the focus where another control took it', async () => {
    const view = render(<Screen />)
    const opener = view.getByRole('button', { name: 'Open' })
    const elsewhere = view.getByRole('button', { name: 'Elsewhere' })
    opener.focus()
    act(() => opener.click())
    elsewhere.focus()
    act(() => elsewhere.click())
    await settle()
    expect(focused(elsewhere)).toBe(true)
  })
})
