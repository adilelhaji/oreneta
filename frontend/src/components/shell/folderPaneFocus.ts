import { useEffect, useLayoutEffect, useRef } from 'react'

// Focus across the 1025 px line (#341). From 1025 px a module's folder-like
// controls (task lists, tags, conversations, filters) are the common folder
// pane's body; below, they sit elsewhere (tabs, chips, a column, a bar). The
// modules mount one or the other, so a control that held the focus unmounts
// when the window crosses the line and the focus falls to <body>.
//
// The markup says what corresponds to what:
//  - `data-focus-key="<key>"` on a control that exists in both layouts, with
//    the same key in both (`list:<id>`, `tag:<name>`, `conversation:<jid>`);
//  - `data-focus-return` on the container that stands in for the pane below
//    1025 px, which is where the fallback looks when no key matches.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const AREAS = '[data-folder-pane], [data-focus-return]'

/** The key of a control in the pane or in its narrow stand-in; `null` when it has none; `undefined` when it is elsewhere. */
function keyInAreas(target: EventTarget | null): string | null | undefined {
  if (!(target instanceof HTMLElement) || !target.closest(AREAS)) return undefined
  return target.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey ?? null
}

function focused(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body && active.isConnected
}

/**
 * Keeps the focus on the control it was on when the window crosses 1025 px.
 *
 * Where the focus is cannot be read when the window changes: a browser may
 * already have dropped it by then (the pane is hidden by CSS the moment the
 * query stops matching), and React removes the control after. So the key of the
 * last control focused in the pane, or in its narrow stand-in, is kept as it
 * happens (`focusin`), and read again after each press of the pointer, which
 * may have moved it with no focusin. Focus that falls to <body> by itself (a
 * control the app removes) is not noticed: the next crossing then puts it on
 * the first control of the region that stands in, still better than <body>. After the render of the other layout
 * the control with the same key takes the focus; with none, the first focusable
 * thing of the region that stands in its place (the pane going wide, the
 * `data-focus-return` container going narrow). Focus that survived the switch
 * is left alone, and so is focus that was anywhere else. It does nothing on the
 * first render, and it does not touch F6.
 */
export function useFolderPaneFocus(inPane: boolean) {
  const key = useRef<string | null | undefined>(undefined)
  const was = useRef(inPane)

  useEffect(() => {
    const entered = (event: FocusEvent) => {
      key.current = keyInAreas(event.target)
    }
    // A press may move the focus with no focusin (onto the page's background,
    // which leaves it on <body>) or not move it at all (a second press in the
    // field that has it): once the press is over, read where the focus is.
    let afterPress: ReturnType<typeof setTimeout> | undefined
    const pressed = () => {
      clearTimeout(afterPress)
      afterPress = setTimeout(() => {
        key.current = focused() ? keyInAreas(document.activeElement) : undefined
      })
    }
    document.addEventListener('focusin', entered, true)
    // A touch moves the focus only after the finger lifts, with the
    // compatibility mousedown, so that and the end of a press are read too.
    const ends = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown'] as const
    for (const name of ends) document.addEventListener(name, pressed, true)
    return () => {
      document.removeEventListener('focusin', entered, true)
      for (const name of ends) document.removeEventListener(name, pressed, true)
      clearTimeout(afterPress)
    }
  }, [])

  useLayoutEffect(() => {
    if (was.current === inPane) return
    was.current = inPane
    const wanted = key.current
    key.current = undefined
    if (wanted === undefined || focused()) return
    const region = document.querySelectorAll<HTMLElement>(inPane ? '[data-folder-pane]' : '[data-focus-return]')
    const inside = (element: HTMLElement) => [...region].some((node) => node.contains(element))
    const twin =
      wanted === null
        ? undefined
        : [...document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
            (element) => element.dataset.focusKey === wanted && inside(element),
          )
    const candidates = [
      ...(twin ? [twin] : []),
      ...[...region].flatMap((node) => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]),
    ]
    // A candidate that is not drawn (a CSS-hidden part of the region) does not
    // take the focus: try the next one.
    for (const candidate of candidates) {
      candidate.focus()
      if (document.activeElement === candidate) return
    }
  }, [inPane])
}
