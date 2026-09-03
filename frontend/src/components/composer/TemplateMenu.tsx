import { useEffect, useRef, useState } from 'react'
import { FileText, Settings2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { loadTemplates, templates$, type Template } from '../../states/templates'
import { ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { MenuItem } from '../menu/MenuItem'

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
  const wrapRef = useRef<HTMLDivElement>(null)

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

  const snippets = stored.filter((template) => template.kind === 'snippet')
  const messages = stored.filter((template) => template.kind === 'message')

  const manage = () => {
    setOpen(false)
    ui$.settingsOpen.set(true)
  }

  return (
    <div ref={wrapRef} className="relative">
      <IconButton
        icon={FileText}
        iconSize={16}
        label={t('templates.menu')}
        radius="xl"
        active={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-control border border-border bg-chats p-1 shadow-xl">
          {stored.length === 0 && (
            <p className="px-3 py-2 text-caption leading-snug text-secondary">{t('templates.none')}</p>
          )}
          {snippets.length > 0 && (
            <p className="px-3 pb-0.5 pt-1.5 text-2xs font-bold uppercase tracking-wide text-secondary">
              {t('templates.kind.snippet')}
            </p>
          )}
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
          {messages.length > 0 && (
            <p className="px-3 pb-0.5 pt-1.5 text-2xs font-bold uppercase tracking-wide text-secondary">
              {t('templates.kind.message')}
            </p>
          )}
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
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={<Settings2 size={13} className="text-secondary" />}
            label={t('templates.manage')}
            onClick={manage}
          />
        </div>
      )}
    </div>
  )
}
