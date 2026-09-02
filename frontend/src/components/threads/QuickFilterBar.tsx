import { Clock, Mail, Paperclip, Pin, Star } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { activeLabelId, nextFilters, ui$, type FilterFacet } from '../../states/ui'
import { labels$ } from '../../states/labels'
import { SelectInput } from '../field/Field'
import { settings$ } from '../../states/settings'

const FACETS: { facet: FilterFacet; icon: typeof Star; labelKey: string }[] = [
  { facet: 'unread', icon: Mail, labelKey: 'filters.unread' },
  { facet: 'starred', icon: Star, labelKey: 'filters.starred' },
  { facet: 'attachments', icon: Paperclip, labelKey: 'filters.attachments' },
  { facet: 'snoozed', icon: Clock, labelKey: 'filters.snoozed' },
]

/**
 * The narrowings, in the open.
 *
 * They used to live three lines into an overflow menu, one at a time, which
 * made "unread and starred" a question the app could not be asked and made the
 * active filter invisible — a reader could stare at an inbox that was hiding
 * half its mail with nothing on screen to say so.
 *
 * The pin is Thunderbird's: without it a filter is dropped the moment you
 * change folder, which is right when you are triaging one mailbox and wrong
 * when you are working through several.
 */
export function QuickFilterBar({ hideSnoozed }: { hideSnoozed?: boolean }) {
  const { t } = useTranslation()
  const filters = useValue(ui$.filters)
  const sticky = useValue(settings$.stickyFilters)
  const labels = useValue(labels$.labels)
  const activeLabel = activeLabelId(filters)

  const offered = FACETS.filter(({ facet }) => !(hideSnoozed && facet === 'snoozed'))

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
      {offered.map(({ facet, icon: Icon, labelKey }) => {
        const on = filters.includes(facet)
        return (
          <button
            key={facet}
            type="button"
            aria-pressed={on}
            onClick={() => ui$.filters.set(nextFilters(filters, facet))}
            className={clsx(
              'flex items-center gap-1.5 rounded-lg px-2 py-1 text-caption font-semibold transition-colors cursor-pointer',
              on ? 'bg-accent/12 text-accent' : 'text-secondary hover:bg-hover hover:text-primary',
            )}
          >
            <Icon size={12} className={clsx('shrink-0', on && facet === 'starred' && 'fill-current')} />
            {t(labelKey)}
          </button>
        )
      })}

      {/* One label at a time, as a picker rather than a chip each: a mailbox
          can have twenty labels and the bar has room for none of them. */}
      {labels.length > 0 && (
        <SelectInput
          value={activeLabel}
          onChange={(event) => {
            const id = event.target.value
            const withoutLabel = filters.filter((facet) => !facet.startsWith('label:'))
            ui$.filters.set(id ? [...withoutLabel, `label:${id}` as const] : withoutLabel)
          }}
          aria-label={t('labels.filterBy')}
          className={clsx(
            'ml-1 max-w-[10rem] rounded-lg py-1 pl-2 text-caption font-semibold',
            activeLabel && 'text-accent',
          )}
        >
          <option value="">{t('labels.anyLabel')}</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </SelectInput>
      )}

      <button
        type="button"
        aria-pressed={sticky}
        title={t('filters.keepAcrossFolders')}
        aria-label={t('filters.keepAcrossFolders')}
        onClick={() => settings$.stickyFilters.set(!sticky)}
        className={clsx(
          'ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors cursor-pointer',
          sticky ? 'bg-accent/12 text-accent' : 'text-secondary hover:bg-hover hover:text-primary',
        )}
      >
        <Pin size={12} className={clsx(sticky && 'fill-current')} />
      </button>
    </div>
  )
}
