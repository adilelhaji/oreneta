import { useEffect, useState } from 'react'
import { Trash2, Wind } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { showToast } from '../../states/ui'
import { sweep, sweepPreview, type SweepPreview } from '../../states/priority'
import { Button } from '../button/Button'
import { SelectInput } from '../field/Field'
import { LoadingState } from '../empty-state/StateViews'
import { Notice } from '../notice/Notice'
import { Dialog } from './Dialog'

const KEEP_CHOICES = [0, 1, 3, 5, 10]

/**
 * Sweeping older mail from one sender.
 *
 * Outlook's Sweep, with the part Outlook leaves out: it says what it would
 * move, by name, before it moves anything. This is the only action in the app
 * that reaches messages the reader is not looking at, and an action like that
 * has to show its work — the same rule the rules follow.
 */
export function SweepDialog({
  accountId,
  folder,
  sender,
  onClose,
}: {
  accountId: string
  folder: string
  sender: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [keepNewest, setKeepNewest] = useState(1)
  const [preview, setPreview] = useState<SweepPreview | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setPreview(null)
    void sweepPreview({ accountId, folder, from: sender, keepNewest })
      .then((result) => {
        if (live) setPreview(result)
      })
      .catch((error) => {
        if (!live) return
        showToast(error instanceof Error ? error.message : t('sweep.failed'), 'error')
        onClose()
      })
    return () => {
      live = false
    }
  }, [accountId, folder, sender, keepNewest])

  const count = preview?.messages.length ?? 0

  return (
    <Dialog
      title={t('sweep.title')}
      subtitle={t('sweep.subtitle', { sender })}
      icon={Wind}
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button
            variant="danger"
            leftIcon={Trash2}
            disabled={busy || count === 0}
            onClick={() => {
              setBusy(true)
              void sweep({ accountId, folder, from: sender, keepNewest })
                .then(onClose)
                .catch((error) => {
                  showToast(error instanceof Error ? error.message : t('sweep.failed'), 'error')
                  setBusy(false)
                })
            }}
          >
            {t('sweep.confirm', { count })}
          </Button>
        </>
      }
    >
      <label className="flex items-center gap-2 text-ui">
        <span className="shrink-0 font-semibold text-secondary">{t('sweep.keep')}</span>
        <SelectInput
          value={String(keepNewest)}
          onChange={(event) => setKeepNewest(Number(event.target.value))}
          className="w-24"
        >
          {KEEP_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </SelectInput>
      </label>

      {preview === null ? (
        <div className="h-40">
          <LoadingState title={t('empty.loadingThreads')} />
        </div>
      ) : count === 0 ? (
        <Notice tone="success">{t('sweep.nothing')}</Notice>
      ) : (
        <>
          {/* Named, not counted. The reader is about to move these and should
              see which they are before it happens. */}
          <Notice tone="warning" title={t('sweep.willMove', { count })}>
            {t('sweep.recount')}
          </Notice>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-control border border-border bg-raised px-3 py-2">
            {preview.messages.map((message) => (
              <li key={message.uid} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-caption text-primary">
                  {message.subject || t('sendLater.noSubject')}
                </span>
                <time className="shrink-0 text-2xs text-secondary tabular-nums">
                  {message.date ? new Date(message.date * 1000).toLocaleDateString() : ''}
                </time>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  )
}
