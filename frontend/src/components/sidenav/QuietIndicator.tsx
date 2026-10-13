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
 * The side navigation's sign that notifications are quiet (ADR-0049): shown
 * only while they are, and one click resumes them. Badges keep updating either
 * way, so the sign is what tells the person why nothing popped up.
 */
export function QuietIndicator() {
  const { t } = useTranslation()
  const state = useQuietState()
  if (!state.quiet) return null
  const status = quietStatusText(state, t, notificationClock.now())
  const resume = t('notifications.dnd.resume', { defaultValue: 'Resume notifications' })
  return (
    <div role="status" aria-label={status} className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => resumeNotifications()}
        title={`${status} — ${resume}`}
        aria-label={resume}
        className="flex h-10 w-10 items-center justify-center rounded-control bg-white/20 text-white ring-2 ring-warning transition-colors duration-120 hover:bg-white/30 cursor-pointer"
      >
        <BellOff size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
}
