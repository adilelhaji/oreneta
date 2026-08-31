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

/** Escapes text for placing in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
  const doc = new DOMParser().parseFromString(message.body_html, 'text/html')
  for (const element of doc.querySelectorAll('script, iframe, object, embed, link, meta')) {
    element.remove()
  }
  // Inline handlers travel in attributes, not in <script>, so they go too.
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || (name === 'href' && attribute.value.trim().toLowerCase().startsWith('javascript:'))) {
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
  .body { font-size: 10.5pt; }
  .body img { max-width: 100%; height: auto; }
  .body table { max-width: 100%; border-collapse: collapse; }
  pre.plain { white-space: pre-wrap; word-wrap: break-word; font: inherit; margin: 0; }
  .attachments { font-size: 9pt; color: #555; margin-top: 3mm; }
  /* A printed link is useless as a link, so the address is spelled out. */
  .body a::after { content: " (" attr(href) ")"; font-size: 8.5pt; color: #666; word-break: break-all; }
  .body a[href^="#"]::after, .body a[href=""]::after { content: ""; }
`

/** One message: who wrote it, when, to whom, and what it said. */
function senderBlock(
  message: Message,
  labels: { toLabel: string; ccLabel: string; attachmentsLabel: string },
): string {
  const name = message.from_name.trim()
  const address = message.from_addr.trim()
  // The name alone is not enough on paper — two people share a first name and
  // the reader of a printout cannot hover to find out which one this was.
  const who = name
    ? `<span class="who">${escapeHtml(name)}</span> &lt;${escapeHtml(address)}&gt;`
    : `<span class="who">${escapeHtml(address)}</span>`
  const stamp = message.date ? ` · ${escapeHtml(new Date(message.date * 1000).toLocaleString())}` : ''
  const files = (message.attachments ?? []).map((file) => file.filename).filter(Boolean)

  return [
    '<article class="message">',
    '<div class="header">',
    `<div>${who}${stamp}</div>`,
    addressLine(labels.toLabel, message.to),
    addressLine(labels.ccLabel, message.cc),
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
 * A whole conversation as one self-contained HTML document.
 *
 * `title` names the page; a printed sheet with no subject on it is a sheet
 * nobody can file.
 */
export function buildPrintDocument(args: {
  subject: string
  messages: Message[]
  printedLabel: string
  printedAt: Date
  toLabel: string
  ccLabel: string
  attachmentsLabel: string
}): string {
  const subject = args.subject.trim() || '(no subject)'
  const messages = args.messages.map((message) => senderBlock(message, args)).join('\n')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(subject)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(subject)}</h1>
<div class="thread-meta">${escapeHtml(args.printedLabel)} ${escapeHtml(args.printedAt.toLocaleString())}</div>
${messages}
</body>
</html>`
}
