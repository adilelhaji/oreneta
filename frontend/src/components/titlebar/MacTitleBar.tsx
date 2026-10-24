import type { CSSProperties } from 'react'
import { isMac } from '../../lib/shortcuts'

// With the native macOS title bar hidden (see main.go), content reaches the top
// window edge and the traffic-light buttons float over the top-left corner.
// This slim strip reserves that vertical space and provides the draggable
// region the hidden title bar would normally give us. `--wails-draggable` is
// the Wails hook that makes an element move the window. It takes the top
// band's tone, so the two read as one frame: the module bar colour paints only
// the narrow bar of 769–1024 px (owner decision 4 on #352).
const DRAG: CSSProperties = { '--wails-draggable': 'drag' } as CSSProperties

export function MacTitleBar() {
  if (!isMac) return null
  return <div className="flex h-7 shrink-0 items-center bg-header" style={DRAG} aria-hidden />
}
