import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { clsx } from '../../lib/utils'
import { IconButton } from '../button/IconButton'

type DialogWidth = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

const WIDTHS: Record<DialogWidth, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-3xl',
  '2xl': 'max-w-4xl',
}

/**
 * What the icon box says about the dialog. Accent for the ordinary case;
 * danger for a question whose yes destroys something, so the colour is on the
 * page before the reader has read a word.
 */
type DialogIconTone = 'accent' | 'danger'

const ICON_TONES: Record<DialogIconTone, string> = {
  accent: 'bg-accent/10 text-accent',
  danger: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
}

/**
 * Where a dialog sits among other things that float.
 *
 * `base` is an ordinary dialog. `raised` is one asked from inside another
 * floating surface — the calendar editor asking which occurrences a change
 * reaches — and has to sit above it. `top` is for the prompts that must never
 * be covered by anything: a certificate the app cannot verify, a confirm.
 */
type DialogLayer = 'base' | 'raised' | 'top'

const LAYERS: Record<DialogLayer, string> = {
  base: 'z-50',
  raised: 'z-[70]',
  top: 'z-[120]',
}

/**
 * The one shell every dialog sits in.
 *
 * Six dialogs had each copied the same backdrop, card, header and close
 * button, and each had drifted a little: a different blur, a different radius,
 * one without a role, one that could not be closed by clicking outside. This is
 * that markup once, with the accessibility that was missing from most of them
 * — a dialog role, a labelled title, Escape to close — so a dialog is
 * correct by being one rather than by remembering to be.
 */
export function Dialog({
  title,
  subtitle,
  icon: Icon,
  iconTone = 'accent',
  width = 'md',
  layer = 'base',
  role = 'dialog',
  onClose,
  closeDisabled = false,
  children,
  footer,
  className,
}: {
  title: string
  subtitle?: ReactNode
  icon?: LucideIcon
  iconTone?: DialogIconTone
  width?: DialogWidth
  layer?: DialogLayer
  /** `alertdialog` for a question that interrupts — a confirm, a certificate. */
  role?: 'dialog' | 'alertdialog'
  onClose: () => void
  /** While something is in flight the dialog stays; the button says so. */
  closeDisabled?: boolean
  children: ReactNode
  /** Actions, right-aligned. Omitted when the body carries its own. */
  footer?: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const titleId = `dialog-${title.replace(/\s+/g, '-').toLowerCase()}`
  useEscapeKey(onClose, !closeDisabled)

  return (
    <div
      className={clsx(
        'fixed inset-0 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[3px] animate-fade-in select-none dark:bg-black/60',
        LAYERS[layer],
      )}
      onMouseDown={(event) => {
        // Only a press on the backdrop itself: a drag that starts inside the
        // card and ends outside must not close it mid-gesture.
        if (event.target === event.currentTarget && !closeDisabled) onClose()
      }}
    >
      <section
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          'flex max-h-full w-full flex-col gap-5 rounded-dialog border border-border bg-chats p-6 text-primary shadow-overlay animate-slide-up',
          WIDTHS[width],
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {Icon && (
              <div className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-panel', ICON_TONES[iconTone])}>
                <Icon size={17} />
              </div>
            )}
            <div className="min-w-0">
              <h2 id={titleId} className="text-title font-bold leading-tight tracking-tight">
                {title}
              </h2>
              {subtitle && <p className="mt-1 truncate text-caption font-medium text-secondary">{subtitle}</p>}
            </div>
          </div>
          <IconButton
            icon={X}
            iconSize={16}
            label={t('buttons.close')}
            radius="xl"
            disabled={closeDisabled}
            onClick={onClose}
          />
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">{children}</div>

        {footer && <footer className="flex flex-wrap items-center justify-end gap-2">{footer}</footer>}
      </section>
    </div>
  )
}
