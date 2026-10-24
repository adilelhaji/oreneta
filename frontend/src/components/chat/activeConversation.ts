import { useValue } from '@legendapp/state/react'
import { t as translate } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { getActiveThread } from '../../states/mail'
import { ui$ } from '../../states/ui'
import type { Message, MessageTab } from '../../types'
import { useWideWindow } from '../resizer/useElementWidth'

function threadFromTab(tab: MessageTab, fallback: Message | null): Message {
  if (fallback?.thread_id === tab.threadId) return fallback
  return {
    id: tab.messageId || tab.threadId,
    account_id: tab.accountId ?? '',
    folder_id: tab.folderId ?? 'inbox',
    thread_id: tab.threadId,
    from_name: '',
    from_addr: tab.from,
    to: '',
    subject: tab.subject || translate('threads.noSubject'),
    preview: '',
    body: '',
    date: tab.date ?? 0,
    unread: false,
    starred: false,
    has_attachments: false,
  }
}

/**
 * The conversation the conversation pane shows: the selected thread, or the
 * thread tab on top of it, and whether a reader or compose tab covers it. The
 * pane (MessagePane) and the app sidebar's Conversa panel read the same one.
 */
export function useActiveConversation() {
  const accounts = useValue(accounts$)
  const selectedAccountId = useValue(ui$.selectedAccount)
  const selectedThreadId = useValue(ui$.selectedThread)
  const tabs = useValue(compose$.tabs)
  const activeTab = useValue(compose$.activeTab)
  const activeTabData = tabs.find((tab) => tab.id === activeTab) ?? null
  const activeDocumentTab = activeTabData?.kind === 'reader' || activeTabData?.kind === 'compose' ? activeTabData : null
  const listedActiveThread = useValue(getActiveThread)
  const activeThread =
    activeTabData?.kind === 'thread' && activeTabData.threadId === selectedThreadId
      ? threadFromTab(activeTabData, listedActiveThread)
      : listedActiveThread
  const activeAccount = activeThread
    ? accounts.find((account) => account.id === activeThread.account_id)
    : (accounts.find((account) => account.id === selectedAccountId) ?? null)
  const isRSS = activeAccount?.provider === 'rss' || activeAccount?.auth_type === 'rss'
  return { accounts, activeTab, activeTabData, activeDocumentTab, activeThread, activeAccount, isRSS }
}

/**
 * Whether a conversation is open on screen, for the sidebar's Conversa panel
 * (ADR-0069 §1): in mail, or in a board with its conversation pane open, and
 * not under a reader or compose tab. Below 769 px the conversation pane shows
 * only in place of the list (`ui$.mobilePane`).
 */
export function useConversationOpen(): boolean {
  const module = useValue(ui$.module)
  const boardId = useValue(kanban$.activeBoardId)
  const paneThreadId = useValue(kanban$.paneThreadId)
  const mobilePane = useValue(ui$.mobilePane)
  const bothPanes = useWideWindow(769)
  const { activeThread, activeDocumentTab } = useActiveConversation()
  return (
    module === 'mail' &&
    !!activeThread &&
    !activeDocumentTab &&
    (!boardId || !!paneThreadId) &&
    (bothPanes || mobilePane === 'conversation')
  )
}
