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
export function StateFrame({
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
    <div className="flex min-h-full w-full items-center justify-center p-6 text-center animate-fade-in">
      <div className="flex max-w-xs flex-col items-center">
        <div
          className={clsx(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-control border',
            iconClassName ?? 'border-border bg-raised text-accent',
          )}
        >
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" className={clsx(spinning && 'animate-spin')} />
        </div>
        <h3 className="mt-4 text-sm font-semibold wrap-anywhere text-primary">{title}</h3>
        {text && <p className="mt-2 text-ui leading-relaxed wrap-anywhere text-secondary">{text}</p>}
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
        iconClassName="border-danger/30 bg-danger-soft text-danger"
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
