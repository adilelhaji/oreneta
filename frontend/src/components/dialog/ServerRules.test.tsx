import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { ServerRulesPanel } = await import('./ServerRulesPanel')
const { accounts$ } = await import('../../states/accounts')
const { settleConfirm, ui$ } = await import('../../states/ui')

let calls: { command: string; payload: any }[] = []
let pushAnswer: any

const status = {
  available: true,
  status: {
    ours: 'changedElsewhere',
    oursActive: true,
    otherActive: null,
    capabilities: { sieve: ['fileinto'], implementation: 'x' },
  },
  plan: {
    script:
      'require ["fileinto"];\n# Receipts\nif anyof (header :contains "from" "shop") {\n    fileinto "Receipts";\n}\n',
    included: ['r1'],
    left: [
      { id: 'r2', name: 'Team', reasons: ['“is” on an address compares the name too here, which the server cannot'] },
    ],
  },
  state: { included: ['r1'], active: true },
}

beforeEach(() => {
  calls = []
  pushAnswer = { pushed: { outcome: 'changedElsewhere', onServer: '# edited in webmail\n' } }
  accounts$.set([{ id: 'acct', email: 'sam@example.com', provider: 'custom', auth_type: 'password' } as any])
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'rules.serverStatus') return status
          if (command === 'rules.serverPush') return pushAnswer
          return {}
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

it('shows what would go, what stays here and why, before anything is sent', async () => {
  const view = render(<ServerRulesPanel />)
  fireEvent.click(view.getByRole('button', { name: 'Check the server' }))
  await waitFor(() => expect(view.getByText('1 rules can run on the server.')).toBeTruthy())
  expect(view.getByText(/“Team” stays here:/)).toBeTruthy()
  expect(view.getByText(/compares the name too here/)).toBeTruthy()
  expect(view.getByText('The copy on the server was changed elsewhere since Oreneta wrote it.')).toBeTruthy()
  expect(calls.map((c) => c.command)).toEqual(['rules.serverStatus'])
})

it('does not replace a copy changed elsewhere until told, then replaces it', async () => {
  const view = render(<ServerRulesPanel />)
  fireEvent.click(view.getByRole('button', { name: 'Check the server' }))
  await waitFor(() => expect(view.getByRole('button', { name: 'Run on the server' })).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: 'Run on the server' }))
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  settleConfirm(true)
  await waitFor(() => expect(view.getByText('# edited in webmail')).toBeTruthy())
  expect(calls.find((c) => c.command === 'rules.serverPush')?.payload).toEqual({ account: 'acct', overwrite: false })

  pushAnswer = { pushed: { outcome: 'stored', hash: 'h', active: true, otherActive: null } }
  fireEvent.click(view.getByRole('button', { name: 'Replace it with Oreneta’s rules' }))
  await waitFor(() => expect(ui$.confirm.get()).toBeTruthy())
  settleConfirm(true)
  await waitFor(() =>
    expect(calls.filter((c) => c.command === 'rules.serverPush').at(-1)?.payload).toEqual({
      account: 'acct',
      overwrite: true,
    }),
  )
})

it('says why an account cannot have rules on its server', async () => {
  ;(window as any).go.main.App.Invoke = async () => ({
    available: false,
    reason: 'Exchange keeps its own server rules, which Oreneta does not edit yet',
  })
  const view = render(<ServerRulesPanel />)
  fireEvent.click(view.getByRole('button', { name: 'Check the server' }))
  await waitFor(() => expect(view.getByText(/Exchange keeps its own server rules/)).toBeTruthy())
  expect(view.queryByRole('button', { name: 'Run on the server' })).toBeNull()
})
