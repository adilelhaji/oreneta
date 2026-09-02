import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx } from '../../lib/utils'

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger'

/**
 * Tone paints the border and the icon, not the whole box: a page with three
 * notices should not look like three coloured slabs, and the text stays the
 * same ink whatever the tone so it reads at the same contrast in every theme.
 */
const TONES: Record<NoticeTone, { icon: LucideIcon; ring: string; iconColor: string }> = {
  info: { icon: Info, ring: 'border-border', iconColor: 'text-accent' },
  success: { icon: CheckCircle2, ring: 'border-emerald-500/40', iconColor: 'text-emerald-600 dark:text-emerald-400' },
  warning: { icon: AlertTriangle, ring: 'border-amber-500/45', iconColor: 'text-amber-600 dark:text-amber-400' },
  danger: { icon: XCircle, ring: 'border-rose-500/45', iconColor: 'text-rose-600 dark:text-rose-400' },
}

/**
 * A line of information set into the page, where the reader will see it
 * without it interrupting them.
 *
 * Different from a toast, which comes and goes, and from a confirm, which
 * blocks. A notice stays for as long as what it says is true — "labels stay
 * on this computer", "three messages would be touched" — and can carry the
 * one action that follows from it.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone
  title?: string
  children: ReactNode
  /** One control that follows from the notice — a button, a link. */
  action?: ReactNode
  className?: string
}) {
  const { icon: Icon, ring, iconColor } = TONES[tone]
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={clsx(
        'flex items-start gap-2.5 rounded-control border bg-raised px-3.5 py-2.5 text-ui text-primary',
        ring,
        className,
      )}
    >
      <Icon size={15} className={clsx('mt-0.5 shrink-0', iconColor)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={clsx('text-secondary', title && 'mt-0.5')}>{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
