import { afterEach, beforeEach, expect, it, mock } from 'bun:test'

mock.module('../boot', () => ({ boot: async () => {} }))

const { bulkLabelSelected, labelCoverage, labels$ } = await import('./labels')
const { mail$ } = await import('./mail')
const { ui$ } = await import('./ui')

let assigned: { thread_id: string; label_ids: string[] }[] = []
const item = (threadId: string) =>
  ({ key: threadId, threadId, accountId: 'a@x', folderId: 'INBOX', kind: 'mail' }) as any

beforeEach(() => {
  assigned = []
  labels$.labels.set([
    { id: 'work', name: 'Work', colour: '#2056dd', inBar: false, links: {} },
    { id: 'home', name: 'Home', colour: '#0f9d58', inBar: false, links: {} },
  ])
  mail$.threads.set([
    { thread_id: 't1', labels: ['home'] },
    { thread_id: 't2', labels: ['work'] },
    { thread_id: 't3', labels: [] },
  ] as any)
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command !== 'labels.assign') return {}
          assigned.push(payload)
          return { labels: payload.label_ids }
        },
      },
    },
  }
})
afterEach(() => {
  delete (window as any).go
})

it('says whether a label is on all, some or none of a selection', () => {
  expect(labelCoverage(['t1', 't2'], 'work')).toBe('some')
  expect(labelCoverage(['t2'], 'work')).toBe('all')
  expect(labelCoverage(['t3'], 'work')).toBe('none')
})

it('adds a label to every selected conversation and keeps their other labels', async () => {
  await bulkLabelSelected([item('t1'), item('t2'), item('t3')], 'work', true)
  // t2 already had it: nothing is written for it.
  expect(assigned).toEqual([
    { thread_id: 't1', label_ids: ['home', 'work'] },
    { thread_id: 't3', label_ids: ['work'] },
  ])
  expect(mail$.threads.get().map((t: any) => t.labels)).toEqual([['home', 'work'], ['work'], ['work']])
  expect(ui$.toastTone.get()).toBe('success')
})

it('removes a label without touching the others', async () => {
  mail$.threads.set([{ thread_id: 't1', labels: ['home', 'work'] }] as any)
  await bulkLabelSelected([item('t1')], 'work', false)
  expect(assigned).toEqual([{ thread_id: 't1', label_ids: ['home'] }])
})

it('does not guess the labels of a conversation it cannot see', async () => {
  await bulkLabelSelected([item('t3'), item('gone'), item('t1')], 'work', true)
  // Stating "gone"'s set from nothing would wipe what it carries. As with
  // every bulk action, it stops there and says how far it got (#34).
  expect(assigned.map((a) => a.thread_id)).toEqual(['t3'])
  expect(ui$.toastTone.get()).toBe('error')
  expect(ui$.toast.get()).toContain('1')
})
