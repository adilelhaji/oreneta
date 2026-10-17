import { useEffect, useState, type RefObject } from 'react'

/**
 * The drawn width of an element (or of its parent), followed as it changes; 0
 * until measured or where there is no layout (tests), which callers read as
 * "unknown".
 */
export function useElementWidth(ref: RefObject<Element | null>, ofParent = false): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ofParent ? ref.current?.parentElement : ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, ofParent])
  return width
}

/**
 * Whether an element is drawn at least `px` wide, followed as it is resized:
 * null until measured, while it has no layout (hidden, or tests) or while
 * `enabled` is false. Only crossing `px` re-renders the caller, so a drag
 * across a long list does not repaint it on every pixel.
 */
export function useElementAtLeast(ref: RefObject<Element | null>, px: number, enabled = true): boolean | null {
  const [atLeast, setAtLeast] = useState<boolean | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!enabled || !element || typeof ResizeObserver === 'undefined') {
      setAtLeast(null)
      return
    }
    const measure = () => {
      const width = element.getBoundingClientRect().width
      setAtLeast(width > 0 ? width >= px : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, px, enabled])
  return atLeast
}

/** Whether the window is at least `px` wide, followed as it is resized. */
export function useWideWindow(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [wide, setWide] = useState(() => !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list?.addEventListener) return
    const update = () => setWide(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return wide
}
