// Folding quoted history and signatures out of the way while reading (#35,
// S01-07, ADR-0046).
//
// Display only: the stored body, the reply quote and the print view are built
// from the message itself and never see any of this. The rule throughout is
// that a fold is only made when the markup (or the plain-text convention) says
// unmistakably "this is the earlier message" — a block that merely looks
// indented, a forwarded message, or a quote answered line by line stays open.
//
// The HTML fold is a `<details>`/`<summary>` pair, so opening it needs no
// script in the sandboxed frame (whose CSP forbids every script) and no
// message from the frame to the app.

export type FoldKind = 'quote' | 'signature'

export interface FoldLabels {
  showQuoted: string
  hideQuoted: string
  showSignature: string
  hideSignature: string
}

export interface FoldOptions {
  /** Fold quoted history (the earlier messages a reply carries). */
  quotes: boolean
  /** Fold signatures that are marked up (or delimited) as such. */
  signatures: boolean
}

export const DEFAULT_FOLD_LABELS: FoldLabels = {
  showQuoted: 'Show quoted text',
  hideQuoted: 'Hide quoted text',
  showSignature: 'Show signature',
  hideSignature: 'Hide signature',
}

export const FOLD_STYLE_ID = 'oreneta-fold-style'

// "On Mon, 12 Oct 2026 at 10:02, Ana <ana@example.test> wrote:" in the
// languages Oreneta ships, plus the common ones it receives.
const ATTRIBUTION_RE =
  /(wrote|writes|escribió|escribio|a écrit|a ecrit|schrieb|ha scritto|escreveu|schreef|skrev|kirjoitti|napisał|napisal|va escriure|ha escrit|написал|написала|écrit)\s*:\s*$/i
// A forward is the content being sent, not history to be skipped.
const FORWARD_RE =
  /(forwarded message|begin forwarded message|mensaje reenviado|inicio del mensaje reenviado|message transféré|message transfere|weitergeleitete nachricht|messaggio inoltrato|mensagem encaminhada|missatge reenviat|doorgestuurd bericht)/i
const FORWARD_SUBJECT_RE =
  /(subject|asunto|objet|betreff|oggetto|assunto|assumpte|onderwerp)\s*:\s*(fw|fwd|rv|tr|wg|enc|i|doorst)\s*:/i
const ORIGINAL_MESSAGE_RE =
  /^\s*-{2,}\s*(original message|mensaje original|message d'origine|ursprüngliche nachricht|messaggio originale|mensagem original|missatge original|oorspronkelijk bericht)\s*-{2,}\s*$/i
const HEADER_FROM_RE = /^\s*\*?(from|de|von|da|van|från|fra|od)\s*:\*?\s*\S/i
const HEADER_SENT_RE = /(^|\s|\*|\n)(sent|date|enviado|fecha|envoyé|gesendet|datum|inviato|data|enviat|verzonden|skickat)\s*:/i
const ATTRIBUTION_LEAD_RE = /^\s*(on|el|le|am|il|em|op|den|w dniu)\s/i

const VISIBLE_MEDIA = 'img, video, svg, canvas, picture, object, embed'

// ───────────────────────────── HTML ─────────────────────────────

interface FoldRange {
  kind: FoldKind
  /** First and last of a run of siblings that make up the fold. */
  start: Node
  end: Node
}

function rangeNodes(range: FoldRange): Node[] {
  const nodes: Node[] = []
  let node: Node | null = range.start
  while (node) {
    nodes.push(node)
    if (node === range.end) break
    node = node.nextSibling
  }
  return nodes
}

function textOf(node: Node): string {
  return (node.textContent ?? '').replace(/[\s ​‌‍﻿]+/g, ' ').trim()
}

const BLOCK_TAGS = new Set(['BR', 'P', 'DIV', 'LI', 'TR', 'TABLE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR'])

/** Text with a line break wherever the markup breaks a line (`<br>`, blocks). */
function lineTextOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const inner = Array.from(el.childNodes).map(lineTextOf).join('')
  return BLOCK_TAGS.has(el.tagName) ? `\n${inner}\n` : inner
}

function isBlank(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return textOf(node) === ''
  if (node.nodeType !== Node.ELEMENT_NODE) return true
  const el = node as Element
  if (el.tagName === 'BR' || el.tagName === 'HR') return true
  if (el.matches(VISIBLE_MEDIA) || el.querySelector(VISIBLE_MEDIA)) return false
  return textOf(el) === ''
}

/** The nearest sibling before `node` that is not whitespace or a line break. */
function previousContent(node: Node): Node | null {
  let prev = node.previousSibling
  while (prev && isBlank(prev)) prev = prev.previousSibling
  return prev
}

/** Whether `node` carries something a reader would see, outside `excluded`. */
function hasVisibleContent(node: Node, excluded: Set<Node>): boolean {
  if (excluded.has(node)) return false
  if (node.nodeType === Node.TEXT_NODE) return textOf(node) !== ''
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as Element
  if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT' || el.tagName === 'TITLE' || el.tagName === 'HEAD') return false
  if (el.matches(VISIBLE_MEDIA)) return true
  for (const child of Array.from(el.childNodes)) {
    if (hasVisibleContent(child, excluded)) return true
  }
  return false
}

/** True when nothing a reader would see follows the range, other than `allowed`. */
function isTrailing(range: FoldRange, body: Element, allowed: Set<Node>): boolean {
  let node: Node | null = range.end
  while (node && node !== body) {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      if (hasVisibleContent(next, allowed)) return false
    }
    node = node.parentNode
  }
  return true
}

function gmailRanges(doc: Document): FoldRange[] {
  const ranges: FoldRange[] = []
  for (const el of Array.from(doc.querySelectorAll('div.gmail_quote, div.gmail_quote_container'))) {
    if (el.parentElement?.closest('div.gmail_quote, div.gmail_quote_container')) continue
    // A Gmail forward is a `gmail_quote` too, with no blockquote and a
    // "Forwarded message" attribution line.
    const attr = el.querySelector('.gmail_attr')
    if (attr && FORWARD_RE.test(textOf(attr))) continue
    if (!el.querySelector('blockquote')) continue
    ranges.push({ kind: 'quote', start: el, end: el })
  }
  return ranges
}

function toEndOfParent(start: Node): FoldRange {
  let end = start
  while (end.nextSibling) end = end.nextSibling
  return { kind: 'quote', start, end }
}

function isForwardHeader(range: FoldRange): boolean {
  const text = rangeNodes(range)
    .map((node) => lineTextOf(node))
    .join('\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .slice(0, 1200)
  return FORWARD_SUBJECT_RE.test(text) || FORWARD_RE.test(text.slice(0, 200))
}

function outlookRanges(doc: Document): FoldRange[] {
  const ranges: FoldRange[] = []

  // Outlook on the web / new Outlook: `#appendonsend`, an `<hr>`, then the
  // `#divRplyFwdMsg` header, with the earlier message as the siblings after it.
  for (const header of Array.from(doc.querySelectorAll('[id="divRplyFwdMsg" i]'))) {
    let start: Node = header
    const prev = header.previousElementSibling
    if (prev?.tagName === 'HR') {
      start = prev
      const before = prev.previousElementSibling
      if (before?.id?.toLowerCase() === 'appendonsend') start = before
    }
    const range = toEndOfParent(start)
    if (!isForwardHeader(range)) ranges.push(range)
  }

  // Outlook for Windows / Mac: a top-bordered block whose first line is
  // "From:" and which names when it was sent; or a "-----Original
  // Message-----" line. Both are followed by the earlier message.
  for (const el of Array.from(doc.querySelectorAll('div, p'))) {
    const text = lineTextOf(el).replace(/[ \t\u00a0]+/g, ' ').trim()
    let isDivider = false
    if (el.tagName === 'DIV') {
      const style = (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '')
      isDivider =
        style.includes('border-top:solid') && HEADER_FROM_RE.test(text) && HEADER_SENT_RE.test(text.slice(0, 400))
    }
    if (!isDivider && ORIGINAL_MESSAGE_RE.test(textOf(el)) && !el.querySelector('div, p')) isDivider = true
    if (!isDivider) continue
    if (el.closest('[id="divRplyFwdMsg" i]')) continue

    // Climb out of wrappers that hold nothing but the divider, so the fold
    // takes in the earlier message that follows the wrapper.
    let start: Element = el
    while (
      start.parentElement &&
      start.parentElement.tagName !== 'BODY' &&
      Array.from(start.parentElement.childNodes).every((child) => child === start || isBlank(child))
    ) {
      start = start.parentElement
    }
    const range = toEndOfParent(start)
    if (!isForwardHeader(range)) ranges.push(range)
  }
  return ranges
}

function blockquoteRanges(doc: Document): FoldRange[] {
  const ranges: FoldRange[] = []
  for (const quote of Array.from(doc.querySelectorAll('blockquote'))) {
    if (quote.parentElement?.closest('blockquote')) continue
    if (quote.closest('div.gmail_quote, div.gmail_quote_container')) continue
    const cite = (quote.getAttribute('type') ?? '').toLowerCase() === 'cite'
    const prev = previousContent(quote)
    const prevText = prev ? textOf(prev) : ''
    const prevIsAttribution =
      !!prev &&
      prevText.length <= 400 &&
      (ATTRIBUTION_RE.test(prevText) || (prev as Element).classList?.contains('moz-cite-prefix'))
    // Apple Mail and Thunderbird forward inside a cite blockquote too.
    if (prev && FORWARD_RE.test(prevText.slice(-200))) continue
    if (FORWARD_RE.test(textOf(quote).slice(0, 200))) continue
    // A plain blockquote is only history when an attribution line says so;
    // otherwise it is the sender quoting something on purpose.
    if (!cite && !prevIsAttribution) continue
    ranges.push({ kind: 'quote', start: prevIsAttribution && prev ? prev : quote, end: quote })
  }
  return ranges
}

function signatureRanges(doc: Document): FoldRange[] {
  const ranges: FoldRange[] = []
  const selector =
    '.gmail_signature, [data-smartmail="gmail_signature"], [id="Signature"], .moz-signature, div[data-signature]'
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    if (el.parentElement?.closest(selector)) continue
    if (!hasVisibleContent(el, new Set())) continue
    let start: Node = el
    const prev = previousContent(el)
    if (prev && (prev as Element).classList?.contains('gmail_signature_prefix')) start = prev
    ranges.push({ kind: 'signature', start, end: el })
  }
  return ranges
}

function dropNested(ranges: FoldRange[]): FoldRange[] {
  const kept: FoldRange[] = []
  // Outer ranges first, so the inner ones are what get dropped.
  const ordered = [...ranges].sort((a, b) => {
    if (a.start === b.start) return 0
    if (a.start.contains(b.start)) return -1
    if (b.start.contains(a.start)) return 1
    return a.start.compareDocumentPosition(b.start) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  for (const range of ordered) {
    const nested = kept.some((other) => rangeNodes(other).some((node) => node === range.start || node.contains(range.start)))
    if (!nested) kept.push(range)
  }
  return kept
}

/**
 * Finds what can be folded in a parsed message. Pure: the document is not
 * touched. Returned ranges never overlap and never leave the message with
 * nothing to read.
 */
export function findFoldRanges(doc: Document, options: FoldOptions): FoldRange[] {
  const body = doc.body
  if (!body || (!options.quotes && !options.signatures)) return []

  const signatures = options.signatures ? signatureRanges(doc) : []
  const signatureNodes = new Set(signatures.flatMap(rangeNodes))
  const quotes = options.quotes
    ? dropNested([...gmailRanges(doc), ...outlookRanges(doc), ...blockquoteRanges(doc)]).filter((range) =>
        // History sits at the end. A quote with the reader's answer after it
        // is an inline reply, and folding it would hide what is being
        // answered.
        isTrailing(range, body, signatureNodes),
      )
    : []

  const leavesSomething = (ranges: FoldRange[]) =>
    hasVisibleContent(body, new Set(ranges.flatMap(rangeNodes)))

  const all = dropNested([...quotes, ...signatures])
  if (all.length === 0) return []
  if (leavesSomething(all)) return all
  // Never fold a message down to nothing: a reply that is only a quote, or a
  // message that is only a signature, is read as it is.
  const quotesOnly = all.filter((range) => range.kind === 'quote')
  if (quotesOnly.length && leavesSomething(quotesOnly)) return quotesOnly
  return []
}

/** The stylesheet the fold toggles need, inside the frame. */
export function foldStylesheet(): string {
  return `
    details.oreneta-fold { display: block; margin: 8px 0; }
    details.oreneta-fold > summary.oreneta-fold-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      list-style: none;
      margin: 2px 0;
      padding: 1px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 999px;
      background: #f8fafc;
      color: #475569;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      user-select: none;
    }
    details.oreneta-fold > summary.oreneta-fold-toggle::-webkit-details-marker { display: none; }
    details.oreneta-fold > summary.oreneta-fold-toggle::marker { content: ''; }
    details.oreneta-fold > summary.oreneta-fold-toggle::before {
      content: '\\2022\\2022\\2022';
      letter-spacing: 1px;
      font-size: 10px;
    }
    details.oreneta-fold > summary.oreneta-fold-toggle:hover { color: #0f172a; border-color: #94a3b8; }
    details.oreneta-fold > summary.oreneta-fold-toggle:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
    details.oreneta-fold > summary .oreneta-fold-hide { display: none; }
    details.oreneta-fold[open] > summary .oreneta-fold-show { display: none; }
    details.oreneta-fold[open] > summary .oreneta-fold-hide { display: inline; }
  `
}

function ensureFoldStyle(doc: Document) {
  if (doc.getElementById(FOLD_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = FOLD_STYLE_ID
  style.textContent = foldStylesheet()
  ;(doc.head ?? doc.documentElement).appendChild(style)
}

/**
 * Wraps the foldable ranges of `doc` in closed `<details>` toggles. Returns how
 * many folds were made. Idempotent: an already-folded document is left alone.
 */
export function applyHtmlFolds(doc: Document, options: FoldOptions, labels: FoldLabels = DEFAULT_FOLD_LABELS): number {
  if (doc.querySelector('details.oreneta-fold')) return 0
  const ranges = findFoldRanges(doc, options)
  for (const range of ranges) {
    const nodes = rangeNodes(range)
    const parent = range.start.parentNode
    if (!parent) continue
    const details = doc.createElement('details')
    details.className = `oreneta-fold oreneta-fold-${range.kind}`
    details.setAttribute('data-oreneta-fold', range.kind)
    const summary = doc.createElement('summary')
    summary.className = 'oreneta-fold-toggle'
    const show = doc.createElement('span')
    show.className = 'oreneta-fold-show'
    show.textContent = range.kind === 'quote' ? labels.showQuoted : labels.showSignature
    const hide = doc.createElement('span')
    hide.className = 'oreneta-fold-hide'
    hide.textContent = range.kind === 'quote' ? labels.hideQuoted : labels.hideSignature
    summary.append(show, hide)
    details.appendChild(summary)
    parent.insertBefore(details, range.start)
    for (const node of nodes) details.appendChild(node)
  }
  if (ranges.length) ensureFoldStyle(doc)
  return ranges.length
}

/** String-in, string-out wrapper for frames whose HTML is prepared as text. */
export function foldHtml(html: string, options: FoldOptions, labels: FoldLabels = DEFAULT_FOLD_LABELS): string {
  if (!options.quotes && !options.signatures) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    if (applyHtmlFolds(doc, options, labels) === 0) return html
    return doc.documentElement.outerHTML
  } catch {
    return html
  }
}

/** Opens every fold that holds `node`, so a search hit inside one shows. */
export function revealFoldsAround(node: Node | null) {
  let el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null)
  while (el) {
    const fold = el.closest('details.oreneta-fold') as HTMLDetailsElement | null
    if (!fold) break
    fold.open = true
    el = fold.parentElement
  }
}

// ────────────────────────── plain text ──────────────────────────

export interface PlainSegment {
  kind: 'body' | FoldKind
  text: string
}

const isQuoteLine = (line: string) => /^\s*>/.test(line)
const isBlankLine = (line: string) => line.trim() === ''

/** Index of a trailing Outlook-style header block ("From: … Sent: …"), or -1. */
function plainOutlookStart(lines: string[]): number {
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    let headerAt = -1
    if (ORIGINAL_MESSAGE_RE.test(line)) headerAt = i + 1
    else if (/^\s*_{8,}\s*$/.test(line)) headerAt = i + 1
    else if (HEADER_FROM_RE.test(line) && isBlankLine(lines[i - 1])) headerAt = i
    if (headerAt < 0) continue
    // Allow a blank line between the divider and the header.
    while (headerAt < lines.length && isBlankLine(lines[headerAt]) && headerAt <= i + 2) headerAt += 1
    const header = lines.slice(headerAt, headerAt + 8)
    if (!header.length || !HEADER_FROM_RE.test(header[0])) {
      // "-----Original Message-----" is unambiguous on its own.
      if (!ORIGINAL_MESSAGE_RE.test(line)) continue
    } else if (!header.slice(1).some((h) => HEADER_SENT_RE.test(h))) {
      continue
    }
    if (FORWARD_SUBJECT_RE.test(header.join('\n')) || FORWARD_RE.test(lines.slice(Math.max(0, i - 2), i + 1).join(' ')))
      continue
    return i
  }
  return -1
}

/** Index where a trailing ">" quote (with its attribution) begins, or -1. */
function plainQuoteStart(lines: string[]): number {
  let i = lines.length - 1
  let quoteLines = 0
  let first = -1
  while (i >= 0 && (isBlankLine(lines[i]) || isQuoteLine(lines[i]))) {
    if (isQuoteLine(lines[i])) {
      quoteLines += 1
      first = i
    }
    i -= 1
  }
  if (first < 0) return -1

  // The attribution sits directly above, perhaps after one blank line, and is
  // sometimes wrapped over two lines.
  let attribution = -1
  let j = first - 1
  if (j >= 0 && isBlankLine(lines[j])) j -= 1
  if (j >= 0 && ATTRIBUTION_RE.test(lines[j].trim()) && lines[j].length <= 300) {
    attribution = j
    if (j - 1 >= 0 && !isBlankLine(lines[j - 1]) && ATTRIBUTION_LEAD_RE.test(lines[j - 1]) && !ATTRIBUTION_LEAD_RE.test(lines[j]))
      attribution = j - 1
  }
  if (attribution >= 0 && FORWARD_RE.test(lines.slice(attribution, first).join(' '))) return -1
  // One stray "> " line at the end could be anything; two, or one that
  // someone introduced with "… wrote:", is a quote.
  if (attribution < 0 && quoteLines < 2) return -1
  return attribution >= 0 ? attribution : first
}

function plainSignatureStart(lines: string[], before: number): number {
  for (let i = before - 1; i > 0; i -= 1) {
    if (/^-- ?$/.test(lines[i])) {
      // The convention asks for four lines; allow a generous margin, but a
      // "--" with half the message below it is a separator, not a signature.
      return before - i - 1 <= 12 ? i : -1
    }
  }
  return -1
}

function hasText(lines: string[]) {
  return lines.some((line) => !isBlankLine(line))
}

/**
 * Splits a plain-text body into what to show and what to fold. The segments
 * concatenate (joined by "\n") back to the original text.
 */
export function splitPlainText(text: string, options: FoldOptions): PlainSegment[] {
  const whole: PlainSegment[] = [{ kind: 'body', text }]
  if (!text || (!options.quotes && !options.signatures)) return whole
  const lines = text.split('\n')

  let quoteStart = -1
  if (options.quotes) {
    const candidates = [plainOutlookStart(lines), plainQuoteStart(lines)].filter((n) => n > 0)
    if (candidates.length) quoteStart = Math.min(...candidates)
  }
  const tail = quoteStart >= 0 ? quoteStart : lines.length
  let signatureStart = options.signatures ? plainSignatureStart(lines, tail) : -1

  const bodyEnd = () => (signatureStart >= 0 ? signatureStart : tail)
  if (!hasText(lines.slice(0, bodyEnd()))) {
    // Never fold down to nothing: keep the signature, then give up.
    signatureStart = -1
    if (!hasText(lines.slice(0, bodyEnd()))) return whole
  }
  if (quoteStart < 0 && signatureStart < 0) return whole

  const segments: PlainSegment[] = [{ kind: 'body', text: lines.slice(0, bodyEnd()).join('\n') }]
  if (signatureStart >= 0) segments.push({ kind: 'signature', text: lines.slice(signatureStart, tail).join('\n') })
  if (quoteStart >= 0) segments.push({ kind: 'quote', text: lines.slice(quoteStart).join('\n') })
  return segments
}
