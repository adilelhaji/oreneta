import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { MailboxColumns } from '../src/components/threads/MailboxColumns'
import { ThreadTable } from '../src/components/threads/ThreadTable'
import { hydrateSettings, settings$, SETTINGS_DB_KEYS } from '../src/states/settings'
import { DEFAULT_MAILBOX_COLUMNS, parseMailboxViews, resolveMailboxColumns } from '../src/lib/mailboxViews'
import { createFixture } from './fixtures'

const scope = { accountId: 'synthetic-account', folderId: 'INBOX' }
let original: Record<string, unknown> | null
let bridge: unknown
const calls = mock(async (_command: string, _payload: unknown) => ({ ok: true }))
beforeEach(() => {
  original = settings$.mailboxViews.peek()
  settings$.mailboxViews.set(null)
  bridge = (window as any).go
  ;(window as any).go = { main: { App: { Invoke: calls } } }
  calls.mockClear()
})
afterEach(() => {
  cleanup()
  ;(window as any).go = bridge
  settings$.mailboxViews.set(original)
})

describe('mailbox columns integration', () => {
  it('hydrates without writes, retains future JSON, and persists explicit changes through the existing key', () => {
    expect(SETTINGS_DB_KEYS).toContain('mailbox_views')
    const future = { version: 3, opaque: { anything: ['retain'] } }
    hydrateSettings({ mailbox_views: future })
    expect(settings$.mailboxViews.peek()).toEqual(future)
    expect(calls.mock.calls.filter(([command]) => command === 'app.prefsSet')).toHaveLength(0)
    const value = { version: 1, defaultColumns: [...DEFAULT_MAILBOX_COLUMNS], folders: [] }
    settings$.mailboxViews.set(value)
    expect(calls).toHaveBeenCalledWith('app.prefsSet', { key: 'mailbox_views', value })
    hydrateSettings({ mailbox_views: JSON.parse(JSON.stringify(value)) })
    expect(parseMailboxViews(settings$.mailboxViews.peek()).kind).toBe('ready')
  })
  it('validates widths, preserves subject, cancels edits, and saves an independent folder view', () => {
    const view = render(<MailboxColumns {...scope} />)
    fireEvent.click(view.getByRole('button', { name: 'Columns' }))
    expect((view.getByRole('checkbox', { name: 'Subject' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'folder' } })
    fireEvent.click(view.getByRole('checkbox', { name: 'Account' }))
    fireEvent.change(view.getByRole('spinbutton', { name: 'Width (px): From' }), { target: { value: '641' } })
    expect((view.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByRole('alert')).toBeTruthy()
    const invalid = view.getByRole('spinbutton', { name: 'Width (px): From' })
    expect(invalid.getAttribute('aria-invalid')).toBe('true')
    expect(invalid.getAttribute('aria-describedby')).toBe(view.getByRole('alert').id)
    fireEvent.change(view.getByRole('spinbutton', { name: 'Width (px): From' }), { target: { value: '160' } })
    fireEvent.click(view.getByRole('button', { name: 'Move up: Account' }))
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    const columns = resolveMailboxColumns(settings$.mailboxViews.peek(), scope)!
    expect(columns[0].width).toBe(160)
    expect(columns[2]).toMatchObject({ id: 'account', visible: true })
    expect(resolveMailboxColumns(settings$.mailboxViews.peek(), { ...scope, accountId: 'other' })).toEqual([
      ...DEFAULT_MAILBOX_COLUMNS,
    ])
    const saved = settings$.mailboxViews.peek()
    fireEvent.click(view.getByRole('button', { name: 'Columns' }))
    fireEvent.click(view.getByRole('checkbox', { name: 'From' }))
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(settings$.mailboxViews.peek()).toEqual(saved)
    fireEvent.click(view.getByRole('button', { name: 'Columns' }))
    fireEvent.click(view.getByRole('button', { name: 'Use general view' }))
    expect(resolveMailboxColumns(settings$.mailboxViews.peek(), scope)).toEqual([...DEFAULT_MAILBOX_COLUMNS])
  })
  it('requires explicit reset for a future version instead of replacing it on open or cancel', () => {
    const future = { version: 2, unknown: 'preserve' }
    settings$.mailboxViews.set(future)
    const view = render(<MailboxColumns {...scope} />)
    fireEvent.click(view.getByRole('button', { name: 'Columns' }))
    expect(view.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(settings$.mailboxViews.peek()).toEqual(future)
    fireEvent.click(view.getByRole('button', { name: 'Columns' }))
    fireEvent.click(view.getByRole('button', { name: 'Reset all column views' }))
    expect(settings$.mailboxViews.peek()).toBeNull()
  })
  it('renders configured order while account stays informational and selection remains separate', () => {
    const fixture = createFixture()
    settings$.mailboxViews.set({
      version: 1,
      defaultColumns: [...DEFAULT_MAILBOX_COLUMNS].reverse().map((column) => ({ ...column, visible: true })),
      folders: [],
    })
    const select = mock(() => {})
    const toggle = mock(() => {})
    const view = render(
      <ThreadTable
        {...scope}
        accounts={[fixture.account]}
        threads={[fixture.threads[0]]}
        selectedThread=""
        showAccount
        onSelect={select}
        onContextMenu={() => {}}
        onToggleSelect={toggle}
      />,
    )
    const headers = view.getAllByRole('columnheader')
    expect(headers.slice(1).map((header) => header.textContent)).toEqual(['Account', 'Date', 'Subject', 'From'])
    expect(within(headers[1]).queryByRole('button')).toBeNull()
    fireEvent.click(view.getByRole('checkbox'))
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
  })
  it('keeps the opened marker visible when sender is hidden and multiple rows are selected', () => {
    const fixture = createFixture()
    settings$.mailboxViews.set({
      version: 1,
      defaultColumns: DEFAULT_MAILBOX_COLUMNS.map((column) => ({ ...column, visible: column.id !== 'sender' })),
      folders: [],
    })
    const first = fixture.threads[0]
    const second = { ...first, id: 'another', thread_id: 'another-thread', subject: 'Another conversation' }
    const view = render(
      <ThreadTable
        {...scope}
        accounts={[fixture.account]}
        threads={[first, second]}
        selectedThread={first.thread_id}
        showAccount
        onSelect={() => {}}
        onContextMenu={() => {}}
        onToggleSelect={() => {}}
        isBulkSelected={() => true}
      />,
    )
    const opened = view.container.querySelector('[data-opened="true"]')!
    expect(opened.getAttribute('data-bulk-selected')).toBe('true')
    expect(opened.querySelector('button[aria-current="true"]')).not.toBeNull()
    expect(view.getByRole('button', { name: /Another conversation/ }).closest('tr')?.hasAttribute('data-opened')).toBe(false)
    expect(view.queryByRole('columnheader', { name: 'From' })).toBeNull()
  })
})
