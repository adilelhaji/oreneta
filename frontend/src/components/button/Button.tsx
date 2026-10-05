import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { clsx } from '../../lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

const SIZES: Record<ButtonSize, { box: string; icon: number }> = {
  sm: { box: 'min-h-8 px-3 py-1 text-caption', icon: 14 },
  md: { box: 'min-h-9 px-3.5 py-1.5 text-ui', icon: 16 },
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-accent text-on-accent enabled:hover:bg-accent-hover',
  secondary: 'border border-border bg-chats text-primary enabled:hover:bg-hover',
  ghost: 'border border-transparent text-secondary enabled:hover:bg-hover enabled:hover:text-primary',
  danger: 'border border-danger/30 bg-danger-soft text-danger enabled:hover:border-danger',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  leftIcon?: LucideIcon
  rightIcon?: LucideIcon
  children: ReactNode
}

// Labeled button. Variants mirror the styles already in use across dialogs and
// headers (accent CTA, bordered secondary, ghost, soft-danger) so call sites stop
// re-deriving them by hand. `className` is additive (see clsx note).
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', leftIcon: Left, rightIcon: Right, children, className, type, ...rest },
  ref,
) {
  const sizing = SIZES[size]
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center justify-center gap-1.5 rounded-control font-semibold text-center whitespace-normal wrap-anywhere cursor-pointer transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-50',
        sizing.box,
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {Left && <Left size={sizing.icon} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />}
      {children}
      {Right && <Right size={sizing.icon} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />}
    </button>
  )
})
