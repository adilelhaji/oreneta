import { useEffect, useRef, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { AlertTriangle, Check, CheckCheck, Clock, MessagesSquare, Send } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import {
  loadMessaging,
  messaging$,
  openConversation,
  removeChatAccount,
  retryChat,
  saveChatAccount,
  sendChat,
  refreshConversations,
  type ChatMessage,
} from '../../states/messaging'
import { confirmAction, showToast } from '../../states/ui'
import { Button } from '../button/Button'
import { CompactNavigation } from '../sidenav/CompactNavigation'

const input = 'rounded-control-sm border border-border bg-app px-2.5 py-1.5 text-sm text-primary'

/**
 * Chat over XMPP (#111, ADR-0036): the person's conversations, each with
 * what was said, and for what they sent, where it got to.
 */
export function MessagingView() {
  const { t } = useTranslation()
  const accounts = useValue(messaging$.accounts)
  const account = useValue(messaging$.account)
  const status = useValue(messaging$.status)
  const conversations = useValue(messaging$.conversations)
  const conversation = useValue(messaging$.conversation)
  const history = useValue(messaging$.history)
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
        <ul className="flex-1 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.conversation}>
              <button
                type="button"
                aria-current={c.conversation === conversation}
                onClick={() => void openConversation(c.conversation)}
                className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left cursor-pointer ${
                  c.conversation === conversation ? 'bg-accent/10' : 'hover:bg-hover'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-primary">{c.conversation}</span>
                  {c.unread > 0 && (
                    <span className="ml-auto rounded-full bg-accent px-1.5 text-2xs font-semibold text-on-accent">
                      {t('messaging.unread', { count: c.unread, defaultValue: '{count} new' })}
                    </span>
                  )}
                </span>
                <span className="truncate text-caption text-secondary">{c.last_body}</span>
              </button>
            </li>
          ))}
        </ul>
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
              {conversation}
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <ol className="flex flex-col gap-1.5">
                {history.map((m) => (
                  <Bubble key={m.id} message={m} />
                ))}
              </ol>
              <div ref={end} />
            </div>
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

function Bubble({ message }: { message: ChatMessage }) {
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
      <span
        className={`whitespace-pre-wrap break-words rounded-panel px-3 py-1.5 text-sm ${
          mine ? 'bg-accent text-on-accent' : 'bg-raised text-primary'
        }`}
      >
        {message.body}
      </span>
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
