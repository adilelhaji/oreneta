import { useId, useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$, type SavedSearch } from '../../states/settings'
import { ui$ } from '../../states/ui'
import { openMailAccount } from '../../states/kanban'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { MenuItem } from '../menu/MenuItem'
import { MenuList, MenuSeparator } from '../menu/Menu'

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
  const account = useValue(ui$.selectedAccount)
  const folder = useValue(ui$.selectedFolder)
  const alreadySaved = saved.some(
    (search) =>
      search.query === trimmed && (search.account ?? account) === account && (search.folder ?? folder) === folder,
  )
  if (!trimmed && saved.length === 0) return null

  const save = () => {
    if (!trimmed || alreadySaved) return
    const entry: SavedSearch = {
      id: `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Named after itself until renamed: asking for a name before the reader
      // knows whether the search is any good is asking too early.
      name: trimmed,
      query: trimmed,
      // Where it was typed: opening it goes back there (#43).
      ...(account && folder ? { account, folder } : {}),
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
        aria-haspopup={saved.length > 0 ? 'menu' : undefined}
        aria-expanded={saved.length > 0 ? open : undefined}
        className="flex h-9 w-9 items-center justify-center rounded-control text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
      >
        {saved.length > 0 ? <Bookmark size={16} strokeWidth={1.75} /> : <BookmarkPlus size={16} strokeWidth={1.75} />}
      </button>

      {open && (
        <MenuList
          label={t('search.saved')}
          autoFocus
          onClose={() => setOpen(false)}
          className="absolute end-0 top-full z-50 mt-1 min-w-[15rem] rounded-control border border-border bg-panel p-1 shadow-raised"
        >
          {trimmed && !alreadySaved && (
            <>
              <MenuItem
                icon={<BookmarkPlus size={14} className="text-secondary" strokeWidth={1.75} />}
                label={<span className="block min-w-0 truncate">{t('search.save')}</span>}
                onClick={() => {
                  save()
                  setOpen(false)
                }}
              />
              <MenuSeparator />
            </>
          )}
          {saved.map((search) => (
            <SavedSearchRow
              key={search.id}
              search={search}
              onOpen={() => {
                if (search.account && search.folder && (search.account !== account || search.folder !== folder)) {
                  openMailAccount(search.account, search.folder)
                }
                ui$.query.set(search.query)
                setOpen(false)
              }}
              onForget={() => {
                const rest = saved.filter((item) => item.id !== search.id)
                settings$.savedSearches.set(rest)
                // Nothing left to list: the menu closes, focus back on its
                // trigger, rather than staying open and empty.
                if (rest.length === 0) setOpen(false)
              }}
            />
          ))}
        </MenuList>
      )}
    </div>
  )
}

// One saved search and its "Forget" beside it: two items of the menu, the
// second described by the first's name so it is never just "Forget".
function SavedSearchRow({
  search,
  onOpen,
  onForget,
}: {
  search: SavedSearch
  onOpen: () => void
  onForget: () => void
}) {
  const { t } = useTranslation()
  const nameId = useId()
  return (
    <div role="none" className="flex items-center gap-1">
      <MenuItem
        className="min-w-0 flex-1"
        icon={<Bookmark size={14} className="text-secondary" strokeWidth={1.75} />}
        label={
          <span className="block min-w-0 truncate text-start">
            <span id={nameId}>{search.name}</span>
            {search.folder && (
              <span className="ms-1.5 text-2xs text-secondary">
                {search.account === 'unified' ? t('search.scopeAll', { defaultValue: 'all accounts' }) : search.folder}
              </span>
            )}
          </span>
        }
        onClick={onOpen}
      />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        title={t('search.forget')}
        aria-label={t('search.forget')}
        aria-describedby={nameId}
        // The row goes; the menu puts focus back on its first item.
        onClick={onForget}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:bg-hover cursor-pointer"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
