import { Send } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

/// Asks whether the people on a meeting should be told.
///
/// Always asked, never remembered: sending mail to other people is not a
/// preference to be inferred from what was chosen last time, and the whole
/// point of the question is that the reader knows a message is about to leave.
export function NotifyAsk({
  action,
  people,
  onChoose,
  onCancel,
}: {
  action: 'save' | 'delete'
  people: string[]
  onChoose: (notify: boolean) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog
      title={
        action === 'delete'
          ? t('calendar.notifyCancelTitle', { defaultValue: 'Cancel this meeting?' })
          : t('calendar.notifyTitle', { defaultValue: 'Tell the people on it?' })
      }
      subtitle={
        action === 'delete'
          ? t('calendar.notifyCancelHint', { defaultValue: 'A cancellation can be sent to everyone on the meeting.' })
          : t('calendar.notifyHint', { defaultValue: 'An invitation can be sent to everyone on the meeting.' })
      }
      icon={Send}
      width="sm"
      layer="raised"
      role="alertdialog"
      onClose={onCancel}
      footer={
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('calendar.cancel', { defaultValue: 'Cancel' })}
        </Button>
      }
    >
      {/* Named, not counted: the reader is about to mail these people and
          should see who they are before it happens. */}
      <ul className="max-h-32 overflow-y-auto rounded-control bg-raised px-3 py-2">
        {people.map((person) => (
          <li key={person} className="truncate text-caption text-primary">
            {person}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Button onClick={() => onChoose(true)}>
          {action === 'delete'
            ? t('calendar.notifySendCancel', { defaultValue: 'Send a cancellation' })
            : t('calendar.notifySend', { defaultValue: 'Send it' })}
        </Button>
        <Button variant="secondary" onClick={() => onChoose(false)}>
          {t('calendar.notifySilent', { defaultValue: 'Save without telling anyone' })}
        </Button>
      </div>
    </Dialog>
  )
}
