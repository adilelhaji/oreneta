import { openCalendarFromNotification } from './calendar'
import { openThreadTabById } from './compose'
import { openChatFromNotification } from './messaging'

export type NotificationClick = { account?: string; threadId?: string; threadKey?: string }

/**
 * A system notification was clicked (the Go bridge's `notification-clicked`,
 * registered by useAppEffects): what it was about, opened. A chat message
 * (ADR-0055) in the Chat view, missed reminders (#225) in the calendar on
 * the day or week the notice names, anything else as a mail thread.
 */
export function onNotificationClicked(detail: NotificationClick | undefined) {
  const threadId = detail?.threadId || detail?.threadKey
  if (threadId?.startsWith('chat:')) {
    void openChatFromNotification(detail?.account ?? '', threadId.slice('chat:'.length))
    return
  }
  if (threadId?.startsWith('calendar:')) {
    openCalendarFromNotification(threadId.slice('calendar:'.length))
    return
  }
  if (threadId) {
    void openThreadTabById(threadId)
  }
}
