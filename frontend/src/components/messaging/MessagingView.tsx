import { useEffect, useRef, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { AlertTriangle, Check, CheckCheck, Clock, FileText, MessagesSquare, Paperclip, Send, Users } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import {
  cancelChatUpload,
  dismissChatUpload,
  dismissInvitation,
  joinRoom,
  leaveRoom,
  loadMessaging,
  messaging$,
  openConversation,
  pickChatFile,
  removeChatAccount,
  retryChat,
  saveChatAccount,
  saveChatFile,
  sendChat,
  sendChatFile,
  refreshConversations,
  type ChatMessage,
  type ChatRoom,
} from '../../states/messaging'
import { formatFileSize } from '../chat/messageHelpers'
import { confirmAction, showToast } from '../../states/ui'
import { Button } from '../button/Button'
import { CompactNavigation } from '../sidenav/CompactNavigation'

const input = 'rounded-control-sm border border-border bg-app px-2.5 py-1.5 text-sm text-primary'

/**
 * Chat over XMPP (#111, ADR-0036): the person's conversations, each with
 * what was said, and for what they sent, where it got to. Group chats and
 * files (ADR-0044): rooms beside the conversations, invitations offered
 * (never acted on alone), files sent with their progress and received as a
 * link saved only when the person asks.
 */
export function MessagingView() {
  const { t } = useTranslation()
  const accounts = useValue(messaging$.accounts)
  const account = useValue(messaging$.account)
  const status = useValue(messaging$.status)
  const conversations = useValue(messaging$.conversations)
  const conversation = useValue(messaging$.conversation)
  const history = useValue(messaging$.history)
  const rooms = useValue(messaging$.rooms)
  const invitations = useValue(messaging$.invitations)
  const uploads = useValue(messaging$.uploads)
  const [joining, setJoining] = useState<{ room: string; nick: string; password: string } | null>(null)
  const [newChat, setNewChat] = useState('')
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadMessaging().catch(() => {})
  }, [])
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [history.length, conversation])

  if (accounts.length === 0) return <ChatSetup />

  const state = status[account]?.state
  const me = accounts.find((a) => a.id === account)
  const openRoom = rooms.find((r) => r.room === conversation)
  const roomUploads = Object.entries(uploads).filter(([, u]) => u.conversation === conversation)
  const startJoin = (room = '') => setJoining({ room, nick: me?.jid.split('@')[0] ?? '', password: '' })
  const join = async () => {
    if (!joining) return
    try {
      await joinRoom(joining.room.trim(), joining.nick.trim(), joining.password)
      setJoining(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }
  const attach = async () => {
    try {
      const file = await pickChatFile()
      if (file) await sendChatFile(file)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }
  const send = async () => {
    const body = draft
    if (!body.trim()) return
    setDraft('')
    try {
      await sendChat(body)
    } catch (error) {
      setDraft(body)
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <div className="flex min-w-0 flex-1 bg-chats">
      <section
        aria-label={t('messaging.conversations', { defaultValue: 'Conversations' })}
        className={`flex w-72 shrink-0 flex-col border-r border-border max-[769px]:w-full ${conversation ? 'max-[769px]:hidden' : ''}`}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <CompactNavigation />
          <MessagesSquare size={16} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
          {accounts.length > 1 ? (
            <select
              aria-label={t('messaging.account', { defaultValue: 'Chat account' })}
              value={account}
              onChange={(e) => {
                messaging$.account.set(e.target.value)
                messaging$.conversation.set('')
                void refreshConversations()
              }}
              className={input}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.jid}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-sm font-semibold text-primary">{accounts[0].jid}</span>
          )}
          <span
            role="status"
            className={`ml-auto text-caption ${state === 'online' ? 'text-success' : 'text-secondary'}`}
            title={status[account]?.message}
          >
            {state === 'online'
              ? t('messaging.online', { defaultValue: 'Connected' })
              : t('messaging.offline', { defaultValue: 'Not connected' })}
          </span>
        </header>
        <form
          className="flex gap-1.5 border-b border-border px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newChat.includes('@')) void openConversation(newChat).then(() => setNewChat(''))
          }}
        >
          <input
            aria-label={t('messaging.newChat', { defaultValue: 'Chat with (address)' })}
            placeholder="name@server.example"
            value={newChat}
            onChange={(e) => setNewChat(e.target.value)}
            className={`${input} min-w-0 flex-1`}
          />
          <Button size="sm" type="submit" disabled={!newChat.includes('@')}>
            {t('messaging.start', { defaultValue: 'Open' })}
          </Button>
        </form>
        {joining ? (
          <form
            aria-label={t('messaging.joinTitle', { defaultValue: 'Join a group' })}
            className="flex flex-col gap-1.5 border-b border-border px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              void join()
            }}
          >
            <label className="flex flex-col gap-1 text-caption text-secondary">
              {t('messaging.roomAddress', { defaultValue: 'Group address' })}
              <input
                className={input}
                placeholder="team@rooms.server.example"
                value={joining.room}
                onChange={(e) => setJoining({ ...joining, room: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-caption text-secondary">
              {t('messaging.nick', { defaultValue: 'Your name in the group' })}
              <input
                className={input}
                value={joining.nick}
                onChange={(e) => setJoining({ ...joining, nick: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-caption text-secondary">
              {t('messaging.roomPassword', { defaultValue: 'Group password (if it has one)' })}
              <input
                type="password"
                autoComplete="off"
                className={input}
                value={joining.password}
                onChange={(e) => setJoining({ ...joining, password: e.target.value })}
              />
            </label>
            <div className="flex gap-1.5">
              <Button size="sm" type="submit" disabled={!joining.room.includes('@') || !joining.nick.trim()}>
                {t('messaging.join', { defaultValue: 'Join' })}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setJoining(null)}>
                {t('buttons.cancel', { defaultValue: 'Cancel' })}
              </Button>
            </div>
          </form>
        ) : (
          <div className="border-b border-border px-3 py-1.5">
            <button
              type="button"
              onClick={() => startJoin()}
              className="flex items-center gap-1.5 text-caption text-accent underline cursor-pointer"
            >
              <Users size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('messaging.joinGroup', { defaultValue: 'Join a group' })}
            </button>
          </div>
        )}
        {invitations.length > 0 && (
          <ul
            aria-label={t('messaging.invitations', { defaultValue: 'Invitations' })}
            className="flex flex-col gap-1.5 border-b border-border px-3 py-2"
          >
            {invitations.map((inv) => (
              <li
                key={inv.room}
                className="flex flex-col gap-1 rounded-control-sm bg-raised px-2.5 py-1.5 text-caption"
              >
                <span className="text-primary">
                  {t('messaging.invited', {
                    inviter: inv.inviter,
                    room: inv.room,
                    defaultValue: '{inviter} invites you to {room}',
                  })}
                </span>
                {inv.reason && <span className="text-secondary">{inv.reason}</span>}
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => startJoin(inv.room)}
                    className="text-accent underline cursor-pointer"
                  >
                    {t('messaging.joinInvited', { defaultValue: 'Join…' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismissInvitation(inv.room)}
                    className="text-secondary underline cursor-pointer"
                  >
                    {t('messaging.notNow', { defaultValue: 'Not now' })}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex-1 overflow-y-auto">
          {rooms.length > 0 && (
            <>
              <h3 className="px-3 pt-2 text-2xs font-semibold uppercase text-secondary">
                {t('messaging.groups', { defaultValue: 'Groups' })}
              </h3>
              <ul aria-label={t('messaging.groups', { defaultValue: 'Groups' })}>
                {rooms.map((r) => (
                  <li key={r.room}>
                    <ConversationButton
                      name={r.room}
                      last={r.last_body || roomStateLabel(r, t)}
                      unread={r.unread}
                      current={r.room === conversation}
                      group
                      onOpen={() => void openConversation(r.room)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul aria-label={t('messaging.direct', { defaultValue: 'Direct conversations' })}>
            {conversations.map((c) => (
              <li key={c.conversation}>
                <ConversationButton
                  name={c.conversation}
                  last={c.last_body}
                  unread={c.unread}
                  current={c.conversation === conversation}
                  onOpen={() => void openConversation(c.conversation)}
                />
              </li>
            ))}
          </ul>
        </div>
        <footer className="border-t border-border px-3 py-2">
          <button
            type="button"
            className="text-caption text-secondary underline cursor-pointer"
            onClick={() =>
              void confirmAction({
                title: t('messaging.removeTitle', { defaultValue: 'Remove this chat account?' }),
                message: t('messaging.removeMessage', {
                  defaultValue:
                    'Its conversations kept on this computer are removed. Nothing is deleted on the server.',
                }),
                confirmLabel: t('messaging.remove', { defaultValue: 'Remove' }),
                cancelLabel: t('buttons.cancel'),
              }).then((ok) => (ok ? removeChatAccount(account) : undefined))
            }
          >
            {t('messaging.removeAccount', { defaultValue: 'Remove this chat account' })}
          </button>
        </footer>
      </section>

      <section
        aria-label={conversation || t('messaging.noConversation', { defaultValue: 'No conversation open' })}
        className={`flex min-w-0 flex-1 flex-col ${conversation ? '' : 'max-[769px]:hidden'}`}
      >
        {conversation ? (
          <>
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold text-primary">
              <button
                type="button"
                onClick={() => messaging$.conversation.set('')}
                className="text-caption font-normal text-accent underline min-[769px]:hidden cursor-pointer"
              >
                {t('messaging.back', { defaultValue: 'Conversations' })}
              </button>
              {openRoom && <Users size={16} strokeWidth={1.75} className="text-accent" aria-hidden="true" />}
              <span className="truncate">{conversation}</span>
              {openRoom && (
                <>
                  <span
                    className="text-caption font-normal text-secondary"
                    title={openRoom.detail?.message ?? undefined}
                  >
                    {roomStateLabel(openRoom, t)}
                  </span>
                  <button
                    type="button"
                    className="ml-auto text-caption font-normal text-secondary underline cursor-pointer"
                    onClick={() =>
                      void confirmAction({
                        title: t('messaging.leaveTitle', { defaultValue: 'Leave this group?' }),
                        message: t('messaging.leaveMessage', {
                          defaultValue:
                            'It is not joined again, and what was kept of it on this computer is removed. The group keeps its own history.',
                        }),
                        confirmLabel: t('messaging.leave', { defaultValue: 'Leave' }),
                        cancelLabel: t('buttons.cancel'),
                      }).then((ok) => (ok ? leaveRoom(openRoom.room) : undefined))
                    }
                  >
                    {t('messaging.leaveGroup', { defaultValue: 'Leave group' })}
                  </button>
                </>
              )}
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <ol className="flex flex-col gap-1.5">
                {history.map((m) => (
                  <Bubble key={m.id} message={m} group={!!openRoom} />
                ))}
              </ol>
              <div ref={end} />
            </div>
            {roomUploads.length > 0 && (
              <ul
                aria-label={t('messaging.uploads', { defaultValue: 'Files being sent' })}
                className="flex flex-col gap-1 border-t border-border px-4 py-2 text-caption"
              >
                {roomUploads.map(([id, u]) => (
                  <li key={id} className="flex items-center gap-2 text-secondary">
                    <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="truncate text-primary">{u.name}</span>
                    {u.error ? (
                      <>
                        <span role="alert" className="text-danger">
                          {uploadErrorText(u.error, t)}
                        </span>
                        <button
                          type="button"
                          onClick={() => dismissChatUpload(id)}
                          className="ml-auto underline cursor-pointer"
                        >
                          {t('messaging.dismiss', { defaultValue: 'Dismiss' })}
                        </button>
                      </>
                    ) : (
                      <>
                        <progress
                          aria-label={t('messaging.sendingFile', { name: u.name, defaultValue: 'Sending {name}' })}
                          value={u.done}
                          max={u.total || 1}
                          className="w-32"
                        />
                        <span>
                          {formatFileSize(u.done)} / {formatFileSize(u.total)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void cancelChatUpload(id)}
                          className="ml-auto underline cursor-pointer"
                        >
                          {t('buttons.cancel', { defaultValue: 'Cancel' })}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex items-end gap-2 border-t border-border px-4 py-2.5"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <textarea
                aria-label={t('messaging.message', { defaultValue: 'Message' })}
                value={draft}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                className={`${input} flex-1 resize-none`}
              />
              <button
                type="button"
                onClick={() => void attach()}
                aria-label={t('messaging.sendFile', { defaultValue: 'Send a file' })}
                title={t('messaging.sendFile', { defaultValue: 'Send a file' })}
                className="flex min-h-9 items-center rounded-control-sm px-2 text-secondary hover:bg-hover hover:text-primary cursor-pointer"
              >
                <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <Button type="submit" disabled={!draft.trim()} leftIcon={Send}>
                {t('messaging.send', { defaultValue: 'Send' })}
              </Button>
            </form>
          </>
        ) : (
          <p className="m-auto text-sm text-secondary">
            {t('messaging.pick', { defaultValue: 'Pick a conversation, or open one with an address.' })}
          </p>
        )}
      </section>
    </div>
  )
}

type T = (key: string, values?: Record<string, unknown>) => string

/** What a room's connection state means, in a few words. */
function roomStateLabel(room: ChatRoom, t: T) {
  switch (room.state) {
    case 'joined':
      return t('messaging.room.joined', { defaultValue: 'In the group' })
    case 'joining':
      return t('messaging.room.joining', { defaultValue: 'Joining…' })
    case 'error':
      return room.detail?.message ?? t('messaging.room.error', { defaultValue: 'Could not join' })
    case 'out':
      return t('messaging.room.out', { defaultValue: 'Not in the group' })
    default:
      return t('messaging.room.offline', { defaultValue: 'Not connected' })
  }
}

/** Why a file was not sent, said for a person. */
function uploadErrorText(error: { message: string; detail?: { code: string } }, t: T) {
  switch (error.detail?.code) {
    case 'tooLarge':
      return t('messaging.file.tooLarge', { defaultValue: 'Too large for the chat server. Nothing was sent.' })
    case 'noService':
      return t('messaging.file.noService', { defaultValue: 'This chat server does not accept files.' })
    case 'disconnected':
      return t('messaging.file.disconnected', { defaultValue: 'The connection went. Nothing was sent.' })
    default:
      return error.message
  }
}

function ConversationButton({
  name,
  last,
  unread,
  current,
  group,
  onOpen,
}: {
  name: string
  last: string
  unread: number
  current: boolean
  group?: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-current={current}
      onClick={onOpen}
      className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left cursor-pointer ${
        current ? 'bg-accent/10' : 'hover:bg-hover'
      }`}
    >
      <span className="flex items-center gap-2">
        {group && <Users size={14} strokeWidth={1.75} className="shrink-0 text-secondary" aria-hidden="true" />}
        <span className="truncate text-sm font-semibold text-primary">{name}</span>
        {unread > 0 && (
          <span className="ml-auto rounded-full bg-accent px-1.5 text-2xs font-semibold text-on-accent">
            {t('messaging.unread', { count: unread, defaultValue: '{count} new' })}
          </span>
        )}
      </span>
      <span className="truncate text-caption text-secondary">{last}</span>
    </button>
  )
}

/** A file someone sent as a link: its name, and saving it only when asked, over HTTPS. */
function FileCard({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const secure = /^https:\/\//i.test(message.file_url ?? '')
  const save = async () => {
    setBusy(true)
    try {
      const result = await saveChatFile(message)
      if (result?.saved) showToast(t('messaging.file.saved', { defaultValue: 'Saved' }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span
      className={`flex items-center gap-2 rounded-panel px-3 py-1.5 text-sm ${
        mine ? 'bg-accent text-on-accent' : 'bg-raised text-primary'
      }`}
    >
      <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="truncate">{message.file_name || t('messaging.file.unnamed', { defaultValue: 'File' })}</span>
      {message.file_size != null && (
        <span className="text-caption opacity-80">{formatFileSize(message.file_size)}</span>
      )}
      {secure ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="underline cursor-pointer disabled:opacity-60"
          aria-label={t('messaging.file.saveNamed', {
            name: message.file_name ?? '',
            defaultValue: 'Save {name}',
          })}
        >
          {t('messaging.file.save', { defaultValue: 'Save…' })}
        </button>
      ) : (
        <span className="text-caption opacity-80">
          {t('messaging.file.insecure', { defaultValue: 'Not a secure link; not saved' })}
        </span>
      )}
    </span>
  )
}

function Bubble({ message, group }: { message: ChatMessage; group?: boolean }) {
  const { t } = useTranslation()
  const mine = message.direction === 'out'
  const time = new Date(message.stamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const states: Record<string, { icon: typeof Check; label: string }> = {
    sending: { icon: Clock, label: t('messaging.state.sending', { defaultValue: 'Sending' }) },
    sent: { icon: Check, label: t('messaging.state.sent', { defaultValue: 'Sent' }) },
    accepted: { icon: Check, label: t('messaging.state.accepted', { defaultValue: 'On the server' }) },
    delivered: { icon: CheckCheck, label: t('messaging.state.delivered', { defaultValue: 'Delivered' }) },
    uncertain: {
      icon: AlertTriangle,
      label: t('messaging.state.uncertain', { defaultValue: 'May not have arrived' }),
    },
    failed: { icon: AlertTriangle, label: t('messaging.state.failed', { defaultValue: 'Not sent' }) },
  }
  const state = mine ? states[message.state] : undefined
  const Icon = state?.icon
  return (
    <li className={`flex max-w-[75%] flex-col gap-0.5 ${mine ? 'self-end items-end' : 'self-start items-start'}`}>
      {group && !mine && <span className="text-2xs font-semibold text-secondary">{message.sender}</span>}
      {message.file_url ? (
        <FileCard message={message} mine={mine} />
      ) : (
        <span
          className={`whitespace-pre-wrap break-words rounded-panel px-3 py-1.5 text-sm ${
            mine ? 'bg-accent text-on-accent' : 'bg-raised text-primary'
          }`}
        >
          {message.body}
        </span>
      )}
      <span className="flex items-center gap-1 text-2xs text-secondary">
        {time}
        {Icon && state && (
          <>
            <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>{state.label}</span>
          </>
        )}
        {mine && (message.state === 'uncertain' || message.state === 'failed') && (
          <button
            type="button"
            onClick={() => void retryChat(message.id)}
            className="text-accent underline cursor-pointer"
          >
            {t('messaging.retry', { defaultValue: 'Send again' })}
          </button>
        )}
      </span>
    </li>
  )
}

/** Adding a chat account: an XMPP address and its password. */
function ChatSetup() {
  const { t } = useTranslation()
  const [form, setForm] = useState({ jid: '', password: '', host: '', port: '5222' })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await saveChatAccount(
        {
          id: `chat-${Date.now().toString(36)}`,
          jid: form.jid.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 5222,
        },
        form.password,
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-1 items-start justify-center bg-chats p-6">
      <form
        aria-label={t('messaging.setup', { defaultValue: 'Add a chat account' })}
        className="flex w-full max-w-md flex-col gap-3 rounded-panel border border-border bg-header p-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex items-center gap-2">
          <CompactNavigation />
          <h2 className="text-base font-semibold text-primary">
            {t('messaging.setup', { defaultValue: 'Add a chat account' })}
          </h2>
        </div>
        <p className="text-caption text-secondary">
          {t('messaging.setupHint', {
            defaultValue:
              'Chat with any XMPP (Jabber) account. The connection always uses TLS. Teams, Slack and others are not available yet.',
          })}
        </p>
        <label className="flex flex-col gap-1 text-caption text-secondary">
          {t('messaging.address', { defaultValue: 'Address' })}
          <input
            className={input}
            placeholder="name@server.example"
            value={form.jid}
            onChange={(e) => setForm({ ...form, jid: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-caption text-secondary">
          {t('messaging.password', { defaultValue: 'Password' })}
          <input
            type="password"
            autoComplete="off"
            className={input}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-caption text-secondary">
            {t('messaging.server', { defaultValue: 'Server (optional)' })}
            <input className={input} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
          </label>
          <label className="flex w-24 flex-col gap-1 text-caption text-secondary">
            {t('messaging.port', { defaultValue: 'Port' })}
            <input className={input} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
          </label>
        </div>
        <Button type="submit" disabled={busy || !form.jid.includes('@') || !form.password}>
          {t('messaging.add', { defaultValue: 'Add' })}
        </Button>
      </form>
    </div>
  )
}
