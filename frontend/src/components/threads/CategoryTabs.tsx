import { useEffect } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { activeCategory, categories$, OTHER, refreshCategoryCounts, showCategory } from '../../states/categories'
import { mail$ } from '../../states/mail'
import { ui$ } from '../../states/ui'

/**
 * The inbox's category tabs (#91, ADR-0023).
 *
 * "All" is first and "Other" last, and both are always there: a category is
 * a way to look at the inbox, not a place mail can disappear into. Every tab
 * says how many conversations it holds, and the line under them says what
 * those counts are of — the mail kept on this computer, not the server's.
 */
export function CategoryTabs() {
  const { t } = useTranslation()
  const list = useValue(categories$.list)
  const counts = useValue(categories$.counts)
  const filters = useValue(ui$.filters)
  const account = useValue(ui$.selectedAccount)
  const folder = useValue(ui$.selectedFolder)
  const loaded = useValue(mail$.threadsLoadedKey)
  const active = activeCategory(filters)

  useEffect(() => {
    void refreshCategoryCounts()
  }, [account, folder, loaded])

  const count = (id: string) => counts?.counts.find((c) => c.category === id)
  const tabs: { id: string | null; name: string; colour?: string; n?: number; unread?: number }[] = [
    { id: null, name: t('categories.all', { defaultValue: 'All' }), n: counts?.conversations },
    ...list.map((c) => ({
      id: c.id,
      name: c.name,
      colour: c.colour,
      n: counts ? (count(c.id)?.conversations ?? 0) : undefined,
      unread: count(c.id)?.unread,
    })),
    {
      id: OTHER,
      name: t('categories.other', { defaultValue: 'Other' }),
      n: counts ? (count('')?.conversations ?? 0) : undefined,
      unread: count('')?.unread,
    },
  ]

  return (
    <nav
      aria-label={t('categories.label', { defaultValue: 'Inbox categories' })}
      className="shrink-0 border-b border-border px-3 pt-1.5"
    >
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {tabs.map((tab) => {
          const on = active === tab.id
          return (
            <button
              key={tab.id ?? 'all'}
              type="button"
              aria-pressed={on}
              onClick={() => showCategory(tab.id)}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded-control-sm px-2 py-1 text-caption font-semibold transition-colors cursor-pointer',
                on ? 'bg-accent/12 text-accent-fg' : 'text-secondary hover:bg-hover hover:text-primary',
              )}
            >
              {tab.colour && (
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: tab.colour }} />
              )}
              {tab.name}
              {tab.n !== undefined && (
                <span className="text-2xs font-normal">
                  {tab.unread
                    ? t('categories.countUnread', {
                        n: tab.n,
                        unread: tab.unread,
                        defaultValue: '{n} · {unread} unread',
                      })
                    : tab.n}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {counts && (
        <p className="pb-1 text-2xs text-secondary">
          {t('categories.coverage', {
            n: counts.messages,
            defaultValue: 'Counts are of the {n} messages kept on this computer.',
          })}
        </p>
      )}
    </nav>
  )
}
