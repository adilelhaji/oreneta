import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountSection } from './AccountSection'
import { KanbanThreadCard } from './KanbanThreadCard'
import { accounts$ } from '../../states/accounts'
import type { Account, Message } from '../../types'
import type { ThreadContextMenuController } from '../threads/ThreadContextMenu'

test('Graph disables folder creation and kanban dragging without affecting legacy accounts', () => {
  const previous = accounts$.peek()
  try {
    for (const auth_type of ['graph_oauth', 'password'] as const) {
      accounts$.set([
        { id: 'capability-test', auth_type, display_name: 'Reader', email: 'reader@example.test' } as Account,
      ])
      const section = renderToStaticMarkup(
        <AccountSection
          group={{ accountId: 'capability-test', label: 'Reader', isRSS: false, folders: [], tree: [] }}
          selected={new Set()}
          onToggle={() => {}}
          onCreateFolder={async () => {
            throw new Error('must not execute')
          }}
        />,
      )
      const node = document.createElement('div')
      node.innerHTML = section
      const create = node.querySelector('button[title="New folder or label"]') as HTMLButtonElement
      expect(create).not.toBeNull()
      expect(create.disabled).toBe(auth_type === 'graph_oauth')
      node.innerHTML = renderToStaticMarkup(
        <KanbanThreadCard
          boardId="board"
          ownerKey="owner"
          column={{ accountId: 'capability-test', folderId: 'INBOX' }}
          thread={
            {
              id: 'message',
              thread_id: 'thread',
              account_id: 'capability-test',
              folder_id: 'INBOX',
              from_name: 'Sender',
              from_addr: 'sender@example.test',
              subject: 'Reader',
              preview: '',
              date: 1,
              unread: true,
              starred: false,
            } as Message
          }
          threadMenu={{ open: () => {} } as unknown as ThreadContextMenuController}
        />,
      )
      expect(node.firstElementChild?.getAttribute('aria-disabled')).toBe(String(auth_type === 'graph_oauth'))
    }
  } finally {
    accounts$.set(previous)
  }
})
