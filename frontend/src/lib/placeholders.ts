// Placeholders in kept text (#88): filled from the message being written when
// a snippet or template goes in.
//
// `{{to.firstName}}` and the rest are read from the draft — never guessed. A
// placeholder that cannot be filled (no recipient yet) or is not one this
// knows is left in the text as written, and reported, so a message never goes
// out with a name quietly missing or a typo quietly removed.

import { escapeHtml } from './printDocument'
import { parseRecipients } from './recipients'

export const PLACEHOLDERS = [
  'to.name',
  'to.firstName',
  'to.email',
  'me.name',
  'me.firstName',
  'me.email',
  'subject',
  'date',
  'cursor',
] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

/** Where the writing cursor goes once the text is in. */
export const CURSOR_TOKEN = '{{cursor}}'

export type PlaceholderContext = {
  /** The To field as written. The first recipient is the one named. */
  to: string
  me: { name: string; email: string }
  subject: string
  now: Date
}

export type Filled = {
  text: string
  /** Placeholders left as written because the draft has nothing for them yet. */
  missing: string[]
  /** Placeholders this does not know, left as written. */
  unknown: string[]
}

/** The first name in a display name, "Last, First" included (#39). */
export function firstName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return ''
  const comma = trimmed.indexOf(',')
  const given = comma >= 0 ? trimmed.slice(comma + 1).trim() : trimmed
  return given.split(/\s+/)[0] ?? ''
}

function values(context: PlaceholderContext): Record<Exclude<Placeholder, 'cursor'>, string> {
  const first = parseRecipients(context.to)[0]
  return {
    'to.name': first?.name || '',
    'to.firstName': firstName(first?.name || ''),
    'to.email': first?.address || '',
    'me.name': context.me.name,
    'me.firstName': firstName(context.me.name),
    'me.email': context.me.email,
    subject: context.subject,
    date: context.now.toLocaleDateString(undefined, { dateStyle: 'long' }),
  }
}

/**
 * Fills the placeholders of a text. `html` escapes what goes in, so a name
 * with "<" in it stays a name. `{{cursor}}` is kept, for the caller to turn
 * into the caret.
 */
export function fillPlaceholders(text: string, context: PlaceholderContext, html: boolean): Filled {
  const known = values(context)
  const missing = new Set<string>()
  const unknown = new Set<string>()
  const filled = text.replace(/\{\{\s*([A-Za-z.]+)\s*\}\}/g, (whole, name: string) => {
    if (name === 'cursor') return CURSOR_TOKEN
    if (!(name in known)) {
      unknown.add(name)
      return whole
    }
    const value = known[name as keyof typeof known]
    if (!value) {
      missing.add(name)
      return whole
    }
    return html ? escapeHtml(value) : value
  })
  return { text: filled, missing: [...missing], unknown: [...unknown] }
}

/**
 * Takes the first `{{cursor}}` out of plain text and says where it was; any
 * further ones are dropped. Without one, the caret goes after the text.
 */
export function takeCursor(text: string): { text: string; cursor: number } {
  const at = text.indexOf(CURSOR_TOKEN)
  const without = text.split(CURSOR_TOKEN).join('')
  return { text: without, cursor: at >= 0 ? at : without.length }
}
