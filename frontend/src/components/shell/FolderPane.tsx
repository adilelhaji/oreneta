import { useId, useRef, type ReactNode } from 'react'
import { useValue } from '@legendapp/state/react'
import { FOLDER_PANE_WIDTH } from '../../lib/paneResize'
import { settings$ } from '../../states/settings'
import { FolderPaneResizer } from '../resizer/PaneResizers'

// Where the row runs short, the folders give way before the list: flexbox
// shrinks each item in proportion to this factor times its width, and this
// one dwarfs the list's 1, so the list keeps its width (to well under a
// pixel) until the folders reach their minimum. The reader does not shrink
// below its own minimum at all (ADR-0068 §7, ADR-0059).
const GIVES_WAY_FIRST = 1000

/**
 * The narrowest window, in CSS px, that draws the pane: the `min-[1025px]`
 * below. A module that keeps its own column at 1024 px and below (Calendar)
 * reads it to put its folders in one place or the other.
 */
export const FOLDER_PANE_MIN_WINDOW = 1025

interface FolderPaneProps {
  /** Shown in the 40 px title row, and the pane's accessible name. */
  title: string
  /** What the module puts in the pane: for mail, its accounts and folders. */
  children: ReactNode
  /** An optional strip under the body (the calendar's month, piece 4). */
  footer?: ReactNode
  /** The place kept at the very foot for the module switcher (ADR-0068 §5), which piece 14 fills. */
  modules?: ReactNode
}

/**
 * The common folder pane (ADR-0068 §4): the frame's "folders" region, a
 * `<nav>` named by its title. One width for every module, in px like every
 * width a separator sets, so the app's zoom grows the text inside and not the
 * pane; a name that does not fit ends in "…" and is whole in its tooltip. It
 * is not drawn at 1024 px and below, where the list's folder switcher takes
 * its place (ADR-0068 §5).
 */
export function FolderPane({ title, children, footer, modules }: FolderPaneProps) {
  const titleId = useId()
  const pane = useRef<HTMLElement | null>(null)
  const width = useValue(settings$.folderPaneWidth)
  return (
    <nav
      ref={pane}
      data-region="folders"
      data-folder-pane
      aria-labelledby={titleId}
      style={{ width: `${width}px`, minWidth: `${FOLDER_PANE_WIDTH.min}px`, flexShrink: GIVES_WAY_FIRST }}
      className="relative hidden flex-col border-e border-border bg-app min-[1025px]:flex"
    >
      <div className="flex h-10 shrink-0 items-center px-4">
        <h2 id={titleId} title={title} className="min-w-0 truncate text-ui font-semibold text-primary">
          {title}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="shrink-0 border-t border-border">{footer}</div>}
      {modules}
      <FolderPaneResizer pane={pane} />
    </nav>
  )
}
