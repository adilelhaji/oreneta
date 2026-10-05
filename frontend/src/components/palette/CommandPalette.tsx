import { useEffect, useId, useMemo, useRef } from 'react'
import { Check, SquareChevronRight } from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { ui$, closeCommandPalette } from '../../states/ui'
import { formatShortcut, isMac } from '../../lib/shortcuts'
import { useCommandList } from './useCommandList'
import { filterCommands } from './paletteCommands'

export function CommandPalette() {
  const { t } = useTranslation()
  const open = useValue(ui$.paletteOpen)
  const query = useValue(ui$.paletteQuery)
  const index = useValue(ui$.paletteIndex)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const commands = useCommandList()
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query])

  // Focus the search field whenever the palette opens.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  // Keep the highlighted index in range as the filtered list shrinks.
  useEffect(() => {
    if (!open) return
    const max = Math.max(0, filtered.length - 1)
    if (index > max) ui$.paletteIndex.set(max)
  }, [open, filtered.length, index])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, index, query])

  // Joins the Escape stack so the palette claims the key even when it is opened
  // on top of another dialog, which would otherwise close underneath it.
  useEscapeKey(closeCommandPalette, open)

  if (!open) return null

  const move = (delta: number) => {
    if (filtered.length === 0) return
    ui$.paletteIndex.set((index + delta + filtered.length) % filtered.length)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const key = event.key.toLowerCase()

    if (event.key === 'ArrowDown' || (event.ctrlKey && key === 'n')) {
      event.preventDefault()
      event.stopPropagation()
      move(1)
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && key === 'p')) {
      event.preventDefault()
      event.stopPropagation()
      move(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (!filtered[index]?.disabled) filtered[index]?.run()
    }
  }

  // Above every other overlay: Ctrl/⌘K opens the palette even with a dialog
  // already up, and it is then the newest layer — so it has to paint on top as
  // well as be the layer Escape closes (see useEscapeKey).
  return (
    <div
      className="fixed inset-0 z-[130] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeCommandPalette()
      }}
    >
      <div
        data-command-palette
        className="w-full max-w-[560px] overflow-hidden rounded-control border border-border bg-chats shadow-overlay animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.label')}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <SquareChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-secondary" />
          <input
            ref={inputRef}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-label={t('palette.label')}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`${id}-results`}
            aria-activedescendant={filtered[index] ? `${id}-${index}` : undefined}
            value={query}
            onChange={(event) => {
              ui$.paletteQuery.set(event.target.value)
              ui$.paletteIndex.set(0)
            }}
            placeholder={t('palette.placeholder')}
            className="w-full min-w-0 border-0 bg-transparent text-sm text-primary outline-none placeholder:text-secondary"
          />
        </div>

        <div
          ref={listRef}
          id={`${id}-results`}
          role="listbox"
          aria-label={t('palette.label')}
          className="max-h-[min(50vh,380px)] overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <div role="status" className="px-3 py-6 text-center text-xs text-secondary">
              {t('palette.noMatches')}
            </div>
          ) : (
            filtered.map((command, i) => {
              const selected = i === index
              return (
                <button
                  type="button"
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={command.disabled || undefined}
                  key={command.id}
                  onFocus={() => ui$.paletteIndex.set(i)}
                  onMouseEnter={() => ui$.paletteIndex.set(i)}
                  onClick={() => {
                    if (!command.disabled) command.run()
                  }}
                  className={`flex w-full items-center gap-3 rounded-control-sm px-3 py-2 text-left text-ui transition-colors cursor-pointer ${
                    selected ? 'bg-accent/10 text-primary' : 'text-primary hover:bg-hover'
                  }`}
                >
                  <span aria-hidden="true" className="shrink-0 text-secondary">
                    {command.icon}
                  </span>
                  <span className="min-w-0 flex-1 wrap-anywhere">
                    <span className="block">{command.label}</span>
                    <span className="block text-caption text-secondary">{command.hint}</span>
                  </span>
                  {command.active && <Check size={14} className="shrink-0 text-accent" strokeWidth={1.75} />}
                  {command.shortcut && (
                    <kbd className="shrink-0 rounded border border-border bg-app px-1.5 py-0.5 text-2xs font-medium text-secondary">
                      {formatShortcut(command.shortcut).join(isMac ? '' : '+')}
                    </kbd>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-2xs text-secondary">
          <Hint keys="Enter" label={t('palette.hints.run')} />
          <Hint keys="↑↓" label={t('palette.hints.navigate')} />
          <Hint keys="Esc" label={t('palette.hints.close')} />
        </div>
      </div>
    </div>
  )
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded border border-border bg-app px-1.5 py-0.5 font-medium">{keys}</kbd>
      <span className="uppercase tracking-wide">{label}</span>
    </span>
  )
}
