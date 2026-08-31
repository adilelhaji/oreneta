// How long a message has been looked at.
//
// "Mark as read after three seconds" has to mean three seconds of actually
// being on screen, not three seconds of having once been passed on the way
// somewhere else. Kept apart from the scroll hook because the rule — what
// counts, what is forgotten, and when to look again — is the part worth being
// able to state and to test on its own.

export type Dwell = {
  /** The messages that have been on screen long enough to count as read. */
  ready: string[]
  /**
   * Milliseconds until the next one comes due, or null if none is waiting.
   *
   * The caller needs this because a reader holding still produces no scroll
   * and no resize: without something to wake it, a message would stay unread
   * precisely because it was being read.
   */
  recheckIn: number | null
}

/**
 * Updates `since` for what is on screen now and reports what is due.
 *
 * `since` is mutated: it is the caller's record of when each message came into
 * view, and a message that has left is dropped from it, so coming back begins
 * its wait again rather than resuming it.
 */
export function dwellUpdate(args: {
  onScreen: string[]
  since: Map<string, number>
  now: number
  delayMs: number
}): Dwell {
  const { onScreen, since, now } = args
  const delayMs = Math.max(0, args.delayMs)

  const stillOnScreen = new Set(onScreen)
  for (const id of [...since.keys()]) {
    if (!stillOnScreen.has(id)) since.delete(id)
  }

  const ready: string[] = []
  let soonest: number | null = null
  for (const id of onScreen) {
    const first = since.get(id)
    if (first === undefined) {
      since.set(id, now)
      // Only a zero delay makes a message that just arrived already due.
      if (delayMs === 0) ready.push(id)
      else soonest = soonest === null ? delayMs : Math.min(soonest, delayMs)
      continue
    }
    const waited = now - first
    if (waited >= delayMs) ready.push(id)
    else {
      const left = delayMs - waited
      soonest = soonest === null ? left : Math.min(soonest, left)
    }
  }

  return { ready, recheckIn: soonest }
}
