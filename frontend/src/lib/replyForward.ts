// Mail → Replies and forwards (SET-09, ADR-0047): the preferences that shape the
// body and subject of a reply or a forward, and the pure builders that apply
// them. Nothing here touches state; compose.ts reads `settings$.replyForward`
// and hands the values in, which keeps every mode testable on its own.

import { t } from './i18n'
import i18n from './i18n'

/** Where the reply's own text goes relative to the quoted original. */
export type ReplyPosition = 'above' | 'below'
/**
 * How the original is quoted. 'html': a blockquote with a left border when the
 * reply is rich (the original was HTML, or the account writes HTML), "> " lines
 * otherwise. 'plain': always a plain-text reply with "> " before every line.
 */
export type QuoteStyle = 'html' | 'plain'
/** 'short': "On {date}, {name} wrote:". 'outlook': a From/Sent/To/Cc/Subject block. */
export type ReplyHeaderStyle = 'short' | 'outlook'
/** 'inline': the original quoted in the body. 'attachment': the original .eml attached. */
export type ForwardMode = 'inline' | 'attachment'

export type ReplyForwardPrefs = {
  replyPosition: ReplyPosition
  /** Whether a reply opened in the full editor carries the original at all. */
  includeOriginal: boolean
  quoteStyle: QuoteStyle
  headerStyle: ReplyHeaderStyle
  forwardMode: ForwardMode
  /** Collapse stacked prefixes ("Re: RE: Re[2]:" → "Re:", "Fwd: FW:" → "Fwd:"). */
  collapsePrefixes: boolean
  /** Whether an inline forward copies the original's attachments into the draft. */
  forwardAttachments: boolean
}

export const DEFAULT_REPLY_FORWARD_PREFS: ReplyForwardPrefs = {
  replyPosition: 'above',
  includeOriginal: true,
  quoteStyle: 'html',
  headerStyle: 'short',
  forwardMode: 'inline',
  collapsePrefixes: true,
  forwardAttachments: true,
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/**
 * Read a stored value back. Unknown fields are dropped and missing or invalid
 * ones fall back to the default one by one, so a value written by a newer build
 * (or edited by hand) never costs the user their other choices.
 */
export function sanitizeReplyForwardPrefs(raw: unknown): ReplyForwardPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const d = DEFAULT_REPLY_FORWARD_PREFS
  return {
    replyPosition: oneOf(value.replyPosition, ['above', 'below'] as const, d.replyPosition),
    includeOriginal: bool(value.includeOriginal, d.includeOriginal),
    quoteStyle: oneOf(value.quoteStyle, ['html', 'plain'] as const, d.quoteStyle),
    headerStyle: oneOf(value.headerStyle, ['short', 'outlook'] as const, d.headerStyle),
    forwardMode: oneOf(value.forwardMode, ['inline', 'attachment'] as const, d.forwardMode),
    collapsePrefixes: bool(value.collapsePrefixes, d.collapsePrefixes),
    forwardAttachments: bool(value.forwardAttachments, d.forwardAttachments),
  }
}

// --- Subjects -----------------------------------------------------------------

// Reply prefixes other clients put on the wire, in the languages they ship:
// Re, Aw (de), Sv (sv/da/no), Antw (nl), Vs (fi), Odp (pl), Ynt (tr), Rif (it),
// Res (pt), Réf. A counter ("Re[2]:", "Re(3):") is part of the same prefix.
const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw|vs|odp|ynt|rif|res|réf)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i
// Only the unambiguous forward prefixes are stripped when collapsing: "I:",
// "TR:" or "Vs:" also start ordinary subjects too often to be guessed at.
const FORWARD_COLLAPSE = /^\s*(?:fwd?|wg)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i

function stripLeading(subject: string, prefix: RegExp): string {
  let rest = subject
  for (;;) {
    const next = rest.replace(prefix, '')
    if (next === rest) return rest
    rest = next
  }
}

/**
 * The subject of a reply. With `collapse` every leading reply prefix, in any
 * case or language, becomes one "Re: "; without it the original is kept as it
 * is and "Re: " is only added when it does not already start with one.
 */
export function replySubject(subject: string, collapse: boolean): string {
  const trimmed = (subject ?? '').trim()
  if (!collapse) return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
  const rest = stripLeading(trimmed, REPLY_PREFIX)
  return `Re: ${rest}`.trimEnd()
}

/** The subject of a forward, collapsing stacked "Fwd:"/"FW:" when asked. */
export function forwardSubject(subject: string, collapse: boolean): string {
  const trimmed = (subject ?? '').trim()
  if (!trimmed) return `Fwd: ${t('compose.forward.noSubject', { defaultValue: '(no subject)' })}`
  if (!collapse) return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`
  const rest = stripLeading(trimmed, FORWARD_COLLAPSE)
  return rest ? `Fwd: ${rest}` : `Fwd: ${t('compose.forward.noSubject', { defaultValue: '(no subject)' })}`
}

// --- Quote building -------------------------------------------------------------

/** What the builders need to know about the message being answered. */
export type QuotedMessage = {
  from_name?: string
  from_addr: string
  to?: string
  cc?: string
  subject: string
  date: number
  body?: string
  body_html?: string
}

export type QuoteOptions = {
  /** BCP 47 locale for the date; defaults to the app's language. */
  locale?: string
  /** IANA zone for the date; defaults to the system's. Tests pin it. */
  timeZone?: string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Strong right-to-left characters (Hebrew, Arabic, Syriac, Thaana, NKo, …).
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/

/**
 * Wrap a value that holds right-to-left text in FIRST STRONG ISOLATE … POP
 * DIRECTIONAL ISOLATE, so "On 3 May, דנה כהן wrote:" keeps its order around the
 * name instead of the name swallowing the comma and the date. Left-to-right
 * values are returned untouched, so ordinary replies carry no invisible marks.
 */
export function isolate(value: string): string {
  return RTL.test(value) ? `⁨${value}⁩` : value
}

function appLocale(): string {
  return (i18n.language || 'en').replace('_', '-')
}

/** The original's date in the user's language (and zone), as the header shows it. */
export function formatQuoteDate(epochSeconds: number, options: QuoteOptions = {}): string {
  if (!epochSeconds) return ''
  const locale = options.locale ?? appLocale()
  const format = (loc: string | undefined) =>
    new Intl.DateTimeFormat(loc, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(new Date(epochSeconds * 1000))
  try {
    return format(locale)
  } catch {
    return format(undefined)
  }
}

function senderLabel(message: QuotedMessage): string {
  return message.from_name?.trim() || message.from_addr
}

function senderFull(message: QuotedMessage): string {
  const name = message.from_name?.trim()
  return name ? `${name} <${message.from_addr}>` : message.from_addr
}

/** The one-line attribution of the short header. */
export function shortAttribution(message: QuotedMessage, options: QuoteOptions = {}): string {
  const date = formatQuoteDate(message.date, options)
  const name = isolate(senderLabel(message))
  return date
    ? t('compose.reply.attribution', { defaultValue: 'On {date}, {name} wrote:', date, name })
    : t('compose.reply.attributionNoDate', { defaultValue: '{name} wrote:', name })
}

/** The rows of the Outlook-style header, empty ones left out. */
export function outlookHeaderRows(message: QuotedMessage, options: QuoteOptions = {}): Array<[string, string]> {
  const rows: Array<[string, string | undefined]> = [
    [t('compose.reply.header.from', { defaultValue: 'From' }), isolate(senderFull(message))],
    [t('compose.reply.header.sent', { defaultValue: 'Sent' }), formatQuoteDate(message.date, options)],
    [t('compose.reply.header.to', { defaultValue: 'To' }), message.to ? isolate(message.to) : ''],
    [t('compose.reply.header.cc', { defaultValue: 'Cc' }), message.cc ? isolate(message.cc) : ''],
    [
      t('compose.reply.header.subject', { defaultValue: 'Subject' }),
      isolate(message.subject?.trim() || t('compose.forward.noSubject', { defaultValue: '(no subject)' })),
    ],
  ]
  return rows.filter((row): row is [string, string] => !!row[1]?.trim())
}

function plainTextOf(message: QuotedMessage): string {
  if (message.body?.trim()) return message.body
  if (!message.body_html) return ''
  const doc = new DOMParser().parseFromString(message.body_html, 'text/html')
  for (const br of Array.from(doc.querySelectorAll('br'))) br.replaceWith('\n')
  for (const block of Array.from(doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote'))) {
    block.append('\n')
  }
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

function textToHtml(text: string): string {
  if (!text.trim()) return ''
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('')
}

/** "> " before every line; an already quoted line gets ">" so levels stack as ">> ". */
export function prefixQuote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line.startsWith('>') ? `>${line}` : line ? `> ${line}` : '>'))
    .join('\n')
}

/** Whether a reply quoting this message is written as rich text. */
export function quoteIsRich(message: QuotedMessage, prefs: ReplyForwardPrefs, accountWritesHtml: boolean): boolean {
  if (prefs.quoteStyle === 'plain') return false
  return !!message.body_html?.trim() || accountWritesHtml
}

/**
 * The quoted original as it is appended to (or put before) a reply: the header
 * in the chosen style, then the original's body quoted. `rich` picks the form;
 * the other one is left empty because the composer only ever reads one.
 */
export function buildReplyQuote(
  message: QuotedMessage,
  prefs: ReplyForwardPrefs,
  rich: boolean,
  options: QuoteOptions = {},
): { html: string; text: string } {
  if (!rich) {
    const header =
      prefs.headerStyle === 'outlook'
        ? ['-----', ...outlookHeaderRows(message, options).map(([label, value]) => `${label}: ${value}`)].join('\n')
        : shortAttribution(message, options)
    const body = plainTextOf(message)
    // The Outlook block is a header, not part of the quote: it reads the same
    // either way, so only the body takes the "> " marks.
    const quoted = body ? prefixQuote(body) : ''
    return { html: '', text: quoted ? `${header}\n${quoted}` : header }
  }
  const header =
    prefs.headerStyle === 'outlook'
      ? `<hr><p>${outlookHeaderRows(message, options)
          .map(([label, value]) => `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`)
          .join('<br>')}</p>`
      : `<p>${escapeHtml(shortAttribution(message, options))}</p>`
  const body = message.body_html?.trim() ? message.body_html : textToHtml(message.body ?? '')
  // The composer's stylesheet draws the border while editing and
  // inlineRichStyles bakes the same border into the sent message.
  return { html: `${header}<blockquote>${body || '<p></p>'}</blockquote>`, text: '' }
}

/**
 * Put the user's own part of a reply (their text, then the signature) and the
 * quote together in the chosen order. A blank line is left between them; in a
 * bottom-posted reply the cursor's place is the empty line after the quote.
 */
export function joinReplyBody(
  own: { rich: boolean; html: string; text: string },
  quote: { html: string; text: string },
  position: ReplyPosition,
): { rich: boolean; html: string; text: string } {
  if (own.rich) {
    const ownHtml = own.html || '<p></p>'
    const html = position === 'above' ? `${ownHtml}<p></p>${quote.html}` : `${quote.html}<p></p>${ownHtml}`
    return { ...own, html }
  }
  const ownText = own.text
  if (position === 'above') {
    const head = ownText.replace(/\n+$/, '')
    return { ...own, text: `${head}\n\n${quote.text}` }
  }
  return { ...own, text: `${quote.text}\n${ownText.startsWith('\n') ? ownText : `\n${ownText}`}` }
}
