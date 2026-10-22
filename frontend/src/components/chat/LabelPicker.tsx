import { useRef, useState } from 'react'
import { Check, Tag } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { assignLabels, labels$ } from '../../states/labels'
import { showToast, ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { MenuItem } from '../menu/MenuItem'
import { MenuList, MenuSeparator } from '../menu/Menu'

/**
 * Puts labels on the open conversation.
 *
 * A list of toggles rather than an add-and-remove pair: what a reader wants to
 * say is "this one is Work and not Urgent", and seeing every label with its
 * state says that in one glance. Each toggle saves the whole set, which is
 * also what the core stores. The toggles are checkbox menu items (#289).
 */
export function LabelPicker({ threadId, applied }: { threadId: string; applied: string[] }) {
  const { t } = useTranslation()
  const labels = useValue(labels$.labels)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(
    open,
    (target) => Boolean(wrapRef.current?.contains(target as Node | null)),
    () => setOpen(false),
  )

  const toggle = async (id: string) => {
    const next = applied.includes(id) ? applied.filter((item) => item !== id) : [...applied, id]
    setSaving(true)
    try {
      await assignLabels(threadId, next)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('labels.assignFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <IconButton
        icon={Tag}
        label={t('labels.label')}
        active={open || applied.length > 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      />
      {open && (
        <MenuList
          label={t('labels.label')}
          autoFocus
          onClose={() => setOpen(false)}
          className="absolute end-0 top-full z-50 mt-2 min-w-[14rem] rounded-control border border-border bg-chats p-1 shadow-overlay"
        >
          {labels.length === 0 ? (
            // Said as a disabled item so the arrow keys reach it too.
            <MenuItem disabled label={t('labels.noneYet')} />
          ) : (
            labels.map((label) => {
              const on = applied.includes(label.id)
              return (
                <MenuItem
                  key={label.id}
                  role="menuitemcheckbox"
                  checked={on}
                  disabled={saving}
                  icon={
                    <span
                      aria-hidden="true"
                      style={{ backgroundColor: label.colour }}
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                    />
                  }
                  label={
                    <span dir="auto" className="block min-w-0 truncate">
                      {label.name}
                    </span>
                  }
                  trailing={on ? <Check size={14} className="shrink-0 text-accent-fg" strokeWidth={1.75} /> : undefined}
                  onClick={() => void toggle(label.id)}
                />
              )
            })
          )}
          <MenuSeparator />
          <MenuItem
            icon={<Tag size={14} className="text-secondary" strokeWidth={1.75} />}
            label={t('labels.manage')}
            onClick={() => {
              setOpen(false)
              ui$.settingsOpen.set(true)
            }}
          />
        </MenuList>
      )}
    </div>
  )
}
