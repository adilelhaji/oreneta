import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ThreadTable } from './components/threads/ThreadTable'
import { ThreadList } from './components/threads/ThreadList'
import { accounts$ } from './states/accounts'
import { kanban$ } from './states/kanban'
import { mail$, threadListViewKey } from './states/mail'
import { settings$ } from './states/settings'
import { ui$ } from './states/ui'
import { t } from './lib/i18n'
import type { Account } from './types'
import { useThreadListLoader } from './useThreadListLoader'

const fixture = {
  account: {
    id: 'synthetic-account',
    email: 'alex@example.test',
    display_name: 'Alex',
    provider: 'imap',
    paused: true,
  } as Account,
}
const calls: Record<string, unknown>[] = []
let previousGo: unknown
let previousListView: 'cards' | 'table'
let reply: (payload: Record<string, unknown>) => unknown

function MailboxControls() {
  useThreadListLoader()
  return (
    <ThreadTable
      threads={[]}
      accounts={[]}
      selectedThread=""
      showAccount={false}
      onSelect={() => {}}
      onContextMenu={() => {}}
    />
  )
}

beforeEach(() => {
  previousGo = (window as any).go
  previousListView = settings$.listView.peek()
  accounts$.set([structuredClone(fixture.account)])
  kanban$.activeBoardId.set('')
  settings$.listSort.set({ key: 'date', dir: 'desc' })
  settings$.listView.set('table')
  ui$.selectedAccount.set(fixture.account.id)
  ui$.selectedFolder.set('INBOX')
  ui$.selectedThread.set('')
  ui$.query.set('')
  ui$.filters.set([])
  mail$.threads.set([])
  mail$.threadsViewKey.set('')
  mail$.threadsLoadedKey.set('')
  mail$.threadsCursor.set('')
  calls.length = 0
  reply = () => ({ threads: [], next_cursor: '' })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: Record<string, unknown>) => {
          if (command !== 'mail.threadList') return {}
          calls.push(structuredClone(payload))
          return reply(payload)
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  ;(window as any).go = previousGo
  settings$.listSort.set({ key: 'date', dir: 'desc' })
  settings$.listView.set(previousListView)
  ui$.query.set('')
  kanban$.activeBoardId.set('')
})

describe('mailbox sort wiring', () => {
  it('loads the first page when a real table header changes sort or direction', async () => {
    const view = render(<MailboxControls />)
    await waitFor(() => expect(calls).toHaveLength(1))
    fireEvent.click(view.getByRole('button', { name: t('table.sender') }))
    await waitFor(() => expect(calls).toHaveLength(2))
    fireEvent.click(view.getByRole('button', { name: t('table.sender') }))
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.map((c) => c.sort)).toEqual(['date', 'sender:asc', 'sender'])
    expect(calls.every((c) => c.before_cursor === undefined && c.refresh === true)).toBe(true)
    expect(view.getAllByRole('columnheader')[0].getAttribute('aria-sort')).toBe('descending')
  })

  it('cancels superseded search timers and reloads only the latest sort', async () => {
    ui$.query.set('proposal')
    const view = render(<MailboxControls />)
    fireEvent.click(view.getByRole('button', { name: t('table.subject') }))
    fireEvent.click(view.getByRole('button', { name: t('table.sender') }))
    expect(calls).toEqual([])
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls.map((c) => [c.sort, c.refresh])).toEqual([
      ['sender:asc', false],
      ['sender:asc', true],
    ])
  })

  it('cancels a pending search on unmount', async () => {
    ui$.query.set('proposal')
    const view = render(<MailboxControls />)
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(calls).toEqual([])
  })

  it('defers sort changes while a board is open, then reloads the current order', async () => {
    kanban$.activeBoardId.set('board')
    render(<MailboxControls />)
    await act(async () => {
      settings$.listSort.set({ key: 'subject', dir: 'asc' })
    })
    expect(calls).toEqual([])
    await act(async () => {
      kanban$.activeBoardId.set('')
    })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].sort).toBe('subject:asc')
  })

  it('matches the completed full view key in the empty-list UI', async () => {
    const key = threadListViewKey(fixture.account.id, 'INBOX', '', 'all', 'date')
    mail$.threadsLoadedKey.set(key)
    const view = render(<ThreadList />)
    expect(view.queryByText(t('empty.loadingThreads'))).toBeNull()
    // Changing sort invalidates the empty state before any loader runs.
    await act(async () => {
      settings$.listSort.set({ key: 'subject', dir: 'asc' })
    })
    expect(view.queryByText(t('empty.loadingThreads'))).not.toBeNull()
    await act(async () => {
      mail$.threadsLoadedKey.set(threadListViewKey(fixture.account.id, 'INBOX', '', 'all', 'subject:asc'))
    })
    expect(view.queryByText(t('empty.loadingThreads'))).toBeNull()
  })
})
