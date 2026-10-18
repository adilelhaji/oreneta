import { useId, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { formatDeferredWhen } from '../../lib/date'
import { sendLaterChoices } from '../../states/scheduledSends'
import { MenuItem } from '../menu/MenuItem'
import { MenuList } from '../menu/Menu'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'

/**
 * The times a message can be held for, beside the button that sends it now.
 *
 * Its own control rather than a mode of Send: choosing to send is one
 * decision, choosing when is another, and folding them together makes it easy
 * to make the first while meaning the second.
 */
export function SendLaterMenu({
  disabled,
  title,
  onSchedule,
}: {
  disabled: boolean
  /** Overrides the default label — used to say *why* it is disabled. */
  title?: string
  onSchedule: (at: number) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const noteId = useId()
  useDismissOnOutside(
    open,
    (target) => Boolean(wrapRef.current?.contains(target as Node | null)),
    () => setOpen(false),
  )

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        title={title ?? t('sendLater.action')}
        aria-label={title ?? t('sendLater.action')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-9 w-9 items-center justify-center rounded-control transition-colors ${
          disabled ? 'cursor-not-allowed text-secondary/50' : 'text-secondary hover:bg-hover cursor-pointer'
        }`}
      >
        <Clock size={16} strokeWidth={1.75} />
      </button>
      {open && (
        <div className="absolute bottom-full end-0 z-50 mb-2 min-w-[15rem] rounded-control border border-border bg-panel p-1 shadow-raised">
          <MenuList
            label={t('sendLater.action')}
            describedBy={noteId}
            autoFocus
            onClose={() => setOpen(false)}
          >
            {sendLaterChoices().map((choice) => (
              <MenuItem
                key={choice.key}
                icon={<Clock size={14} className="text-secondary" strokeWidth={1.75} />}
                label={t(`sendLater.${choice.key}`, {
                  defaultValue: choice.key,
                  when: formatDeferredWhen(choice.at),
                })}
                onClick={() => {
                  setOpen(false)
                  onSchedule(choice.at)
                }}
              />
            ))}
          </MenuList>
          {/* Said before choosing, not after it went late (#89): beside the
              menu (a menu holds only items) and read with it. */}
          <p id={noteId} className="max-w-[15rem] px-2 pb-1 pt-1.5 text-2xs leading-snug text-secondary">
            {t('sendLater.needsApp', {
              defaultValue:
                'Oreneta sends it while it is running. If it is closed or the computer sleeps at that time, it goes as soon as Oreneta opens again.',
            })}
          </p>
        </div>
      )}
    </div>
  )
}
