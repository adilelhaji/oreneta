import type { KeyboardEvent, PointerEvent } from 'react'
import { beginDrag, clampPaneSize, type PaneLimits } from '../../lib/paneResize'

interface PaneResizerProps {
  /** Accessible name, also shown as the tooltip. */
  label: string
  /** The pane's current size, in the unit of `limits`. */
  value: number
  limits: PaneLimits
  /**
   * Which edge of the pane the separator sits on. On the pane's end (right)
   * edge, moving it right grows the pane; on its start (left) edge, moving it
   * left does.
   */
  edge: 'start' | 'end'
  /** The size the pane would have with its edge at this pointer position. */
  sizeAt: (clientX: number) => number
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
  const set = (size: number) => {
    const next = clampPaneSize(size, limits)
    if (next !== value) onResize(next)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    beginDrag((move) => set(sizeAt(move.clientX)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? step * 4 : step
    // Arrows move the separator; which way grows the pane depends on its edge.
    const grow = edge === 'end' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = edge === 'end' ? 'ArrowLeft' : 'ArrowRight'
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
