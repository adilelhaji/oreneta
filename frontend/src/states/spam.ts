// Why the learned spam filter flagged a message, and how to say otherwise.
//
// Same shape as states/priority.ts: the reason comes from the core, one
// conversation at a time, only when the reader is actually looking at a
// flagged message. Nothing here moves a message on its own — the app only
// ever offers, never files anything away by itself.

import { invoke } from '../lib/bridge'
import { showToast } from './ui'
import { t } from '../lib/i18n'

/** Why a message is flagged, in terms a person can check. */
export type SpamReason = 'senderMarkedBefore' | 'triggerWords' | 'nothingKnown'

export type SpamVerdict = {
  spam: boolean
  /** In the order they were applied; the first is the one that decided it. */
  reasons: SpamReason[]
  sender: string
}

/** Why one conversation is flagged as spam, or isn't. */
export async function spamReason(threadId: string): Promise<SpamVerdict | null> {
  try {
    return await invoke<SpamVerdict>('mail.spamReason', { thread_id: threadId })
  } catch {
    // A verdict that cannot be read is not a verdict of "nothing known": the
    // caller shows nothing rather than an explanation it made up.
    return null
  }
}

/**
 * Records the reader's judgement of a conversation without moving it —
 * "not spam" said from the notice, in place. Marking or unmarking junk
 * teaches the same filter as part of the move instead (see `markThreadJunk`).
 */
export async function dismissSpamSuggestion(threadId: string) {
  try {
    await invoke('mail.recordSpamJudgment', { thread_id: threadId, spam: false })
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('spam.changeFailed'), 'error')
  }
}
