import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { OofSettingsCard, fromDateInput, toDateInput } from './OofSettingsCard'
import type { Account } from '../../types'

afterEach(() => {
  cleanup()
  delete (window as any).go
})

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'acct',
    email: 'ana@example.com',
    display_name: 'Ana',
    provider: 'custom',
    auth_type: 'password',
    imap_host: '',
    imap_port: 993,
    smtp_host: '',
    smtp_port: 465,
    tls: true,
    ...over,
  } as Account
}

/** Stub the bridge, returning `getResult` for oof.get and recording every
 * oof.set payload so a test can assert what actually got saved. */
function stubOof(getResult: unknown) {
  const setCalls: unknown[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: unknown) => {
          if (command === 'oof.get') return getResult
          if (command === 'oof.set') {
            setCalls.push(payload)
            return { ok: true }
          }
          return {}
        },
      },
    },
  }
  return setCalls
}

describe('the IMAP/SMTP client-side auto-reply card', () => {
  it('starts disabled and does not show the running-app warning', async () => {
    stubOof({ kind: 'imap', settings: { enabled: false, startAt: 0, endAt: 0, subject: '', body: '' } })
    const view = render(<OofSettingsCard account={account()} />)
    await waitFor(() => expect(view.container.textContent).toContain('Automatic replies'))
    expect(view.queryByText(/only works while Oreneta is running/)).toBeNull()
  })

  it('shows the only-while-running warning once enabled', async () => {
    stubOof({ kind: 'imap', settings: { enabled: true, startAt: 0, endAt: 0, subject: '', body: 'Away.' } })
    const view = render(<OofSettingsCard account={account()} />)
    await waitFor(() => expect(view.getByText(/only works while Oreneta is running/)).toBeTruthy())
  })

  it('turning the toggle on saves enabled:true for this account', async () => {
    const setCalls = stubOof({
      kind: 'imap',
      settings: { enabled: false, startAt: 0, endAt: 0, subject: '', body: '' },
    })
    const view = render(<OofSettingsCard account={account()} />)
    await waitFor(() => expect(view.container.textContent).toContain('Automatic replies'))
    fireEvent.click(view.getByRole('switch'))
    await waitFor(() => expect(setCalls.length).toBeGreaterThan(0))
    expect(setCalls[0]).toMatchObject({ account: 'acct', settings: { enabled: true } })
  })
})

describe('the Exchange Automatic Replies card', () => {
  function ewsAccount() {
    return account({ provider: 'exchange', ews_url: 'https://mail.example.org/EWS/Exchange.asmx' })
  }

  it('renders the three-way state control, not a toggle', async () => {
    stubOof({
      kind: 'ews',
      settings: {
        state: 'disabled',
        externalAudience: 'none',
        startAt: 0,
        endAt: 0,
        internalReply: '',
        externalReply: '',
      },
    })
    const view = render(<OofSettingsCard account={ewsAccount()} />)
    await waitFor(() => expect(view.getByText('Scheduled')).toBeTruthy())
    expect(view.queryByRole('switch')).toBeNull()
  })

  it('never shows the client-side only-while-running warning', async () => {
    stubOof({
      kind: 'ews',
      settings: {
        state: 'enabled',
        externalAudience: 'all',
        startAt: 0,
        endAt: 0,
        internalReply: 'Away.',
        externalReply: 'Away.',
      },
    })
    const view = render(<OofSettingsCard account={ewsAccount()} />)
    await waitFor(() => expect(view.container.textContent).toContain('Message for people in your organization'))
    expect(view.queryByText(/only works while Oreneta is running/)).toBeNull()
  })

  it('picking Scheduled saves that state for this account', async () => {
    const setCalls = stubOof({
      kind: 'ews',
      settings: {
        state: 'disabled',
        externalAudience: 'none',
        startAt: 0,
        endAt: 0,
        internalReply: '',
        externalReply: '',
      },
    })
    const view = render(<OofSettingsCard account={ewsAccount()} />)
    await waitFor(() => expect(view.getByText('Scheduled')).toBeTruthy())
    fireEvent.click(view.getByText('Scheduled'))
    await waitFor(() => expect(setCalls.length).toBeGreaterThan(0))
    expect(setCalls[0]).toMatchObject({ account: 'acct', settings: { state: 'scheduled' } })
  })

  it('hides the external-audience reply field when nobody outside gets one', async () => {
    stubOof({
      kind: 'ews',
      settings: {
        state: 'enabled',
        externalAudience: 'none',
        startAt: 0,
        endAt: 0,
        internalReply: 'Away.',
        externalReply: '',
      },
    })
    const view = render(<OofSettingsCard account={ewsAccount()} />)
    await waitFor(() => expect(view.container.textContent).toContain('Message for people in your organization'))
    expect(view.queryByText('Message for people outside your organization')).toBeNull()
  })
})

describe('automatic reply dates (#48)', () => {
  const zone = process.env.TZ
  afterEach(() => {
    process.env.TZ = zone
  })

  it('show the day that was picked, east and west of UTC', () => {
    for (const tz of ['Europe/Madrid', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = tz
      expect(toDateInput(fromDateInput('2026-10-12', 'start')), tz).toBe('2026-10-12')
      expect(toDateInput(fromDateInput('2026-10-12', 'end')), tz).toBe('2026-10-12')
    }
  })

  it('include the whole end day, in local time', () => {
    process.env.TZ = 'Europe/Madrid'
    const start = fromDateInput('2026-10-12', 'start')
    const end = fromDateInput('2026-10-12', 'end')
    // Picked "until the 12th": still on at 18:00 that day, local time.
    const evening = Math.floor(Date.parse('2026-10-12T18:00:00') / 1000)
    expect(start <= evening && evening <= end).toBe(true)
    expect(end - start).toBe(24 * 60 * 60 - 1)
    // Across a daylight-saving change the day is still whole (25 hours).
    const changeDay = fromDateInput('2026-10-25', 'end') - fromDateInput('2026-10-25', 'start')
    expect(changeDay).toBe(25 * 60 * 60 - 1)
  })

  it('an empty date is no limit', () => {
    expect(fromDateInput('', 'end')).toBe(0)
    expect(toDateInput(0)).toBe('')
  })
})
