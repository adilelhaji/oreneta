// Reading and writing a list of email recipients.
//
// The composer keeps its recipients as one string, the way the field has
// always held them and the way the send path still expects them. Chips are a
// way of looking at that string, not a different way of storing it, so
// everything here is about turning the string into pieces and back without
// losing anything on the way.
//
// The naive version of this — split on commas — is wrong in a way that shows
// up on real mail: `"Doe, John" <j@example.com>` is one person, and splitting
// it produces two broken addresses. So the split respects quotes and angle
// brackets, and the original text of every piece is carried along so that
// whatever the user typed survives a round trip even when this file cannot
// make sense of it.

/** One entry in a recipient field, as the parser understood it. */
export type Recipient = {
  /** The display name, empty when the address stood on its own. */
  name: string
  /** The address, without angle brackets. */
  address: string
  /**
   * Whether this reads as an address at all.
   *
   * `unsure` rather than a verdict for anything merely unusual: an internal
   * host with no dot, an address with a `+` tag, a non-Latin domain are all
   * real, and a composer that refuses them is a composer people work around.
   * Only what cannot be an address — no `@`, nothing before or after it,
   * a space in the middle — is called malformed.
   */
  status: 'ok' | 'malformed'
  /** Exactly what was typed, so nothing is lost if it cannot be parsed. */
  raw: string
}

/**
 * Split a recipient string into its entries.
 *
 * Commas and semicolons both separate — Outlook writes semicolons, and someone
 * pasting a list from it should not have to know that. Neither separates while
 * inside quotes or angle brackets, which is what keeps a quoted display name
 * with a comma in it from becoming two people.
 */
export function splitRecipients(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let inAngles = false
  let escaped = false

  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && inQuotes) {
      current += char
      escaped = true
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      current += char
      continue
    }
    if (!inQuotes && char === '<') inAngles = true
    if (!inQuotes && char === '>') inAngles = false
    if ((char === ',' || char === ';') && !inQuotes && !inAngles) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** Strip surrounding quotes from a display name and unescape what is inside. */
function unquote(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
  return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
}

/** Whether a bare string can be an address at all. */
function addressLooksReal(address: string): boolean {
  const at = address.indexOf('@')
  // One `@`, something on each side, and no whitespace anywhere. Everything
  // beyond that is somebody's real mail server and not this file's business.
  if (at <= 0 || at !== address.lastIndexOf('@') || at === address.length - 1) return false
  return !/\s/.test(address)
}

/** Read one entry: `Name <addr>`, `"Quoted, Name" <addr>` or a bare address. */
export function parseRecipient(raw: string): Recipient | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const open = trimmed.lastIndexOf('<')
  const close = trimmed.lastIndexOf('>')
  if (open !== -1 && close > open) {
    const address = trimmed.slice(open + 1, close).trim()
    return {
      name: unquote(trimmed.slice(0, open)),
      address,
      status: addressLooksReal(address) ? 'ok' : 'malformed',
      raw: trimmed,
    }
  }

  return {
    name: '',
    address: trimmed,
    status: addressLooksReal(trimmed) ? 'ok' : 'malformed',
    raw: trimmed,
  }
}

/** Read a whole field. Empty entries — a trailing comma, a stray space — are dropped. */
export function parseRecipients(value: string): Recipient[] {
  return splitRecipients(value)
    .map(parseRecipient)
    .filter((recipient): recipient is Recipient => recipient !== null)
}

/** Write one entry back out, quoting a name that needs it. */
export function formatRecipient(recipient: Recipient): string {
  // Nothing was understood, so nothing is rewritten: the raw text goes back
  // exactly as it came, which is the only way an unparseable entry survives
  // being looked at.
  if (recipient.status === 'malformed' && !recipient.name) return recipient.raw
  if (!recipient.name) return recipient.address

  // A name carrying a separator or a quote has to be quoted, or reading it
  // back would split it into two people.
  const needsQuotes = /[,;<>"]/.test(recipient.name)
  const name = needsQuotes ? `"${recipient.name.replace(/(["\\])/g, '\\$1')}"` : recipient.name
  return `${name} <${recipient.address}>`
}

/** Write a whole field back out, in the form the send path reads. */
export function formatRecipients(recipients: Recipient[]): string {
  return recipients.map(formatRecipient).join(', ')
}

/** The address, lower-cased, as used to tell two entries apart. */
export function recipientKey(recipient: Recipient): string {
  return recipient.address.trim().toLowerCase() || recipient.raw.trim().toLowerCase()
}

/**
 * Add an entry unless the address is already there.
 *
 * Duplicates in a To field are not an error the user needs telling about; they
 * are just something not to do. Adding silently rather than complaining is the
 * behaviour every other client has, and the one nobody notices.
 */
export function addRecipient(recipients: Recipient[], next: Recipient): Recipient[] {
  const key = recipientKey(next)
  if (recipients.some((existing) => recipientKey(existing) === key)) return recipients
  return [...recipients, next]
}
