// Personalized mass mail (#90, ADR-0026).
//
// The core renders every message; what the preview shows is what starting
// the mailing stores and sends, one message per recipient, to that recipient
// alone. This only asks it and shows the answer.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type MergeMessage = {
  index: number
  line: number
  to: string
  name: string
  subject: string
  body: string
  problems: string[]
}

export type MergePreview = { messages: MergeMessage[]; problems: string[]; ready: boolean }

export type MergeItem = {
  index: number
  to: string
  name: string
  subject: string
  body: string
  messageId: string
  state: 'pending' | 'sending' | 'accepted' | 'rejected' | 'uncertain' | 'cancelled'
  error: string
}

export type MergeBatch = {
  id: string
  account: string
  from: string
  subject: string
  spacing: number
  state: 'sending' | 'paused' | 'cancelled' | 'done'
  reason: string
  createdAt: number
  items: MergeItem[]
}

export type MergeInput = {
  account: string
  from: string
  meName: string
  recipients: string
  subject: string
  body: string
}

export const merge$ = observable({
  open: false,
  batches: [] as MergeBatch[],
})

const params = (input: MergeInput) => ({
  account: input.account,
  from: input.from,
  me_name: input.meName,
  recipients: input.recipients,
  subject: input.subject,
  body: input.body,
})

export function previewMerge(input: MergeInput): Promise<MergePreview> {
  return invoke<MergePreview>('merge.preview', params(input))
}

/** Starts a mailing of exactly the reviewed number of messages. */
export async function startMerge(input: MergeInput, reviewed: number): Promise<string> {
  const res = await invoke<{ id: string }>('merge.start', { ...params(input), reviewed })
  await refreshMerges()
  return res.id
}

export async function refreshMerges() {
  try {
    const res = await invoke<{ batches?: MergeBatch[] }>('merge.list', {})
    merge$.batches.set(res?.batches ?? [])
  } catch {
    // What was shown stays: an unread list is not an empty one.
  }
}

export async function cancelMerge(id: string) {
  await invoke('merge.cancel', { id })
  await refreshMerges()
}

export async function resumeMerge(id: string, retryRejected: boolean) {
  await invoke('merge.resume', { id, retry_rejected: retryRejected })
  await refreshMerges()
}

/** How many messages of a mailing are in each state. */
export function tally(batch: MergeBatch): Record<MergeItem['state'], number> {
  const counts = { pending: 0, sending: 0, accepted: 0, rejected: 0, uncertain: 0, cancelled: 0 }
  for (const item of batch.items) counts[item.state] += 1
  return counts
}
