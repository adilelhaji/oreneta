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
 * breaks. A table of data becomes one line per row, its cells joined by ` | `
 * (#274, ADR-0067), set apart like a paragraph; a layout table (quoted mail,
 * a signature) reads as the blocks it lays out.
 */
export function htmlToText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return blockText(Array.from(div.childNodes))
}

const TABLE_CELL_SEPARATOR = ' | '
/** The class of a table made in the composer (see GRID_TABLE_CLASS). */
const COMPOSER_TABLE_CLASS = 'oreneta-table'

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
  // Only met in layout tables: a data table is read row by row instead.
  'TABLE',
  'TD',
  'TH',
  'CAPTION',
])
const lineBreakTags = new Set(['LI', 'OL', 'TR', 'UL'])
const blockTags = new Set([...paragraphTags, 'OL', 'UL'])

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
    if (node.tagName === 'TABLE' && isDataTable(node)) {
      const text = tableText(node)
      if (text) {
        appendNewlines(2)
        out += text
        appendNewlines(2)
      }
      return
    }

    for (const child of Array.from(node.childNodes)) walk(child)
    if (paragraphTags.has(node.tagName)) appendNewlines(2)
    if (lineBreakTags.has(node.tagName)) appendNewlines(1)
  }

  for (const node of nodes) walk(node)
  return out.replace(/\n+$/g, '').trimStart()
}

// This table's own rows and cells, not those of a table nested in a cell.
function ownRows(table: HTMLElement): HTMLElement[] {
  return Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table)
}
function ownCells(row: HTMLElement): HTMLElement[] {
  return Array.from(row.children).filter(
    (cell): cell is HTMLElement => cell instanceof HTMLElement && (cell.tagName === 'TD' || cell.tagName === 'TH'),
  )
}

// A table of data: one made in the composer, or one that looks like a grid —
// no table inside it and no cell holding more than one block or a line break
// (a signature's "Name<br>Role<br>Phone"). Anything else is taken for layout,
// whose cells are passages of text, not values.
function isDataTable(table: HTMLElement): boolean {
  if (table.classList.contains(COMPOSER_TABLE_CLASS)) return true
  if (table.querySelector('table, br')) return false
  return ownRows(table).every((row) =>
    ownCells(row).every((cell) => Array.from(cell.children).filter((child) => blockTags.has(child.tagName)).length <= 1),
  )
}

// One line per row, cells joined by the separator, each cell's own line breaks
// folded into spaces; the caption, if any, above. Rows with no text at all are
// left out, so an empty table adds nothing.
function tableText(table: HTMLElement): string {
  const lines: string[] = []
  const caption = Array.from(table.children).find((child) => child.tagName === 'CAPTION')
  const captionText = caption ? flatText(caption) : ''
  if (captionText) lines.push(captionText)
  for (const row of ownRows(table)) {
    const cells = ownCells(row).map(flatText)
    if (cells.some((cell) => cell !== '')) lines.push(cells.join(TABLE_CELL_SEPARATOR))
  }
  return lines.join('\n')
}

function flatText(element: Element): string {
  return blockText(Array.from(element.childNodes))
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}
