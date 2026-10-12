// Chat over XMPP (#111, ADR-0036). The core holds the conversations and
// sends only what the person sends; this keeps what is on screen.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type ChatAccount = { id: string; jid: string; host: string; port: number }
export type ChatConversation = {
  conversation: string
  last_body: string
  last_stamp: number
  last_direction: 'in' | 'out'
  unread: number
}
export type ChatMessage = {
  account: string
  conversation: string
  id: string
  stanza_id: string | null
  direction: 'in' | 'out'
  sender: string
  body: string
  stamp: number
  state: 'sending' | 'sent' | 'accepted' | 'delivered' | 'uncertain' | 'failed' | 'received'
}
export type ChatStatus = { account: string; state: 'online' | 'offline' | 'error' | 'stopped'; message?: string }

export const messaging$ = observable({
  accounts: [] as ChatAccount[],
  status: {} as Record<string, ChatStatus>,
  account: '',
  conversations: [] as ChatConversation[],
  conversation: '',
  history: [] as ChatMessage[],
})

export async function loadMessaging() {
  const [accounts, status] = await Promise.all([
    invoke<ChatAccount[]>('chat.accounts', {}),
    invoke<Record<string, ChatStatus>>('chat.status', {}),
  ])
  messaging$.accounts.set(accounts ?? [])
  messaging$.status.set(status ?? {})
  const current = messaging$.account.peek()
  if (!accounts?.some((a) => a.id === current)) messaging$.account.set(accounts?.[0]?.id ?? '')
  await refreshConversations()
}

export async function refreshConversations() {
  const account = messaging$.account.peek()
  if (!account) {
    messaging$.conversations.set([])
    return
  }
  messaging$.conversations.set((await invoke<ChatConversation[]>('chat.conversations', { account })) ?? [])
  if (messaging$.conversation.peek()) await refreshHistory()
}

export async function refreshHistory() {
  const account = messaging$.account.peek()
  const conversation = messaging$.conversation.peek()
  if (!account || !conversation) return
  messaging$.history.set((await invoke<ChatMessage[]>('chat.history', { account, conversation })) ?? [])
}

/** Opens a conversation and counts it as read. */
export async function openConversation(conversation: string) {
  messaging$.conversation.set(conversation.trim().toLowerCase())
  await refreshHistory()
  const account = messaging$.account.peek()
  if (account) {
    await invoke('chat.markRead', { account, conversation: messaging$.conversation.peek() })
    await refreshConversations()
  }
}

export async function sendChat(body: string) {
  const account = messaging$.account.peek()
  const conversation = messaging$.conversation.peek()
  if (!account || !conversation || !body.trim()) return
  await invoke('chat.send', { account, conversation, body })
  await refreshConversations()
}

/** Sends a failed or uncertain message again, by the person's choice. */
export async function retryChat(id: string) {
  await invoke('chat.retry', { account: messaging$.account.peek(), id })
  await refreshHistory()
}

export async function saveChatAccount(account: ChatAccount, password: string) {
  await invoke('chat.save', { account, password })
  messaging$.account.set(account.id)
  await loadMessaging()
}

export async function removeChatAccount(id: string) {
  await invoke('chat.remove', { id })
  messaging$.conversation.set('')
  messaging$.history.set([])
  await loadMessaging()
}

/** Called for the core's `chat.changed` and `chat.status`. */
export function onChatEvent(name: string, detail: { account?: string; conversation?: string } & Partial<ChatStatus>) {
  if (name === 'chat.status' && detail.account) {
    messaging$.status[detail.account].set(detail as ChatStatus)
  }
  if (name === 'chat.changed' && detail.account === messaging$.account.peek()) {
    void refreshConversations().then(async () => {
      // A message arriving in the conversation on screen is read as it arrives.
      const open = messaging$.conversation.peek()
      if (open && detail.conversation === open) {
        await invoke('chat.markRead', { account: detail.account, conversation: open })
        await refreshConversations()
      }
    })
  }
}
