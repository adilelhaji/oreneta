import type { PointerEvent as ReactPointerEvent } from 'react'
import { settings$ } from '../states/settings'
import { isDocumentRtl } from './direction'

const MIN_THREAD_LIST_WIDTH = 280
const MAX_THREAD_LIST_WIDTH = 560
const MIN_KANBAN_PANE_WIDTH = 25
const MAX_KANBAN_PANE_WIDTH = 60

function beginDrag(onMove: (event: PointerEvent) => void) {
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// Drag the kanban conversation pane's start edge (left in LTR, right in RTL);
// width persists as a percentage of the app shell (passed in as `shell`).
export function startKanbanResize(event: ReactPointerEvent<HTMLDivElement>, shell: HTMLElement | null) {
  event.preventDefault()
  if (!shell) return
  const rtl = isDocumentRtl()
  beginDrag((moveEvent) => {
    const rect = shell.getBoundingClientRect()
    // The pane hugs the shell's end edge, so it grows as the pointer moves
    // towards the start edge: leftwards in LTR, rightwards in RTL.
    const extent = rtl ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX
    const raw = (extent / rect.width) * 100
    const next = Math.min(MAX_KANBAN_PANE_WIDTH, Math.max(MIN_KANBAN_PANE_WIDTH, raw))
    settings$.kanbanPaneWidth.set(Math.round(next))
  })
}

// Drag the thread list's end edge (right in LTR, left in RTL); width persists in pixels.
export function startThreadListResize(event: ReactPointerEvent<HTMLDivElement>) {
  event.preventDefault()
  const pane = event.currentTarget.parentElement
  if (!pane) return
  const rect = pane.getBoundingClientRect()
  const rtl = isDocumentRtl()
  beginDrag((moveEvent) => {
    const raw = rtl ? rect.right - moveEvent.clientX : moveEvent.clientX - rect.left
    const next = Math.min(MAX_THREAD_LIST_WIDTH, Math.max(MIN_THREAD_LIST_WIDTH, raw))
    settings$.threadListWidth.set(Math.round(next))
  })
}
