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
