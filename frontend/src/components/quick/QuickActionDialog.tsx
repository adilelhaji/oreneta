import { Zap } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clearBulkSelection } from '../../states/ui'
import { closeQuickRun, confirmQuickAction, failedRows, quickRun$, type QuickStep } from '../../states/quickActions'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

export function useStepLabel() {
  const { t } = useTranslation()
  return (step: QuickStep) =>
    ({
      markRead: t('quick.markRead', { defaultValue: 'Mark as read' }),
      markUnread: t('quick.markUnread', { defaultValue: 'Mark as unread' }),
      star: t('quick.star', { defaultValue: 'Star' }),
      unstar: t('quick.unstar', { defaultValue: 'Remove the star' }),
      archive: t('quick.archive', { defaultValue: 'Archive' }),
      move: t('quick.move', { folder: step.folder ?? '', defaultValue: 'Move to {folder}' }),
    })[step.kind]
}

/**
 * Confirming and reporting a Quick Action (#92). The conversations are the
 * ones frozen when it was started; what arrives meanwhile is not touched.
 */
export function QuickActionDialog() {
  const { t } = useTranslation()
  const pending = useValue(quickRun$.pending)
  const report = useValue(quickRun$.report)
  const running = useValue(quickRun$.running)
  const error = useValue(quickRun$.error)
  const label = useStepLabel()
  if (!pending && !report) return null

  if (report) {
    const failed = failedRows(report)
    return (
      <Dialog
        title={
          failed.length === 0
            ? t('quick.doneTitle', { name: report.action, defaultValue: '“{name}” is done' })
            : t('quick.partialTitle', { name: report.action, defaultValue: '“{name}” stopped for some conversations' })
        }
        icon={Zap}
        layer="raised"
        onClose={() => {
          closeQuickRun()
          clearBulkSelection()
        }}
        footer={
          <Button
            onClick={() => {
              closeQuickRun()
              clearBulkSelection()
            }}
          >
            {t('common.close')}
          </Button>
        }
      >
        <p className="text-caption text-secondary">
          {t('quick.summary', {
            done: report.rows.length - failed.length,
            total: report.rows.length,
            defaultValue: 'Every step ran for {done} of {total} conversations.',
          })}
        </p>
        {failed.length > 0 && (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto text-caption">
            {failed.map((row) => (
              <li key={row.threadId} className="rounded-control border border-border px-3 py-2">
                <p className="font-semibold text-primary">{row.subject || row.threadId}</p>
                <ul>
                  {row.outcomes.map((outcome, index) => (
                    <li key={index} className={outcome.ok ? 'text-secondary' : 'text-danger'}>
                      {outcome.ok ? '✓' : '✕'} {label({ kind: outcome.kind, folder: report.steps[index]?.folder })}
                      {outcome.reason ? `: ${outcome.reason}` : ''}
                    </li>
                  ))}
                  {row.skipped > 0 && (
                    <li className="text-secondary">
                      {t('quick.notRun', {
                        count: row.skipped,
                        defaultValue: '{count, plural, one {# step} other {# steps}} not run',
                      })}
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    )
  }

  const { action, targets } = pending!
  return (
    <Dialog
      title={t('quick.confirmTitle', { name: action.name, defaultValue: 'Run “{name}”?' })}
      icon={Zap}
      layer="raised"
      onClose={closeQuickRun}
      closeDisabled={running}
      footer={
        <>
          <Button variant="ghost" onClick={closeQuickRun} disabled={running}>
            {t('buttons.cancel')}
          </Button>
          <Button onClick={() => void confirmQuickAction()} disabled={running}>
            {t('quick.run', {
              count: targets.length,
              defaultValue: 'Run on {count, plural, one {# conversation} other {# conversations}}',
            })}
          </Button>
        </>
      }
    >
      <p className="text-caption text-secondary">
        {t('quick.frozen', {
          defaultValue: 'Only the conversations selected now. Mail that arrives while it runs is not touched.',
        })}
      </p>
      <ol className="list-decimal pl-5 text-ui text-primary">
        {action.steps.map((step, index) => (
          <li key={index}>{label(step)}</li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </Dialog>
  )
}
