import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { accounts$ } from '../../states/accounts'
import { attachmentList$ } from '../../states/attachmentList'
import { kanban$, setKanbanSearchScope } from '../../states/kanban'
import { notes$ } from '../../states/notes'
import { people$ } from '../../states/people'
import { settings$ } from '../../states/settings'
import { tasks$ } from '../../states/tasks'
import { ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { SearchScopeDropdown } from '../kanban/SearchScopeDropdown'
import { useWideWindow } from '../resizer/useElementWidth'
import { SavedSearchMenu } from '../threads/SavedSearchMenu'
import { SearchBuilder } from '../threads/SearchBuilder'

/** From this width the band shows the field; below it, a button that opens the field over the band. */
export const BAND_FIELD_MIN_WINDOW = 769

/** A module with a search: the band's field reads and writes that module's own state. */
export type FieldScope = {
  kind: 'field'
  id: 'mail' | 'feeds' | 'board' | 'notes' | 'people' | 'tasks' | 'attachments'
  value: string
  set: (value: string) => void
  /** The placeholder and the accessible name: what is searched. */
  label: string
  /** A tooltip on the field: mail's operators. */
  hint?: string
  /**
   * What Escape does in the field, as it did in the module's own: mail's
   * clears it and leaves; the board's clears it, then leaves.
   */
  escape?: 'clear-and-leave' | 'clear-then-leave'
  /** The controls at the end of the field: mail's builder and saved searches, the board's scope. */
  trailing?: ReactNode
}

/** A module with no search (owner decision 3 on #342): the field is disabled and says why. */
export type DisabledScope = { kind: 'disabled'; id: 'calendar' | 'chat'; reason: string }

export type BandScope = FieldScope | DisabledScope

/**
 * The search of the module on screen (ADR-0068 §2, #344). Each module keeps
 * its own state, as before: the field shows and changes that module's, and
 * the module's own effects keep their delays (Notes and Attachments 200 ms,
 * People 150 ms) and their empty and «no results» texts.
 */
export function useBandScope(): BandScope {
  const { t } = useTranslation()
  const module = useValue(ui$.module)
  const boardId = useValue(kanban$.activeBoardId)
  const boards = useValue(settings$.kanbanBoards)
  const boardQuery = useValue(kanban$.searchQuery)
  const boardScope = useValue(kanban$.searchScope)
  const query = useValue(ui$.query)
  const accounts = useValue(accounts$)
  const selectedAccount = useValue(ui$.selectedAccount)
  const notesSearch = useValue(notes$.search)
  const peopleQuery = useValue(people$.query)
  const tasksSearch = useValue(tasks$.search)
  const fileName = useValue(attachmentList$.filter.name)

  switch (module) {
    case 'calendar':
      return { kind: 'disabled', id: 'calendar', reason: t('search.band.calendar') }
    case 'chat':
      return { kind: 'disabled', id: 'chat', reason: t('search.band.chat') }
    case 'notes':
      return {
        kind: 'field',
        id: 'notes',
        value: notesSearch,
        set: (value) => notes$.search.set(value),
        label: t('notes.search'),
      }
    case 'people':
      return {
        kind: 'field',
        id: 'people',
        value: peopleQuery,
        set: (value) => people$.query.set(value),
        label: t('people.search'),
      }
    case 'tasks':
      return {
        kind: 'field',
        id: 'tasks',
        value: tasksSearch,
        set: (value) => tasks$.search.set(value),
        label: t('tasks.search'),
      }
    case 'attachments':
      // The file name; the other filters stay in the folder pane or its bar.
      return {
        kind: 'field',
        id: 'attachments',
        value: fileName,
        set: (value) => attachmentList$.filter.name.set(value),
        label: t('attachmentsView.search'),
      }
    case 'mail':
      break
  }

  // A kanban board open in mail: the board's own search, with its scope.
  if (boardId) {
    const columns = boards.find((board) => board.id === boardId)?.columns ?? []
    return {
      kind: 'field',
      id: 'board',
      value: boardQuery,
      set: (value) => kanban$.searchQuery.set(value),
      label: t('kanban.searchBoard'),
      escape: 'clear-then-leave',
      trailing: (
        <SearchScopeDropdown
          value={boardScope}
          onChange={(scope) => setKanbanSearchScope(boardId, scope)}
          visibleColumns={columns}
        />
      ),
    }
  }

  // Mail's search (mail.threadList), or a feeds account's.
  const account = accounts.find((item) => item.id === selectedAccount)
  const feeds = account?.provider === 'rss' || account?.auth_type === 'rss'
  return {
    kind: 'field',
    id: feeds ? 'feeds' : 'mail',
    value: query,
    set: (value) => ui$.query.set(value),
    label: feeds ? t('threads.searchFeeds') : t('threads.searchMessages'),
    // The operators are discoverable from the box that takes them, which is
    // the only place someone is looking when they wonder whether this search
    // can do more than words.
    hint: feeds ? undefined : t('search.operatorsHint'),
    escape: 'clear-and-leave',
    trailing: (
      <>
        {!feeds && <SearchBuilder query={query} />}
        <SavedSearchMenu query={query} />
      </>
    ),
  }
}

/**
 * The search field at the centre of the top band (ADR-0068 §2, #344): the
 * `search` landmark, scoped to the module on screen. Ctrl/⌘+Shift+F (and
 * `focusGlobalSearch`) focus it.
 *
 * Below 769 px the band has room for a button, which opens the field over
 * the band. Escape closes it there and gives the focus back to the button;
 * the field keeps its query, which is the module's. While it is open it
 * covers the rest of the band: `onCover` tells the band, which makes that
 * inert.
 */
export function BandSearch({ onCover }: { onCover: (covered: boolean) => void }) {
  const { t } = useTranslation()
  const scope = useBandScope()
  const wide = useWideWindow(BAND_FIELD_MIN_WINDOW)
  const nonce = useValue(ui$.globalSearchFocus)
  // Below 769 px: whether the field is open over the band.
  const [open, setOpen] = useState(false)
  // Whether the focus is in the field or its controls. A field that has it
  // when the window narrows stays, over the band.
  const [focused, setFocused] = useState(false)
  const focusedRef = useRef(false)
  const input = useRef<HTMLInputElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  // Where the focus goes once the next render is drawn.
  const pending = useRef<'field' | 'trigger' | null>(null)
  const reasonId = useId()

  const overlay = !wide && (open || focused)
  const shown = wide || overlay

  const setFocusWithin = (value: boolean) => {
    focusedRef.current = value
    setFocused(value)
  }

  const focusField = () => {
    const field = input.current
    if (!field || field.disabled) return false
    field.focus()
    field.select()
    return field.ownerDocument.activeElement === field
  }

  const close = () => {
    pending.current = 'trigger'
    setOpen(false)
    setFocusWithin(false)
  }

  // Crossing 769 px: a wide window has no field to open, and a narrow one
  // keeps the field open only if it has the focus.
  useEffect(() => {
    setOpen(!wide && focusedRef.current)
  }, [wide])

  // Ctrl/⌘+Shift+F, `/` in the Gmail scheme, Ctrl/⌘+F with no conversation
  // on screen, and the palette's search commands. Only a request made while
  // the band is here counts: mounting (the first account arriving) takes no
  // focus.
  const seenNonce = useRef(nonce)
  useEffect(() => {
    if (nonce === seenNonce.current) return
    seenNonce.current = nonce
    if (scope.kind === 'disabled') return
    if (focusField()) return
    pending.current = 'field'
    setOpen(true)
    // Only the nonce asks; the scope and the width are read as they are now.
  }, [nonce])

  useLayoutEffect(() => {
    if (pending.current === 'field' && focusField()) pending.current = null
    else if (pending.current === 'trigger') {
      // Gone if the window widened meanwhile: then there is nothing to go back to.
      pending.current = null
      trigger.current?.focus()
    }
  })

  useLayoutEffect(() => {
    onCover(overlay)
    return () => onCover(false)
  }, [overlay, onCover])

  const disabled = scope.kind === 'disabled'
  const value = disabled ? '' : scope.value
  const label = disabled ? t('shell.region.search') : scope.label

  return (
    <>
      {!wide && (
        <IconButton
          ref={trigger}
          icon={Search}
          label={label}
          size="md"
          radius="lg"
          // A query applies while the field is closed: the button says so.
          active={!!value}
          className={clsx(
            'ms-auto aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
            overlay && 'invisible',
          )}
          data-band-search-button=""
          // No search here: the button says why and does nothing, as a
          // command that cannot run does in the app menu.
          aria-disabled={disabled || undefined}
          aria-describedby={disabled ? reasonId : undefined}
          title={disabled ? scope.reason : label}
          onClick={() => {
            if (disabled) return
            pending.current = 'field'
            setOpen(true)
          }}
        />
      )}
      {shown && (
        <div
          role="search"
          aria-label={t('shell.region.search')}
          data-search-scope={scope.id}
          data-band-search-overlay={overlay ? '' : undefined}
          className={clsx(
            'flex min-w-0 items-center gap-1',
            // Over the band, with no z-index of its own: a dialog or menu
            // opened from it stays in the window's stacking order.
            overlay ? 'absolute inset-0 bg-header px-1' : 'w-full max-w-xl',
          )}
          onFocus={() => setFocusWithin(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
          }}
          onKeyDown={(event) => {
            // Over the band, Escape closes the field and goes back to the
            // button. A menu or dialog opened from it has taken the key first.
            if (!overlay || event.key !== 'Escape' || event.defaultPrevented) return
            event.preventDefault()
            close()
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              size={14}
              strokeWidth={1.75}
              className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-secondary"
            />
            <input
              ref={input}
              type="text"
              value={value}
              disabled={disabled}
              aria-label={label}
              aria-describedby={disabled ? reasonId : undefined}
              placeholder={disabled ? scope.reason : scope.label}
              title={disabled ? scope.reason : scope.hint}
              onChange={(event) => {
                if (!disabled) scope.set(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || overlay || disabled) return
                if (scope.escape === 'clear-and-leave') {
                  scope.set('')
                  event.currentTarget.blur()
                } else if (scope.escape === 'clear-then-leave') {
                  if (scope.value) scope.set('')
                  else event.currentTarget.blur()
                }
              }}
              className={clsx(
                'h-7 w-full min-w-0 rounded-control-sm border bg-chats ps-8 text-ui text-primary placeholder-secondary transition-colors',
                'focus:border-accent-fg disabled:cursor-not-allowed disabled:border-border',
                // The end padding only has to clear the clear button while there is one.
                value ? 'pe-8' : 'pe-2.5',
                disabled ? 'border-border' : 'border-input',
              )}
            />
            {value && !disabled && (
              <button
                type="button"
                aria-label={t('common.clearSearch')}
                title={t('common.clearSearch')}
                onClick={() => {
                  scope.set('')
                  input.current?.focus()
                }}
                className="absolute end-1 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary"
              >
                <X aria-hidden="true" size={14} strokeWidth={1.75} />
              </button>
            )}
          </div>
          {!disabled && scope.trailing}
          {overlay && (
            <IconButton icon={X} label={t('search.band.close')} size="md" radius="lg" onClick={close} />
          )}
        </div>
      )}
      {disabled && (
        // The reason, for the keyboard and assistive technology, which a
        // placeholder or a tooltip does not always reach.
        <span id={reasonId} role="none" className="sr-only">
          {scope.reason}
        </span>
      )}
    </>
  )
}
