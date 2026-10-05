import { AlertCircle, Check, Info } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { ui$, runToastUndo } from '../../states/ui'

// The floating status toast, with an optional Undo action. Reads its state
// directly from ui$ and renders nothing when there's no active toast.
export function AppToast() {
  const toast = useValue(ui$.toast)
  const toastTone = useValue(ui$.toastTone)
  const toastUndo = useValue(ui$.toastUndo)

  if (!toast) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 animate-slide-up flex w-max max-w-[calc(100%-2rem)] items-center gap-2 rounded-control border border-border bg-chats py-2 pl-4 text-xs font-semibold text-primary shadow-overlay z-50 ${
        toastUndo ? 'pr-2' : 'pr-4'
      }`}
    >
      {toastTone === 'error' ? (
        <AlertCircle size={14} aria-hidden="true" className="shrink-0 text-danger" strokeWidth={1.75} />
      ) : toastTone === 'info' ? (
        <Info size={14} aria-hidden="true" className="shrink-0 text-info" strokeWidth={1.75} />
      ) : (
        <Check size={14} aria-hidden="true" className="shrink-0 text-success" strokeWidth={1.75} />
      )}
      <span className="min-w-0 wrap-anywhere">{toast}</span>
      {toastUndo && (
        <button
          onClick={runToastUndo}
          className="ml-1 shrink-0 rounded-control-sm bg-hover px-2.5 py-1 font-bold text-primary hover:bg-active transition-colors cursor-pointer"
        >
          Undo
        </button>
      )}
    </div>
  )
}
