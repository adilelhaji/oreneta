import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TrackerNotice } from './TrackerNotice'
import { TrackingProtectionGroup } from '../dialog/TrackingProtectionGroup'
import { settleConfirm, ui$ } from '../../states/ui'

const calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

const message = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'm',
    thread_id: 'acct#INBOX#t',
    account_id: 'acct',
    message_id: '<m1@example.test>',
    trackers_protected: true,
    trackers_blocked: [
      { url: 'https://us5.list-manage.com/track/open.php?u=1', rule: '||list-manage.com/track/' },
      { url: 'https://email.acemlna.com/lt.php?x=1', rule: '.acemlna.com/lt.php?$image' },
    ],
    ...overrides,
  }) as any

beforeEach(() => {
  calls.length = 0
  answers = {}
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? {}
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  ui$.confirm.set(null)
})

it('says how many trackers were kept from loading, and by which rule', () => {
  const view = render(<TrackerNotice message={message()} />)
  expect(view.getByText('2 trackers blocked')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Which' }))
  expect(view.getByText('us5.list-manage.com — EasyPrivacy rule ||list-manage.com/track/')).toBeTruthy()
})

it('says what a feed item was kept from loading, with no way to let it, as it has no Message-ID (#191)', () => {
  const feedItem = message({
    id: 'rss-acct#rss#feed-1#item-1',
    thread_id: 'rss-acct#rss#feed-1',
    account_id: 'rss-acct',
    message_id: undefined,
    trackers_blocked: [{ url: 'https://tracker.example/open.gif', rule: '||tracker.example^' }],
  })
  const view = render(<TrackerNotice message={feedItem} />)
  expect(view.getByText('1 tracker blocked')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Load them for this message' })).toBeNull()
})

it('lets one message load its trackers only after asking, and can undo it', async () => {
  const view = render(<TrackerNotice message={message()} />)
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Load them for this message' }))
  })
  expect(ui$.confirm.get()?.message).toContain('tell you opened it')
  settleConfirm(false)
  expect(calls.some((c) => c.command === 'privacy.allowMessage')).toBe(false)

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Load them for this message' }))
  })
  settleConfirm(true)
  await waitFor(() =>
    expect(calls.find((c) => c.command === 'privacy.allowMessage')?.payload).toEqual({
      account: 'acct',
      message_id: '<m1@example.test>',
      allow: true,
    }),
  )

  cleanup()
  const allowed = render(<TrackerNotice message={message({ trackers_protected: false, trackers_blocked: [] })} />)
  expect(allowed.getByText('Trackers are allowed in this message.')).toBeTruthy()
  await act(async () => {
    fireEvent.click(allowed.getByRole('button', { name: 'Block them again' }))
  })
  await waitFor(() =>
    expect(calls.filter((c) => c.command === 'privacy.allowMessage').at(-1)?.payload.allow).toBe(false),
  )
})

it('shows nothing when nothing was blocked', () => {
  const view = render(<TrackerNotice message={message({ trackers_blocked: [] })} />)
  expect(view.container.textContent).toBe('')
})

it('fetches a newer list only when asked, and says which list is in use', async () => {
  answers['privacy.info'] = () => ({ title: 'EasyPrivacy', version: '4b79596e08b7', rules: 51000, source: 'bundled' })
  answers['privacy.update'] = () => ({ title: 'EasyPrivacy', version: '202610130000', rules: 52000, source: 'updated' })
  const view = render(<TrackingProtectionGroup />)
  await waitFor(() => expect(view.getByText(/4b79596e08b7, included with Oreneta/)).toBeTruthy())
  expect(calls.map((c) => c.command)).toEqual(['privacy.info'])
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Fetch the current list' }))
  })
  settleConfirm(true)
  await waitFor(() => expect(view.getByText(/202610130000, fetched on request/)).toBeTruthy())
  expect(view.getByRole('button', { name: 'Use the included list' })).toBeTruthy()
})
