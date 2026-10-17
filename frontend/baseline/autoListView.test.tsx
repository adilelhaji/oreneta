import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { createFixture } from './fixtures'
import { accounts$ } from '../src/states/accounts'
import { compose$ } from '../src/states/compose'
import { mail$, threadListViewKey } from '../src/states/mail'
import { settings$, type ListDensity, type ListView } from '../src/states/settings'
import { clearBulkSelection, ui$ } from '../src/states/ui'
import { ThreadList } from '../src/components/threads/ThreadList'

// The automatic list view (#283): two-line rows with date groups while the
// list is narrow, the table once it is wide. The width here is the remembered
// one, which is what the list follows until it has been measured; the browser
// checks in e2e/startup.e2e.ts follow the drawn width.

let previousGo: unknown
let previousView: ListView
let previousDensity: ListDensity
const fixture = createFixture()

beforeEach(() => {
  previousGo = (window as any).go
  previousView = settings$.listView.peek()
  previousDensity = settings$.listDensity.peek()
  ;(window as any).go = { main: { App: { Invoke: async () => ({}) } } }
  accounts$.set([structuredClone(fixture.account)])
  settings$.listView.set('auto')
  settings$.listDensity.set('compact')
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
  mail$.threadsPagination.set('conversation-v1')
  mail$.threadsLoadedKey.set(threadListViewKey(fixture.account.id, 'INBOX', '', '', 'date'))
  mail$.threadsCursor.set('')
})

afterEach(() => {
  cleanup()
  clearBulkSelection()
  settings$.listView.set(previousView)
  settings$.listDensity.set(previousDensity)
  ;(window as any).go = previousGo
})

/** The row line that holds an element: a direct child of the row's column of lines. */
function lineOf(element: Element): Element | null {
  let node: Element | null = element
  while (node?.parentElement && !node.parentElement.classList.contains('flex-col')) node = node.parentElement
  return node?.parentElement ? node : null
}

describe('automatic list view (#283)', () => {
  it('draws two-line rows under date groups in a narrow list', () => {
    const view = render(<ThreadList width={360} />)
    const list = view.container.querySelector('[data-thread-list]')!
    expect(list.getAttribute('data-list-view')).toBe('cards')
    expect(view.queryByRole('table')).toBeNull()
    expect(view.container.querySelectorAll('[data-date-group]').length).toBeGreaterThan(0)

    const senders = view.container.querySelectorAll('[data-thread-sender]')
    const subjects = view.container.querySelectorAll('[data-thread-subject]')
    expect(senders).toHaveLength(fixture.threads.length)
    expect(subjects).toHaveLength(fixture.threads.length)
    // Compact keeps two lines here: the sender (with the date) and the subject
    // (with the preview) each have a line of their own.
    for (let i = 0; i < senders.length; i++) {
      expect(lineOf(senders[i])).not.toBeNull()
      expect(lineOf(subjects[i])).not.toBeNull()
      expect(lineOf(senders[i])).not.toBe(lineOf(subjects[i]))
    }
    expect(view.getByText('Budget review: Q4 planning')).toBeTruthy()
  })

  it('draws the table once the list is wide enough for its columns', () => {
    const view = render(<ThreadList width={560} />)
    expect(view.container.querySelector('[data-thread-list]')!.getAttribute('data-list-view')).toBe('table')
    expect(view.getByRole('table')).toBeTruthy()
    expect(view.getAllByRole('row')).toHaveLength(fixture.threads.length + 1)
  })

  it('keeps an explicit table in a narrow list', () => {
    settings$.listView.set('table')
    const view = render(<ThreadList width={280} />)
    expect(view.getByRole('table')).toBeTruthy()
  })

  it('keeps explicit compact cards on one line in a wide list', () => {
    settings$.listView.set('cards')
    const view = render(<ThreadList width={560} />)
    expect(view.queryByRole('table')).toBeNull()
    const sender = view.container.querySelector('[data-thread-sender]')!
    const subject = view.container.querySelector('[data-thread-subject]')!
    expect(lineOf(sender)).toBe(lineOf(subject))
  })
})
