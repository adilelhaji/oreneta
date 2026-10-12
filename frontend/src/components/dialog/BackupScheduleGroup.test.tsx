import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { BackupScheduleGroup } from './BackupScheduleGroup'
import { backupSchedule$, onBackupScheduled } from '../../states/backupSchedule'

const calls: { command: string; payload: any }[] = []
let status: any

const base = () => ({
  schedule: { enabled: false, folder: '', every_hours: 24, keep: 7, max_bytes: null },
  last_attempt: null,
  last_success: null,
  last_error: null,
  next_run: null,
  backups: [],
  password_saved: false,
  running: false,
})

beforeEach(() => {
  calls.length = 0
  status = base()
  backupSchedule$.set(null)
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'backupSchedule.pickFolder') return { path: '/backups' }
          if (command === 'backupSchedule.save') {
            status = {
              ...status,
              schedule: payload.schedule,
              password_saved: status.password_saved || !!payload.password,
            }
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

it('is off by default and is not turned on without a folder and a confirmed password', async () => {
  const screen = render(<BackupScheduleGroup />)
  const toggle = (await waitFor(() => screen.getByLabelText('Back up the profile on a schedule'))) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  const save = screen.getByText('Save') as HTMLButtonElement
  expect(save.disabled).toBe(true)

  await act(async () => fireEvent.click(toggle))
  expect(save.disabled).toBe(true) // no folder, no password

  await act(async () => fireEvent.click(screen.getByText('Choose…')))
  await waitFor(() => screen.getByText('/backups'))
  expect(save.disabled).toBe(true) // still no password

  fireEvent.change(screen.getByLabelText('Backup password'), { target: { value: 'long enough' } })
  fireEvent.change(screen.getByLabelText('Confirm the backup password'), { target: { value: 'long enougX' } })
  expect(screen.getByText('The passwords do not match.')).toBeTruthy()
  expect(save.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Confirm the backup password'), { target: { value: 'long enough' } })
  expect(save.disabled).toBe(false)

  await act(async () => fireEvent.click(save))
  const sent = calls.find((c) => c.command === 'backupSchedule.save')!.payload
  expect(sent.schedule).toEqual({ enabled: true, folder: '/backups', every_hours: 24, keep: 7, max_bytes: null })
  expect(sent.password).toBe('long enough')
  await waitFor(() => screen.getByText(/Password saved in the system keychain/))
})

it('a later change keeps the saved password unless a new one is typed', async () => {
  status = { ...base(), schedule: { ...base().schedule, enabled: true, folder: '/b' }, password_saved: true }
  const screen = render(<BackupScheduleGroup />)
  const keep = (await waitFor(() => screen.getByLabelText('Keep'))) as HTMLInputElement
  fireEvent.change(keep, { target: { value: '99' } })
  expect(keep.value).toBe('30')
  await act(async () => fireEvent.click(screen.getByText('Save')))
  const sent = calls.find((c) => c.command === 'backupSchedule.save')!.payload
  expect(sent.schedule.keep).toBe(30)
  expect('password' in sent).toBe(false)
})

it('says when the last run failed and that earlier backups are kept, and lists what is kept', async () => {
  status = {
    ...base(),
    schedule: { ...base().schedule, enabled: true, folder: '/b' },
    password_saved: true,
    last_success: 1_760_000_000,
    last_attempt: 1_760_090_000,
    last_error: 'No space left on device',
    next_run: 1_760_093_600,
    backups: [
      {
        path: '/b/oreneta-scheduled-1.oreneta-profile',
        created_at: 1_760_000_000,
        bytes: 2048,
        verified: true,
        present: false,
      },
    ],
  }
  const screen = render(<BackupScheduleGroup />)
  await waitFor(() => screen.getByText(/No space left on device/))
  expect(screen.getByText(/Earlier backups are kept/)).toBeTruthy()
  expect(screen.getByText(/Last good backup/)).toBeTruthy()
  expect(screen.getByText('missing')).toBeTruthy()
  expect(screen.getByText('2 KB')).toBeTruthy()
})

it('a scheduled run arriving while open updates what is shown', async () => {
  status = { ...base(), schedule: { ...base().schedule, enabled: true, folder: '/b' }, password_saved: true }
  const screen = render(<BackupScheduleGroup />)
  await waitFor(() => screen.getByText('Back up now'))
  act(() => onBackupScheduled({ state: 'running' }))
  await waitFor(() => screen.getByText('Backing up…'))
  act(() => onBackupScheduled({ state: 'done', status: { ...status, last_success: 1_760_000_000, running: false } }))
  await waitFor(() => screen.getByText(/Last good backup/))
})
