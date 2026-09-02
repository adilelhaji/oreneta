import type { CSSProperties, ReactNode } from 'react'
import { X } from 'lucide-react'
import { clsx } from '../../lib/utils'

type ChipTone = 'neutral' | 'accent' | 'colour'
type ChipSize = 'sm' | 'md'

const SIZES: Record<ChipSize, string> = {
  sm: 'h-[1.125rem] px-1.5 text-2xs',
  md: 'h-6 px-2 text-caption',
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
  onRemove?: () => void
  /** Required with `onRemove`: an unlabelled × is a control nobody can name. */
  removeLabel?: string
  title?: string
  className?: string
}) {
  const tinted = colour ? tone === 'colour' || tone === 'neutral' : false
  const style: CSSProperties | undefined = tinted
    ? { color: colour, borderColor: `${colour}55`, backgroundColor: `${colour}14` }
    : undefined
  const Tag = onClick ? 'button' : 'span'

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      title={title}
      style={style}
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border font-semibold leading-none whitespace-nowrap',
        SIZES[size],
        !tinted &&
          (tone === 'accent' || selected
            ? 'border-accent/30 bg-accent/12 text-accent'
            : 'border-border bg-raised text-secondary'),
        onClick && 'cursor-pointer transition-colors hover:border-accent/40 hover:text-primary',
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          className="-mr-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100 cursor-pointer"
        >
          <X size={10} />
        </button>
      )}
    </Tag>
  )
}
