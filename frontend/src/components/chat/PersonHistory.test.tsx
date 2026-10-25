import { afterEach, expect, it, mock } from 'bun:test'
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { PersonHistory, type PersonContext } from './PersonHistory'

const context = (account: string): PersonContext => ({
  address: 'ana@x.test',
  conversations: [
    {
      thread_id: `${account}#INBOX#t1`,
      folder: 'INBOX',
      subject: `Budget (${account})`,
      date: 1_760_000_000,
      from_them: true,
    },
  ],
  events: [{ calendar_id: 'cal', event_id: 'e1', subject: 'Review', start: 1_790_000_000, end: 1_790_003_600 }],
  files: [
    { filename: 'quote.pdf', size: 90_000, thread_id: `${account}#INBOX#t2`, folder: 'INBOX', date: 1_760_000_000 },
  ],
  coverage: { messages: 120, downloaded: 80 },
})

afterEach(() => {
  cleanup()
  delete (window as any).go
})

it("shows a person's history in this account, each item opening where it came from", async () => {
  ;(window as any).go = { main: { App: { Invoke: async (_: string, p: any) => context(p.account) } } }
  const onOpenConversation = mock(() => {})
  const onOpenEvent = mock(() => {})
  const screen = render(
    <PersonHistory
      accountId="work"
      address="ana@x.test"
      onOpenConversation={onOpenConversation}
      onOpenEvent={onOpenEvent}
    />,
  )
  await waitFor(() => expect(screen.getByText('Budget (work)')).toBeTruthy())
  fireEvent.click(screen.getByText('Budget (work)'))
  expect(onOpenConversation).toHaveBeenCalledWith('work#INBOX#t1', 'INBOX')
  fireEvent.click(screen.getByText('quote.pdf'))
  expect(onOpenConversation).toHaveBeenCalledWith('work#INBOX#t2', 'INBOX')
  fireEvent.click(screen.getByText('Review'))
  expect(onOpenEvent).toHaveBeenCalledWith(1_790_000_000)
  expect(screen.getByText(/80 of 120 messages are downloaded, so older history may be missing/)).toBeTruthy()
})

it('a slow answer for the account left behind never shows in the new one', async () => {
  const pending: Record<string, (v: PersonContext) => void> = {}
  ;(window as any).go = {
    main: { App: { Invoke: (_: string, p: any) => new Promise((resolve) => (pending[p.account] = resolve)) } },
  }
  const props = { address: 'ana@x.test', onOpenConversation: () => {}, onOpenEvent: () => {} }
  const screen = render(<PersonHistory accountId="work" {...props} />)
  screen.rerender(<PersonHistory accountId="home" {...props} />)
  await act(async () => pending.home(context('home')))
  await act(async () => pending.work(context('work')))
  expect(screen.getByText('Budget (home)')).toBeTruthy()
  expect(screen.queryByText('Budget (work)')).toBeNull()
})

// The sidebar's Persona panel moves from one person or account to another
// under the same history (#363): the drawing for the new one never holds the
// previous one's answer, not even before the new question goes out.
it("never draws the previous account's history for the new one", async () => {
  ;(window as any).go = { main: { App: { Invoke: async (_: string, p: any) => context(p.account) } } }
  const drawn: string[] = []
  function Probe({ accountId }: { accountId: string }) {
    const box = useRef<HTMLDivElement | null>(null)
    // After each drawing of this account's history, before its effects run.
    useLayoutEffect(() => {
      drawn.push(`${accountId}: ${box.current?.textContent?.includes('Budget (work)') ? 'work' : '-'}`)
    })
    return (
      <div ref={box}>
        <PersonHistory
          accountId={accountId}
          address="ana@x.test"
          onOpenConversation={() => {}}
          onOpenEvent={() => {}}
        />
      </div>
    )
  }
  const screen = render(<Probe accountId="work" />)
  await waitFor(() => expect(screen.getByText('Budget (work)')).toBeTruthy())
  drawn.length = 0
  screen.rerender(<Probe accountId="home" />)
  expect(drawn[0]).toBe('home: -')
  await waitFor(() => expect(screen.getByText('Budget (home)')).toBeTruthy())
  expect(drawn.every((entry) => entry === 'home: -')).toBe(true)
})
