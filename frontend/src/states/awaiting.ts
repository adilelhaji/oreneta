// Waiting for a reply (#45, ADR-0025).
//
// The core reads, every time it is asked, whether a reply has come; this only
// asks it and shows the answer. Nothing here sends anything to anyone.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { intlLocale, t } from '../lib/i18n'
import { showToast } from './ui'

export type AwaitingEvidence = {
  messageId: string
  from: string
  date: number
  link: 'direct' | 'conversation'
  doubt: '' | 'automated' | 'notRecipient'
}

export type AwaitingItem = {
  account: string
  messageId: string
  threadKey: string
  subject: string
  recipients: string[]
  sentAt: number
  remindAt: number | null
  status: 'waiting' | 'answered' | 'possible' | 'done' | 'cancelled'
  answer: AwaitingEvidence | null
  possible: AwaitingEvidence[]
  overdue: boolean
}

export const awaiting$ = observable({
  open: false,
  items: [] as AwaitingItem[],
  loaded: false,
})

/** When a reminder after `days` days falls: that morning at nine, local time. */
export function reminderAt(days: number, now = new Date()): number {
  const at = new Date(now)
  at.setDate(at.getDate() + days)
  at.setHours(9, 0, 0, 0)
  return Math.floor(at.getTime() / 1000)
}

export async function loadAwaiting() {
  try {
    const res = await invoke<{ items?: AwaitingItem[] }>('awaiting.list', { account: '' })
    awaiting$.items.set(res?.items ?? [])
    awaiting$.loaded.set(true)
  } catch {
    // Not read is not empty: what was shown stays.
  }
}

/** Starts waiting for a reply to the last message the person sent in a conversation. */
export async function waitForReply(threadId: string, remindAt: number | null) {
  try {
    await invoke('awaiting.add', { thread_id: threadId, ...(remindAt ? { remind_at: remindAt } : {}) })
    showToast(
      remindAt
        ? t('awaiting.addedWithReminder', {
            when: new Date(remindAt * 1000).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
            defaultValue: 'Waiting for a reply; a reminder here on {when} if none comes',
          })
        : t('awaiting.added', { defaultValue: 'Waiting for a reply' }),
    )
    await loadAwaiting()
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('awaiting.addFailed', { defaultValue: 'Could not start waiting' }),
      'error',
    )
  }
}

export async function settleAwaiting(item: AwaitingItem, state: 'waiting' | 'done' | 'cancelled') {
  await invoke('awaiting.setState', { account: item.account, message_id: item.messageId, state })
  await loadAwaiting()
}

/** The person says whether a possible answer is the answer. */
export async function ruleOnAnswer(item: AwaitingItem, candidate: string, isAnswer: boolean) {
  await invoke('awaiting.ruleOn', {
    account: item.account,
    message_id: item.messageId,
    candidate,
    is_answer: isAnswer,
  })
  await loadAwaiting()
}
