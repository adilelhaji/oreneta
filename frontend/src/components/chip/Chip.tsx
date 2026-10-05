import type { CSSProperties, ReactNode } from 'react'
import { X } from 'lucide-react'
import { clsx } from '../../lib/utils'

type ChipTone = 'neutral' | 'accent' | 'colour' | 'danger'
type ChipSize = 'sm' | 'md'
type ChipRemoval = { onRemove: () => void; removeLabel: string } | { onRemove?: undefined; removeLabel?: never }

const SIZES: Record<ChipSize, string> = {
  sm: 'h-[1.125rem] text-2xs',
  md: 'h-6 text-caption',
}

/**
 * A small labelled pill: a label on a conversation, a facet in the filter bar,
 * a count on a folder.
 *
 * One component for all of them so they share a height, a radius and a
 * weight, and so a label chip on a list row and the same label in a picker
 * cannot come out two different shapes. A `colour` is the reader's own — a
 * label's — and is applied as a tint rather than a fill, so the text keeps
 * its contrast whatever colour they chose.
 */
export function Chip({
  children,
  tone = 'neutral',
  colour,
  size = 'md',
  selected = false,
  onClick,
  onRemove,
  removeLabel,
  title,
  className,
}: {
  children: ReactNode
  tone?: ChipTone
  /** `#rrggbb`; implies the `colour` tone. */
  colour?: string
  size?: ChipSize
  /** For chips that toggle something — a filter facet. */
  selected?: boolean
  onClick?: () => void
  title?: string
  className?: string
} & ChipRemoval) {
  const tinted = colour ? tone === 'colour' || tone === 'neutral' : false
  const style: CSSProperties | undefined = tinted
    ? { color: colour, borderColor: `${colour}55`, backgroundColor: `${colour}14` }
    : undefined
  // A selectable/removable chip contains two sibling controls, never a button
  // inside another button. Removing must not toggle the selected state.
  const wholeChipButton = !!onClick && !onRemove
  const padding = size === 'sm' ? 'px-1.5' : 'px-2'
  const Tag = wholeChipButton ? 'button' : 'span'

  return (
    <Tag
      type={wholeChipButton ? 'button' : undefined}
      onClick={wholeChipButton ? onClick : undefined}
      aria-pressed={wholeChipButton ? selected : undefined}
      title={title}
      style={style}
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center rounded-full border font-semibold leading-none whitespace-nowrap',
        SIZES[size],
        !(onClick && onRemove) && clsx('gap-1', padding),
        !tinted &&
          (tone === 'danger'
            ? 'border-danger/40 bg-danger-soft text-danger'
            : tone === 'accent' || selected
              ? 'border-accent/30 bg-accent/12 text-accent'
              : 'border-border bg-raised text-secondary'),
        wholeChipButton && 'cursor-pointer transition-colors hover:border-accent/40 hover:text-primary',
        onClick && selected && 'ring-1 ring-accent',
        className,
      )}
    >
      {onClick && onRemove ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={selected}
          className={clsx('flex h-full min-w-0 flex-1 items-center rounded-full text-left cursor-pointer', padding)}
        >
          <span className="min-w-0 truncate">{children}</span>
        </button>
      ) : (
        <span className="min-w-0 truncate">{children}</span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          className={clsx(
            'flex shrink-0 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100 cursor-pointer',
            onClick ? 'h-full w-6' : '-mr-0.5 h-3.5 w-3.5',
          )}
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </Tag>
  )
}
