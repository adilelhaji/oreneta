// General → Print (SET-05, ADR-0060): what a printout contains. The defaults
// print what the app has always printed — the whole conversation, oldest
// first, every header it carried and the attachment list — so nobody's
// printout changes because a setting appeared.
//
// Nothing here touches state: settings.ts keeps `settings$.print` and the
// print entry points hand the value to buildPrintDocument.

/** One message, or every loaded message of its conversation. */
export type PrintScope = 'message' | 'conversation'
/** Which end of the conversation comes first on paper. */
export type PrintOrder = 'oldest' | 'newest'

/**
 * The header fields that can be left off. The sender is not among them: on
 * paper there is no other way to tell who wrote a message.
 */
export type PrintHeaders = {
  /** The subject as the heading of the page. */
  subject: boolean
  date: boolean
  to: boolean
  cc: boolean
  /** Only ever known on copies this account sent. */
  bcc: boolean
}

export type PrintOptions = {
  headers: PrintHeaders
  scope: PrintScope
  order: PrintOrder
  /** Whether each message lists its attachments by name. */
  attachments: boolean
}

export const PRINT_HEADER_FIELDS = [
  'subject',
  'date',
  'to',
  'cc',
  'bcc',
] as const satisfies readonly (keyof PrintHeaders)[]

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  // Bcc was never printed: it names people the other recipients were not told
  // about, so it goes on paper only when asked for.
  headers: { subject: true, date: true, to: true, cc: true, bcc: false },
  scope: 'conversation',
  order: 'oldest',
  attachments: true,
}

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/**
 * Read a stored value back. Unknown fields are dropped and missing or invalid
 * ones fall back to the default one by one, so a value written by a newer build
 * (or edited by hand) never costs the reader their other choices.
 */
export function sanitizePrintOptions(raw: unknown): PrintOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const d = DEFAULT_PRINT_OPTIONS
  const storedHeaders =
    value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
      ? (value.headers as Record<string, unknown>)
      : {}
  const headers = { ...d.headers }
  for (const field of PRINT_HEADER_FIELDS) headers[field] = bool(storedHeaders[field], d.headers[field])
  return {
    headers,
    scope: value.scope === 'message' || value.scope === 'conversation' ? value.scope : d.scope,
    order: value.order === 'oldest' || value.order === 'newest' ? value.order : d.order,
    attachments: bool(value.attachments, d.attachments),
  }
}
