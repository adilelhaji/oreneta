import { Repeat } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { EditScope } from '../../states/calendar'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'

/// Asks which occurrences an action reaches, for an event that repeats.
///
/// Only asked when it can matter — an event that repeats, and an action that
/// could go either way. Answering for the reader would be guessing at the one
/// thing they alone know, and guessing wrong here changes appointments they
/// did not open.
export function ScopeAsk({
  action,
  onChoose,
  onCancel,
}: {
  action: 'save' | 'delete'
  onChoose: (scope: EditScope) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog
      title={
        action === 'delete'
          ? t('calendar.scopeDeleteTitle', { defaultValue: 'Delete a repeating event' })
          : t('calendar.scopeSaveTitle', { defaultValue: 'Change a repeating event' })
      }
      subtitle={
        action === 'delete'
          ? t('calendar.scopeDeleteHint', { defaultValue: 'This event is one of a series. What should be deleted?' })
          : t('calendar.scopeSaveHint', {
              defaultValue: 'This event is one of a series. What should the change apply to?',
            })
      }
      icon={Repeat}
      width="sm"
      layer="raised"
      onClose={onCancel}
      footer={
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('calendar.cancel', { defaultValue: 'Cancel' })}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <Button variant="secondary" className="justify-start" onClick={() => onChoose('occurrence')}>
          {t('calendar.scopeThisOne', { defaultValue: 'This event only' })}
        </Button>
        <Button variant="secondary" className="justify-start" onClick={() => onChoose('series')}>
          {t('calendar.scopeAll', { defaultValue: 'The whole series' })}
        </Button>
      </div>
    </Dialog>
  )
}
