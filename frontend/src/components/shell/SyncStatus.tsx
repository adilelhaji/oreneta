import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { endAlignedX, menuLeft } from '../../lib/direction'
import { isBareShortcut, matchShortcut } from '../../lib/shortcuts'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { clsx } from '../../lib/utils'
import {
  ConnectivityDetail,
  syncPopoverOpen$,
  useConnectivityState,
  useConnectivitySummary,
} from '../banner/ConnectivityBanner'
import { useWideWindow } from '../resizer/useElementWidth'

/** From this width the button shows the summary beside its icon; below it, the icon alone (ADR-0068 §2). */
export const SYNC_SUMMARY_MIN_WINDOW = 1025

/** Kept between the popover and the window's edges, in CSS px. */
const MARGIN = 8
/** The popover's width, in rem, so it grows with the app's zoom; never wider than the window. */
const WIDTH_REM = 24

/** The button's box when the popover opened, in visual px. */
type Anchor = { left: number; right: number; bottom: number }

/**
 * The sync status at the end of the top band (ADR-0068 §2, #345): a button
 * with an icon and the summary today's region showed, «{count} need
 * attention» or «Complete sync status unknown», and never «Synced»: there is
 * no signal of a complete sync (account-sync-health.md). Below 1025 px it is
 * the icon alone, with the summary as its name and its tooltip.
 *
 * The polite `status` region beside it says the summary too, visually hidden,
 * at every width: it is the one live region of the sync status, here whether
 * or not the bar under the header is, so a change is announced once, as it
 * was.
 *
 * The button opens today's detail (each account, its observation and its
 * actions) in a popover anchored under it, its end edge on the button's, so it
 * opens towards the start of the line in either direction, inside the window.
 * It is not modal: Escape closes it and gives the focus back to the button; a
 * click or the focus elsewhere close it too, and so do a scroll outside and a
 * resize, which give a focus that was in it back to the button.
 *
 * With no account and no unattributed problem there is nothing to say, and
 * nothing is drawn, as before.
 *
 * `inert` (the band's search covering the band below 769 px) makes the button
 * and the popover inert, never the live region, which keeps announcing.
 */
export function SyncStatus({ inert = false }: { inert?: boolean }) {
  const sync = useConnectivityState()
  const wide = useWideWindow(SYNC_SUMMARY_MIN_WINDOW)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const popoverId = useId()
  const open = anchor !== null && sync.shown

  // The bar under the header folds its detail while this one is open. Set
  // with the anchor, in the same render, so the two details are never drawn
  // in one commit.
  useEffect(() => () => syncPopoverOpen$.set(false), [])
  // Nothing left to say (the last account removed): closed, not reopened later.
  useEffect(() => {
    if (sync.shown) return
    syncPopoverOpen$.set(false)
    setAnchor(null)
  }, [sync.shown])

  const show = () => {
    const trigger = button.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    syncPopoverOpen$.set(true)
    setAnchor({ left: rect.left, right: rect.right, bottom: rect.bottom })
  }
  const close = useCallback((refocus: boolean) => {
    if (refocus) button.current?.focus({ preventScroll: true })
    syncPopoverOpen$.set(false)
    setAnchor(null)
  }, [])

  if (!sync.shown) return null
  const attention = sync.attention > 0
  const Icon = attention ? TriangleAlert : RefreshCw

  return (
    <div data-sync-status="" className="flex min-w-0 items-center">
      <button
        ref={button}
        type="button"
        inert={inert}
        data-sync-status-button=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={sync.summary}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          // Enter and Space click it; they end here, as the app menu's do.
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        }}
        className={clsx(
          'flex h-8 min-w-0 items-center gap-1.5 rounded-control-sm border text-caption cursor-pointer transition-colors duration-(--duration-fast)',
          wide ? 'max-w-full px-2' : 'w-8 shrink-0 justify-center',
          // As the bar under the header: the danger tone while it is shown,
          // which every theme keeps at 4.5:1 or more on its soft tone.
          sync.prominent
            ? clsx('bg-danger-soft text-danger hover:border-danger', open ? 'border-danger' : 'border-danger/30')
            : open
              ? 'border-transparent bg-active text-accent-fg'
              : 'border-transparent text-secondary hover:bg-hover hover:text-primary',
        )}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        {/* The name, from 1025 px also on screen. */}
        <span className={wide ? 'min-w-0 truncate' : 'sr-only'}>{sync.summary}</span>
      </button>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {sync.summary}
      </span>
      {open && <SyncPopover id={popoverId} anchor={anchor} opener={button} inert={inert} onClose={close} />}
    </div>
  )
}

function SyncPopover({
  id,
  anchor,
  opener,
  inert,
  onClose,
}: {
  id: string
  anchor: Anchor
  opener: RefObject<HTMLButtonElement | null>
  inert: boolean
  onClose: (refocus: boolean) => void
}) {
  const { t } = useTranslation()
  // The whole detail follows every account, but only while it is open.
  const summary = useConnectivitySummary()
  const ref = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const inside = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node && (!!ref.current?.contains(target) || !!opener.current?.contains(target)),
    [opener],
  )

  // The focus goes in, so the keyboard reads it and Tab reaches its actions.
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  // Escape closes it and gives the focus back to the button; it is the top
  // layer, so a dialog under it stays open.
  useEscapeKey(() => closeRef.current(true))
  useEffect(() => {
    // A click outside, or the focus going elsewhere (Tab past its end, F6, a
    // click in the page), close it and leave the focus where it went.
    const outside = (event: Event) => {
      if (!inside(event.target)) closeRef.current(false)
    }
    // A scroll outside or a resize moves what it is anchored to: closed, and
    // a focus that was in it goes back to the button rather than to the page.
    const moved = (event: Event) => {
      if (event.type === 'resize' || !inside(event.target)) closeRef.current(inside(document.activeElement))
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    document.addEventListener('focusin', outside)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', moved)
      document.removeEventListener('focusin', outside)
    }
  }, [inside])

  // Anchors are visual pixels; fixed positions use CSS pixels under a root zoom.
  const rootStyle = getComputedStyle(document.documentElement)
  const zoom = parseFloat(rootStyle.zoom) || 1
  const viewportWidth = window.innerWidth / zoom
  const viewportHeight = window.innerHeight / zoom
  const width = Math.floor(
    Math.max(0, Math.min(WIDTH_REM * (parseFloat(rootStyle.fontSize) || 16), viewportWidth - 2 * MARGIN)),
  )
  const top = Math.ceil(anchor.bottom / zoom + 4)
  // Its end edge on the button's: the button ends the band, so the popover
  // opens towards the start of the line, leftwards or, in right to left,
  // rightwards; then kept inside the window.
  const start = endAlignedX({ left: anchor.left / zoom, right: anchor.right / zoom }, width)

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      inert={inert}
      data-sync-popover=""
      className="fixed z-[61] overflow-y-auto rounded-control border border-border bg-chats p-3 text-ui text-primary shadow-overlay animate-fade-in"
      style={{
        width,
        top,
        left: menuLeft(start, width, viewportWidth, MARGIN),
        maxHeight: Math.max(0, Math.floor(viewportHeight - top - MARGIN)),
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') return
        // A shortcut with Ctrl/⌘, Alt or a function key (F6, the palette)
        // acts from the button, the popover closed: a dialog it opens gives
        // the focus back there, not to an action that is gone.
        const action = matchShortcut(event.nativeEvent)
        if (action && !isBareShortcut(action)) {
          closeRef.current(true)
          return
        }
        // The other keys are the popover's: a letter, an arrow or Delete must
        // not also act on the list or the conversation behind it.
        if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation()
      }}
    >
      <p id={titleId} className="mb-2 font-semibold">
        {t('connectivity.health.title')}
      </p>
      {/* An action that opens Settings closes the popover first, with the
          focus on the button, which Settings gives it back to. */}
      <ConnectivityDetail summary={summary} onOpenSettings={() => closeRef.current(true)} />
    </div>
  )
}
