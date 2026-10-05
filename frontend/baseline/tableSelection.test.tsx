import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createFixture } from './fixtures'
import { accounts$ } from '../src/states/accounts'
import { compose$ } from '../src/states/compose'
import { mail$, threadListViewKey } from '../src/states/mail'
import { settings$ } from '../src/states/settings'
import { clearBulkSelection, selectedBulkItems, ui$ } from '../src/states/ui'
import { ThreadList } from '../src/components/threads/ThreadList'

let previousGo: unknown
let previousView: 'cards' | 'table'
const fixture = createFixture()

beforeEach(() => {
  previousGo = (window as any).go
  previousView = settings$.listView.peek()
  ;(window as any).go = { main: { App: { Invoke: async () => ({}) } } }
  accounts$.set([structuredClone(fixture.account)])
  settings$.listView.set('table')
  settings$.listSort.set({ key: 'date', dir: 'desc' })
  ui$.selectedAccount.set(fixture.account.id)
  ui$.selectedFolder.set('INBOX')
  ui$.selectedThread.set('')
  ui$.query.set('')
  ui$.filters.set([])
  clearBulkSelection()
  compose$.activeTab.set('')
  compose$.tabs.set([])
  mail$.folders.set(structuredClone(fixture.folders))
  mail$.foldersByAccount.set({ [fixture.account.id]: structuredClone(fixture.folders) })
  mail$.threads.set(structuredClone(fixture.threads))
  mail$.threadsLoadedKey.set(threadListViewKey(fixture.account.id, 'INBOX', '', '', 'date'))
  mail$.threadsCursor.set('')
})

afterEach(() => {
  cleanup()
  clearBulkSelection()
  settings$.listView.set(previousView)
  compose$.activeTab.set('')
  compose$.tabs.set([])
  ;(window as any).go = previousGo
})

describe('default table reviewed selection', () => {
  it('selects without opening and keeps the reviewed set when new rows arrive', () => {
    const view = render(<ThreadList />)
    fireEvent.click(view.getByRole('checkbox', { name: /Pilot checklist/ }))
    expect(ui$.selectedThread.peek()).toBe('')
    expect(selectedBulkItems().map((item) => item.threadId)).toEqual(['thread-1'])
    act(() =>
      mail$.threads.set([
        { ...fixture.threads[0], id: 'arrival', thread_id: 'arrival', subject: 'New arrival' },
        ...fixture.threads,
      ]),
    )
    expect((view.getByRole('checkbox', { name: /New arrival/ }) as HTMLInputElement).checked).toBe(false)
    expect(selectedBulkItems().map((item) => item.threadId)).toEqual(['thread-1'])
    fireEvent.click(view.getByRole('checkbox', { name: /Pilot checklist/ }))
    expect(selectedBulkItems()).toEqual([])
  })

  it('can open independently while selecting and leaves the active compose tab', () => {
    const view = render(<ThreadList />)
    fireEvent.click(view.getByRole('checkbox', { name: /Pilot checklist/ }))
    act(() => compose$.activeTab.set('synthetic-compose-tab'))
    fireEvent.click(view.getByRole('button', { name: /Budget review/ }))
    expect(selectedBulkItems()).toEqual([])
    expect(ui$.selectedThread.peek()).toBe('thread-3')
    expect(compose$.activeTab.peek()).toBe('')
    expect(view.getByRole('button', { name: /Budget review/ }).getAttribute('aria-current')).toBe('true')
    expect(view.container.querySelector('button input')).toBeNull()
    expect(view.getAllByRole('row')).toHaveLength(fixture.threads.length + 1)
  })

  it('preserves modifier and range selection without opening a row', () => {
    const view = render(<ThreadList />)
    fireEvent.click(view.getByRole('button', { name: /Pilot checklist/ }), { ctrlKey: true })
    fireEvent.click(view.getByRole('button', { name: /Budget review/ }), { shiftKey: true })
    expect(selectedBulkItems().map((item) => item.threadId)).toEqual(['thread-1', 'thread-2', 'thread-3'])
    expect(ui$.selectedThread.peek()).toBe('')
    fireEvent.click(view.getByRole('button', { name: /Budget review/ }), { ctrlKey: true })
    expect(selectedBulkItems().map((item) => item.threadId)).toEqual(['thread-1', 'thread-2'])
  })

  it('suppresses individual context actions while a reviewed set is active', () => {
    const view = render(<ThreadList />)
    fireEvent.click(view.getByRole('checkbox', { name: /Pilot checklist/ }))
    fireEvent.click(view.getByRole('checkbox', { name: /Budget review/ }))
    const uncancelled = fireEvent.contextMenu(view.getByRole('button', { name: /Meeting notes/ }))
    expect(uncancelled).toBe(false)
    expect(view.queryByRole('button', { name: 'Open in new tab' })).toBeNull()
    expect(selectedBulkItems().map((item) => item.threadId)).toEqual(['thread-1', 'thread-3'])
    expect(ui$.selectedThread.peek()).toBe('')
  })

  it('opens a standalone draft through the existing draft reader', async () => {
    const draft = { ...fixture.threads[0], folder_id: 'Drafts', body: 'Preserve this draft' }
    mail$.threads.set([draft])
    const calls: string[] = []
    ;(window as any).go.main.App.Invoke = async (command: string) => {
      calls.push(command)
      if (command === 'mail.threadRead') return { messages: [draft] }
      return {}
    }
    const view = render(<ThreadList />)
    fireEvent.click(view.getByRole('button', { name: /Pilot checklist/ }))
    await waitFor(() => expect(compose$.tabs.peek().some((tab) => tab.kind === 'compose')).toBe(true))
    expect(calls).toContain('mail.threadRead')
    expect(calls).not.toContain('mail.send')
  })

  it('opens a starred feed directly in its existing reader path', () => {
    const feed = {
      ...fixture.threads[0],
      account_id: 'rss-demo',
      feed_url: 'https://example.test/feed',
      body: 'Feed content',
    }
    accounts$.set([{ ...fixture.account, id: 'rss-demo', provider: 'rss', auth_type: 'rss' }])
    ui$.selectedAccount.set('unified')
    ui$.selectedFolder.set('starred')
    mail$.threads.set([feed])
    const view = render(<ThreadList />)
    fireEvent.click(view.getByRole('button', { name: /Pilot checklist/ }))
    expect(compose$.tabs.peek().at(-1)?.kind).toBe('reader')
    expect(compose$.tabs.peek().at(-1)?.body).toBe('Feed content')
    expect(compose$.activeTab.peek()).toBe(feed.id)
  })
})
