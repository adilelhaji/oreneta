import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MailNavigationView } from './MailNavigation'
import type { Account, Folder } from '../../types'

afterEach(cleanup)
const account: Account = {
  id: 'test-account',
  email: 'alex@example.test',
  display_name: 'Alex',
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
}
const folders: Folder[] = [
  { id: 'INBOX', account_id: account.id, name: 'Inbox', role: 'inbox', unread: 3 },
  { id: 'Sent', account_id: account.id, name: 'Sent', role: 'sent', unread: 0 },
]
const fixture = { account, folders }
const props = {
  accounts: [fixture.account],
  folders: fixture.folders,
  selectedAccount: fixture.account.id,
  selectedFolder: 'INBOX',
  unifiedVisible: true,
  onAccount: (_id: string) => {},
  onFolder: (_id: string) => {},
}

describe('production mailbox navigation', () => {
  it('uses real IDs, labels the current folder and shows backend unread counts', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} onFolder={(id) => destinations.push(id)} />)
    expect(view.getByRole('button', { name: 'Inbox 3' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(view.getByRole('button', { name: 'Sent' }))
    expect(destinations).toEqual(['Sent'])
    view.rerender(
      <MailNavigationView {...props} folders={fixture.folders.map((folder) => ({ ...folder, unread: 9 }))} />,
    )
    expect(view.getByRole('button', { name: 'Inbox 9' })).toBeTruthy()
  })
  it('keeps structural parents non-selectable and navigates custom delimiter children', () => {
    const destinations: string[] = []
    const view = render(
      <MailNavigationView
        {...props}
        folders={[
          {
            id: 'server-id-42',
            account_id: fixture.account.id,
            name: 'Projects.Reviews',
            delimiter: '.',
            role: '',
            unread: 2,
          },
        ]}
        onFolder={(id) => destinations.push(id)}
      />,
    )
    expect(view.queryByRole('button', { name: 'Projects' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Collapse Projects' }))
    expect(view.queryByRole('button', { name: 'Reviews 2' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Expand Projects' }))
    fireEvent.click(view.getByRole('button', { name: 'Reviews 2' }))
    expect(destinations).toEqual(['server-id-42'])
  })
  it('filters folder names without selecting or writing a mail query', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} onFolder={(id) => destinations.push(id)} />)
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'zzzz' } })
    expect(view.getByText('No matching folders')).toBeTruthy()
    expect(destinations).toEqual([])
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'sent' } })
    expect(view.getByRole('button', { name: 'Sent' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Inbox 3' })).toBeNull()
  })
  it('exposes account and unified destinations independently of folder selection', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} onAccount={(id) => destinations.push(id)} />)
    fireEvent.click(view.getByRole('button', { name: /Alex.*alex@example.test/ }))
    fireEvent.click(view.getByRole('button', { name: 'Unified inbox' }))
    expect(destinations).toEqual([fixture.account.id, 'unified'])
    view.rerender(<MailNavigationView {...props} unifiedVisible={false} />)
    expect(view.queryByRole('button', { name: 'Unified inbox' })).toBeNull()
  })
  it('does not invent folders when the cache is empty or an account is RSS', () => {
    const destinations: string[] = []
    const view = render(<MailNavigationView {...props} folders={[]} />)
    expect(view.getByText('No folders available')).toBeTruthy()
    view.rerender(
      <MailNavigationView
        {...props}
        accounts={[{ ...fixture.account, provider: 'rss', auth_type: 'rss' }]}
        onFolder={(id) => destinations.push(id)}
      />,
    )
    expect(view.queryByRole('searchbox')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'All feeds' }))
    expect(destinations).toEqual(['inbox'])
  })
})
