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

it('restores only after the archive is checked aside and the person confirms, then reloads', async () => {
  const { startProfileRestore, activateRestore } = await import('../../states/profileArchive')
  const calls = bridge((command, payload) => {
    if (command === 'backup.profileRestorePrepare')
      return payload.path
        ? { ready: true, summary, path: payload.path }
        : { needsPassphrase: true, path: '/tmp/p.oreneta-profile' }
    if (command === 'backup.profileRestoreActivate') return { activated: true }
    throw new Error(command)
  })
  await startProfileRestore()
  const view = render(<ProfileArchiveDialog />)
  expect(view.getByText('Restore a profile archive')).toBeTruthy()
  fireEvent.change(view.getByLabelText('Passphrase'), { target: { value: 'right passphrase' } })
  fireEvent.click(view.getByRole('button', { name: 'Check and continue' }))
  await waitFor(() => expect(view.getByText('Restore this profile?')).toBeTruthy())
  expect(view.getByText(/Accounts come back paused/)).toBeTruthy()
  expect(calls.some((call) => call.command === 'backup.profileRestoreActivate')).toBe(false)

  let reloaded = 0
  await activateRestore(() => reloaded++)
  expect(calls.at(-1)!.command).toBe('backup.profileRestoreActivate')
  expect(reloaded).toBe(1)
  expect(profileArchive$.restoreState.get()).toBe('activated')
})

it('a failed activation stays in the dialog and says the previous profile is back', async () => {
  const { activateRestore } = await import('../../states/profileArchive')
  bridge(() => {
    throw new Error('the core did not open the restored profile; the previous one is back')
  })
  profileArchive$.step.set({ kind: 'ready', path: '/tmp/p', summary })
  const view = render(<ProfileArchiveDialog />)
  let reloaded = 0
  await activateRestore(() => reloaded++)
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('previous one is back'))
  expect(reloaded).toBe(0)
})
