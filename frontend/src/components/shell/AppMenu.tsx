import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Check, Menu } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { formatShortcut, isBareShortcut, isMac, matchShortcut } from '../../lib/shortcuts'
import { menuLeft, startEdgeX } from '../../lib/direction'
import { focusMenuEdge } from '../../lib/menuKeyboard'
import { IconButton } from '../button/IconButton'
import { MenuGroup, MenuList } from '../menu/Menu'
import { MenuItem } from '../menu/MenuItem'
import { menuItemCurrentClass } from '../menu/menuStyles'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { useCommandList } from '../palette/useCommandList'
import { groupCommandsByArea, type Command } from '../palette/paletteCommands'

/** Kept between the menu and the window's edges, in CSS px. */
const MARGIN = 8
/** The menu's width, in rem, so it grows with the app's zoom; never wider than the window. */
const WIDTH_REM = 20

type Anchor = { x: number; y: number }
/** The item the focus starts on. */
type Edge = 'first' | 'last'

/**
 * The «Menú de l'aplicació» button at the start of the top band (ADR-0068 §2).
 * Enter, Space or Down opens the menu with the focus on its first item, and Up
 * on its last; Escape closes it and gives the focus back to the button.
 */
export function AppMenuButton() {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [edge, setEdge] = useState<Edge>('first')
  const button = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const label = t('appMenu.label')

  const open = (from: Edge = 'first') => {
    const trigger = button.current
    if (!trigger) return
    // The menu gives the focus back to what had it when it opened: make that
    // the button, also where a click does not focus one (WebKit).
    trigger.focus({ preventScroll: true })
    const rect = trigger.getBoundingClientRect()
    // Its inline-start edge goes to the button's, so it opens towards the
    // end of the line: rightwards, or leftwards in right to left.
    setAnchor({ x: startEdgeX(rect), y: rect.bottom })
    setEdge(from)
  }
  const close = () => setAnchor(null)

  return (
    <>
      <IconButton
        ref={button}
        icon={Menu}
        iconSize={18}
        label={label}
        size="md"
        radius="lg"
        active={anchor !== null}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? menuId : undefined}
        onClick={() => (anchor ? close() : open())}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return
          // The keys the button answers end here: the app's arrows would also
          // step the conversation list or the board behind it (AppHotkeys).
          // Enter and Space click it.
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation()
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          event.stopPropagation()
          if (!anchor) open(event.key === 'ArrowDown' ? 'first' : 'last')
        }}
      />
      {anchor && <AppMenu id={menuId} label={label} anchor={anchor} edge={edge} opener={button} onClose={close} />}
    </>
  )
}

/**
 * The app menu: every command of the palette (`useCommandList`, the one
 * list), grouped by area with a title per group, which takes in what the
 * rail's More menu offers. A command that shows a state (the module on
 * screen, the theme, a filter) is a radio item.
 */
function AppMenu({
  id,
  label,
  anchor,
  edge,
  opener,
  onClose,
}: {
  id: string
  label: string
  anchor: Anchor
  edge: Edge
  opener: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const groups = groupCommandsByArea(useCommandList())
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const inside = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node && (!!document.getElementById(id)?.contains(target) || !!opener.current?.contains(target)),
    [id, opener],
  )
  // A click or scroll outside, a resize and Escape close it.
  useDismissOnOutside(true, inside, onClose)
  // So does the focus going elsewhere (F6, a click in the page).
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) closeRef.current()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [inside])
  // A shortcut pressed in the menu acts from the button, the menu closed: a
  // dialog it opens (the palette with Ctrl/⌘+K, Settings) gives the focus back
  // to the button, not to an item that is gone. It runs before AppHotkeys,
  // which listens on the window. A shortcut with no Ctrl/⌘, Alt or function
  // key is left alone: in the menu, a letter finds an item.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!inside(event.target) || event.target === opener.current) return
      const action = matchShortcut(event)
      if (!action || isBareShortcut(action)) return
      opener.current?.focus({ preventScroll: true })
      closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [inside, opener])
  // Opened with Up, it starts on the last item. MenuList's own layout effect,
  // which runs first, has put the focus on the first. Neither the edge nor
  // the id changes while the menu is open.
  useLayoutEffect(() => {
    if (edge === 'last') focusMenuEdge(document.getElementById(id), 'last')
  }, [edge, id])

  const run = (command: Command) => {
    // Back on the button first, as the palette does: a dialog the command
    // opens gives the focus back there, and a command that moves the focus
    // (to the search, to the reply) takes it from there.
    opener.current?.focus({ preventScroll: true })
    onClose()
    command.run()
  }

  // Anchors are visual pixels; fixed positions use CSS pixels under a root zoom.
  const rootStyle = getComputedStyle(document.documentElement)
  const zoom = parseFloat(rootStyle.zoom) || 1
  const viewportWidth = window.innerWidth / zoom
  const viewportHeight = window.innerHeight / zoom
  const width = Math.floor(
    Math.max(0, Math.min(WIDTH_REM * (parseFloat(rootStyle.fontSize) || 16), viewportWidth - 2 * MARGIN)),
  )
  // Whole pixels: a scrollport of a fractional height scrolls a whole number
  // of them, and would leave the last row half a pixel short.
  const top = Math.ceil(anchor.y / zoom + 4)

  return (
    <MenuList
      id={id}
      label={label}
      autoFocus
      tabStop
      onClose={onClose}
      className="fixed z-[61] overflow-y-auto rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in text-primary"
      style={{
        width,
        top,
        left: menuLeft(anchor.x / zoom, width, viewportWidth, MARGIN),
        maxHeight: Math.max(0, Math.floor(viewportHeight - top - MARGIN)),
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {groups.map((group, index) => (
        <MenuGroup key={group.area} label={t(`appMenu.area.${group.area}`)} separated={index > 0}>
          {group.commands.map((command) => (
            <CommandItem key={command.id} command={command} onRun={run} />
          ))}
        </MenuGroup>
      ))}
    </MenuList>
  )
}

function CommandItem({ command, onRun }: { command: Command; onRun: (command: Command) => void }) {
  const reasonId = useId()
  // Why it cannot run (a read-only account), as the palette says it.
  const reason = command.disabled ? command.hint : undefined
  const icon = (
    <span aria-hidden="true" className="flex w-4 shrink-0 justify-center text-secondary">
      {command.icon}
    </span>
  )
  // The chord is learnable from the menu; the name stays the command's own.
  const trailing =
    command.shortcut || command.active ? (
      <span aria-hidden="true" className="flex items-center gap-2">
        {command.shortcut && (
          <kbd className="text-2xs font-normal text-secondary">
            {formatShortcut(command.shortcut).join(isMac ? '' : '+')}
          </kbd>
        )}
        {command.active && <Check size={14} strokeWidth={1.75} className="text-accent-fg" />}
      </span>
    ) : undefined
  const shared = {
    icon,
    label: command.label,
    trailing,
    disabled: command.disabled,
    // The tooltip for the pointer; the description for the keyboard and
    // assistive technology, which a tooltip does not reach.
    title: reason,
    describedBy: reason ? reasonId : undefined,
    onClick: () => onRun(command),
  }
  const item =
    command.active === undefined ? (
      <MenuItem {...shared} />
    ) : (
      <MenuItem
        {...shared}
        role="menuitemradio"
        checked={command.active}
        appearance={command.active ? menuItemCurrentClass : undefined}
      />
    )
  if (!reason) return item
  return (
    <>
      {item}
      <span id={reasonId} role="none" className="sr-only">
        {reason}
      </span>
    </>
  )
}
