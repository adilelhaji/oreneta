import type { RefObject } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { drawnPane, FOLDER_PANE_WIDTH, kanbanPane, THREAD_LIST_WIDTH } from '../../lib/paneResize'
import { settings$ } from '../../states/settings'
import { PaneResizer } from './PaneResizer'
import { useElementWidth } from './useElementWidth'

/**
 * The thread list's separator, on its end edge (ADR-0059). It states the
 * width as drawn: a remembered wide list gives way on a narrow window, and
 * the separator says so rather than a width nobody can see.
 */
export function ThreadListResizer({ list }: { list: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const stored = useValue(settings$.threadListWidth)
  const { value, limits } = drawnPane(stored, useElementWidth(list), THREAD_LIST_WIDTH)
  return (
    <PaneResizer
      label={t('layout.resizeThreadList')}
      value={value}
      limits={limits}
      edge="end"
      sizeAt={(clientX, rtl) => {
        const rect = list.current?.getBoundingClientRect()
        if (!rect) return value
        return rtl ? rect.right - clientX : clientX - rect.left
      }}
      onResize={(size) => settings$.threadListWidth.set(size)}
      className="absolute end-0 top-0 hidden h-full translate-x-1 rtl:-translate-x-1 min-[769px]:block"
    />
  )
}

/**
 * The folder pane's separator, on its end edge (ADR-0068 §4). One width for
 * every module, so one separator; like the list's, it states the width as
 * drawn, which is less than the one remembered where the folders give way.
 */
export function FolderPaneResizer({ pane }: { pane: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const stored = useValue(settings$.folderPaneWidth)
  const { value, limits } = drawnPane(stored, useElementWidth(pane), FOLDER_PANE_WIDTH)
  return (
    <PaneResizer
      label={t('layout.resizeFolderPane')}
      value={value}
      limits={limits}
      edge="end"
      sizeAt={(clientX, rtl) => {
        const rect = pane.current?.getBoundingClientRect()
        if (!rect) return value
        return rtl ? rect.right - clientX : clientX - rect.left
      }}
      onResize={(size) => settings$.folderPaneWidth.set(size)}
      className="absolute end-0 top-0 h-full translate-x-1 rtl:-translate-x-1"
    />
  )
}

/**
 * The board's conversation pane separator, on its start edge, as a
 * percentage of the app shell (ADR-0059). The pane is never drawn under
 * 320 px, so on a narrow shell the smallest honoured percentage rises, and
 * where nothing is left to choose there is no separator.
 */
export function KanbanPaneResizer({
  pane,
  shell,
}: {
  pane: RefObject<HTMLElement | null>
  shell: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const stored = useValue(settings$.kanbanPaneWidth)
  const shellWidth = useElementWidth(shell)
  const state = kanbanPane(stored, useElementWidth(pane), shellWidth)
  if (!state) return null
  return (
    <PaneResizer
      label={t('layout.resizeConversation')}
      value={state.value}
      limits={state.limits}
      edge="start"
      step={2}
      valueText={(value) => `${value}%`}
      sizeAt={(clientX, rtl) => {
        const rect = shell.current?.getBoundingClientRect()
        if (!rect || rect.width <= 0) return state.value
        return ((rtl ? clientX - rect.left : rect.right - clientX) / rect.width) * 100
      }}
      onResize={(size) => settings$.kanbanPaneWidth.set(size)}
      className="absolute start-0 top-0 h-full -translate-x-1 rtl:translate-x-1"
    />
  )
}
