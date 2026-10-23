import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Focus lifecycle only: this does not trap Tab or isolate the background. */
export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>) {
  const openerRef = useRef(typeof document === 'undefined' ? null : document.activeElement)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.contains(document.activeElement)) dialog.focus()
    return () => {
      // The dialog's focus is the one in it, and the one that fell out of it
      // to the body: a control that disabled itself while it worked (Settings'
      // «Restore») or that went. Both go back to the opener, as menus do
      // (useMenuFocus). Focus that another surface took stays there.
      const active = document.activeElement
      const ownedFocus = !active || active === document.body || !active.isConnected || dialog.contains(active)
      const opener = openerRef.current
      queueMicrotask(() => {
        if (dialog.isConnected || !ownedFocus) return
        if (document.activeElement !== document.body && !dialog.contains(document.activeElement)) return
        if (!(opener instanceof HTMLElement) || !opener.isConnected || opener.matches(':disabled')) return
        if (opener.closest('[hidden], [inert], [aria-hidden="true"]')) return
        opener.focus({ preventScroll: true })
      })
    }
  }, [dialogRef])
}
