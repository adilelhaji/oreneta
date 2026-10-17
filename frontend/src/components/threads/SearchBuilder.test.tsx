import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { SearchBuilder } = await import('./SearchBuilder')
const { SavedSearchMenu } = await import('./SavedSearchMenu')
const { ui$ } = await import('../../states/ui')
const { settings$, sanitizeSavedSearches } = await import('../../states/settings')
const { dayToSeconds, secondsToDay, EMPTY_QUERY } = await import('../../states/searchBuilder')
const { folderPrefs$ } = await import('../../states/folderPrefs')
const { mail$ } = await import('../../states/mail')

function bridge(answer: (command: string, payload: any) => unknown) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), answer(command, payload)),
      },
    },
  }
  return calls
}

beforeEach(() => {
  ui$.query.set('')
  ui$.selectedAccount.set('a@x')
  ui$.selectedFolder.set('INBOX')
  settings$.savedSearches.set([])
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('opens on what was typed, as the core read it, and writes the edit back through the core', async () => {
  const calls = bridge((command, payload) =>
    command === 'search.parse'
      ? {
          query: {
            text: 'budget',
            from: ['Ann Example'],
            to: [],
            subject: [],
            flags: ['unread'],
            label: null,
            after: 1767225600,
            before: null,
          },
        }
      : { text: 'composed by the core' },
  )
  const view = render(<SearchBuilder query='budget from:"Ann Example" is:unread after:2026-01-01' />)
  fireEvent.click(view.getByRole('button', { name: 'Search options' }))
  await waitFor(() => expect((view.getByLabelText('From') as HTMLInputElement).value).toBe('Ann Example'))
  expect((view.getByLabelText('Words') as HTMLInputElement).value).toBe('budget')
  expect((view.getByLabelText('Read or unread') as HTMLSelectElement).value).toBe('unread')
  expect((view.getByLabelText('From day') as HTMLInputElement).value).toBe('2026-01-01')

  fireEvent.change(view.getByLabelText('To'), { target: { value: 'bo@x, cy@y' } })
  fireEvent.click(view.getByRole('checkbox', { name: 'Has attachments' }))
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Search' })))
  const composed = calls.find((c) => c.command === 'search.compose')!.payload.query
  expect(composed.to).toEqual(['bo@x', 'cy@y'])
  expect(composed.flags).toEqual(['unread', 'hasAttachment'])
  expect(ui$.query.get()).toBe('composed by the core')
})

it('days are the core’s days', () => {
  expect(dayToSeconds('2026-01-01')).toBe(1767225600)
  expect(secondsToDay(1767225600)).toBe('2026-01-01')
  expect(dayToSeconds('01/02/2026')).toBeNull()
})

it('a saved search remembers where it was saved and goes back there', () => {
  ui$.query.set('from:ann')
  const view = render(<SavedSearchMenu query="from:ann" />)
  fireEvent.click(view.getByRole('button', { name: 'Save this search' }))
  expect(settings$.savedSearches.get()[0]).toMatchObject({ query: 'from:ann', account: 'a@x', folder: 'INBOX' })
  cleanup()

  ui$.selectedAccount.set('b@z')
  ui$.selectedFolder.set('Archive')
  ui$.query.set('')
  const again = render(<SavedSearchMenu query="" />)
  fireEvent.click(again.getByRole('button', { name: 'Saved searches' }))
  fireEvent.click(again.getByRole('button', { name: /from:ann/ }))
  expect(ui$.selectedAccount.get()).toBe('a@x')
  expect(ui$.query.get()).toBe('from:ann')
})

it('a search saved before scopes existed is kept and applies where it is opened', () => {
  expect(sanitizeSavedSearches([{ id: '1', name: 'n', query: 'q' }])).toEqual([{ id: '1', name: 'n', query: 'q' }])
  expect(sanitizeSavedSearches([{ id: '1', name: 'n', query: 'q', account: 'a', folder: 'f' }])).toEqual([
    { id: '1', name: 'n', query: 'q', account: 'a', folder: 'f' },
  ])
})

it('says where the search looks and whether hidden folders are in it (#273)', async () => {
  bridge(() => ({ query: EMPTY_QUERY }))
  const folders = [
    { id: 'INBOX', account_id: 'a@x', name: 'Inbox', role: 'inbox', unread: 0, delimiter: '/' },
    { id: 'Lists', account_id: 'a@x', name: 'Lists', role: 'folder', unread: 0, delimiter: '/' },
  ]
  mail$.foldersByAccount['a@x'].set(folders)
  folderPrefs$.hidden.set([{ accountId: 'a@x', folderId: 'Lists' }])
  const scopeOf = async () => {
    const view = render(<SearchBuilder query="" />)
    fireEvent.click(view.getByRole('button', { name: 'Search options' }))
    const text = view.getByText(/^Searches /).textContent
    await act(async () => {})
    cleanup()
    return text
  }
  try {
    expect(await scopeOf()).toBe('Searches only “Inbox”. Hidden folders are not included.')
    ui$.selectedFolder.set('Lists')
    expect(await scopeOf()).toBe('Searches only “Lists”, a hidden folder.')
    ui$.selectedAccount.set('unified')
    ui$.selectedFolder.set('sent')
    expect(await scopeOf()).toBe('Searches “Unified sent”: that folder in each account in view, even where it is hidden.')
    ui$.selectedFolder.set('inbox')
    expect(await scopeOf()).toBe('Searches “Unified inbox”: the inbox of each account in view.')
    ui$.selectedFolder.set('starred')
    expect(await scopeOf()).toBe(
      'Searches starred messages in every folder of every account, hidden folders included.',
    )
  } finally {
    folderPrefs$.hidden.set([])
    mail$.foldersByAccount['a@x'].delete()
  }
})
