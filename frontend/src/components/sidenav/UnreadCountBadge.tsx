import { clsx } from '../../lib/utils'

/**
 * Numeric unread-count badge over the top inline-end corner of an icon: the
 * Mail and Chat buttons of the module switcher (ADR-0068 §5, #354). Caps at
 * "99+". Renders nothing when count is 0. Its ring is the colour of the
 * surface under it (`surface`): the folder pane's under the strip, the module
 * bar's in the narrow bar. It is drawn for the eye; the button says the count
 * in words.
 */
export function UnreadCountBadge({
  count,
  surface = 'sidenav',
  className,
}: {
  count: number
  surface?: 'sidenav' | 'app'
  className?: string
}) {
  if (count <= 0) return null
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'pointer-events-none absolute flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold leading-none text-on-accent ring-2',
        surface === 'app' ? 'ring-app' : 'ring-sidenav',
        className ?? '-top-1 -end-1',
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
