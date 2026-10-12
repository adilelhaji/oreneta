// Chat over XMPP (#111, ADR-0036). The core holds the conversations and
// sends only what the person sends; this keeps what is on screen.
// Group chats and files (ADR-0044): rooms the person joined, invitations
// waiting for their answer, and files going up with their progress.

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
  kind?: 'chat' | 'groupchat'
  /** A file shared as a link; fetched only when the person saves it. */
  file_url?: string | null
  file_name?: string | null
  file_size?: number | null
}
export type ChatRoom = {
  account: string
  room: string
  nick: string
  has_password: boolean
  last_body: string
  last_stamp: number
  unread: number
  state: 'offline' | 'joining' | 'joined' | 'out' | 'error'
  detail?: { condition?: string; message?: string } | null
}
export type ChatInvitation = {
  account: string
  room: string
  inviter: string
  reason: string
  has_password: boolean
  received_at: number
}
export type ChatUpload = {
  conversation: string
  name: string
  done: number
  total: number
  error?: { message: string; detail?: { code: string } }
}
export type PickedFile = { path: string; name: string; size: number }
export type ChatStatus = { account: string; state: 'online' | 'offline' | 'error' | 'stopped'; message?: string }

export const messaging$ = observable({
  accounts: [] as ChatAccount[],
  status: {} as Record<string, ChatStatus>,
  account: '',
  conversations: [] as ChatConversation[],
  conversation: '',
  history: [] as ChatMessage[],
  rooms: [] as ChatRoom[],
  invitations: [] as ChatInvitation[],
  uploads: {} as Record<string, ChatUpload>,
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
    messaging$.rooms.set([])
    messaging$.invitations.set([])
    return
  }
  const [conversations, rooms, invitations] = await Promise.all([
    invoke<ChatConversation[]>('chat.conversations', { account }),
    invoke<ChatRoom[]>('chat.rooms', { account }),
    invoke<ChatInvitation[]>('chat.invitations', { account }),
  ])
  messaging$.conversations.set(conversations ?? [])
  messaging$.rooms.set(Array.isArray(rooms) ? rooms : [])
  messaging$.invitations.set(Array.isArray(invitations) ? invitations : [])
  if (messaging$.conversation.peek()) await refreshHistory()
}

/** Whether the open conversation (or `conversation`) is a room. */
export function isRoom(conversation = messaging$.conversation.peek()) {
  return messaging$.rooms.peek().some((r) => r.room === conversation)
}

/** Joins a room by its address, with a nickname and, if it has one, its password. */
export async function joinRoom(room: string, nick: string, password: string) {
  const account = messaging$.account.peek()
  const joined = await invoke<{ room: string }>('chat.join', { account, room, nick, password })
  await refreshConversations()
  await openConversation(joined?.room ?? room)
}

/** Leaves a room: it is not joined again, and what was kept of it here goes. */
export async function leaveRoom(room: string) {
  await invoke('chat.leave', { account: messaging$.account.peek(), room })
  if (messaging$.conversation.peek() === room) {
    messaging$.conversation.set('')
    messaging$.history.set([])
  }
  await refreshConversations()
}

/** Sets an invitation aside without joining. */
export async function dismissInvitation(room: string) {
  await invoke('chat.dismissInvitation', { account: messaging$.account.peek(), room })
  await refreshConversations()
}

export async function pickChatFile(): Promise<PickedFile | null> {
  const picked = await invoke<PickedFile | { cancelled: true }>('chat.pickFile', {})
  return picked && 'path' in picked ? picked : null
}

/** Sends a file to the open conversation; its progress shows until it is sent. */
export async function sendChatFile(file: PickedFile, uploadId = `up-${Date.now().toString(36)}`) {
  const account = messaging$.account.peek()
  const conversation = messaging$.conversation.peek()
  if (!account || !conversation) return
  messaging$.uploads[uploadId].set({ conversation, name: file.name, done: 0, total: file.size })
  try {
    await invoke('chat.sendFile', { account, conversation, path: file.path, upload_id: uploadId })
  } catch (error) {
    messaging$.uploads[uploadId].set({
      conversation,
      name: file.name,
      done: 0,
      total: file.size,
      error: { message: error instanceof Error ? error.message : String(error) },
    })
  }
}

export async function cancelChatUpload(uploadId: string) {
  await invoke('chat.cancelUpload', { upload_id: uploadId })
}

export function dismissChatUpload(uploadId: string) {
  messaging$.uploads[uploadId].delete()
}

/** Saves a received file where the person chooses; only then is it fetched. */
export async function saveChatFile(message: ChatMessage): Promise<{ saved: boolean }> {
  return invoke('chat.saveFileAs', {
    account: messaging$.account.peek(),
    url: message.file_url,
    name: message.file_name ?? '',
  })
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
  messaging$.rooms.set([])
  messaging$.invitations.set([])
  messaging$.history.set([])
  await loadMessaging()
}

type ChatEventDetail = { account?: string; conversation?: string; room?: string } & Partial<ChatStatus> & {
    upload_id?: string
    done?: number
    total?: number
    id?: string
    error?: ChatUpload['error']
  }

/**
 * Called for the core's `chat.changed`, `chat.status`, `chat.room`,
 * `chat.invitation`, `chat.progress` and `chat.uploaded`.
 */
export function onChatEvent(name: string, detail: ChatEventDetail) {
  if (name === 'chat.status' && detail.account) {
    messaging$.status[detail.account].set(detail as ChatStatus)
  }
  if ((name === 'chat.room' || name === 'chat.invitation') && detail.account === messaging$.account.peek()) {
    void refreshConversations()
  }
  if (name === 'chat.progress' && detail.upload_id) {
    const upload = messaging$.uploads[detail.upload_id].peek()
    if (upload)
      messaging$.uploads[detail.upload_id].set({ ...upload, done: detail.done ?? 0, total: detail.total ?? 0 })
  }
  if (name === 'chat.uploaded' && detail.upload_id) {
    const upload = messaging$.uploads[detail.upload_id].peek()
    // Sent, or cancelled by the person: nothing more to show. Otherwise, why not.
    if (!detail.error || detail.error.detail?.code === 'cancelled') messaging$.uploads[detail.upload_id].delete()
    else if (upload) messaging$.uploads[detail.upload_id].set({ ...upload, error: detail.error })
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
