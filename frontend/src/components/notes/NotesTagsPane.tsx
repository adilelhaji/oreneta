import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { elementDirection, groupIndexForKey } from '../../lib/direction'
import { clsx } from '../../lib/utils'
import { notes$ } from '../../states/notes'

/// The tags of the notes, as the body of the common folder pane (ADR-0068 §4,
/// #335): "All notes" and each tag with its count, the chips that sat above the
/// list, in the same order and with the same counts. It is the body of the
/// "folders" region, which names it, so it is not a landmark of its own.
///
/// What it does is what the chips did: choosing a tag sets `notes$.tag`, and
/// choosing the tag that is already chosen clears it, as does "All notes". In
/// the trash the tags are not offered (the core does not filter the trash by
/// tag), so the pane says so instead of listing them.
export function NotesTagsPane() {
  const { t } = useTranslation()
  const tags = useValue(notes$.tags)
  const tag = useValue(notes$.tag)
  const trash = useValue(notes$.trash)

  if (trash) {
    return (
      <p className="px-4 py-2 text-caption text-secondary">
        {t('notes.trashNoTags', { defaultValue: 'The trash is not filtered by tag.' })}
      </p>
    )
  }

  const row = (active: boolean) =>
    clsx(
      'flex w-full min-w-0 items-center gap-2 rounded-control-sm px-2 py-1.5 text-start text-ui text-primary transition-colors cursor-pointer',
      active ? 'bg-accent/20 font-semibold dark:bg-accent/30' : 'hover:bg-hover',
    )

  const allNotes = t('notes.allNotes', { defaultValue: 'All notes' })

  return (
    <ul
      className="flex flex-col px-3 py-2"
      // Up and Down move between the rows in reading order and choose them, as
      // the arrows did in the other modules' panes (ADR-0061); Home and End go
      // to the ends. The keys are taken here: let through, the window's list
      // navigation would step the mail thread list as well. An arrow chooses
      // the row it lands on rather than clicking it, since a click on the tag
      // that is already chosen clears it.
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-tag-row]')]
        const current =
          event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-tag-row]') : null
        const index = current ? rows.indexOf(current) : -1
        const next = groupIndexForKey(event.key, index, rows.length, elementDirection(event.currentTarget), 'vertical')
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        rows[next].focus()
        // Focus that was not on a row yet only arrives; it picks nothing.
        if (index >= 0) notes$.tag.set(rows[next].dataset.tagRow ?? '')
      }}
    >
      <li>
        <button
          type="button"
          data-tag-row=""
          data-focus-key="tag-all"
          aria-current={tag === '' ? 'true' : undefined}
          title={allNotes}
          onClick={() => notes$.tag.set('')}
          className={row(tag === '')}
        >
          <span dir="auto" className="min-w-0 flex-1 truncate">
            {allNotes}
          </span>
        </button>
      </li>
      {tags.map((entry) => {
        const active = tag === entry.tag
        // The name can end in "…" in a narrow pane: the tooltip has it whole,
        // with its count (ADR-0068 §4), and the accessible name reads the same.
        const named = t('notes.tagOption', {
          tag: entry.tag,
          count: entry.count,
          defaultValue: '#{tag} ({count})',
        })
        return (
          <li key={entry.tag}>
            <button
              type="button"
              data-tag-row={entry.tag}
              data-focus-key={`tag:${entry.tag}`}
              aria-current={active ? 'true' : undefined}
              aria-label={named}
              title={named}
              onClick={() => notes$.tag.set(active ? '' : entry.tag)}
              className={row(active)}
            >
              <span dir="auto" className="min-w-0 flex-1 truncate">
                #{entry.tag}
              </span>
              {/* On the tinted row the secondary colour falls under 4.5:1. */}
              <span className={clsx('shrink-0 text-caption tabular-nums', active ? 'text-primary' : 'text-secondary')}>
                {entry.count}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
