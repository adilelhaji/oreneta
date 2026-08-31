import { useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$, type SavedSearch } from '../../states/settings'
import { ui$ } from '../../states/ui'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { menuItemClass } from '../menu/menuStyles'

/**
 * Searches worth keeping, beside the box they were typed into.
 *
 * A search only earns a name once it has been typed, so saving appears when
 * there is something to save and the list appears when there is something in
 * it. An empty control offering to save nothing is a control in the way.
 */
export function SavedSearchMenu({ query }: { query: string }) {
  const { t } = useTranslation()
  const saved = useValue(settings$.savedSearches)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(
    open,
    (target) => Boolean(wrapRef.current?.contains(target as Node | null)),
    () => setOpen(false),
  )

  const trimmed = query.trim()
  const alreadySaved = saved.some((search) => search.query === trimmed)
  if (!trimmed && saved.length === 0) return null

  const save = () => {
    if (!trimmed || alreadySaved) return
    const entry: SavedSearch = {
      id: `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Named after itself until renamed: asking for a name before the reader
      // knows whether the search is any good is asking too early.
      name: trimmed,
      query: trimmed,
    }
    settings$.savedSearches.set([...saved, entry])
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => (saved.length > 0 ? setOpen((was) => !was) : save())}
        title={saved.length > 0 ? t('search.saved') : t('search.save')}
        aria-label={saved.length > 0 ? t('search.saved') : t('search.save')}
        className="flex h-9 w-9 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
      >
        {saved.length > 0 ? <Bookmark size={15} /> : <BookmarkPlus size={15} />}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[15rem] rounded-xl border border-border bg-panel p-1 shadow-lg">
          {trimmed && !alreadySaved && (
            <>
              <button type="button" onClick={() => { save(); setOpen(false) }} className={menuItemClass}>
                <BookmarkPlus size={13} className="text-secondary" />
                <span className="min-w-0 truncate">{t('search.save')}</span>
              </button>
              <div className="my-1 border-t border-border" />
            </>
          )}
          {saved.map((search) => (
            <div key={search.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  ui$.query.set(search.query)
                  setOpen(false)
                }}
                className={`${menuItemClass} min-w-0 flex-1`}
              >
                <Bookmark size={13} className="text-secondary" />
                <span className="min-w-0 flex-1 truncate text-left">{search.name}</span>
              </button>
              <button
                type="button"
                title={t('search.forget')}
                aria-label={t('search.forget')}
                onClick={() =>
                  settings$.savedSearches.set(saved.filter((item) => item.id !== search.id))
                }
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
