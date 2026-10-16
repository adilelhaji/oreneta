import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { beginDrag, clampPaneSize, type PaneLimits } from '../../lib/paneResize'

interface PaneResizerProps {
  /** Accessible name, also shown as the tooltip. */
  label: string
  /** The pane's current size, in the unit of `limits`. */
  value: number
  limits: PaneLimits
  /**
   * Which edge of the pane the separator sits on, in the reading direction.
   * Moving the separator towards the end of the line grows a pane on its
   * end edge, and towards the start grows one on its start edge; in a
   * right-to-left layout the arrow keys follow suit.
   */
  edge: 'start' | 'end'
  /** The size the pane would have with its edge at this pointer position. */
  sizeAt: (clientX: number, rtl: boolean) => number
  onResize: (size: number) => void
  /** One arrow press; Shift moves four times as far. */
  step?: number
  valueText?: (value: number) => string
  className?: string
}

/**
 * A vertical window splitter (WAI-ARIA separator, #212, ADR-0059): drag it, or
 * focus it and use the arrow keys, Home (smallest) and End (largest). The
 * size is always clamped to the pane's limits.
 */
export function PaneResizer({
  label,
  value,
  limits,
  edge,
  sizeAt,
  onResize,
  step = 16,
  valueText,
  className = '',
}: PaneResizerProps) {
  // A drag outlives the render it started in: it reads the latest size,
  // limits and callbacks, not the ones of the moment the pointer went down.
  const latest = useRef({ value, limits, sizeAt, onResize })
  latest.current = { value, limits, sizeAt, onResize }

  const set = (size: number) => {
    const current = latest.current
    const next = clampPaneSize(size, current.limits)
    if (next === current.value) return
    current.value = next
    current.onResize(next)
  }

  const isRtl = (element: Element) => getComputedStyle(element).direction === 'rtl'

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const rtl = isRtl(event.currentTarget)
    beginDrag((move) => set(latest.current.sizeAt(move.clientX, rtl)), {
      element: event.currentTarget,
      pointerId: event.pointerId,
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? step * 4 : step
    // Arrows move the separator; which way grows the pane depends on its edge
    // and on which way the line runs.
    const towardsEnd = isRtl(event.currentTarget) ? 'ArrowLeft' : 'ArrowRight'
    const towardsStart = towardsEnd === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight'
    const grow = edge === 'end' ? towardsEnd : towardsStart
    const shrink = edge === 'end' ? towardsStart : towardsEnd
    if (event.key === grow) set(value + amount)
    else if (event.key === shrink) set(value - amount)
    else if (event.key === 'Home') set(limits.min)
    else if (event.key === 'End') set(limits.max)
    else return
    event.preventDefault()
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuetext={valueText?.(Math.round(value))}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={`group z-20 w-2 cursor-col-resize touch-none ${className}`}
    >
      <div className="mx-auto h-full w-px bg-transparent group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  )
}
