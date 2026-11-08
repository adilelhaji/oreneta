import { useRef, useState } from 'react'
import { Check, Tag } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { assignLabels, labels$ } from '../../states/labels'
import { showToast, ui$ } from '../../states/ui'
import { clsx } from '../../lib/utils'
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
export function LabelPicker({
  threadId,
  applied,
  labelToggle: shared,
  className,
}: {
  threadId: string
  applied: string[]
  /**
   * The saving state and toggle of the owner's `useLabelToggle`, when another
   * menu puts the same labels on (the conversation header's «Label» submenu,
   * #347): one save in flight disables the toggles in both. Without it the
   * picker keeps its own.
   */
  labelToggle?: LabelToggle
  /** On the wrapper: a narrow header hides the button (#347). */
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const own = useLabelToggle(threadId, applied)
  const labelToggle = shared ?? own
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(
    open,
    (target) => Boolean(wrapRef.current?.contains(target as Node | null)),
    () => setOpen(false),
  )

  return (
    <div ref={wrapRef} className={clsx('relative', className)}>
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
          <LabelMenuItems
            applied={applied}
            {...labelToggle}
            onManage={() => {
              setOpen(false)
              ui$.settingsOpen.set(true)
            }}
          />
        </MenuList>
      )}
    </div>
  )
}

/** Whether a save of the labels is in flight, and the toggle that starts one. */
export type LabelToggle = { saving: boolean; toggle: (id: string) => Promise<void> }

/**
 * Saves the conversation's labels with one label turned on or off. Kept by
 * the menus' owner, not the menu: while a save is in flight the toggles stay
 * disabled, also in a menu closed and opened again and in another menu with
 * the same labels, so a second toggle cannot start from the set before the
 * first.
 */
export function useLabelToggle(threadId: string, applied: string[]): LabelToggle {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)

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

  return { saving, toggle }
}

/**
 * The picker's items: a toggle per label and «Manage labels». Also the «Label»
 * submenu of «More actions» while a narrow conversation header hides the
 * picker's button (#347), so labelling stays one menu away.
 */
export function LabelMenuItems({
  applied,
  saving,
  toggle,
  onManage,
}: {
  applied: string[]
  saving: boolean
  toggle: (id: string) => Promise<void>
  onManage: () => void
}) {
  const { t } = useTranslation()
  const labels = useValue(labels$.labels)

  return (
    <>
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
        onClick={onManage}
      />
    </>
  )
}
