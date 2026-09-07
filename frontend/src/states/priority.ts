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
  messages: SweepCandidate[]
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
 * Moves everything the preview named to the trash.
 *
 * The core is asked for the list again rather than being handed the one the
 * dialog is showing: between showing it and agreeing to it, mail may have
 * arrived from the same sender, and sweeping a message nobody was shown is the
 * one thing this must not do. What that costs is that the count can differ
 * from the preview by a message that arrived in between — which is the honest
 * outcome, and the toast says how many actually went.
 */
export async function sweep(args: {
  accountId: string
  folder: string
  from: string
  keepNewest: number
}): Promise<number> {
  const res = await invoke<{ swept?: number }>('mail.sweep', {
    account_id: args.accountId,
    folder: args.folder,
    from: args.from,
    keep_newest: args.keepNewest,
  })
  const swept = res?.swept ?? 0
  showToast(t('sweep.done', { count: swept }))
  await loadThreads(false)
  return swept
}
