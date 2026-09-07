import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SharedMailboxesCard } from './SharedMailboxesCard'
import { accounts$, sharedMailboxesOf } from '../../states/accounts'
import type { Account } from '../../types'

afterEach(() => {
  cleanup()
  accounts$.set([])
  delete (window as any).go
})

function ewsAccount(over: Partial<Account> = {}): Account {
  return {
    id: 'acct-ews',
    email: 'ana@corp.example.com',
    display_name: 'Ana',
    provider: 'exchange',
    auth_type: 'password',
    imap_host: '',
    imap_port: 0,
    smtp_host: '',
    smtp_port: 0,
    tls: true,
    ews_url: 'https://mail.corp.example.com/EWS/Exchange.asmx',
    ...over,
  } as Account
}

function sharedAccount(id: string, email: string, delegateOf: string): Account {
  return {
    id,
    email,
    display_name: email,
    provider: 'exchange',
    auth_type: 'password',
    imap_host: '',
    imap_port: 0,
    smtp_host: '',
    smtp_port: 0,
    tls: true,
    delegate_account_id: delegateOf,
  } as Account
}

describe('sharedMailboxesOf', () => {
  it('finds only accounts delegating to the given one', () => {
    accounts$.set([
      ewsAccount(),
      sharedAccount('support', 'support@corp.example.com', 'acct-ews'),
      sharedAccount('sales', 'sales@corp.example.com', 'someone-else'),
    ])
    const found = sharedMailboxesOf('acct-ews')
    expect(found.map((a) => a.id)).toEqual(['support'])
  })
})

describe('the shared mailboxes card', () => {
  it('lists an existing shared mailbox with its address', () => {
    accounts$.set([ewsAccount(), sharedAccount('support', 'support@corp.example.com', 'acct-ews')])
    const view = render(<SharedMailboxesCard account={ewsAccount()} />)
    expect(view.container.textContent).toContain('support@corp.example.com')
  })

  it('adds a shared mailbox by calling account.addSharedMailbox with the parent account', async () => {
    accounts$.set([ewsAccount()])
    const calls: { command: string; payload: any }[] = []
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            calls.push({ command, payload })
            switch (command) {
              case 'account.addSharedMailbox':
                return { id: 'support' }
              case 'account.list':
                return {
                  accounts: [ewsAccount(), sharedAccount('support', payload?.address ?? 'support@corp.example.com', 'acct-ews')],
                }
              case 'system.check':
                return {
                  platform: 'linux',
                  mail_engine: 'meron_mail',
                  meron_mail: { configured: true, available: true, server_path: '' },
                  gmail_oauth_configured: false,
                  outlook_oauth_configured: false,
                  database_path: '',
                }
              default:
                return {}
            }
          },
        },
      },
    }

    const view = render(<SharedMailboxesCard account={ewsAccount()} />)
    fireEvent.click(view.getByText('Add a shared mailbox'))
    fireEvent.change(view.getByPlaceholderText('shared-mailbox@example.com'), {
      target: { value: 'support@corp.example.com' },
    })
    fireEvent.click(view.getByRole('button', { name: 'Add a shared mailbox' }))

    await waitFor(() => expect(calls.some((c) => c.command === 'account.addSharedMailbox')).toBe(true))
    const addCall = calls.find((c) => c.command === 'account.addSharedMailbox')
    expect(addCall?.payload).toMatchObject({
      parent_account: 'acct-ews',
      address: 'support@corp.example.com',
    })
  })
})
