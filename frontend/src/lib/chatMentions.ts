// Completing @mentions in a group chat (ADR-0055). Whether a received
// message mentions the person is the core's to say; this only helps write
// one: what is being typed after `@`, who in the room matches it, and the
// text once a nickname is picked.

/** At most this many suggestions show at once. */
export const MAX_SUGGESTIONS = 8

/** A letter, digit or `_` continues a word, as the core reads mentions. */
const WORD = /[\p{L}\p{N}_]/u

/**
 * The `@` being completed at the caret, if any: where it is and what was
 * typed after it. It must start the text or follow something that is not
 * part of a word (so an address like `ana@chat.test` is not a mention), and
 * what follows it has no spaces yet.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query) || query.length > 64) return null
  const previous = at > 0 ? before[at - 1] : ''
  if (previous && WORD.test(previous)) return null
  return { start: at, query }
}

/**
 * The nicknames in the room that start with what was typed, ignoring case,
 * without the person's own, each once, in alphabetical order.
 */
export function mentionCandidates(nicks: string[], query: string, ownNick = ''): string[] {
  const wanted = query.toLocaleLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const nick of [...nicks].sort((a, b) => a.localeCompare(b))) {
    if (!nick.trim() || nick === ownNick || seen.has(nick)) continue
    if (!nick.toLocaleLowerCase().startsWith(wanted)) continue
    seen.add(nick)
    out.push(nick)
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/** The text with the `@query` at `start` replaced by `@nick `, and where the caret goes. */
export function applyMention(text: string, start: number, caret: number, nick: string): { text: string; caret: number } {
  const inserted = `@${nick} `
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}

/** The picked nicknames still written as `@nick` when sending, each once. */
export function mentionsKept(picked: string[], text: string): string[] {
  return [...new Set(picked)].filter((nick) => text.includes(`@${nick}`))
}
