import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ShareLinkDialog } from './ShareLinkDialog'
import { cloudAccounts$, expiryDate, linkPassword, onCloudEvent } from '../../states/cloud'

const calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

const account = {
  id: 'c1',
  provider: 'nextcloud',
  name: 'Nextcloud · cloud.example.org',
  server: 'https://cloud.example.org',
  username: 'ana',
  folder: 'Oreneta',
}

beforeEach(() => {
  calls.length = 0
  cloudAccounts$.set([])
  answers = {
    'cloud.list': () => [account],
    'cloud.providers': () => [{ id: 'nextcloud', name: 'Nextcloud', usable: true }],
    'cloud.check': () => ({
      capabilities: { links: true, password_enforced: true, expiry_enforced: false, expiry_max_days: 5 },
    }),
    'cloud.pickFile': () => ({ path: '/home/ana/quote.pdf', name: 'quote.pdf', size: 3_000_000 }),
    'cloud.upload': () => ({ started: 'x' }),
    'cloud.share': (p) => ({
      link: {
        id: '42',
        url: 'https://cloud.example.org/s/AbC',
        path: 'Oreneta/quote.pdf',
        view_only: true,
        expires: p.link.expires,
        password_protected: true,
      },
    }),
  }
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
})

const uploadId = () => calls.find((c) => c.command === 'cloud.upload')!.payload.upload_id

it('says where the file goes and what the link allows, then shows the link the server made', async () => {
  const onInsert = mock(() => {})
  const screen = render(<ShareLinkDialog onInsert={onInsert} onClose={() => {}} />)
  await waitFor(() => expect(screen.getByLabelText('Days')).toBeTruthy())
  // The server's rules: a password is required, and links last at most 5 days.
  const password = screen.getAllByRole('checkbox')[0] as HTMLInputElement
  expect(password.checked && password.disabled).toBe(true)
  expect((screen.getByLabelText('Days') as HTMLInputElement).value).toBe('5')
  expect(screen.getByText(/view the file, not change it/)).toBeTruthy()

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose a file' }))
  })
  expect(screen.getByText(/Goes to Oreneta\/quote.pdf on https:\/\/cloud.example.org/)).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Upload and create the link' }))
  })
  await waitFor(() => expect(calls.some((c) => c.command === 'cloud.upload')).toBe(true))
  expect(calls.find((c) => c.command === 'cloud.upload')!.payload).toMatchObject({
    id: 'c1',
    path: '/home/ana/quote.pdf',
  })
  await act(async () => onCloudEvent('cloud.progress', { upload_id: uploadId(), done: 1_500_000, total: 3_000_000 }))
  expect((screen.getByLabelText('Uploading') as HTMLProgressElement).value).toBe(1_500_000)
  await act(async () => onCloudEvent('cloud.uploaded', { upload_id: uploadId(), path: 'Oreneta/quote.pdf' }))

  await waitFor(() => expect(screen.getByText('https://cloud.example.org/s/AbC')).toBeTruthy())
  const share = calls.find((c) => c.command === 'cloud.share')!.payload
  expect(share.path).toBe('Oreneta/quote.pdf')
  expect(share.link.expires).toBe(expiryDate(5))
  expect(share.link.password.length).toBe(16)
  expect(screen.getByText(`View only · works until ${expiryDate(5)} · needs the password`)).toBeTruthy()
  expect(screen.getByText(/not put in the message/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Insert the link' }))
  expect(onInsert).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'https://cloud.example.org/s/AbC' }),
    'quote.pdf',
  )
})

it('a full storage or a link the server changed is said, and nothing is inserted', async () => {
  const onInsert = mock(() => {})
  const screen = render(<ShareLinkDialog onInsert={onInsert} onClose={() => {}} />)
  await waitFor(() => expect(screen.getByLabelText('Days')).toBeTruthy())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose a file' }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Upload and create the link' }))
  })
  await waitFor(() => expect(calls.some((c) => c.command === 'cloud.upload')).toBe(true))
  await act(async () =>
    onCloudEvent('cloud.uploaded', { upload_id: uploadId(), error: { message: 'x', detail: { code: 'quota' } } }),
  )
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('storage is full'))

  answers['cloud.share'] = () => ({
    error: { message: 'x', detail: { code: 'permissionMismatch', detail: 'it would let people change the file' } },
  })
  calls.length = 0
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Upload and create the link' }))
  })
  await waitFor(() => expect(calls.some((c) => c.command === 'cloud.upload')).toBe(true))
  await act(async () => onCloudEvent('cloud.uploaded', { upload_id: uploadId(), path: 'Oreneta/quote.pdf' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('so it was withdrawn'))
  expect(onInsert).not.toHaveBeenCalled()
})

it('makes link passwords from the random source and dates the server reads', () => {
  expect(linkPassword((n) => new Uint8Array(n))).toBe('a'.repeat(16))
  expect(linkPassword()).toMatch(/^[a-zA-Z2-9]{16}$/)
  expect(expiryDate(7, new Date(2026, 11, 28))).toBe('2027-01-04')
})
