import { useRef, useState } from 'react'
import { Check, Tag } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { assignLabels, labels$ } from '../../states/labels'
import { showToast, ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { menuItemClass } from '../menu/menuStyles'

/**
 * Puts labels on the open conversation.
 *
 * A list of toggles rather than an add-and-remove pair: what a reader wants to
 * say is "this one is Work and not Urgent", and seeing every label with its
 * state says that in one glance. Each toggle saves the whole set, which is
 * also what the core stores.
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
        onClick={() => setOpen((was) => !was)}
      />
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-[14rem] rounded-control border border-border bg-chats p-1 shadow-xl">
          {labels.length === 0 ? (
            <p className="px-3 py-2 text-xs text-secondary">{t('labels.noneYet')}</p>
          ) : (
            labels.map((label) => {
              const on = applied.includes(label.id)
              return (
                <button
                  key={label.id}
                  type="button"
                  disabled={saving}
                  onClick={() => void toggle(label.id)}
                  className={clsx(menuItemClass, 'disabled:opacity-60')}
                >
                  <span
                    aria-hidden="true"
                    style={{ backgroundColor: label.colour }}
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{label.name}</span>
                  {on && <Check size={13} className="shrink-0 text-accent" />}
                </button>
              )
            })
          )}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              ui$.settingsOpen.set(true)
            }}
            className={menuItemClass}
          >
            <Tag size={13} className="text-secondary" />
            <span className="min-w-0 flex-1 truncate text-left">{t('labels.manage')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
