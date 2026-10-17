import { afterEach, beforeEach, expect, it, mock } from 'bun:test'

mock.module('../../boot', () => ({ boot: async () => {} }))

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AccountDialogCustom } from './AccountDialogCustom'
import { useAccountDialog } from './useAccountDialog'
import { dialogClasses } from './accountDialogStyles'
import { ui$ } from '../../states/ui'
import type { ConnectionReport, ServerReport, StepKind } from './connectionTest'

// The manual setup's connection test (#269), driven through the dialog with
// synthetic core answers: what is sent, what is shown, and that nothing is
// saved until a test passes or the person chooses "Save anyway".

const calls: { command: string; payload: any }[] = []
let nextReport: ConnectionReport

function side(
  protocol: ServerReport['protocol'],
  port: number,
  security: ServerReport['security'],
  failed?: { step: 'dns' | 'tcp' | 'tls' | 'auth'; kind: StepKind },
): ServerReport {
  const order = ['dns', 'tcp', 'tls', 'auth'] as const
  const at = failed ? order.indexOf(failed.step) : order.length
  return {
    protocol,
    host: `${protocol}.example.org`,
    port,
    security,
    ok: !failed,
    steps: order.map((step, i) =>
      i < at
        ? { step, status: 'ok' as const }
        : i === at
          ? { step, status: 'failed' as const, kind: failed!.kind, detail: 'synthetic server words' }
          : { step, status: 'not_run' as const },
    ),
  }
}

function report(incoming: ServerReport, outgoing: ServerReport): ConnectionReport {
  return { ok: incoming.ok && outgoing.ok, incoming, outgoing }
}

const passing = () => report(side('imap', 993, 'tls'), side('smtp', 465, 'tls'))

beforeEach(() => {
  calls.length = 0
  nextReport = passing()
  ui$.setupMode.set('custom')
  ui$.reconnectAccountId.set('')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'account.testConnection') return structuredClone(nextReport)
          if (command === 'account.probeCert') {
            return {
              certificate: {
                fingerprint: 'ab12',
                subject: 'CN=imap.example.org',
                issuer: 'CN=imap.example.org',
                not_before: '',
                not_after: '',
                self_signed: true,
              },
            }
          }
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
})

function Harness() {
  const ctl = useAccountDialog()
  return (
    <>
      <AccountDialogCustom ctl={ctl} classes={dialogClasses(false)} isSetup={false} />
      <button type="button" disabled={ctl.saveDisabled} onClick={() => void ctl.save()}>
        Harness save
      </button>
      {ctl.certPrompt && <p data-testid="cert-prompt">{ctl.certPrompt.protocol}</p>}
      {ctl.certPrompt && (
        <button type="button" onClick={() => void ctl.trustCertificate()}>
          Harness trust
        </button>
      )}
      {ctl.error && <p data-testid="error">{ctl.error}</p>}
    </>
  )
}

const of = (command: string) => calls.filter((c) => c.command === command)

async function fillForm(screen: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'ana@example.org' } })
    fireEvent.change(screen.getByLabelText('Password', { selector: 'input' }), { target: { value: 'pa55word' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced server settings' }))
  })
  await act(async () => {
    fireEvent.change(screen.getByLabelText('IMAP Host'), { target: { value: 'imap.example.org' } })
    fireEvent.change(screen.getByLabelText('SMTP Host'), { target: { value: 'smtp.example.org' } })
  })
}

async function click(screen: ReturnType<typeof render>, name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

it('Test connection sends the form as a save would and saves nothing', async () => {
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Test connection')
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Both servers passed'))
  expect(of('account.testConnection')).toHaveLength(1)
  expect(of('account.testConnection')[0].payload).toMatchObject({
    email: 'ana@example.org',
    imap_host: 'imap.example.org',
    imap_port: 993,
    smtp_host: 'smtp.example.org',
    smtp_port: 465,
    username: 'ana@example.org',
    password: 'pa55word',
    tls: true,
    starttls: false,
    smtp_tls: true,
    smtp_starttls: false,
    proxy: null,
  })
  expect(of('account.addPassword')).toEqual([])
  // Every step of both servers is listed.
  const region = screen.getByRole('region', { name: 'Connection test' })
  for (const step of ['Name lookup', 'Connection', 'Encryption', 'Sign-in']) {
    expect(region.textContent?.split(step).length).toBe(3)
  }
})

it('a failed step says what to fix, and a fix changes only the form', async () => {
  nextReport = report(side('imap', 993, 'tls', { step: 'tcp', kind: 'refused' }), side('smtp', 465, 'tls'))
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Test connection')
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('did not pass'))
  const region = screen.getByRole('region', { name: 'Connection test' })
  expect(region.textContent).toContain('Nothing accepts connections on port 993')
  expect(region.textContent).toContain('synthetic server words')
  expect(region.textContent).toContain('not tried')

  await click(screen, 'Use port 143 with STARTTLS')
  const [imapPort] = screen.getAllByLabelText('Port') as HTMLInputElement[]
  expect(imapPort.value).toBe('143')
  expect((screen.getByLabelText('IMAP security') as HTMLSelectElement).value).toBe('starttls')
  // The result was about the old settings.
  expect(region.textContent).toContain('settings have changed')
  expect(of('account.addPassword')).toEqual([])
  expect(of('account.testConnection')).toHaveLength(1)
})

it('a refused sign-in offers the other form of the user name', async () => {
  nextReport = report(side('imap', 993, 'tls', { step: 'auth', kind: 'rejected' }), side('smtp', 465, 'tls'))
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Test connection')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Use the user name ana' })).toBeTruthy())
  await click(screen, 'Use the user name ana')
  expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('ana')
})

it('Save tests first and stores nothing when the test fails', async () => {
  nextReport = report(side('imap', 993, 'tls'), side('smtp', 465, 'tls', { step: 'auth', kind: 'rejected' }))
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Harness save')
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Nothing has been saved'))
  expect(of('account.testConnection')).toHaveLength(1)
  expect(of('account.addPassword')).toEqual([])
})

it('Save anyway is the explicit way past a failed test', async () => {
  nextReport = report(side('imap', 993, 'tls', { step: 'dns', kind: 'name_not_found' }), side('smtp', 465, 'tls'))
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Harness save')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save anyway' })).toBeTruthy())
  expect(of('account.addPassword')).toEqual([])
  await click(screen, 'Save anyway')
  await waitFor(() => expect(of('account.addPassword')).toHaveLength(1))
  expect(of('account.addPassword')[0].payload).toMatchObject({
    email: 'ana@example.org',
    password: 'pa55word',
    skip_validation: true,
  })
})

it('Save after a passing test stores the account with the core validating it', async () => {
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Harness save')
  await waitFor(() => expect(of('account.addPassword')).toHaveLength(1))
  expect(calls.map((c) => c.command).filter((c) => c.startsWith('account.'))).toEqual([
    'account.testConnection',
    'account.addPassword',
  ])
  expect(of('account.addPassword')[0].payload).not.toHaveProperty('skip_validation')
})

it('an untrusted certificate is shown before it is pinned, then tested with the pin', async () => {
  nextReport = report(side('imap', 993, 'tls', { step: 'tls', kind: 'certificate' }), side('smtp', 465, 'tls'))
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Test connection')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Inspect the certificate' })).toBeTruthy())
  await click(screen, 'Inspect the certificate')
  await waitFor(() => expect(screen.getByTestId('cert-prompt').textContent).toBe('imap'))
  expect(of('account.probeCert')[0].payload).toMatchObject({ host: 'imap.example.org', port: 993, protocol: 'imap' })
  // Nothing is pinned or saved until the person accepts it.
  expect(of('account.testConnection')).toHaveLength(1)

  nextReport = passing()
  await click(screen, 'Harness trust')
  await waitFor(() => expect(of('account.testConnection')).toHaveLength(2))
  expect(of('account.testConnection')[1].payload).toMatchObject({ cert_pin: 'ab12' })
  // Asked from Test connection, not from Save: still nothing saved.
  expect(of('account.addPassword')).toEqual([])
})

it('a test that cannot run says so and saves nothing', async () => {
  ;(window as any).go.main.App.Invoke = async (command: string, payload: any) => {
    calls.push({ command, payload })
    if (command === 'account.testConnection') throw new Error('server required')
    return {}
  }
  const screen = render(<Harness />)
  await fillForm(screen)
  await click(screen, 'Harness save')
  await waitFor(() => expect(screen.getByTestId('error').textContent).toContain('server required'))
  expect(of('account.addPassword')).toEqual([])
})
