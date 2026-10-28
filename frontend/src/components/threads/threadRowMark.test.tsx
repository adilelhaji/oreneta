import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadListItem } from './ThreadListItem'
import { ThreadTable } from './ThreadTable'
import type { Message } from '../../types'

// Hotkeys read this mark to tell which conversation a focused row stands for (#369).
const thread = {
  id: 'acc:inbox:thread:7#1',
  account_id: 'acc',
  folder_id: 'inbox',
  thread_id: 'acc:inbox:thread:7',
  from_name: 'Sender',
  from_addr: 'sender@example.com',
  to: 'me@example.com',
  subject: 'Subject',
  preview: '',
  body: '',
  date: 1_780_000_000,
  unread: false,
  starred: false,
  has_attachments: false,
} as Message

describe('rows name their conversation', () => {
  it('ThreadListItem', () => {
    const html = renderToStaticMarkup(
      <ThreadListItem thread={thread} accounts={[]} selectedAccount="acc" selectedThread="" onSelect={() => {}} />,
    )
    expect(html).toContain('data-thread-row="acc:inbox:thread:7"')
  })

  it('ThreadTable', () => {
    const html = renderToStaticMarkup(
      <ThreadTable
        accountId="acc"
        threads={[thread]}
        accounts={[]}
        selectedThread=""
        showAccount={false}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />,
    )
    expect(html).toContain('data-thread-row="acc:inbox:thread:7"')
  })
})
