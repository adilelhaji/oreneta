import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Focus lifecycle only: this does not trap Tab or isolate the background. */
export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>) {
  const openerRef = useRef(typeof document === 'undefined' ? null : document.activeElement)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.contains(document.activeElement)) dialog.focus()
    return () => {
      const ownedFocus = dialog.contains(document.activeElement)
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
