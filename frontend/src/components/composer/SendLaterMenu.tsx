import { useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { formatDeferredWhen } from '../../lib/date'
import { sendLaterChoices } from '../../states/scheduledSends'
import { MenuItem } from '../menu/MenuItem'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'

/**
 * The times a message can be held for, beside the button that sends it now.
 *
 * Its own control rather than a mode of Send: choosing to send is one
 * decision, choosing when is another, and folding them together makes it easy
 * to make the first while meaning the second.
 */
export function SendLaterMenu({ disabled, onSchedule }: { disabled: boolean; onSchedule: (at: number) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
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
        title={t('sendLater.action')}
        aria-label={t('sendLater.action')}
        className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
          disabled
            ? 'cursor-not-allowed text-secondary/50'
            : 'text-secondary hover:bg-hover cursor-pointer'
        }`}
      >
        <Clock size={15} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 min-w-[15rem] rounded-xl border border-border bg-panel p-1 shadow-lg">
          {sendLaterChoices().map((choice) => (
            <MenuItem
              key={choice.key}
              icon={<Clock size={13} className="text-secondary" />}
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
        </div>
      )}
    </div>
  )
}
