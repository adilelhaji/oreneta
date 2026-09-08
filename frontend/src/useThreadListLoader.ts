import { useEffect } from 'react'
import { useValue } from '@legendapp/state/react'
import { kanban$ } from './states/kanban'
import { loadThreads } from './states/mail'
import { settings$, sortParam } from './states/settings'
import { filterKey, ui$ } from './states/ui'

const SEARCH_DEBOUNCE_MS = 300

/** Reload the mailbox when any part of its view changes, including ordering. */
export function useThreadListLoader() {
  const account = useValue(ui$.selectedAccount)
  const folder = useValue(ui$.selectedFolder)
  const query = useValue(ui$.query)
  const filter = filterKey(useValue(ui$.filters))
  const sort = sortParam(useValue(settings$.listSort))
  const board = useValue(kanban$.activeBoardId)

  useEffect(() => {
    // Mail rows wait while a board owns the reader. Closing it reloads them.
    if (!account || !folder || board) return
    if (!query.trim()) {
      void loadThreads()
      return
    }
    const timer = window.setTimeout(() => {
      void loadThreads()
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [account, folder, query, filter, sort, board])
}
