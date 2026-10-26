import { useMemo } from 'react'
import { useValue } from '@legendapp/state/react'
import { t as translate } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { compose$, withoutHydratedQuickReplyDraft } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { getActiveThread, mail$ } from '../../states/mail'
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

/** The reader or compose tab that covers the conversation, if one is active. */
export function documentTabOf(tabs: MessageTab[], activeTab: string): MessageTab | null {
  const tab = tabs.find((candidate) => candidate.id === activeTab)
  return tab?.kind === 'reader' || tab?.kind === 'compose' ? tab : null
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
  const activeDocumentTab = documentTabOf(tabs, activeTab)
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
 * The open conversation's messages as the conversation pane shows them (its
 * hydrated quick-reply draft left out), for the sidebar's Conversa and
 * Persona panels. `loading` while a freshly selected conversation loads and
 * the messages are still the previous one's, as the pane says it; `ours`
 * once any of them is this conversation's.
 */
export function useConversationMessages(activeThread: Message | null) {
  const messages = useValue(mail$.messages)
  const threadLoading = useValue(mail$.threadLoading)
  const quickReplyDraftId = useValue(compose$.quickReplyDraftId)
  const quickReplyDraftSaved = useValue(compose$.quickReplyDraftSaved)
  const displayMessages = useMemo(
    () => withoutHydratedQuickReplyDraft(messages, quickReplyDraftId, quickReplyDraftSaved),
    [messages, quickReplyDraftId, quickReplyDraftSaved],
  )
  const ours = !!activeThread && messages.some((message) => message.thread_id === activeThread.thread_id)
  return { displayMessages, loading: threadLoading && !ours, ours }
}

/**
 * Whether the conversation pane shows a conversation in mail now: in a board,
 * only with its conversation pane open, and not under a reader or compose tab.
 * The same answer as `useActiveConversation`, read where a selector tracks it.
 */
function conversationShown(): boolean {
  if (ui$.module.get() !== 'mail') return false
  if (kanban$.activeBoardId.get() && !kanban$.paneThreadId.get()) return false
  const activeTab = compose$.activeTab.get()
  const tab = compose$.tabs.get().find((candidate) => candidate.id === activeTab)
  if (tab?.kind === 'reader' || tab?.kind === 'compose') return false
  if (tab?.kind === 'thread' && tab.threadId === ui$.selectedThread.get()) return true
  return !!getActiveThread()
}

/**
 * Whether a conversation is open on screen, for the sidebar's Conversa panel
 * (ADR-0069 §1): in mail, or in a board with its conversation pane open, and
 * not under a reader or compose tab. Below 769 px the conversation pane shows
 * only in place of the list (`ui$.mobilePane`). A boolean selector, so a
 * change of the thread list or of the messages that leaves the answer as it
 * was draws nothing again.
 */
export function useConversationOpen(): boolean {
  const bothPanes = useWideWindow(769)
  const mobilePane = useValue(ui$.mobilePane)
  const shown = useValue(conversationShown)
  return shown && (bothPanes || mobilePane === 'conversation')
}
