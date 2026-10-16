// A conversation as a page.
//
// Building the document is kept apart from printing it: what goes on paper is
// worth being able to state and to test, while asking the window to print is
// three lines that cannot be tested anywhere useful.
//
// Paper is not the screen. There are no bubbles, no left and right, no colour
// standing in for who sent what — a printed conversation has to say who wrote
// each message in words, because the reader of a printout cannot hover, click
// or scroll to find out.

import type { Message } from '../types'
import { stripTrackingPixels } from '../components/chat/readerHtml'
import { DEFAULT_PRINT_OPTIONS, type PrintOptions } from './printOptions'
import { intlLocale } from './i18n'

/** Escapes text for placing in HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The body of one message, as markup.
 *
 * HTML bodies keep their own markup; plain text is escaped and wrapped so the
 * line breaks the author put there survive. Scripts are stripped rather than
 * trusted: this document is same-origin, so an email's own JavaScript would be
 * running with the app's privileges if it were left in.
 */
export function printableBody(message: Message): string {
  if (!message.body_html) {
    return `<pre class="plain">${escapeHtml(message.body ?? '')}</pre>`
  }
  // Tracking pixels go, as they do in the reader tab (#35): printing is not a
  // reason to tell a sender the message was opened.
  const doc = new DOMParser().parseFromString(stripTrackingPixels(message.body_html), 'text/html')
  for (const element of doc.querySelectorAll('script, iframe, object, embed, link, meta')) {
    element.remove()
  }
  // Inline handlers travel in attributes, not in <script>, so they go too.
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (
        name.startsWith('on') ||
        (name === 'href' && attribute.value.trim().toLowerCase().startsWith('javascript:'))
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return doc.body.innerHTML
}

/** One address line, left out entirely when there is nothing to say. */
function addressLine(label: string, value: string | undefined): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  return `<div><span class="label">${escapeHtml(label)}</span> ${escapeHtml(text)}</div>`
}

const STYLE = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #111;
    background: #fff;
    font: 11pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 { font-size: 15pt; margin: 0 0 4mm; }
  .thread-meta { font-size: 9pt; color: #555; margin-bottom: 8mm; }
  /* Never split a message's header from the message it introduces. */
  .message { border-top: 1px solid #bbb; padding-top: 4mm; margin-top: 6mm; }
  .message:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
  .header { font-size: 9pt; color: #333; margin-bottom: 3mm; break-after: avoid; }
  .header .label { color: #777; }
  .who { font-weight: 700; color: #111; font-size: 10pt; }
  .mark { font-weight: 700; color: #111; text-transform: uppercase; letter-spacing: 0.05em; font-size: 8.5pt; }
  .body { font-size: 10.5pt; }
  .body img { max-width: 100%; height: auto; }
  .body table { max-width: 100%; border-collapse: collapse; }
  pre.plain { white-space: pre-wrap; word-wrap: break-word; font: inherit; margin: 0; }
  .attachments { font-size: 9pt; color: #555; margin-top: 3mm; }
  /* A printed link is useless as a link, so the address is spelled out. */
  .body a::after { content: " (" attr(href) ")"; font-size: 8.5pt; color: #666; word-break: break-all; }
  .body a[href^="#"]::after, .body a[href=""]::after { content: ""; }
`

type BlockLabels = { toLabel: string; ccLabel: string; bccLabel: string; attachmentsLabel: string }

/** One message: who wrote it, and as much of when and to whom as was asked for. */
function senderBlock(message: Message, labels: BlockLabels, options: PrintOptions, mark?: string): string {
  const name = message.from_name.trim()
  const address = message.from_addr.trim()
  // The name alone is not enough on paper — two people share a first name and
  // the reader of a printout cannot hover to find out which one this was.
  const who = name
    ? `<span class="who">${escapeHtml(name)}</span> &lt;${escapeHtml(address)}&gt;`
    : `<span class="who">${escapeHtml(address)}</span>`
  const { headers } = options
  const stamp = headers.date && message.date ? ` · ${escapeHtml(new Date(message.date * 1000).toLocaleString(intlLocale()))}` : ''
  const files = options.attachments ? (message.attachments ?? []).map((file) => file.filename).filter(Boolean) : []

  return [
    '<article class="message">',
    '<div class="header">',
    // A draft or an unsent message says so on paper: nothing else would tell
    // it apart from mail that went out.
    mark ? `<div class="mark">${escapeHtml(mark)}</div>` : '',
    `<div>${who}${stamp}</div>`,
    headers.to ? addressLine(labels.toLabel, message.to) : '',
    headers.cc ? addressLine(labels.ccLabel, message.cc) : '',
    headers.bcc ? addressLine(labels.bccLabel, message.bcc) : '',
    '</div>',
    `<div class="body">${printableBody(message)}</div>`,
    files.length > 0
      ? `<div class="attachments">${escapeHtml(labels.attachmentsLabel)} ${escapeHtml(files.join(', '))}</div>`
      : '',
    '</article>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The messages that go on paper, in the order they go there.
 *
 * Sorted by date rather than trusted in the order they were loaded, and
 * stably, so two messages sent in the same second keep the order they came in;
 * newest first is that order reversed, exactly.
 *
 * One message is the one asked about. When none was named it is the newest
 * that is not `marked` (a draft or an unsent copy): "this message" means mail
 * that was sent or received. Only when every message is marked does the
 * newest marked one stand in, and its mark goes on paper with it.
 */
export function printedMessages(
  messages: Message[],
  options: PrintOptions,
  messageId?: string,
  marked: (message: Message) => boolean = () => false,
): Message[] {
  const oldestFirst = [...messages].sort((a, b) => a.date - b.date)
  if (options.scope === 'message') {
    const newestFirst = [...oldestFirst].reverse()
    const chosen =
      messages.find((message) => message.id === messageId) ??
      newestFirst.find((message) => !marked(message)) ??
      newestFirst[0]
    return chosen ? [chosen] : []
  }
  return options.order === 'newest' ? oldestFirst.reverse() : oldestFirst
}

/**
 * A whole conversation, or one message of it, as one self-contained HTML
 * document.
 *
 * `title` names the page whatever the options say; a printed sheet with no
 * subject on it is a sheet nobody can file, so leaving the heading off is a
 * choice the reader makes, not a default.
 */
export function buildPrintDocument(args: {
  subject: string
  /** Every loaded message of the conversation; the options decide which print. */
  messages: Message[]
  printedLabel: string
  printedAt: Date
  toLabel: string
  ccLabel: string
  bccLabel: string
  attachmentsLabel: string
  /** What goes on paper (SET-05); what the app has always printed if absent. */
  options?: PrintOptions
  /** "This message" when the scope is one message; the newest sent or
   * received one if absent. */
  messageId?: string
  /** What sets a message apart from sent or received mail, by id: "Draft",
   * "Not sent". Printed on the message, and never chosen as "this message"
   * when another one is there. */
  marks?: Record<string, string>
  /** Whether the account loads remote images; otherwise the printout does not
   * either, whatever the message asks for (#35). */
  allowRemoteImages?: boolean
  /** Said at the top when older messages of the conversation were not loaded. */
  incompleteNotice?: string
  /** Said at the top when one message is printed out of a conversation that
   * has others: a single message on paper does not show what it answers. */
  oneMessageNotice: string
  /** Said instead when it is not known whether the conversation has others,
   * because it was not loaded: it must not claim there are. */
  oneMessageUnknownNotice: string
  /** The conversation the message belongs to was not loaded here. */
  conversationUnknown?: boolean
}): string {
  const options = args.options ?? DEFAULT_PRINT_OPTIONS
  const marks = args.marks ?? {}
  const printed = printedMessages(args.messages, options, args.messageId, (message) => !!marks[message.id])
  const single = options.scope === 'message'
  // One message prints under its own subject, which may be a reply's.
  const subject = (single && printed[0]?.subject.trim()) || args.subject.trim() || '(no subject)'
  const messages = printed.map((message) => senderBlock(message, args, options, marks[message.id])).join('\n')
  // The message's own policy is stripped with its other <meta> tags, so the
  // printout states its own: no scripts, no frames, no forms, and remote
  // images only where the reader allows them.
  const images = args.allowRemoteImages ? "'self' data: blob: https: http:" : "'self' data: blob:"
  const policy = `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src 'self' data:`
  // What was left out is said, whatever was chosen (#35): the older messages
  // that never loaded, or — for one message — that the conversation has more.
  // A conversation with messages on the server but not here has others too;
  // one that was not loaded at all may have, and the page says only that.
  const othersLeftOut = args.messages.length > printed.length || !!args.incompleteNotice
  // Nothing printed is nothing to speak for: no claim about "this message".
  const singleOmission = !printed.length
    ? ''
    : othersLeftOut
      ? args.oneMessageNotice
      : args.conversationUnknown
        ? args.oneMessageUnknownNotice
        : ''
  const omission = single ? singleOmission : (args.incompleteNotice ?? '')
  const notice = omission ? `<div class="thread-meta incomplete">${escapeHtml(omission)}</div>` : ''
  const heading = options.headers.subject ? `<h1>${escapeHtml(subject)}</h1>\n` : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escapeHtml(subject)}</title>
<style>${STYLE}</style>
</head>
<body>
${heading}<div class="thread-meta">${escapeHtml(args.printedLabel)} ${escapeHtml(args.printedAt.toLocaleString(intlLocale()))}</div>
${notice}
${messages}
</body>
</html>`
}
