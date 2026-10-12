// Why a conversation is where the priority filter put it, and how to disagree.
//
// The reasons come from the core, one conversation at a time, because a reason
// is only wanted when someone wonders. Computing fifty of them to show none
// would be work nobody asked for.

import { invoke } from '../lib/bridge'
import { loadThreads } from './mail'
import { showToast } from './ui'
import { t } from '../lib/i18n'

/** Why a message is where it is, in terms a person can check. */
export type PriorityReason =
  | 'yourChoice'
  | 'writtenToSender'
  | 'addressedDirectly'
  | 'onlyCopiedIn'
  | 'automatedSender'
  | 'nothingKnown'

export type PriorityVerdict = {
  priority: boolean
  /** In the order they were applied; the first is the one that decided it. */
  reasons: PriorityReason[]
  sender: string
  /** What the reader has said about this sender, or null if nothing. */
  override: boolean | null
}

/** Why one conversation is where it is. */
export async function priorityReason(threadId: string): Promise<PriorityVerdict | null> {
  try {
    return await invoke<PriorityVerdict>('mail.priorityReason', { thread_id: threadId })
  } catch {
    // A verdict that cannot be read is not a verdict of "nothing known": the
    // caller shows nothing rather than an explanation it made up.
    return null
  }
}

/**
 * Records what the reader decided about a sender.
 *
 * `null` forgets the decision rather than reversing it — back to whatever the
 * signals say, not to the opposite of however it was last pushed.
 *
 * The whole account is re-judged, so every conversation from that sender moves
 * at once: a decision that applied only to the message it was made on would be
 * a decision the reader has to keep making.
 */
export async function setSenderPriority(accountId: string, addr: string, priority: boolean | null) {
  try {
    await invoke('mail.setSenderPriority', {
      account_id: accountId,
      addr,
      ...(priority === null ? {} : { priority }),
    })
    showToast(
      priority === null
        ? t('priority.forgotten', { sender: addr })
        : t(priority ? 'priority.alwaysSet' : 'priority.neverSet', { sender: addr }),
    )
    await loadThreads(false)
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('priority.changeFailed'), 'error')
  }
}

/** One message a sweep would move. */
export type SweepCandidate = { uid: number; subject: string; date: number }

export type SweepPreview = {
  from: string
  folder: string
  keepNewest: number
  /** The core's handle on exactly this list. Confirming sends it back, so
   * what moves is what was shown and nothing that arrived since. */
  reviewId: string
  messages: SweepCandidate[]
}

/** What a confirmed sweep came to, item by item. */
export type SweepOutcome = {
  swept: number
  /** Reviewed messages still in the folder after the move was attempted. */
  unresolved: number[]
  complete: boolean
  error?: string | null
}

/** What a sweep would move, moving nothing. */
export async function sweepPreview(args: {
  accountId: string
  folder: string
  from: string
  keepNewest: number
}): Promise<SweepPreview> {
  const res = await invoke<SweepPreview>('mail.sweepPreview', {
    account_id: args.accountId,
    folder: args.folder,
    from: args.from,
    keep_newest: args.keepNewest,
  })
  return { ...res, messages: res?.messages ?? [] }
}

/**
 * Does the sweep that was previewed.
 *
 * The dialog hands back the review the core issued with the list, and the
 * core moves those messages: not the sender's mail recomputed now, which by
 * then may include something nobody was shown. The answer is item by item.
 * When some reviewed messages are still there afterwards — another client
 * took them first, or the move failed part-way — the toast says so rather
 * than a count that reads as "all done"; a fresh preview shows what is left.
 */
export async function sweep(args: { accountId: string; reviewId: string }): Promise<SweepOutcome> {
  const res = await invoke<Partial<SweepOutcome> | null>('mail.sweep', {
    account_id: args.accountId,
    review_id: args.reviewId,
  })
  const outcome: SweepOutcome = {
    swept: res?.swept ?? 0,
    unresolved: res?.unresolved ?? [],
    complete: res?.complete === true,
    error: res?.error ?? null,
  }
  if (outcome.complete) {
    showToast(t('sweep.done', { count: outcome.swept }))
  } else {
    showToast(
      t('sweep.partial', { swept: outcome.swept, left: outcome.unresolved.length }) +
        (outcome.error ? ` · ${outcome.error}` : ''),
      'error',
    )
  }
  await loadThreads(false)
  return outcome
}
