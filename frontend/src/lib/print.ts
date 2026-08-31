// Putting a conversation on paper.
//
// The document is printed from an iframe of its own rather than by printing
// the app's window: the window is a mail client — panes, lists, a side
// navigation — and none of that belongs on the page. The iframe holds only the
// conversation, so what comes out is what was asked for.

import { buildPrintDocument } from './printDocument'
import type { Message } from '../types'

/**
 * Prints a conversation.
 *
 * Resolves once the print dialog has been asked for, not once anything has
 * been printed: what the reader does with the dialog is theirs, and no part of
 * it comes back to us.
 */
export function printConversation(args: {
  subject: string
  messages: Message[]
  printedLabel: string
  toLabel: string
  ccLabel: string
  attachmentsLabel: string
}): Promise<void> {
  const html = buildPrintDocument({ ...args, printedAt: new Date() })

  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    // Off-screen rather than `display: none`: a frame that was never laid out
    // has no pages to print.
    frame.setAttribute('aria-hidden', 'true')
    frame.style.position = 'fixed'
    frame.style.right = '100%'
    frame.style.bottom = '100%'
    frame.style.width = '210mm'
    frame.style.height = '297mm'
    frame.style.border = '0'

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      // After the dialog, not during: removing the frame while the engine is
      // still reading it loses the print.
      window.setTimeout(() => frame.remove(), 1000)
      resolve()
    }

    frame.onload = () => {
      const view = frame.contentWindow
      if (!view) {
        finish()
        return
      }
      try {
        view.focus()
        view.print()
      } catch {
        // A refusal to open the dialog is not a reason to leave a stray frame
        // in the document.
      }
      finish()
    }

    document.body.appendChild(frame)
    frame.srcdoc = html
  })
}
