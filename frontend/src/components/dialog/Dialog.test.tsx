import { afterEach, describe, expect, it, mock } from 'bun:test'
import { StrictMode, useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Dialog } from './Dialog'

afterEach(cleanup)

function Example({ removeOpener = false, disableOpener = false }: { removeOpener?: boolean; disableOpener?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {!(open && removeOpener) && (
        <button disabled={open && disableOpener} onClick={() => setOpen(true)}>
          Open example
        </button>
      )}
      {open && (
        <Dialog title="Example" onClose={() => setOpen(false)}>
          <input aria-label="Value" />
        </Dialog>
      )}
    </>
  )
}

describe('shared dialog focus lifecycle', () => {
  it('retains focus through StrictMode effect replay and restores after a real close', async () => {
    const view = render(<StrictMode><Example /></StrictMode>)
    const opener = view.getByRole('button', { name: 'Open example' })
    opener.focus()
    fireEvent.click(opener)
    await Promise.resolve()
    expect(document.activeElement).toBe(view.getByRole('dialog'))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('focuses the dialog on open and returns to its opener after Escape', async () => {
    const view = render(<Example />)
    const opener = view.getByRole('button', { name: 'Open example' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(view.getByRole('dialog'))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('preserves explicit child autofocus and gives duplicate titles distinct names', () => {
    const view = render(
      <>
        <Dialog title="Same" onClose={() => {}}>
          <input aria-label="First" />
        </Dialog>
        <Dialog title="Same" onClose={() => {}}>
          <input autoFocus aria-label="Second" />
        </Dialog>
      </>,
    )
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Second' }))
    const ids = view.getAllByRole('dialog').map((dialog) => dialog.getAttribute('aria-labelledby'))
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => !!document.getElementById(id!))).toBe(true)
  })

  it('does not try to focus a removed opener', async () => {
    const view = render(<Example removeOpener />)
    const opener = view.getByRole('button', { name: 'Open example' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    await Promise.resolve()
    expect(opener.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(opener)
  })

  it('does not steal focus that another surface already owns on unmount', async () => {
    const view = render(<Example />)
    const opener = view.getByRole('button', { name: 'Open example' })
    opener.focus()
    fireEvent.click(opener)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    view.unmount()
    await Promise.resolve()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('does not restore focus to an opener disabled during the operation', async () => {
    const view = render(<Example />)
    const opener = view.getByRole('button', { name: 'Open example' }) as HTMLButtonElement
    opener.focus()
    fireEvent.click(opener)
    opener.disabled = true
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    await Promise.resolve()
    expect(document.activeElement).not.toBe(opener)
  })

  it('consumes Escape in a busy child rather than closing its parent', async () => {
    const parentClose = mock(() => {})
    const childClose = mock(() => {})
    function Nested() {
      const [child, setChild] = useState(false)
      return (
        <Dialog title="Parent" onClose={parentClose}>
          <button onClick={() => setChild(true)}>Open child</button>
          {child && (
            <Dialog title="Child" layer="raised" closeDisabled onClose={childClose}>
              Working
            </Dialog>
          )}
        </Dialog>
      )
    }
    const view = render(<Nested />)
    fireEvent.click(view.getByRole('button', { name: 'Open child' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(parentClose).not.toHaveBeenCalled()
    expect(childClose).not.toHaveBeenCalled()
    expect(view.getAllByRole('dialog')).toHaveLength(2)
  })
})
