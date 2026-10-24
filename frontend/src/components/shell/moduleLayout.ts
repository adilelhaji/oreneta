import { BookUser, CalendarDays, ListTodo, Mail, MessagesSquare, Paperclip, StickyNote } from 'lucide-react'
import { APP_MODULES, type AppModule } from '../../states/ui'

// What the module switcher (ADR-0068 §5, piece 14b, #354) draws, apart from
// how: the strip at the foot of the folder pane from 1025 px, and the narrow
// bar from 769 to 1024 px share it.

/** The modules in the order of the strip, which is the order of `ui$.module`'s values. */
export const MODULE_ORDER: readonly AppModule[] = APP_MODULES

/**
 * Each module's icon, and the catalog key of its name: the name its `<main>`
 * takes (App.tsx), which is also its button's tooltip and accessible name.
 */
export const MODULE_BUTTONS: Record<AppModule, { icon: typeof Mail; name: string }> = {
  mail: { icon: Mail, name: 'shell.region.mail' },
  calendar: { icon: CalendarDays, name: 'calendar.title' },
  people: { icon: BookUser, name: 'people.title' },
  tasks: { icon: ListTodo, name: 'tasks.title' },
  notes: { icon: StickyNote, name: 'notes.title' },
  chat: { icon: MessagesSquare, name: 'messaging.title' },
  attachments: { icon: Paperclip, name: 'attachmentsView.title' },
}

/**
 * How many places of `slot` px there are along `length` px: a button each,
 * «Més» included. Null while either is unknown (nothing laid out yet, or no
 * layout at all, as in tests), which draws every button.
 */
export function slotsAlong(length: number, slot: number): number | null {
  if (!(length > 0) || !(slot > 0)) return null
  // A hair of tolerance: 252 px of 36 px places are 7, not 6.9999.
  return Math.floor(length / slot + 0.001)
}

/**
 * Which modules the switcher draws and which go into «Més», for `slots`
 * places. All of them when they all fit. Otherwise one place is kept for
 * «Més» and the others go to the first modules in the strip's order; the
 * active module is always drawn, in the place of the last of those when it is
 * not among them. However short the switcher, the active module is drawn.
 * Both lists keep the strip's order.
 */
export function fitModules(
  active: AppModule,
  slots: number | null,
  order: readonly AppModule[] = MODULE_ORDER,
): { shown: AppModule[]; more: AppModule[] } {
  if (slots === null || slots >= order.length) return { shown: [...order], more: [] }
  const room = Math.max(1, slots - 1)
  let drawn = order.slice(0, room)
  if (!drawn.includes(active)) drawn = [...drawn.slice(0, room - 1), active]
  const kept = new Set(drawn)
  return { shown: order.filter((key) => kept.has(key)), more: order.filter((key) => !kept.has(key)) }
}
