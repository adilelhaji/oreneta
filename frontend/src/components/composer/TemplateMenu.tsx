import { useEffect, useRef, useState } from 'react'
import { FileText, Settings2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { loadTemplates, searchTemplates, templates$, type Template } from '../../states/templates'
import { ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { MenuItem } from '../menu/MenuItem'
import { MenuGroup, MenuList, MenuSeparator, menuSurfaceProps } from '../menu/Menu'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { focusMenuEdge } from '../../lib/menuKeyboard'

/**
 * The kept text, offered where it is used.
 *
 * Snippets first and whole messages after, under headings, because the two
 * do different things when picked and a list that mixed them would make that
 * a surprise. A writer with nothing kept yet gets a way to keep something
 * rather than an empty box: the menu that has nothing in it is exactly where
 * someone finds out the feature exists.
 */
export function TemplateMenu({ onPick }: { onPick: (template: Template) => void }) {
  const { t } = useTranslation()
  const stored = useValue(templates$.templates)
  const loaded = useValue(templates$.loaded)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Fetched when the composer opens rather than when the menu does, so that
  // picking one is instant instead of a round trip with the menu already down.
  useEffect(() => {
    if (!loaded) void loadTemplates()
  }, [loaded])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  // Escape closes the menu (#289); a click outside still does, as before.
  useEscapeKey(() => setOpen(false), open)

  const found = searchTemplates(stored, query)
  const snippets = found.filter((template) => template.kind === 'snippet')
  const messages = found.filter((template) => template.kind === 'message')

  const manage = () => {
    setOpen(false)
    ui$.settingsOpen.set(true)
  }

  return (
    // Opens from its button where the footer has room for its 16 rem beside
    // the buttons before it (21 rem); in a narrower footer (the app's 200 %
    // in a 360 px reader, #347) from the footer's start edge, and no wider
    // than the footer, so it stays inside the reader.
    <div ref={wrapRef} className="relative @max-[21rem]:static">
      <IconButton
        icon={FileText}
        iconSize={16}
        label={t('templates.menu')}
        radius="xl"
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        // The search field sits beside the menu, not in it: a menu holds only
        // items. Down from the field goes into the list.
        <div
          className="absolute bottom-full start-0 z-50 mb-2 w-64 max-w-[100cqw] rounded-control border border-border bg-chats p-1 shadow-overlay"
          {...menuSurfaceProps}
        >
          {stored.length === 0 && (
            <p className="px-3 py-2 text-caption leading-snug text-secondary">{t('templates.none')}</p>
          )}
          {stored.length > 0 && (
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('templates.search', { defaultValue: 'Search kept text' })}
              placeholder={t('templates.search', { defaultValue: 'Search kept text' })}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown') return
                event.preventDefault()
                focusMenuEdge(menuRef.current, 'first')
              }}
              className="mb-1 w-full rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
            />
          )}
          {stored.length > 0 && found.length === 0 && (
            <p className="px-3 py-2 text-caption text-secondary">
              {t('templates.noMatch', { defaultValue: 'Nothing kept matches that.' })}
            </p>
          )}
          <div ref={menuRef} role="none">
            <MenuList
              label={t('templates.menu')}
              // With nothing kept there is no field to type in: the list
              // takes focus itself.
              autoFocus={stored.length === 0}
              restoreFocus
              onClose={() => setOpen(false)}
            >
              {snippets.length > 0 && (
                <MenuGroup
                  label={t('templates.kind.snippet')}
                  labelClassName="px-3 pb-0.5 pt-1.5 text-2xs font-bold uppercase tracking-wide text-secondary"
                >
                  {snippets.map((template) => (
                    <MenuItem
                      key={template.id}
                      label={template.name}
                      onClick={() => {
                        setOpen(false)
                        onPick(template)
                      }}
                    />
                  ))}
                </MenuGroup>
              )}
              {messages.length > 0 && (
                <MenuGroup
                  label={t('templates.kind.message')}
                  labelClassName="px-3 pb-0.5 pt-1.5 text-2xs font-bold uppercase tracking-wide text-secondary"
                >
                  {messages.map((template) => (
                    <MenuItem
                      key={template.id}
                      label={template.name}
                      onClick={() => {
                        setOpen(false)
                        onPick(template)
                      }}
                    />
                  ))}
                </MenuGroup>
              )}
              <MenuSeparator />
              <MenuItem
                icon={<Settings2 size={14} className="text-secondary" strokeWidth={1.75} />}
                label={t('templates.manage')}
                onClick={manage}
              />
            </MenuList>
          </div>
        </div>
      )}
    </div>
  )
}
