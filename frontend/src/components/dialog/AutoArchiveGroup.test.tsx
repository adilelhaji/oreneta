import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AutoArchiveGroup } from './AutoArchiveGroup'
import { autoArchiveRan$, onAutoArchiveRan, type AutoArchiveRun } from '../../states/autoArchive'
import { ui$ } from '../../states/ui'
import { settingsDestinations } from '../../lib/settingsDestinations'
import { t } from '../../lib/i18n'
import type { Account } from '../../types'

const calls: { command: string; payload: any }[] = []
let status: any

const policy = () => ({
  enabled: false,
  older_than: { value: 6, unit: 'months' },
  folders: [{ name: 'INBOX', older_than: null }],
  destination: 'server',
  keep_server_copy: false,
  include_starred: false,
  include_unread: false,
})

const base = () => ({
  policy: policy(),
  confirmed: false,
  last_attempt: null,
  last_success: null,
  last_error: null,
  next_run: null,
  running: false,
  local_supported: true,
  folders: [
    { name: 'INBOX', display_name: 'INBOX', refused: null },
    { name: 'Projects', display_name: 'Projects', refused: null },
    { name: 'Drafts', display_name: 'Drafts', refused: 'drafts' },
    { name: 'Trash', display_name: 'Trash', refused: 'trash' },
  ],
  runs: [],
})

const run = (over: Partial<AutoArchiveRun> = {}): AutoArchiveRun => ({
  id: 1,
  account: 'ana',
  started_at: 1_760_000_000,
  finished_at: 1_760_000_010,
  trigger: 'scheduled',
  destination: 'local',
  target: 'Archived/ana@x.cat',
  moved: 3,
  kept: 0,
  failed: 0,
  gone: 0,
  folders: [],
  failures: [],
  error: null,
  ...over,
})

beforeEach(() => {
  calls.length = 0
  status = base()
  ui$.toast.set('')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload: structuredClone(payload) })
          if (command === 'autoArchive.preview') {
            return {
              account: 'ana',
              destination: payload.policy.destination,
              target: 'Archive',
              total: 5,
              fingerprint: 'print-1',
              folders: payload.policy.folders.map((f: any, i: number) => ({
                folder: f.name,
                cutoff: 1_760_000_000,
                target: 'Archive',
                count: i === 0 ? 4 : 1,
                oldest: 1,
                newest: 2,
              })),
            }
          }
          if (command === 'autoArchive.save') {
            if (payload.policy.enabled && !payload.confirm && !status.confirmed) throw new Error('confirm first')
            status = { ...status, policy: payload.policy, confirmed: !!payload.confirm || status.confirmed }
          }
          if (command === 'autoArchive.runNow') {
            const done = run({ trigger: 'manual', moved: 2, failed: 1 })
            status = { ...status, runs: [done, ...status.runs] }
            return { run: done, archive_created: false, status }
          }
          return status
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('is off by default and turns on only through a confirmed preview', async () => {
  const screen = render(<AutoArchiveGroup accountId="ana" />)
  const toggle = (await waitFor(() => screen.getByLabelText('Archive old messages automatically'))) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  expect((screen.getByText('Run now') as HTMLButtonElement).disabled).toBe(true)
  // Special folders are listed but cannot be chosen.
  const drafts = screen.getByLabelText('Drafts') as HTMLInputElement
  expect(drafts.disabled).toBe(true)
  expect(screen.getByText('(drafts are never archived)')).toBeTruthy()

  await act(async () => fireEvent.click(toggle))
  // Turned on, there is no plain save: only the preview.
  expect(screen.queryByText('Save')).toBeNull()
  await act(async () => fireEvent.click(screen.getByLabelText('Projects')))
  await act(async () => fireEvent.click(screen.getByText('Preview…')))
  await waitFor(() => screen.getByText('5 messages would be archived now.'))
  expect(calls.some((c) => c.command === 'autoArchive.save')).toBe(false)
  const previewed = calls.find((c) => c.command === 'autoArchive.preview')!.payload
  expect(previewed.policy.enabled).toBe(true)
  expect(previewed.policy.folders.map((f: any) => f.name)).toEqual(['INBOX', 'Projects'])
  expect(screen.getByText(/INBOX: 4 messages from before/)).toBeTruthy()
  expect(screen.getByText(/Projects: 1 message from before/)).toBeTruthy()

  // Changing anything drops the preview: it no longer describes the policy.
  await act(async () => fireEvent.click(screen.getByLabelText('Include unread messages')))
  expect(screen.queryByText('Confirm and turn on')).toBeNull()
  await act(async () => fireEvent.click(screen.getByText('Preview…')))
  const confirm = await waitFor(() => screen.getByText('Confirm and turn on'))
  await act(async () => fireEvent.click(confirm))
  const saved = calls.find((c) => c.command === 'autoArchive.save')!.payload
  expect(saved.confirm).toBe('print-1')
  expect(saved.policy.include_unread).toBe(true)
  await waitFor(() => expect((screen.getByText('Run now') as HTMLButtonElement).disabled).toBe(false))
})

it('keeps the local archive choice for accounts that can copy there, with an option to keep the server copy', async () => {
  status = { ...base(), local_supported: false }
  const screen = render(<AutoArchiveGroup accountId="graph" />)
  const local = (await waitFor(() => screen.getByLabelText('The local archive, on this computer'))) as HTMLInputElement
  expect(local.disabled).toBe(true)
  expect(screen.getByText('This account cannot copy messages to the local archive.')).toBeTruthy()
  cleanup()

  status = base()
  const again = render(<AutoArchiveGroup accountId="ana" />)
  const localAgain = await waitFor(() => again.getByLabelText('The local archive, on this computer'))
  await act(async () => fireEvent.click(localAgain))
  await act(async () => fireEvent.click(again.getByLabelText('Also keep them on the server')))
  await act(async () => fireEvent.click(again.getByText('Preview…')))
  await waitFor(() => again.getByText(/the server keeps its copy/))
  const sent = calls.find((c) => c.command === 'autoArchive.preview')!.payload.policy
  expect([sent.destination, sent.keep_server_copy]).toEqual(['local', true])
})

it('runs on request and lists every run with what did not go, item by item', async () => {
  status = {
    ...base(),
    policy: { ...policy(), enabled: true },
    confirmed: true,
    next_run: 1_760_086_400,
    runs: [
      run({
        id: 7,
        failed: 2,
        failures: [
          { folder: 'INBOX', uid: 4, subject: 'Invoice', step: 'verify', error: 'the archived copy did not match' },
          { folder: 'INBOX', uid: 5, subject: '', step: 'delete', error: 'the archived copy is kept' },
        ],
      }),
      run({ id: 6, error: 'connection refused', moved: 0 }),
    ],
  }
  const screen = render(<AutoArchiveGroup accountId="ana" />)
  await waitFor(() => screen.getByLabelText('Run log'))
  expect(screen.getByText(/3 archived, 2 left where they were/)).toBeTruthy()
  expect(screen.getByText(/did not run: connection refused/)).toBeTruthy()
  expect(screen.getByText('2 messages not archived')).toBeTruthy()
  expect(screen.getByText('Invoice (INBOX), at verify: the archived copy did not match')).toBeTruthy()
  expect(screen.getByText('(no subject) (INBOX), at delete: the archived copy is kept')).toBeTruthy()
  expect(screen.getByText(/Next run:/)).toBeTruthy()

  await act(async () => fireEvent.click(screen.getByText('Run now')))
  await waitFor(() => expect(ui$.toast.get()).toBe('2 messages archived; 1 left where they were.'))
  expect(calls.filter((c) => c.command === 'autoArchive.runNow')).toHaveLength(1)
  await waitFor(() => expect(screen.getAllByText(/run now ·/)).toHaveLength(1))
})

it('a scheduled run that leaves mail behind is said with Settings closed, and an open page reloads', async () => {
  await onAutoArchiveRan({ account: 'ana', run: run({ failed: 2 }) })
  expect(ui$.toast.get()).toContain('left 2 messages where they were')
  expect(autoArchiveRan$.get()?.account).toBe('ana')
  ui$.toast.set('')
  await onAutoArchiveRan({ account: 'ana', run: run() })
  expect(ui$.toast.get()).toBe('')
  await onAutoArchiveRan({ account: 'ana', run: null, error: 'no Archive folder' })
  expect(ui$.toast.get()).toContain('no Archive folder')

  const screen = render(<AutoArchiveGroup accountId="ana" />)
  await waitFor(() => screen.getByText('Automatic archiving'))
  const before = calls.filter((c) => c.command === 'autoArchive.status').length
  await act(async () => autoArchiveRan$.set({ account: 'ana', at: Date.now() }))
  await waitFor(() => expect(calls.filter((c) => c.command === 'autoArchive.status').length).toBe(before + 1))
})

it('settings search finds automatic archiving for accounts with a server only', () => {
  const account = (id: string, auth_type: string) =>
    ({ id, email: `${id}@x.cat`, display_name: id, auth_type, provider: 'custom' }) as unknown as Account
  const found = settingsDestinations([account('ana', 'password'), account('pop', 'pop3')], t).filter(
    (d) => d.section === 'autoArchive',
  )
  expect(found.map((d) => d.accountId)).toEqual(['ana'])
  expect(found[0].label).toBe('Automatic archiving: ana')
  expect(found[0].keywords).toContain('archive')
})
