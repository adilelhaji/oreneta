import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LabelsSettingsSection } from './LabelsSettingsSection'
import { accounts$ } from '../../states/accounts'
import { labels$ } from '../../states/labels'
import type { Account } from '../../types'
import type { Label } from '../../states/labels'

const account = (id: string, name: string): Account => ({
  id,
  email: `${id}@example.com`,
  display_name: name,
  provider: 'gmail',
  auth_type: 'gmail_oauth',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  tls: true,
})

const label = (id: string, name: string, links: Record<string, string> = {}): Label => ({
  id,
  name,
  colour: '#2056dd',
  inBar: false,
  links,
})

type Call = { command: string; payload: any }

describe('LabelsSettingsSection — remote linking', () => {
  let calls: Call[] = []

  beforeEach(() => {
    calls = []
    accounts$.set([account('acct-1', 'Work Gmail')])
    labels$.labels.set([label('l-1', 'Clients')])
    labels$.loaded.set(true)
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: unknown) => {
            calls.push({ command, payload })
            if (command === 'labels.list') return { labels: labels$.labels.peek() }
            return { ok: true }
          },
        },
      },
    }
  })

  afterEach(cleanup)

  it('opens the link panel and links a label to an account by name', async () => {
    render(<LabelsSettingsSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Remote links' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: 'acct-1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Remote label name' }), {
      target: { value: 'Important' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))

    await waitFor(() => {
      const call = calls.find((c) => c.command === 'labels.link')
      expect(call?.payload).toEqual({ label_id: 'l-1', account_id: 'acct-1', remote_name: 'Important' })
    })
    // Once linked, the account no longer offers itself again for a second link.
    await waitFor(() => expect(screen.getByText('Every account is already linked.')).toBeTruthy())
  })

  it('shows an existing link as a removable chip, and unlinks on request', async () => {
    labels$.labels.set([label('l-1', 'Clients', { 'acct-1': 'Important' })])

    render(<LabelsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote links' }))

    expect(screen.getByText('Work Gmail: Important')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))

    await waitFor(() => {
      const call = calls.find((c) => c.command === 'labels.unlink')
      expect(call?.payload).toEqual({ label_id: 'l-1', account_id: 'acct-1' })
    })
  })

  it('offers no link control at all when there is no mail account to link to', () => {
    accounts$.set([])
    render(<LabelsSettingsSection />)

    expect(screen.queryByRole('button', { name: 'Remote links' })).toBeNull()
  })

  it('keeps the link control reachable for a label that already has a link, even once every account is gone', () => {
    // The account the link points at no longer exists — removed, or the
    // account list just hasn't loaded yet — but the link itself is still
    // real data sitting in the store, and unlinking it must stay possible.
    labels$.labels.set([label('l-1', 'Clients', { 'gone-acct': 'Important' })])
    accounts$.set([])

    render(<LabelsSettingsSection />)

    expect(screen.getByRole('button', { name: 'Remote links' })).toBeTruthy()
  })
})
