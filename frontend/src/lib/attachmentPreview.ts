// Which attachments can be shown without leaving the app.
//
// Deliberately a short list. Offering a preview that renders a blank frame is
// worse than offering none: the reader concludes the file is empty or broken
// when it is neither. WebKitGTK carries no PDF viewer of its own, so PDFs are
// drawn by pdf.js — and only drawn: no links, no forms, nothing a document
// from a stranger can ask the app to do.

/** How an attachment can be shown, or null when it cannot be. */
export type PreviewKind = 'image' | 'text' | 'pdf' | null

/** Extensions that hold text whatever the server called their type. */
const TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.log',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.ics',
  '.vcf',
  '.diff',
  '.patch',
]

/** Beyond this a text preview stops being a preview and starts being a wait. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot).toLowerCase()
}

/**
 * Whether an attachment can be previewed, and how.
 *
 * `key` is what makes it possible at all: without one the file is not on disk
 * yet, so there is nothing to show.
 */
export function previewKind(attachment: {
  filename: string
  mime: string
  size: number
  key: string | null
}): PreviewKind {
  if (!attachment.key) return null
  const mime = attachment.mime.toLowerCase()

  // SVG is an image that can carry script, and it would render from the app's
  // own origin. Not shown as a picture, and not shown as markup either — a
  // reader who clicks a logo wants to see the logo, and being handed its
  // source instead is a worse answer than being handed the file.
  if (mime.includes('svg') || extensionOf(attachment.filename) === '.svg') return null
  if (mime.startsWith('image/')) return 'image'

  // Drawn page by page rather than handed to the platform. Size is not capped
  // here the way text is: only the pages being looked at are ever rendered, so
  // a long document costs a page, not a document.
  if (mime === 'application/pdf' || extensionOf(attachment.filename) === '.pdf') return 'pdf'

  const looksTextual =
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime.endsWith('+json') ||
    TEXT_EXTENSIONS.includes(extensionOf(attachment.filename))
  if (!looksTextual) return null
  if (attachment.size > TEXT_PREVIEW_MAX_BYTES) return null
  // Including HTML, which is shown as its source rather than rendered: it is a
  // document written by a stranger, and reading it is not the same as running
  // it.
  return 'text'
}
