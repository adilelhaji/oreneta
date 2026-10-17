/** Rewrite `cid:<inlineId>` image refs to `data:` URLs from the matching
 * composer attachments. Used for locally-rendered copies of an outgoing
 * message (the optimistic sent bubble/reader): they never went through the
 * backend's cid-to-`/media/<key>` rewrite, so without this the reader has no
 * way to resolve the refs and shows broken images. */
export function resolveInlineCids(
  html: string,
  attachments: Array<{ inlineId?: string; mime: string; data: string }>,
): string {
  let out = html
  for (const attachment of attachments) {
    if (!attachment.inlineId) continue
    out = out.split(`cid:${attachment.inlineId}`).join(`data:${attachment.mime};base64,${attachment.data}`)
  }
  return out
}

/**
 * Derive a plaintext fallback from rich-text HTML while preserving visible line
 * breaks. A table becomes one line per row, its cells joined by ` | ` (#274,
 * ADR-0067), set apart like a paragraph.
 */
export function htmlToText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return blockText(Array.from(div.childNodes))
}

export const TABLE_CELL_SEPARATOR = ' | '

const paragraphTags = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'P',
  'PRE',
  'SECTION',
])
const lineBreakTags = new Set(['LI', 'OL', 'TR', 'UL'])

function blockText(nodes: Node[]): string {
  let out = ''

  const appendNewlines = (count: number) => {
    if (!out) return
    const trailing = out.match(/\n*$/)?.[0].length ?? 0
    if (trailing < count) out += '\n'.repeat(count - trailing)
  }

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      return
    }
    if (!(node instanceof HTMLElement)) return

    if (node.tagName === 'BR') {
      out += '\n'
      return
    }
    if (node.tagName === 'IMG') {
      // Composer inline images are block-level, so put the alt (the image's
      // filename) on its own paragraph rather than gluing it to the text
      // before/after the image.
      const alt = node.getAttribute('alt')?.trim()
      if (alt) {
        appendNewlines(2)
        out += alt
        appendNewlines(2)
      }
      return
    }
    if (node.tagName === 'TABLE') {
      appendNewlines(2)
      out += tableText(node)
      appendNewlines(2)
      return
    }

    for (const child of Array.from(node.childNodes)) walk(child)
    if (paragraphTags.has(node.tagName)) appendNewlines(2)
    if (lineBreakTags.has(node.tagName)) appendNewlines(1)
  }

  for (const node of nodes) walk(node)
  return out.replace(/\n+$/g, '').trimStart()
}

// The rows of this table (not those of a table nested in a cell), one line
// each. A cell is read as text with its own line breaks folded into spaces, so
// a cell with two paragraphs, or with a table of its own, stays on its row.
function tableText(table: HTMLElement): string {
  return Array.from(table.querySelectorAll('tr'))
    .filter((row) => row.closest('table') === table)
    .map((row) =>
      Array.from(row.children)
        .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
        .map((cell) =>
          blockText(Array.from(cell.childNodes))
            .replace(/\s*\n+\s*/g, ' ')
            .trim(),
        )
        .join(TABLE_CELL_SEPARATOR),
    )
    .join('\n')
}
