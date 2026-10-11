import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { CategoryTabs } = await import('./CategoryTabs')
const { CategoryMenuSection } = await import('./CategoryMenuSection')
const { CategoriesGroup } = await import('./CategoriesGroup')
const { categories$, activeCategory, dropStaleFacet } = await import('../../states/categories')
const { ui$, isFilterMode } = await import('../../states/ui')
const { mail$ } = await import('../../states/mail')

const news = {
  id: 'news',
  name: 'Newsletters',
  colour: '#2056dd',
  matchMode: 'any' as const,
  conditions: [{ field: 'from' as const, op: 'endsWith' as const, value: '@news.example' }],
}
let calls: { command: string; payload: any }[] = []

function bridge(answers: Record<string, (payload: any) => unknown>) {
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          const answer = answers[command]
          if (!answer) return {}
          return answer(payload)
        },
      },
    },
  }
}

beforeEach(() => {
  calls = []
  categories$.assign({ list: [news], loaded: true, counts: null })
  ui$.selectedAccount.set('a@x')
  ui$.selectedFolder.set('INBOX')
  ui$.filters.set([])
  mail$.folders.set([])
  mail$.foldersByAccount.set({})
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('offers All, each category and Other, with counts and what they cover', async () => {
  bridge({
    'categories.counts': () => ({
      counts: [
        { category: 'news', conversations: 3, unread: 1 },
        { category: '', conversations: 2, unread: 0 },
      ],
      conversations: 5,
      messages: 9,
    }),
  })
  const view = render(<CategoryTabs />)
  await waitFor(() => expect(view.getByText('3 · 1 unread')).toBeTruthy())
  expect(view.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true')
  expect(view.getByText('Counts are of the 9 messages kept on this computer.')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: /^Other/ }))
  expect(ui$.filters.get()).toEqual(['category:none'])
  fireEvent.click(view.getByRole('button', { name: /^Newsletters/ }))
  expect(activeCategory(ui$.filters.get())).toBe('news')
  fireEvent.click(view.getByRole('button', { name: /^All/ }))
  expect(ui$.filters.get()).toEqual([])
})

it('keeps other filters when switching tabs, and is a filter the core can read', () => {
  ui$.filters.set(['unread'])
  const view = render(<CategoryTabs />)
  fireEvent.click(view.getByRole('button', { name: /^Newsletters/ }))
  expect(ui$.filters.get()).toEqual(['unread', 'category:news'])
  expect(isFilterMode('category:news')).toBe(true)
  expect(isFilterMode('category:')).toBe(false)
})

it('drops a tab nobody can see: a removed category, or one outside the inbox', () => {
  ui$.filters.set(['category:gone'])
  dropStaleFacet()
  expect(ui$.filters.get()).toEqual([])
  ui$.filters.set(['category:news'])
  dropStaleFacet(false)
  expect(ui$.filters.get()).toEqual([])
  ui$.filters.set(['category:none'])
  dropStaleFacet(true)
  expect(ui$.filters.get()).toEqual(['category:none'])
})

it('says why a conversation is where it is and moves it on request', async () => {
  bridge({
    'categories.reason': () => ({
      category: 'news',
      reason: { kind: 'conditions', held: [0] },
      sender: 'weekly@news.example',
    }),
  })
  let closed = false
  const view = render(
    <CategoryMenuSection threadId="t1" accountId="a@x" folderId="INBOX" onAct={() => (closed = true)} />,
  )
  await waitFor(() => expect(view.getByText('Category: Newsletters')).toBeTruthy())
  expect(view.getByText('Its rule matched: From ends with “@news.example”.')).toBeTruthy()
  // No "Let the rules decide" when the rules already did.
  expect(view.queryByText('Let the rules decide')).toBeNull()

  fireEvent.click(view.getByText('Move to Other'))
  expect(closed).toBe(true)
  await waitFor(() => expect(calls.some((c) => c.command === 'categories.assign')).toBe(true))
  expect(calls.find((c) => c.command === 'categories.assign')?.payload).toEqual({
    thread_id: 't1',
    category: '',
    scope: 'conversation',
  })
})

it('offers to undo a correction, for the sender it was made on', async () => {
  bridge({
    'categories.reason': () => ({
      category: '',
      reason: { kind: 'sender', addr: 'shop@store.example' },
      sender: 'shop@store.example',
    }),
  })
  const view = render(<CategoryMenuSection threadId="t2" accountId="a@x" folderId="INBOX" onAct={() => {}} />)
  await waitFor(() => expect(view.getByText('You put mail from shop@store.example here.')).toBeTruthy())
  expect(view.queryByText(/^Always put mail from/)).toBeNull()
  fireEvent.click(view.getByText('Let the rules decide'))
  await waitFor(() =>
    expect(calls.find((c) => c.command === 'categories.assign')?.payload).toEqual({
      thread_id: 't2',
      category: null,
      scope: 'sender',
    }),
  )
})

it('shows nothing outside the inbox', () => {
  bridge({})
  const view = render(<CategoryMenuSection threadId="t1" accountId="a@x" folderId="Sent" onAct={() => {}} />)
  expect(view.container.textContent).toBe('')
  expect(calls.length).toBe(0)
})

it('edits categories and refuses ones whose rules could not be predicted', async () => {
  bridge({ 'categories.save': (payload) => ({ categories: payload.categories }) })
  const view = render(<CategoriesGroup />)
  fireEvent.click(view.getByRole('button', { name: 'New category' }))
  const save = view.getByRole('button', { name: 'Save category' }) as HTMLButtonElement
  expect(view.getByText('Give it a name.')).toBeTruthy()
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'newsletters' } })
  expect(view.getByText('Another category already has that name.')).toBeTruthy()
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Bills' } })
  fireEvent.click(view.getByRole('button', { name: 'Add condition' }))
  expect(view.getByText('Each condition needs something to look for.')).toBeTruthy()
  expect(save.disabled).toBe(true)
  fireEvent.change(view.getByLabelText('Condition 1: field'), { target: { value: 'subject' } })
  fireEvent.change(view.getByLabelText('Condition 1: text'), { target: { value: 'invoice' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await waitFor(() => expect(categories$.list.get().length).toBe(2))
  expect(categories$.list.get()[1]).toMatchObject({
    name: 'Bills',
    conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
  })
})
