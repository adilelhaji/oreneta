import { useEffect, useId, useRef, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settingsDestinations, type SettingsDestination } from '../../lib/settingsDestinations'
import { accounts$ } from '../../states/accounts'
import { update$ } from '../../states/update'
import { focusSettingsSection } from '../../states/ui'
import { filterCommands } from '../palette/paletteCommands'
import { TextInput } from '../field/Field'

export function SettingsSearch() {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  const updatesSupported = useValue(update$.status.supported)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const filtered = filterCommands(settingsDestinations(accounts, t, updatesSupported), query)
  const selected = Math.min(index, Math.max(0, filtered.length - 1))
  const expanded = !!query.trim()
  useEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, query])
  const activate = (item?: SettingsDestination) => {
    if (!item || (item.accountId && !accounts$.peek().some((account) => account.id === item.accountId))) return
    focusSettingsSection(item.section, item.accountId)
    setQuery('')
  }
  return (
    <div ref={root} className="shrink-0 border-b border-border px-4 py-2">
      <TextInput
        role="combobox"
        aria-label={t('settingsSearch.label')}
        placeholder={t('settingsSearch.label')}
        aria-expanded={expanded}
        aria-controls={`${id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={expanded && filtered.length ? `${id}-${selected}` : undefined}
        className="w-full"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (!expanded || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            if (filtered.length)
              setIndex((selected + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            activate(filtered[selected])
          }
        }}
      />
      {expanded && (
        <div
          id={`${id}-results`}
          role="listbox"
          aria-label={t('settingsSearch.results')}
          className="mt-2 max-h-36 overflow-auto"
        >
          {!filtered.length && (
            <p role="status" className="p-2 text-caption text-secondary">
              {t('settingsSearch.noMatches')}
            </p>
          )}
          {filtered.map((item, i) => (
            <button
              type="button"
              role="option"
              aria-selected={selected === i}
              id={`${id}-${i}`}
              key={item.id}
              onClick={() => activate(item)}
              onMouseEnter={() => setIndex(i)}
              onFocus={() => setIndex(i)}
              className={`block w-full rounded-control px-3 py-2 text-left text-ui wrap-anywhere ${selected === i ? 'bg-accent/10 text-primary' : 'text-secondary hover:bg-hover'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
