// Chat over XMPP (#111, ADR-0036). The core holds the conversations and
// sends only what the person sends; this keeps what is on screen.
// Group chats and files (ADR-0044): rooms the person joined, invitations
// waiting for their answer, and files going up with their progress.
// Presence, mentions and private messages in rooms (ADR-0055): the person's
// own status, what the session knows of contacts and of who is in each room,
// and private conversations `room@service/nick`.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { ui$ } from './ui'

export type ChatAccount = { id: string; jid: string; host: string; port: number }
export type ChatConversation = {
  conversation: string
  last_body: string
  last_stamp: number
  last_direction: 'in' | 'out'
  unread: number
  /** `private`: with someone in a room, through that room. */
  kind?: 'chat' | 'private'
  room?: string | null
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
  kind?: 'chat' | 'groupchat' | 'private'
  /** Someone else in a room named the person. */
  mention?: boolean
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
export type OwnShow = 'available' | 'away' | 'dnd' | 'invisible'
export type ContactShow = 'chat' | 'available' | 'away' | 'xa' | 'dnd' | 'offline'
export type OwnPresence = {
  show: OwnShow
  status: string
  /** Where it stands on the connection; `withheld`: invisible chosen but the server cannot hide. */
  applied: 'offline' | 'waiting' | 'announced' | 'invisible' | 'withheld'
  invisible_supported: boolean | null
}
export type ChatOccupant = { nick: string; show: ContactShow; role: string }

export const DEFAULT_OWN_PRESENCE: OwnPresence = {
  show: 'available',
  status: '',
  applied: 'offline',
  invisible_supported: null,
}

/** What the open account's session knows about presence (ADR-0055). */
export const chatPresence$ = observable({
  own: { ...DEFAULT_OWN_PRESENCE } as OwnPresence,
  contacts: {} as Record<string, { show: ContactShow; status: string }>,
  requests: [] as string[],
  /** Who is in the open room. */
  occupants: [] as ChatOccupant[],
})

/** A conversation as the core keeps it: the address in lower case, a nickname as it is. */
export function normalizeConversation(conversation: string) {
  const trimmed = conversation.trim()
  const slash = trimmed.indexOf('/')
  return slash < 0 ? trimmed.toLowerCase() : `${trimmed.slice(0, slash).toLowerCase()}/${trimmed.slice(slash + 1)}`
}

/** A private conversation's room and nickname. */
export function splitPrivate(conversation: string): { room: string; nick: string } | null {
  const slash = conversation.indexOf('/')
  if (slash <= 0 || slash === conversation.length - 1) return null
  return { room: conversation.slice(0, slash), nick: conversation.slice(slash + 1) }
}

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
  await Promise.all([refreshConversations(), loadPresence()])
}

/** The person's status and what the session knows of others, for the open account. */
export async function loadPresence() {
  const account = messaging$.account.peek()
  if (!account) {
    chatPresence$.set({ own: { ...DEFAULT_OWN_PRESENCE }, contacts: {}, requests: [], occupants: [] })
    return
  }
  const known = await invoke<{
    own?: OwnPresence
    contacts?: Record<string, { show: ContactShow; status: string }>
    requests?: string[]
  }>('chat.presence', { account })
  // Another account was picked meanwhile: this answer is not for the screen.
  if (messaging$.account.peek() !== account) return
  chatPresence$.own.set({ ...DEFAULT_OWN_PRESENCE, ...(known?.own ?? {}) })
  chatPresence$.contacts.set(known?.contacts ?? {})
  const requests = known?.requests
  chatPresence$.requests.set(Array.isArray(requests) ? requests : [])
}

/** Sets the person's status; the core says it to contacts allowed to see it. */
export async function setOwnPresence(show: OwnShow, status: string) {
  const account = messaging$.account.peek()
  if (!account) return
  const saved = await invoke<{ show: OwnShow; status: string }>('chat.setPresence', { account, show, status })
  if (saved) chatPresence$.own.set({ ...chatPresence$.own.peek(), show: saved.show, status: saved.status })
}

/** Asks to see someone's status; they decide. */
export async function askToSeeStatus(jid: string) {
  await invoke('chat.subscribe', { account: messaging$.account.peek(), jid })
}

/** Answers someone's request to see the person's status. */
export async function answerStatusRequest(jid: string, allow: boolean) {
  await invoke('chat.answerSubscription', { account: messaging$.account.peek(), jid, allow })
  chatPresence$.requests.set(chatPresence$.requests.peek().filter((j) => j !== jid))
}

/** Who is in a room now, as the room said on this connection. */
export async function loadOccupants(room = messaging$.conversation.peek()) {
  const account = messaging$.account.peek()
  if (!account || !room) return
  const list = await invoke<ChatOccupant[]>('chat.occupants', { account, room })
  if (messaging$.account.peek() === account && messaging$.conversation.peek() === room)
    chatPresence$.occupants.set(Array.isArray(list) ? list : [])
}

/** A system notification was clicked: the Chat view, its account, that conversation. */
export async function openChatFromNotification(account: string, conversation: string) {
  ui$.calendarOpen.set(false)
  ui$.peopleOpen.set(false)
  ui$.tasksOpen.set(false)
  ui$.notesOpen.set(false)
  ui$.attachmentsOpen.set(false)
  ui$.messagingOpen.set(true)
  if (account) messaging$.account.set(account)
  await loadMessaging()
  await openConversation(conversation)
}

/** Opens a private conversation with someone in a room. */
export async function openPrivate(room: string, nick: string) {
  await openConversation(`${room}/${nick}`)
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
  messaging$.conversation.set(normalizeConversation(conversation))
  chatPresence$.occupants.set([])
  await refreshHistory()
  if (isRoom()) await loadOccupants()
  const account = messaging$.account.peek()
  if (account) {
    await invoke('chat.markRead', { account, conversation: messaging$.conversation.peek() })
    await refreshConversations()
  }
}

/** Sends to the open conversation; in a room, with the nicknames picked from the suggestions. */
export async function sendChat(body: string, mentions: string[] = []) {
  const account = messaging$.account.peek()
  const conversation = messaging$.conversation.peek()
  if (!account || !conversation || !body.trim()) return
  await invoke('chat.send', mentions.length ? { account, conversation, body, mentions } : { account, conversation, body })
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
    jid?: string
    show?: string
    status?: string
    answered?: boolean
    applied?: OwnPresence['applied']
    invisible_supported?: boolean | null
  }

let occupantsTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Called for the core's `chat.changed`, `chat.status`, `chat.room`,
 * `chat.invitation`, `chat.progress` and `chat.uploaded`; and (ADR-0055)
 * `chat.own`, `chat.presence`, `chat.subscription` and `chat.occupants`.
 */
export function onChatEvent(name: string, detail: ChatEventDetail) {
  const current = detail.account === messaging$.account.peek()
  if (name === 'chat.own' && current) {
    const { show, status, applied, invisible_supported } = detail
    chatPresence$.own.set({
      ...chatPresence$.own.peek(),
      ...(show ? { show: show as OwnShow } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(applied ? { applied } : {}),
      ...(invisible_supported !== undefined ? { invisible_supported } : {}),
    })
  }
  if (name === 'chat.presence' && current && detail.jid) {
    // Offline stays known: the contact allowed it, so nothing is asked again.
    chatPresence$.contacts[detail.jid].set({
      show: (detail.show ?? 'available') as ContactShow,
      status: detail.status ?? '',
    })
  }
  if (name === 'chat.subscription' && current && detail.jid) {
    const others = chatPresence$.requests.peek().filter((j) => j !== detail.jid)
    chatPresence$.requests.set(detail.answered ? others : [...others, detail.jid])
  }
  if (name === 'chat.occupants' && current && detail.room === messaging$.conversation.peek()) {
    // A room says who is in it one person at a time: ask once they are done.
    clearTimeout(occupantsTimer)
    occupantsTimer = setTimeout(() => void loadOccupants(detail.room), 150)
  }
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
