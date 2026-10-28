import type { RefObject } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { thread$ } from '../../states/thread'

// The in-thread search bar under the conversation header, for a narrow window
// or a narrow header (the wide equivalent lives inside ConversationHeader).
// Rendered only while thread search is open.
export function ThreadSearchBarMobile({
  searchMatches,
  activeSearchIndex,
  goToSearchMatch,
  inputRef,
}: {
  searchMatches: string[]
  activeSearchIndex: number
  goToSearchMatch: (direction: -1 | 1) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const { t } = useTranslation()
  const threadSearch = useValue(thread$.search)
  const normalizedThreadSearch = threadSearch.trim().toLowerCase()

  return (
    // Measured as the header is: hidden where the header holds the search,
    // from 900 px and a header of 32 rem. This bar is as wide as the header,
    // whose 0.5 rem padding on each side leaves it 1 rem less, hence 33 rem
    // here. At the app's 200 % in a 1025 px window the 360 px reader has room
    // for the search here and not in the header (#347). There, the field
    // keeps a row of its own and the previous and next buttons wrap to one
    // under it, at its end, instead of running past the reader.
    <div className="@container z-10 shrink-0">
      <div className="min-[900px]:@min-[33rem]:hidden flex min-h-11 flex-wrap items-center gap-1 border-b border-border bg-header px-3 py-1">
        <div className="flex min-w-0 grow basis-48 items-center gap-2 rounded-control bg-hover px-2 py-1.5 border border-transparent focus-within:border-accent/40 focus-within:bg-chats">
          <Search size={14} className="text-secondary shrink-0" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={threadSearch}
            onChange={(event) => thread$.search.set(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                goToSearchMatch(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') {
                thread$.search.set('')
                thread$.searchOpen.set(false)
              }
            }}
            placeholder={t('chat.searchThread')}
            className="min-w-0 flex-1 bg-transparent text-xs text-primary placeholder-secondary border-none outline-none"
          />
          <button
            onClick={() => {
              thread$.search.set('')
              thread$.searchOpen.set(false)
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-secondary hover:text-primary cursor-pointer"
            title={t('chat.closeThreadSearch')}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
          <span className="w-12 shrink-0 text-center text-2xs font-semibold text-secondary">
            {normalizedThreadSearch
              ? `${searchMatches.length ? activeSearchIndex + 1 : 0}/${searchMatches.length}`
              : ''}
          </span>
        </div>
        <button
          onClick={() => goToSearchMatch(-1)}
          disabled={searchMatches.length === 0}
          className="ms-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-control-sm text-secondary hover:bg-hover disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
          title={t('chat.previousMatch')}
        >
          <ChevronUp size={16} strokeWidth={1.75} />
        </button>
        <button
          onClick={() => goToSearchMatch(1)}
          disabled={searchMatches.length === 0}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control-sm text-secondary hover:bg-hover disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
          title={t('chat.nextMatch')}
        >
          <ChevronDown size={16} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}
