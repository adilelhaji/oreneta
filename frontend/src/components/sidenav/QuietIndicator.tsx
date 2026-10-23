import { BellOff } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { formatDeferredWhen } from '../../lib/date'
import { quietStateAt, type QuietState } from '../../lib/quietHours'
import { settings$ } from '../../states/settings'
import { notificationClock, quietClock$, resumeNotifications } from '../../states/notifications'
import type { t as translate } from '../../lib/i18n'

/** "Do not disturb until 08:00", "… until turned off", "Quiet hours until 07:00". */
export function quietStatusText(state: QuietState, t: typeof translate, now = new Date()): string {
  if (!state.quiet) return ''
  if (state.until === null)
    return t('notifications.dnd.statusOff', { defaultValue: 'Do not disturb is on until you turn it off' })
  const when = formatDeferredWhen(state.until / 1000, now)
  return state.reason === 'schedule'
    ? t('notifications.dnd.statusSchedule', { when, defaultValue: 'Quiet hours until {when}' })
    : t('notifications.dnd.statusUntil', { when, defaultValue: 'Do not disturb until {when}' })
}

/** The current quiet state, recomputed when the prefs change and as the clock ticks. */
export function useQuietState(): QuietState {
  const prefs = useValue(settings$.notifications)
  // Read so the component re-renders on each tick; the instant itself comes
  // from the (overridable) clock.
  useValue(quietClock$)
  return quietStateAt(prefs, notificationClock.now())
}

/**
 * The sign that notifications are quiet (ADR-0049): shown only while they
 * are, and one click resumes them. Badges keep updating either way, so the
 * sign is what tells the person why nothing popped up.
 *
 * It sits at the end of the top band (ADR-0068 §2, #345), at every width.
 * Until piece 14 retires the vertical rail, the rail shows it too (owner
 * decision 1 on #342): both read the same state, so they appear, change and
 * go together. The band's is the `status`, named by what it says; the rail's
 * copy (`placement="rail"`) is only the button, so the status is not there
 * twice for a screen reader. Both buttons resume, and both say the state in
 * their tooltip.
 */
export function QuietIndicator({ placement = 'band' }: { placement?: 'band' | 'rail' }) {
  const { t } = useTranslation()
  const state = useQuietState()
  if (!state.quiet) return null
  const status = quietStatusText(state, t, notificationClock.now())
  const resume = t('notifications.dnd.resume', { defaultValue: 'Resume notifications' })
  const button = (className: string, iconSize: number) => (
    <button
      type="button"
      onClick={() => resumeNotifications()}
      title={`${status} — ${resume}`}
      aria-label={resume}
      className={className}
    >
      <BellOff size={iconSize} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
  if (placement === 'rail')
    return (
      <div data-quiet-indicator="rail" className="flex flex-col items-center">
        {button(
          'flex h-10 w-10 items-center justify-center rounded-control bg-white/20 text-white ring-2 ring-warning transition-colors duration-120 hover:bg-white/30 cursor-pointer',
          18,
        )}
      </div>
    )
  return (
    <div role="status" aria-label={status} data-quiet-indicator="band" className="flex shrink-0 items-center">
      {/* The warning tone on its own soft tone, which every theme keeps at
          4.5:1 or more (lib/themes.test.ts), as the danger button does. */}
      {button(
        'flex h-8 w-8 items-center justify-center rounded-control-sm border border-warning/30 bg-warning-soft text-warning transition-colors duration-(--duration-fast) hover:border-warning cursor-pointer',
        16,
      )}
    </div>
  )
}
