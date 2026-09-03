import { AlertTriangle } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { settleConfirm, ui$ } from '../../states/ui'
import { Button } from '../button/Button'
import { Dialog } from './Dialog'

/**
 * The one question the app asks before doing something it cannot undo.
 *
 * On the top layer, as an alert, with the danger tone on the page before the
 * reader has read a word. Escape and the backdrop both answer "no": the only
 * way to say yes is the button that says what yes does.
 */
export function AppConfirm() {
  const confirm = useValue(ui$.confirm)

  if (!confirm) return null

  const isDanger = confirm.tone === 'danger'

  return (
    <Dialog
      title={confirm.title}
      icon={AlertTriangle}
      iconTone={isDanger ? 'danger' : 'accent'}
      width="sm"
      layer="top"
      role="alertdialog"
      onClose={() => settleConfirm(false)}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => settleConfirm(false)}>
            {confirm.cancelLabel}
          </Button>
          <Button autoFocus variant={isDanger ? 'danger' : 'primary'} size="sm" onClick={() => settleConfirm(true)}>
            {confirm.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-secondary">{confirm.message}</p>
    </Dialog>
  )
}
