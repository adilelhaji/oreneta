// Pure helpers for email address-list strings ("Name <addr>, addr2").
import { splitRecipients } from './recipients'

/** Split a "Name <addr>, addr2" list into individual entries, trimming empties. */
export function splitAddressList(raw: string | undefined | null): string[] {
  if (!raw) return []
  // Not a plain split on commas: `"Doe, John" <j@example.com>` is one person,
  // and a comma or semicolon inside quotes or angle brackets separates nothing.
  return splitRecipients(raw)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Bare-address ("addr") form of a "Name <addr>" or "addr" entry, lowercased. */
export function bareAddr(entry: string): string {
  const match = entry.match(/<([^>]+)>/)
  return (match ? match[1] : entry).trim().toLowerCase()
}
