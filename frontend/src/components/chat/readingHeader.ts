// What the header above an open conversation should say about it.
//
// The header used to describe the newest message: one sender, one avatar. A
// conversation of nine messages between four people got the same header as a
// notification from a robot, and nothing on screen said how much of it there
// was or when it last moved. This computes the other thing — the conversation
// as a whole — so the header can show it.
//
// The rule everything here follows: say only what is known. A thread whose
// older messages have not been fetched yet has participants nobody has seen,
// so the list is marked short rather than presented as complete, and the
// caller renders it as "at least these". A count the core did not send is
// null, not zero.

import type { Message } from '../../types'

/** One person in a conversation, as they appeared in it. */
export type Participant = {
  /** Display name if the message carried one, else the address. */
  name: string
  /** Lower-cased address, which is also the identity used to dedupe. */
  address: string
  /** True when this is an address of the account reading the conversation. */
  self: boolean
}

export type ReadingSummary = {
  /**
   * Everyone who wrote, newest message first.
   *
   * Ordered by when they last wrote rather than alphabetically: the people
   * still in the conversation are the ones a reader is looking for.
   */
  participants: Participant[]
  /**
   * True when older messages have not been loaded, so somebody could be
   * missing from `participants`. The header must not claim a complete cast
   * while this holds.
   */
  partial: boolean
  /** Messages in the thread as the core counted them; null when it did not. */
  messageCount: number | null
  /** Unread among them; null when unknown, 0 meaning genuinely none. */
  unreadCount: number | null
  /** The newest message's time, epoch seconds; null when no message has one. */
  lastDate: number | null
}

/** The address out of a `Name <addr>` or bare-address field, lower-cased. */
function addressOf(message: Message): string {
  return message.from_addr.trim().toLowerCase()
}

/**
 * Reduce a thread and its loaded messages to what the header shows.
 *
 * `loaded` is the messages actually in hand, which for a long thread is the
 * newest page only. `hasOlder` says whether more exist behind it — the caller
 * passes the pagination cursor's emptiness, which is the only place that fact
 * is known.
 *
 * The thread card's own count is preferred over counting `loaded`, because
 * counting what happens to be loaded would report "3 messages" for a thread of
 * thirty and be wrong in the confident-looking way.
 */
export function summariseThread(
  thread: Message,
  loaded: Message[],
  hasOlder: boolean,
  /** Addresses belonging to the reader, lower-cased, for marking their own messages. */
  ownAddresses: string[] = [],
): ReadingSummary {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean))

  const mine = loaded.filter((message) => message.thread_id === thread.thread_id)
  // Newest first, so the participant order is "who spoke most recently".
  const newestFirst = [...mine].sort((a, b) => (b.date || 0) - (a.date || 0))

  const participants: Participant[] = []
  const seen = new Set<string>()
  for (const message of newestFirst) {
    const address = addressOf(message)
    if (!address || seen.has(address)) continue
    seen.add(address)
    participants.push({
      name: message.from_name.trim() || message.from_addr.trim(),
      address,
      self: own.has(address) || message.outgoing === true,
    })
  }

  // The thread card is a participant of last resort: when nothing is loaded
  // yet, its sender is still someone we know wrote in this conversation.
  if (participants.length === 0) {
    const address = addressOf(thread)
    if (address) {
      participants.push({
        name: thread.from_name.trim() || thread.from_addr.trim(),
        address,
        self: own.has(address) || thread.outgoing === true,
      })
    }
  }

  const dates = [...mine.map((message) => message.date || 0), thread.date || 0].filter((date) => date > 0)

  return {
    participants,
    partial: hasOlder,
    messageCount: typeof thread.message_count === 'number' ? thread.message_count : null,
    unreadCount: typeof thread.unread_count === 'number' ? thread.unread_count : null,
    lastDate: dates.length ? Math.max(...dates) : null,
  }
}

/**
 * Whether the header should describe a conversation rather than a sender.
 *
 * One message from one person is a message: naming "the participants" of it
 * would be ceremony around a single name. The switch happens when there is
 * genuinely more than one of something.
 */
export function isConversation(summary: ReadingSummary): boolean {
  return summary.participants.length > 1 || (summary.messageCount ?? 1) > 1
}
