import { afterEach, describe, expect, it } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ModalCard } from './ModalCard'

afterEach(cleanup)

function Example({ autoFocusInside = false }: { autoFocusInside?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open event</button>
      {open && (
        <ModalCard label="Team meeting">
          <input aria-label="Title" autoFocus={autoFocusInside} />
          <button onClick={() => setOpen(false)}>Close</button>
        </ModalCard>
      )}
    </>
  )
}

describe('a modal card', () => {
  it('is a named modal dialog', () => {
    const view = render(<Example />)
    fireEvent.click(view.getByRole('button', { name: 'Open event' }))
    const dialog = view.getByRole('dialog', { name: 'Team meeting' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('takes the focus from the event that opened it, and gives it back on close', async () => {
    const view = render(<Example />)
    const opener = view.getByRole('button', { name: 'Open event' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(view.getByRole('dialog'))
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('leaves the focus on a control inside that took it itself', () => {
    const view = render(<Example autoFocusInside />)
    const opener = view.getByRole('button', { name: 'Open event' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Title' }))
  })
})
