import { useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { ui$ } from '../../states/ui'
import { fetchChangelog, type ChangelogRelease } from '../../lib/changelog'
import { Button } from '../button/Button'
import { EmptyState } from '../empty-state/EmptyState'
import { ErrorState, LoadingState } from '../empty-state/StateViews'
import { Dialog } from './Dialog'

function formatDate(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ChangelogDialog() {
  const { t } = useTranslation()
  const open = useValue(ui$.changelogOpen)
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const onClose = () => ui$.changelogOpen.set(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setReleases(null)
    setError(false)
    fetchChangelog()
      .then((items) => {
        if (!cancelled) setReleases(items)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, attempt])

  if (!open) return null

  return (
    <Dialog
      title={t('changelog.title')}
      icon={ScrollText}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('buttons.close')}
        </Button>
      }
    >
      {/* The three ways a list can be missing, each said as itself: still
          coming is not the same as nothing, and nothing is not the same as
          could not be fetched. */}
      {error ? (
        <div className="h-48">
          <ErrorState title={t('changelog.error')} retryLabel={t('buttons.retry')} onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      ) : releases === null ? (
        <div className="h-48">
          <LoadingState title={t('changelog.loading')} />
        </div>
      ) : releases.length === 0 ? (
        <div className="h-48">
          <EmptyState title={t('changelog.empty')} text="" />
        </div>
      ) : (
        <ol className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
          {releases.map((release) => (
            <li key={release.tag}>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-base font-bold tracking-tight">{release.version}</h3>
                <span className="text-xs font-semibold text-secondary tabular-nums">{formatDate(release.date)}</span>
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-secondary">
                {release.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  )
}
