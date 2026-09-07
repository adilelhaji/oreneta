// Messages written now and due to go later.
//
// The promise lives in the core, not here: a message due at eight goes at
// eight whether or not this window is open, and whether or not it was ever
// reopened. What this module holds is the view of it — enough to show what is
// waiting, let it go early, or call it off.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'
import type { ComposedMessage } from './compose'
import { composedPayload, openComposeTab } from './compose'
import type { ComposerAttachment } from '../types'

/** One message waiting for its hour. */
export type ScheduledSend = {
  id: string
  account: string
  /** Seconds since the epoch, as the core keeps it. */
  dueAt: number
  subject: string
  to: string
  attempts: number
  lastError: string
  /** True once the core has stopped trying, so this is failed and not merely late. */
  gaveUp: boolean
}

export const scheduled$ = observable({
  messages: [] as ScheduledSend[],
  loaded: false,
})

/**
 * When a message may be scheduled for.
 *
 * Times a person would name rather than instants they would calculate. The
 * evening is dropped once it has passed, and the morning is tomorrow's, so
 * every choice offered is one that can still happen.
 */
export function sendLaterChoices(now = new Date()): { key: string; at: number }[] {
  const at = (date: Date) => Math.floor(date.getTime() / 1000)

  const thisEvening = new Date(now)
  thisEvening.setHours(18, 0, 0, 0)

  const tomorrowMorning = new Date(now)
  tomorrowMorning.setDate(now.getDate() + 1)
  tomorrowMorning.setHours(8, 0, 0, 0)

  const mondayMorning = new Date(now)
  // The coming Monday: what "next week" means to a working calendar.
  mondayMorning.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
  mondayMorning.setHours(8, 0, 0, 0)

  return [
    { key: 'thisEvening', at: at(thisEvening) },
    { key: 'tomorrowMorning', at: at(tomorrowMorning) },
    { key: 'mondayMorning', at: at(mondayMorning) },
  ].filter((choice) => choice.at > at(now))
}

/** A client-side id, so the composer can name the message it just scheduled. */
function newScheduleId() {
  return `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Files a composed message to go at `dueAt`.
 *
 * Returns the id the core knows it by, so the caller can undo or point at it.
 */
export async function scheduleComposed(message: ComposedMessage, dueAt: number): Promise<string> {
  const id = newScheduleId()
  await invoke('mail.scheduleSend', {
    id,
    due_at: dueAt,
    message: composedPayload(message),
  })
  await refreshScheduledSends()
  return id
}

/** What is still waiting to go, for the whole app or one account. */
export async function refreshScheduledSends(accountId = '') {
  try {
    const res = await invoke<{ messages?: ScheduledSend[] }>('mail.scheduledSends', {
      account_id: accountId,
    })
    scheduled$.messages.set(res?.messages ?? [])
    scheduled$.loaded.set(true)
  } catch {
    // A list that cannot be read is not a list that is empty: leave whatever
    // was last known rather than telling the reader nothing is waiting.
  }
}

/**
 * Calls a scheduled message off, handing the message itself back.
 *
 * The caller decides what to do with it — reopen it in a composer, most
 * usefully. Cancelling should give the reader their words, not take them away.
 */
export async function cancelScheduledSend(id: string): Promise<Record<string, unknown> | null> {
  const res = await invoke<{ message?: Record<string, unknown> | null }>('mail.cancelScheduledSend', {
    id,
  })
  scheduled$.messages.set(scheduled$.messages.peek().filter((message) => message.id !== id))
  return res?.message ?? null
}

/** Lets a scheduled message go now, rather than at its hour. */
export async function sendScheduledNow(id: string) {
  try {
    await invoke('mail.sendScheduledNow', { id })
    scheduled$.messages.set(scheduled$.messages.peek().filter((message) => message.id !== id))
    showToast(t('sendLater.toast.sent'), 'success')
  } catch (error) {
    // Surfaced, not swallowed: the message is still there, and the reason it
    // did not go is the thing its writer needs.
    const message = error instanceof Error ? error.message : t('sendLater.toast.sendFailed')
    showToast(message, 'error')
    await refreshScheduledSends()
  }
}

/** Drops one message from the view once the core says it has gone. */
export function forgetScheduledSend(id: string) {
  scheduled$.messages.set(scheduled$.messages.peek().filter((message) => message.id !== id))
}

/** Records that the core has given up on a message, so the view can say so. */
export function markScheduledSendFailed(id: string, error: string) {
  scheduled$.messages.set(
    scheduled$.messages.peek().map((message) =>
      message.id === id
        ? { ...message, gaveUp: true, lastError: error, attempts: message.attempts + 1 }
        : message,
    ),
  )
}

/** The bridge payload of a scheduled message, as the core hands it back. */
type StoredMessage = {
  account_id?: string
  from?: string
  to?: string
  cc?: string
  bcc?: string
  reply_to?: string
  subject?: string
  body?: string
  html?: string
  in_reply_to?: string
  references?: string
  attachments?: { filename?: string; mime?: string; data?: string; inline_id?: string }[]
}

/**
 * Calls a scheduled message off and opens it again for editing.
 *
 * This is what cancelling should mean: the message comes back as a draft in
 * front of the reader, with its recipients, its body and its attachments, so
 * changing their mind about *when* costs them nothing of *what*.
 */
export async function cancelAndReopen(id: string) {
  const raw = (await cancelScheduledSend(id)) as StoredMessage | null
  if (!raw) return
  const rich = !!raw.html
  openComposeTab({
    accountId: raw.account_id ?? '',
    fromEmail: raw.from ?? '',
    to: raw.to ?? '',
    cc: raw.cc ?? '',
    bcc: raw.bcc ?? '',
    replyTo: raw.reply_to ?? '',
    subject: raw.subject ?? '',
    rich,
    html: rich ? (raw.html ?? '') : '',
    text: rich ? '' : (raw.body ?? ''),
    inReplyTo: raw.in_reply_to ?? '',
    references: raw.references ?? '',
    attachments: (raw.attachments ?? []).map((file, index): ComposerAttachment => ({
      id: `${id}-${index}`,
      filename: file.filename ?? '',
      mime: file.mime ?? 'application/octet-stream',
      // The bytes are what was about to be sent; their length is the size.
      size: Math.floor(((file.data ?? '').length * 3) / 4),
      data: file.data ?? '',
      inlineId: file.inline_id || undefined,
    })),
    // It already carries whatever signature it was written with, and a second
    // copy is not wanted.
    noSignature: true,
  })
  showToast(t('sendLater.toast.cancelled'))
}
