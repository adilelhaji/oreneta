// The operations a chip field performs on a recipient string.
//
// The chips are a view. The string underneath is still the whole truth: it is
// what the draft saves, what the send path reads, and what survives closing
// the composer mid-word. So every gesture — committing a name, removing a
// chip, taking one back apart to fix a typo — is a function from that string
// to a new one, and none of them keeps state of its own.
//
// The one subtlety is what counts as "still being typed". A field ending in a
// separator has nothing pending; otherwise the last piece is the token under
// the cursor and must not become a chip yet, or the field would harden a
// half-typed address the moment a letter was entered.

import {
  formatRecipient,
  formatRecipients,
  parseRecipient,
  splitRecipients,
  type Recipient,
} from './recipients'

export type FieldParts = {
  /** The entries that have become chips. */
  committed: Recipient[]
  /** The text under the cursor, not yet a chip. */
  pending: string
}

/** Read the field into its chips and the token still being typed. */
export function fieldParts(value: string): FieldParts {
  const parts = splitRecipients(value)
  const pending = parts.pop() ?? ''
  const committed = parts
    .map(parseRecipient)
    .filter((recipient): recipient is Recipient => recipient !== null)
  return { committed, pending: pending.trimStart() }
}

/** Write chips and a pending token back into one field. */
export function compose(committed: Recipient[], pending: string): string {
  const head = committed.length ? `${formatRecipients(committed)}, ` : ''
  return `${head}${pending}`
}

/** Replace the token under the cursor, leaving the chips alone. */
export function setPending(value: string, pending: string): string {
  return compose(fieldParts(value).committed, pending)
}

/**
 * Turn the pending token into a chip.
 *
 * Given text, that text becomes the chip instead — which is how a suggestion
 * accepted from the dropdown replaces what was typed towards it.
 *
 * Nothing pending and nothing given means nothing happens, so pressing Enter
 * on an empty field is not a way to grow a list of blanks.
 */
export function commitPending(value: string, text?: string): string {
  const { committed, pending } = fieldParts(value)
  const source = (text ?? pending).trim()
  if (!source) return compose(committed, '')

  // A paste can carry a whole list, so one commit may add several chips.
  const added = splitRecipients(source)
    .map(parseRecipient)
    .filter((recipient): recipient is Recipient => recipient !== null)
  if (added.length === 0) return compose(committed, '')

  const next = [...committed]
  for (const recipient of added) {
    const key = recipient.address.trim().toLowerCase() || recipient.raw.trim().toLowerCase()
    const already = next.some(
      (existing) => (existing.address.trim().toLowerCase() || existing.raw.trim().toLowerCase()) === key,
    )
    if (!already) next.push(recipient)
  }
  return compose(next, '')
}

/** Remove one chip, leaving whatever is being typed untouched. */
export function removeAt(value: string, index: number): string {
  const { committed, pending } = fieldParts(value)
  if (index < 0 || index >= committed.length) return value
  return compose(committed.filter((_, i) => i !== index), pending)
}

/**
 * Take a chip back apart so it can be corrected.
 *
 * The chip's text becomes the pending token. Anything already pending is
 * committed first rather than thrown away or run together with it — losing
 * what someone had half-typed because they reached for an earlier chip would
 * be the composer editing on their behalf.
 */
export function editAt(value: string, index: number): string {
  const { committed, pending } = fieldParts(value)
  if (index < 0 || index >= committed.length) return value

  const target = committed[index]
  const kept = committed.filter((_, i) => i !== index)
  const withPending = pending.trim() ? fieldParts(commitPending(compose(kept, pending))).committed : kept
  return compose(withPending, formatRecipient(target))
}

/** Whether anything in the field could not be read as an address. */
export function hasMalformed(value: string): boolean {
  return fieldParts(value).committed.some((recipient) => recipient.status === 'malformed')
}
