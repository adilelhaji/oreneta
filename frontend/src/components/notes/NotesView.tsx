import { useEffect, useState } from 'react'
import { Pin, Plus, Search, StickyNote, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { loadNotes, noteTitle, notes$ } from '../../states/notes'
import { Button } from '../button/Button'
import { EmptyState } from '../empty-state/EmptyState'
import { CompactNavigation } from '../sidenav/CompactNavigation'
import { NoteEditor } from './NoteEditor'

/**
 * Notes that belong to no account and no message (#104, ADR-0015): a list
 * on the left, the open note on the right. Kept on this computer only.
 */
export function NotesView() {
  const { t } = useTranslation()
  const items = useValue(notes$.items)
  const tags = useValue(notes$.tags)
  const loaded = useValue(notes$.loaded)
  const search = useValue(notes$.search)
  const tag = useValue(notes$.tag)
  const trash = useValue(notes$.trash)
  const selected = useValue(notes$.selected)
  // The editor is remounted only when the reader opens another note, not
  // when a new note gets its id on first save.
  const [opened, setOpened] = useState<{ key: number; id: string | null } | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => void loadNotes(), search ? 200 : 0)
    return () => clearTimeout(timer)
  }, [search, tag, trash])

  useEffect(() => {
    if (selected === null) setOpened(null)
  }, [selected])

  const open = (id: string | null) => {
    notes$.selected.set(id ?? 'new')
    setOpened((prev) => ({ key: (prev?.key ?? 0) + 1, id }))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-header px-4 py-3">
        <CompactNavigation />
        <h1 className="flex items-center gap-2 text-heading-sm font-bold text-primary">
          <StickyNote size={20} strokeWidth={1.75} />
          {t('notes.title', { defaultValue: 'Notes' })}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={trash}
            onClick={() => {
              notes$.trash.set(!trash)
              notes$.selected.set(null)
            }}
          >
            <Trash2 size={14} strokeWidth={1.75} />
            {t('notes.trash', { defaultValue: 'Trash' })}
          </Button>
          {!trash && (
            <Button size="sm" onClick={() => open(null)}>
              <Plus size={14} strokeWidth={1.75} />
              {t('notes.new', { defaultValue: 'New note' })}
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label={t('notes.listLabel', { defaultValue: 'Notes' })}
          className={clsx(
            'flex min-h-0 w-full flex-col border-e border-border min-[900px]:w-80 min-[900px]:shrink-0',
            opened && 'max-[899px]:hidden',
          )}
        >
          <div className="flex flex-col gap-2 border-b border-border p-3">
            <div className="flex items-center gap-2 rounded-control border border-border bg-chats px-2.5 py-1.5 focus-within:border-accent">
              <Search size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(event) => notes$.search.set(event.target.value)}
                placeholder={t('notes.search', { defaultValue: 'Search notes' })}
                aria-label={t('notes.search', { defaultValue: 'Search notes' })}
                className="min-w-0 flex-1 bg-transparent text-caption text-primary placeholder-secondary outline-none"
              />
            </div>
            {tags.length > 0 && !trash && (
              <div className="flex flex-wrap gap-1" aria-label={t('notes.tags', { defaultValue: 'Tags' })}>
                {tags.map((entry) => (
                  <button
                    key={entry.tag}
                    type="button"
                    aria-pressed={tag === entry.tag}
                    onClick={() => notes$.tag.set(tag === entry.tag ? '' : entry.tag)}
                    className={clsx(
                      'rounded-control-sm px-2 py-0.5 text-2xs font-semibold cursor-pointer',
                      tag === entry.tag ? 'bg-accent text-on-accent' : 'bg-hover text-secondary hover:text-primary',
                    )}
                  >
                    #{entry.tag} <span className="tabular-nums">{entry.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loaded && items.length === 0 ? (
              <EmptyState
                title={
                  trash
                    ? t('notes.trashEmpty', { defaultValue: 'The trash is empty' })
                    : search || tag
                      ? t('notes.noMatches', { defaultValue: 'No notes match' })
                      : t('notes.emptyTitle', { defaultValue: 'No notes yet' })
                }
                text={
                  trash
                    ? t('notes.trashText', { defaultValue: 'Deleted notes stay here for 30 days.' })
                    : t('notes.emptyText', {
                        defaultValue: 'Notes are kept on this computer and belong to no account.',
                      })
                }
              />
            ) : (
              <ul className="flex flex-col p-2">
                {items.map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      aria-current={selected === note.id ? 'true' : undefined}
                      onClick={() => open(note.id)}
                      className={clsx(
                        'flex w-full flex-col gap-0.5 rounded-control px-3 py-2 text-start transition-colors cursor-pointer',
                        selected === note.id ? 'bg-accent/10 dark:bg-accent/15' : 'hover:bg-hover',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-ui font-semibold text-primary">
                        {note.pinned && (
                          <Pin
                            size={12}
                            strokeWidth={2}
                            className="shrink-0 text-accent"
                            aria-label={t('notes.pinned', { defaultValue: 'Pinned' })}
                          />
                        )}
                        <span className="truncate">{noteTitle(note)}</span>
                      </span>
                      {note.title && note.preview && (
                        <span className="line-clamp-2 text-caption text-secondary">{note.preview}</span>
                      )}
                      <span className="flex flex-wrap gap-x-2 text-2xs text-secondary">
                        <span>
                          {new Date(note.updated_at * 1000).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                        {note.tags.map((name) => (
                          <span key={name}>#{name}</span>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section
          aria-label={t('notes.editorLabel', { defaultValue: 'Note' })}
          className={clsx('flex min-h-0 min-w-0 flex-1 flex-col', !opened && 'max-[899px]:hidden')}
        >
          {opened ? (
            <>
              <button
                type="button"
                onClick={() => notes$.selected.set(null)}
                className="border-b border-border px-4 py-2 text-start text-caption text-secondary hover:bg-hover min-[900px]:hidden cursor-pointer"
              >
                ← {t('notes.backToList', { defaultValue: 'All notes' })}
              </button>
              <NoteEditor key={opened.key} initialId={opened.id} />
            </>
          ) : (
            <EmptyState
              title={t('notes.pickTitle', { defaultValue: 'Pick a note' })}
              text={t('notes.pickText', { defaultValue: 'Or start a new one.' })}
            />
          )}
        </section>
      </div>
    </div>
  )
}
