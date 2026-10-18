import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AccountTogglesSection, mailCheckChoices } from './AccountTogglesSection'
import { accounts$ } from '../../states/accounts'
import type { Account } from '../../types'

// The periodic mail check setting of a mail account (#270).

const calls: { command: string; payload: any }[] = []
let stored: number | undefined

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'ana@example.org',
    email: 'ana@example.org',
    display_name: 'Ana',
    provider: 'custom',
    auth_type: 'password',
    imap_host: 'imap.example.org',
    imap_port: 993,
    smtp_host: 'smtp.example.org',
    smtp_port: 465,
    ...overrides,
  } as Account
}

beforeEach(() => {
  calls.length = 0
  stored = undefined
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'account.setMailCheckInterval') return { ok: true, minutes: stored ?? payload.minutes }
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  accounts$.set([])
  delete (window as any).go
})

// The setting's hint lives in its row's info tooltip, shown on focus.
async function hintOf(screen: ReturnType<typeof render>): Promise<string> {
  let row: HTMLElement | null = screen.getByLabelText('Check for new mail').parentElement
  while (row && !row.querySelector('[tabindex="0"]')) row = row.parentElement
  const tip = row?.querySelector('[tabindex="0"]') as HTMLElement
  await act(async () => {
    fireEvent.focus(tip)
  })
  return screen.getByRole('tooltip').textContent ?? ''
}

function Harness({ id, isRSS = false }: { id: string; isRSS?: boolean }) {
  const list = accounts$.get()
  const current = list.find((a) => a.id === id)!
  return <AccountTogglesSection account={current} isRSS={isRSS} />
}

it('an account with no choice of its own is manual, and "manual only" is stored as 0', async () => {
  accounts$.set([account()])
  const screen = render(<Harness id="ana@example.org" />)
  const select = screen.getByLabelText('Check for new mail') as HTMLSelectElement
  expect(select.value).toBe('0')
  expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
    'Manually only',
    'Every 5 min',
    'Every 10 min',
    'Every 15 min',
    'Every 30 min',
    'Every 60 min',
    'Every 120 min',
  ])
  expect(await hintOf(screen)).toContain('get new mail by push as it arrives')
  await act(async () => {
    fireEvent.change(select, { target: { value: '30' } })
  })
  expect(calls).toEqual([{ command: 'account.setMailCheckInterval', payload: { id: 'ana@example.org', minutes: 30 } }])
  expect(accounts$.get()[0].mail_check_interval_minutes).toBe(30)
})

it('stores "manual only" as 0', async () => {
  accounts$.set([account({ mail_check_interval_minutes: 15 })])
  const screen = render(<Harness id="ana@example.org" />)
  const select = screen.getByLabelText('Check for new mail') as HTMLSelectElement
  expect(select.value).toBe('15')
  await act(async () => {
    fireEvent.change(select, { target: { value: '0' } })
  })
  expect(calls).toEqual([{ command: 'account.setMailCheckInterval', payload: { id: 'ana@example.org', minutes: 0 } }])
  expect(accounts$.get()[0].mail_check_interval_minutes).toBe(0)
})

it('keeps what the core stored when it bounded the value', async () => {
  accounts$.set([account({ mail_check_interval_minutes: 30 })])
  stored = 60
  const screen = render(<Harness id="ana@example.org" />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Check for new mail'), { target: { value: '120' } })
  })
  await waitFor(() => expect(accounts$.get()[0].mail_check_interval_minutes).toBe(60))
})

it('goes back to what was stored when the change fails', async () => {
  accounts$.set([account({ mail_check_interval_minutes: 30 })])
  ;(window as any).go.main.App.Invoke = async () => {
    throw new Error('engine unavailable')
  }
  const screen = render(<Harness id="ana@example.org" />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Check for new mail'), { target: { value: '5' } })
  })
  await waitFor(() => expect(accounts$.get()[0].mail_check_interval_minutes).toBe(30))
})

it('says what the check covers for POP3 and for accounts without push', async () => {
  accounts$.set([
    account({ id: 'pop', auth_type: 'pop3' }),
    account({ id: 'ews', ews_url: 'https://mail.example.org/EWS/Exchange.asmx' }),
  ])
  const pop = render(<Harness id="pop" />)
  expect(await hintOf(pop)).toContain('downloaded only when the account is checked')
  cleanup()
  const ews = render(<Harness id="ews" />)
  expect(await hintOf(ews)).toContain('its folders, except Trash and Junk, are checked')
})

it('is not offered for feeds or the local archive', () => {
  accounts$.set([
    account({ id: 'feeds', auth_type: 'rss', provider: 'rss' }),
    account({ id: 'archive', auth_type: 'local_archive', provider: 'local' }),
  ])
  const feeds = render(<Harness id="feeds" isRSS />)
  expect(feeds.queryByLabelText('Check for new mail')).toBeNull()
  cleanup()
  const archive = render(<Harness id="archive" />)
  expect(archive.queryByLabelText('Check for new mail')).toBeNull()
})

it('offers a stored value that is not one of the usual choices', () => {
  expect(mailCheckChoices(45)).toEqual([0, 5, 10, 15, 30, 45, 60, 120])
  expect(mailCheckChoices(15)).toEqual([0, 5, 10, 15, 30, 60, 120])
})
