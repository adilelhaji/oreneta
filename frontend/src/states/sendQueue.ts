// The grace period between pressing Send and the message actually going.
//
// Its own module, like the pending-send registry it sits beside, so both send
// paths and the shutdown hook can reach it without forming an import cycle.

/** A send waiting out its grace period. */
type Queued = {
  timer: ReturnType<typeof setTimeout>
  /** Sends it now. Called by the timer, by `flushQueuedSends`, or by nobody. */
  send: () => void
  /** Undoes it: the caller decides what "undone" means for its own path. */
  cancel: () => void
  /** Lets it go as the app closes; `send` unless the caller says otherwise. */
  flush: () => void
}

const queue = new Map<string, Queued>()

/**
 * Holds a send for `seconds`, then lets it go.
 *
 * Returns immediately: waiting is the point, and the caller's interface should
 * carry on as if the message had gone — which, as far as the reader is
 * concerned and after a few seconds, it has.
 */
export function queueSend(id: string, seconds: number, send: () => void, cancel: () => void, flush: () => void = send) {
  // Already waiting: replace it rather than stack two timers on one message.
  clearQueuedSend(id)
  const timer = setTimeout(
    () => {
      queue.delete(id)
      send()
    },
    Math.max(0, seconds) * 1000,
  )
  queue.set(id, { timer, send, cancel, flush })
}

/** Whether a send is still waiting, and can therefore still be taken back. */
export const isQueued = (id: string) => queue.has(id)

export const queuedCount = () => queue.size

/**
 * Takes a send back, if it has not gone yet.
 *
 * Answers whether it did: a message that has already left cannot be recalled,
 * and telling the reader otherwise would be a lie about something they care
 * about a great deal.
 */
export function undoQueuedSend(id: string): boolean {
  const waiting = queue.get(id)
  if (!waiting) return false
  clearTimeout(waiting.timer)
  queue.delete(id)
  waiting.cancel()
  return true
}

/** Drops the timer without sending or undoing. For teardown paths only. */
function clearQueuedSend(id: string) {
  const waiting = queue.get(id)
  if (!waiting) return
  clearTimeout(waiting.timer)
  queue.delete(id)
}

/**
 * Sends everything still waiting, at once.
 *
 * Called when the app is closing. A message the reader believes they sent must
 * not be lost because they quit before its few seconds were up — the grace
 * period is a chance to take something back, not a chance to lose it.
 */
export function flushQueuedSends() {
  for (const [id, waiting] of [...queue]) {
    clearTimeout(waiting.timer)
    queue.delete(id)
    waiting.flush()
  }
}

/**
 * Ids of the stored copies of replies still in their grace period (#89).
 * Each is a scheduled send the core keeps until the reply goes or is taken
 * back, so quitting or crashing in those seconds cannot lose it; the list of
 * messages waiting to go leaves them out, since the reply already shows as
 * waiting where it was written.
 */
export const heldCopies = new Set<string>()
