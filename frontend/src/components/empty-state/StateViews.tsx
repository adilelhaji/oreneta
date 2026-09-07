import type { ReactNode } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx } from '../../lib/utils'
import { Button } from '../button/Button'

/**
 * The three things a panel can say instead of its content: there is nothing
 * here, it is still coming, or it could not come.
 *
 * One shape for all three, so a reader learns it once. Each view had been
 * resolving these its own way — a spinner here, a sentence there, sometimes
 * nothing at all — and "still loading" and "empty" in particular must never
 * look alike: an empty folder that is only empty because it has not arrived
 * yet is the wrong thing to tell someone.
 */
function StateFrame({
  icon: Icon,
  iconClassName,
  title,
  text,
  action,
  spinning = false,
}: {
  icon: LucideIcon
  iconClassName?: string
  title: string
  text?: ReactNode
  action?: ReactNode
  spinning?: boolean
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8 text-center animate-fade-in select-none">
      <div className="flex max-w-xs flex-col items-center">
        <div
          className={clsx(
            'relative flex h-16 w-16 items-center justify-center rounded-panel border bg-raised shadow-raised',
            iconClassName ?? 'border-accent/10 text-accent',
          )}
        >
          <div className="absolute inset-0 rounded-panel bg-current opacity-[0.04] blur-lg" />
          <Icon size={24} strokeWidth={1.8} className={clsx('relative z-10', spinning && 'animate-spin')} />
        </div>
        <h3 className="mt-5 text-sm font-bold tracking-tight text-primary">{title}</h3>
        {text && <p className="mt-2 px-2 text-xs leading-relaxed text-secondary">{text}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  )
}

/** Still on its way. Says so, rather than showing an empty panel that is not. */
export function LoadingState({ title, text }: { title: string; text?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="h-full w-full">
      <StateFrame icon={Loader2} spinning title={title} text={text} />
    </div>
  )
}

/**
 * Could not come. Says what went wrong in words the reader can act on, and
 * offers the one thing that usually helps.
 */
export function ErrorState({
  title,
  text,
  retryLabel,
  onRetry,
}: {
  title: string
  text?: ReactNode
  retryLabel?: string
  onRetry?: () => void
}) {
  return (
    <div role="alert" className="h-full w-full">
      <StateFrame
        icon={AlertTriangle}
        iconClassName="border-rose-500/20 text-rose-600 dark:text-rose-400"
        title={title}
        text={text}
        action={
          onRetry && retryLabel ? (
            <Button variant="secondary" size="sm" leftIcon={RefreshCw} onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : undefined
        }
      />
    </div>
  )
}
