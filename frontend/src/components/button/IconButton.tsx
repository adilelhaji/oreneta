import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { clsx } from '../../lib/utils'

type IconButtonVariant = 'ghost' | 'accent' | 'accentSoft' | 'danger'
type IconButtonSize = 'sm' | 'md' | 'lg'
type IconButtonRadius = 'full' | 'lg' | 'xl'

const SIZES: Record<IconButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-7 w-7', icon: 14 },
  md: { box: 'h-8 w-8', icon: 16 },
  lg: { box: 'h-9 w-9', icon: 16 },
}

const RADII: Record<IconButtonRadius, string> = {
  full: 'rounded-full',
  lg: 'rounded-control-sm',
  xl: 'rounded-control',
}

function variantClasses(variant: IconButtonVariant, active: boolean): string {
  switch (variant) {
    case 'accent':
      return 'bg-accent text-on-accent enabled:hover:bg-accent-hover'
    case 'accentSoft':
      return 'bg-active text-accent enabled:hover:bg-hover'
    case 'danger':
      return 'text-danger enabled:hover:bg-danger-soft'
    case 'ghost':
    default:
      return active ? 'bg-active text-accent' : 'text-secondary enabled:hover:bg-hover enabled:hover:text-primary'
  }
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  // Accessible label — drives both the tooltip and aria-label. Required so we
  // never ship an unlabeled icon-only control.
  label: string
  icon?: LucideIcon
  iconSize?: number
  children?: ReactNode
  variant?: IconButtonVariant
  size?: IconButtonSize
  radius?: IconButtonRadius
  active?: boolean
}

// Square, icon-only button. Centralizes the rounded-full + slate hover treatment
// repeated across the headers so the hover token and
// radius can't drift per call site. Spreads through refs, dnd-kit listeners,
// onPointerDown, disabled, etc.; `className` is additive (see clsx note).
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon: Icon,
    iconSize,
    children,
    variant = 'ghost',
    size = 'lg',
    radius = 'full',
    active = false,
    className,
    type,
    ...rest
  },
  ref,
) {
  const sizing = SIZES[size]
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      title={label}
      aria-label={label}
      className={clsx(
        'flex shrink-0 items-center justify-center cursor-pointer transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-50',
        sizing.box,
        RADII[radius],
        variantClasses(variant, active),
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon size={iconSize ?? sizing.icon} strokeWidth={1.75} aria-hidden="true" /> : children}
    </button>
  )
})
