import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { ProfileArchiveDialog } = await import('./ProfileArchiveDialog')
const { profileArchive$, startProfileExport, startProfileCheck, formatBytes } =
  await import('../../states/profileArchive')
const { ui$ } = await import('../../states/ui')

const summary = {
  created_at: 1_760_000_000,
  app_version: '1.2.3',
  schema_version: 42,
  entries: 3,
  bytes: 5 * 1024 * 1024,
  accounts: 2,
  messages: 120,
  excluded: [{ what: 'attachment cache', why: 'downloaded again from the mail servers when opened' }],
}

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
  profileArchive$.assign({ step: null, busy: false, error: '' })
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('needs a confirmed passphrase of at least 8 characters before asking where to save', async () => {
  const calls = bridge(() => ({ saved: true, summary }))
  startProfileExport()
  const view = render(<ProfileArchiveDialog />)
  const save = view.getByRole('button', { name: 'Choose where to save' }) as HTMLButtonElement
  fireEvent.change(view.getByLabelText('Passphrase'), { target: { value: 'short' } })
  expect(view.getByText('Use at least 8 characters.')).toBeTruthy()
  expect(save.disabled).toBe(true)
  fireEvent.change(view.getByLabelText('Passphrase'), { target: { value: 'long enough' } })
  fireEvent.change(view.getByLabelText('Confirm passphrase'), { target: { value: 'long enougH' } })
  expect(save.disabled).toBe(true)
  fireEvent.change(view.getByLabelText('Confirm passphrase'), { target: { value: 'long enough' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await waitFor(() => expect(profileArchive$.step.get()).toBeNull())
  expect(calls).toEqual([{ command: 'backup.profileExport', payload: { passphrase: 'long enough' } }])
  expect(ui$.toast.get()).toBe('Profile backed up (5.0 MB)')
})

it('checks an archive, keeps the dialog open on a wrong passphrase and lists what is left out', async () => {
  bridge((_command, payload) => {
    if (!payload.path) return { needsPassphrase: true, path: '/tmp/p.oreneta-profile' }
    if (payload.passphrase !== 'right passphrase')
      throw new Error('wrong passphrase, or not an Oreneta profile archive')
    return { summary, path: payload.path }
  })
  await startProfileCheck()
  const view = render(<ProfileArchiveDialog />)
  expect(view.getByText('/tmp/p.oreneta-profile')).toBeTruthy()
  fireEvent.change(view.getByLabelText('Passphrase'), { target: { value: 'nope' } })
  fireEvent.click(view.getByRole('button', { name: 'Check' }))
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('wrong passphrase'))
  fireEvent.change(view.getByLabelText('Passphrase'), { target: { value: 'right passphrase' } })
  fireEvent.click(view.getByRole('button', { name: 'Check' }))
  await waitFor(() => expect(view.getByText('The archive is whole')).toBeTruthy())
  expect(view.getByText('2 accounts, 120 messages, 5.0 MB')).toBeTruthy()
  expect(view.getByText('attachment cache')).toBeTruthy()
})

it('formats sizes readably', () => {
  expect(formatBytes(10)).toBe('1 KB')
  expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
})
