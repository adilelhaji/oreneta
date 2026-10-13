import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { bookNames$, clearBookNames, useSenderName } from './contactNames'
import { settings$ } from './settings'

function Sender({ name, addr, lookUp = true }: { name: string; addr: string; lookUp?: boolean }) {
  return <span>{useSenderName(name, addr, lookUp) || addr}</span>
}

function stubBridge(names: Record<string, unknown>) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return command === 'people.names' ? { names } : {}
        },
      },
    },
  }
  return calls
}

afterEach(() => {
  cleanup()
  clearBookNames()
  delete (window as any).go
  settings$.contactNameDisplay.set('auto')
})

describe('sender names in the mail list (ADR-0052)', () => {
  it("shows the book's name, in the reader's order, only when the message gave none", async () => {
    const calls = stubBridge({ 'ada@example.com': { name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace' } })
    settings$.contactNameDisplay.set('last_comma_first')
    const view = render(
      <>
        <Sender name="" addr="Ada@Example.com" />
        <Sender name="" addr="ada@example.com" />
        <Sender name="The Countess" addr="ada@example.com" />
        <Sender name="" addr="stranger@example.com" />
      </>,
    )
    await waitFor(() => expect(view.container.textContent).toContain('Lovelace, Ada'))
    // A header's own name is never rewritten; nobody in the book keeps the address.
    expect(view.container.textContent).toContain('The Countess')
    expect(view.container.textContent).toContain('stranger@example.com')
    // One batched question for the whole screen.
    const asked = calls.filter((c) => c.command === 'people.names')
    expect(asked).toHaveLength(1)
    expect(asked[0].payload.addrs.sort()).toEqual(['ada@example.com', 'stranger@example.com'])
    expect(bookNames$['stranger@example.com'].get()).toBeNull()
  })

  it('does not ask about feeds', async () => {
    const calls = stubBridge({})
    render(<Sender name="" addr="feed@example.com" lookUp={false} />)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls).toHaveLength(0)
  })
})
