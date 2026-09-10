import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Message } from '../types'
import { accounts$ } from './accounts'
import { kanban$ } from './kanban'
import { getActiveThread, loadMoreThreads, loadThreads, mail$ } from './mail'
import { settings$, type ListSort } from './settings'
import { ui$ } from './ui'

const row = (id: string): Message => ({
  id,
  thread_id: id,
  account_id: 'acc',
  folder_id: 'INBOX',
  from_name: id,
  from_addr: `${id}@example.test`,
  to: '',
  subject: id,
  preview: '',
  body: '',
  date: 100,
  unread: false,
  starred: false,
  has_attachments: false,
})
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const sorts: ListSort[] = ['date', 'sender', 'subject'].flatMap((key) =>
  ['asc', 'desc'].map((dir) => ({ key, dir }) as ListSort),
)
type Request = { before_cursor?: string; sort?: string; refresh?: boolean; limit?: number }
let requests: Request[]
let respond: (request: Request) => unknown
let previousGo: unknown

beforeEach(() => {
  previousGo = (window as any).go
  accounts$.set([])
  kanban$.activeBoardId.set('')
  settings$.listSort.set({ key: 'date', dir: 'desc' })
  ui$.selectedAccount.set('acc')
  ui$.selectedFolder.set('INBOX')
  ui$.selectedThread.set('')
  ui$.query.set('')
  ui$.filters.set([])
  mail$.threads.set([])
  mail$.threadsCursor.set('')
  mail$.threadsPagination.set('')
  mail$.retainedThread.set(null)
  mail$.threadsViewKey.set('')
  mail$.threadsLoadingMore.set(false)
  requests = []
  respond = () => ({ threads: [row('a')], next_cursor: 'page-1' })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, request: Request) => {
          if (command !== 'mail.threadList') return {}
          requests.push(structuredClone(request))
          return respond(request)
        },
      },
    },
  }
})

afterEach(() => {
  ;(window as any).go = previousGo
  settings$.listSort.set({ key: 'date', dir: 'desc' })
  ui$.query.set('')
  ui$.filters.set([])
  mail$.threadsCursor.set('')
  mail$.threadsPagination.set('')
  mail$.retainedThread.set(null)
  mail$.threadsLoadedKey.set('')
  mail$.threadsViewKey.set('')
})

describe('mailbox pagination view contract', () => {
  for (const account of ['acc', 'unified']) {
    it(`keeps conversation order and replaces background traversal (${account})`, async () => {
      ui$.selectedAccount.set(account)
      settings$.listSort.set({ key: 'sender', dir: 'asc' })
      respond = () => ({
        threads: [{ ...row('a'), date: 1 }],
        next_cursor: 'conv1:first',
        pagination: 'conversation-v1',
      })
      await loadThreads()
      respond = () => ({
        threads: [{ ...row('b'), date: 999 }],
        next_cursor: 'conv1:tail',
        pagination: 'conversation-v1',
      })
      await loadMoreThreads()
      expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['a', 'b'])
      respond = () => ({ threads: [row('fresh'), row('b')], next_cursor: 'conv1:fresh', pagination: 'conversation-v1' })
      await loadThreads(false)
      expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['fresh', 'b'])
      expect(mail$.threadsCursor.get()).toBe('conv1:fresh')
    })
  }

  it('requests loaded depth and honors the conversation marker on terminal pages', async () => {
    respond = () => ({
      threads: Array.from({ length: 60 }, (_, i) => row(`r${i}`)),
      next_cursor: 'conv1:tail',
      pagination: 'conversation-v1',
    })
    await loadThreads()
    respond = () => ({ threads: [], pagination: 'conversation-v1' })
    await loadThreads(false)
    expect(requests.at(-1)?.limit).toBe(60)
    expect(mail$.threads.get()).toEqual([])
    expect(mail$.threadsCursor.get()).toBe('')
    expect(mail$.threadsPagination.get()).toBe('conversation-v1')
  })

  it('deduplicates repeated identities on the first page without changing backend order', async () => {
    respond = () => ({
      threads: [row('first'), row('duplicate'), row('duplicate'), row('last')],
      next_cursor: 'conv1:tail',
      pagination: 'conversation-v1',
    })
    await loadThreads()
    expect(mail$.threads.get().map((thread) => thread.thread_id)).toEqual(['first', 'duplicate', 'last'])
    expect(mail$.threadsCursor.get()).toBe('conv1:tail')
  })

  it('keeps a loaded conversation prefix ordered after a same-view refresh with new arrivals', async () => {
    respond = () => ({
      threads: Array.from({ length: 60 }, (_, index) => row(`old-${index}`)),
      next_cursor: 'conv1:old-tail',
      pagination: 'conversation-v1',
    })
    await loadThreads()
    respond = () => ({
      threads: [row('new-arrival'), ...Array.from({ length: 59 }, (_, index) => row(`old-${index}`))],
      next_cursor: 'conv1:new-tail',
      pagination: 'conversation-v1',
    })
    await loadThreads(false)
    expect(mail$.threads.get().map((thread) => thread.thread_id)).toEqual([
      'new-arrival',
      ...Array.from({ length: 59 }, (_, index) => `old-${index}`),
    ])
    expect(mail$.threadsCursor.get()).toBe('conv1:new-tail')
    expect(new Set(mail$.threads.get().map((thread) => thread.thread_id)).size).toBe(60)
  })

  it('retains the open reader independently of filtered sorted rows', async () => {
    ui$.filters.set(['unread'])
    respond = () => ({ threads: [row('open'), row('other')], pagination: 'conversation-v1' })
    await loadThreads()
    ui$.selectedThread.set('open')
    respond = () => ({ threads: [row('other')], pagination: 'conversation-v1' })
    await loadThreads(false)
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['other'])
    expect(ui$.selectedThread.get()).toBe('open')
    expect(getActiveThread()?.thread_id).toBe('open')
    await loadThreads(false)
    expect(getActiveThread()?.thread_id).toBe('open')
    ui$.selectedFolder.set('Sent')
    await loadThreads()
    expect(mail$.retainedThread.get()).toBeNull()
    expect(getActiveThread()).toBeNull()
  })

  it('reloads an incompatible conversation cursor without grafting a first page', async () => {
    respond = () => ({ threads: [row('old')], next_cursor: 'conv1:old', pagination: 'conversation-v1' })
    await loadThreads()
    respond = (request) => {
      if (request.before_cursor) throw new Error('conversation cursor invalid for this view; reload the first page')
      return { threads: [row('fresh')], next_cursor: 'conv1:fresh', pagination: 'conversation-v1' }
    }
    await loadMoreThreads()
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['fresh'])
    expect(mail$.threadsCursor.get()).toBe('conv1:fresh')
    expect(requests.at(-1)?.before_cursor).toBeUndefined()
    expect(mail$.threadsLoadingMore.get()).toBe(false)
  })

  it('keeps conversation retry state when a same-view refresh fails', async () => {
    respond = () => ({ threads: [row('old')], next_cursor: 'conv1:old', pagination: 'conversation-v1' })
    await loadThreads()
    respond = () => {
      throw new Error('offline')
    }
    await loadThreads(false)
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['old'])
    expect(mail$.threadsCursor.get()).toBe('conv1:old')
    expect(mail$.threadsPagination.get()).toBe('conversation-v1')
  })

  it('does not reload another view when a stale cursor error arrives', async () => {
    respond = () => ({ threads: [row('old')], next_cursor: 'conv1:old', pagination: 'conversation-v1' })
    await loadThreads()
    let reject!: (error: Error) => void
    respond = () =>
      new Promise((_, fail) => {
        reject = fail
      })
    const loading = loadMoreThreads()
    ui$.selectedFolder.set('Sent')
    reject(new Error('conversation cursor invalid for this view; reload the first page'))
    await loading
    expect(requests).toHaveLength(2)
    expect(mail$.threadsCursor.get()).toBe('conv1:old')
    expect(mail$.threadsLoadingMore.get()).toBe(false)
  })

  for (const account of ['acc', 'unified']) {
    it.each(sorts)(`forwards %o on every page (${account})`, async (sort) => {
      ui$.selectedAccount.set(account)
      settings$.listSort.set(sort)
      await loadThreads()
      respond = () => ({ threads: [row('b')], next_cursor: '' })
      await loadMoreThreads()
      const wireSort = sort.dir === 'asc' ? `${sort.key}:asc` : sort.key
      expect(requests.map((r) => r.sort)).toEqual([wireSort, wireSort])
      expect(requests[1].before_cursor).toBe('page-1')
      expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['a', 'b'])
    })
  }

  const changes = {
    sort: () => settings$.listSort.set({ key: 'subject', dir: 'asc' }),
    folder: () => ui$.selectedFolder.set('Sent'),
    account: () => ui$.selectedAccount.set('other'),
    query: () => ui$.query.set('new'),
    filter: () => ui$.filters.set(['unread']),
  }
  for (const [name, change] of Object.entries(changes)) {
    it(`does not reuse an old cursor after ${name} changes before reload`, async () => {
      await loadThreads()
      requests.length = 0
      change()
      await loadMoreThreads()
      expect(requests).toEqual([])
    })

    it(`rejects an in-flight page when ${name} changes before reload`, async () => {
      await loadThreads()
      const old = deferred()
      respond = () => old.promise
      const loading = loadMoreThreads()
      change()
      old.resolve({ threads: [row('stale')], next_cursor: 'stale-cursor', folder_unread: 999 })
      await loading
      expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['a'])
      expect(mail$.threadsCursor.get()).toBe('page-1')
      expect(mail$.threadsLoadingMore.get()).toBe(false)
    })
  }

  it('keeps backend single-account order and removes duplicate identities within and across pages', async () => {
    settings$.listSort.set({ key: 'sender', dir: 'asc' })
    await loadThreads()
    respond = () => ({ threads: [row('a'), row('b'), row('b'), row('c')], next_cursor: '' })
    await loadMoreThreads()
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['a', 'b', 'c'])
  })

  it('does not merge previous-view rows or cursor on a background load during navigation', async () => {
    await loadThreads()
    ui$.selectedFolder.set('Sent')
    respond = () => ({ threads: [row('new')], next_cursor: 'new-cursor' })
    await loadThreads(false)
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['new'])
    expect(mail$.threadsCursor.get()).toBe('new-cursor')
  })

  it('does not advance an old cache-to-live search after the sort changes', async () => {
    ui$.query.set('proposal')
    const cached = deferred()
    respond = () => cached.promise
    const loading = loadThreads()
    settings$.listSort.set({ key: 'subject', dir: 'asc' })
    cached.resolve({ threads: [], next_cursor: '' })
    await loading
    expect(requests).toHaveLength(1)
    expect(requests[0].refresh).toBe(false)
  })

  it('keeps the cursor and clears the loading flag when pagination fails, permitting retry', async () => {
    await loadThreads()
    respond = () => {
      throw new Error('offline')
    }
    await expect(loadMoreThreads()).rejects.toThrow('offline')
    expect(mail$.threadsLoadingMore.get()).toBe(false)
    expect(mail$.threadsCursor.get()).toBe('page-1')
    respond = () => ({ threads: [row('b')], next_cursor: '' })
    await loadMoreThreads()
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['a', 'b'])
  })

  it('discards an old page after a same-view foreground refresh even when the cursor is unchanged', async () => {
    await loadThreads()
    const old = deferred()
    respond = () => old.promise
    const loading = loadMoreThreads()
    respond = () => ({ threads: [row('fresh')], next_cursor: 'page-1' })
    await loadThreads()
    old.resolve({ threads: [row('stale')], next_cursor: 'old-page-2' })
    await loading
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['fresh'])
    expect(mail$.threadsCursor.get()).toBe('page-1')
  })

  it('preserves loaded later pages and their cursor on a same-view background refresh', async () => {
    await loadThreads()
    respond = () => ({ threads: [row('b')], next_cursor: 'page-2' })
    await loadMoreThreads()
    respond = () => ({ threads: [row('new'), row('a')], next_cursor: 'page-1' })
    await loadThreads(false)
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['new', 'a', 'b'])
    expect(mail$.threadsCursor.get()).toBe('page-2')
  })

  it('does not retain the selected row from a previous folder in a filtered load', async () => {
    ui$.filters.set(['unread'])
    await loadThreads()
    ui$.selectedThread.set('a')
    ui$.selectedFolder.set('Sent')
    respond = () => ({ threads: [row('new')], next_cursor: '' })
    await loadThreads()
    expect(mail$.threads.get().map((r) => r.thread_id)).toEqual(['new'])
  })
})
