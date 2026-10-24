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
 * It sits at the end of the top band (ADR-0068 §2, #345), at every width: a
 * `status` named by what it says, around the button that resumes, which says
 * the state in its tooltip. The rail's copy went with the rail (#354).
 *
 * `inert` makes the button alone inert (the band's search covering the band
 * below 769 px): the status around it stays in the accessibility tree.
 */
export function QuietIndicator({ inert = false }: { inert?: boolean }) {
  const { t } = useTranslation()
  const state = useQuietState()
  if (!state.quiet) return null
  const status = quietStatusText(state, t, notificationClock.now())
  const resume = t('notifications.dnd.resume', { defaultValue: 'Resume notifications' })
  return (
    <div role="status" aria-label={status} data-quiet-indicator="band" className="flex shrink-0 items-center">
      {/* The warning tone on its own soft tone, which every theme keeps at
          4.5:1 or more (lib/themes.test.ts), as the danger button does. */}
      <button
        type="button"
        inert={inert}
        onClick={() => resumeNotifications()}
        title={`${status} — ${resume}`}
        aria-label={resume}
        className="flex h-8 w-8 items-center justify-center rounded-control-sm border border-warning/30 bg-warning-soft text-warning transition-colors duration-(--duration-fast) hover:border-warning cursor-pointer"
      >
        <BellOff size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
}
