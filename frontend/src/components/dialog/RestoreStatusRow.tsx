import { useEffect } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { keepRestoredProfile, loadRestoreState, profileArchive$, undoRestore } from '../../states/profileArchive'
import { confirmAction } from '../../states/ui'

const action =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors'

/** While a restored profile is in use, the previous one waits aside (#172). */
export function RestoreStatusRow() {
  const { t } = useTranslation()
  const state = useValue(profileArchive$.restoreState)
  useEffect(() => {
    void loadRestoreState()
  }, [])
  if (state !== 'activated') return null

  const keep = async () => {
    const confirmed = await confirmAction({
      title: t('profileArchive.keepTitle', { defaultValue: 'Keep the restored profile?' }),
      message: t('profileArchive.keepText', {
        defaultValue: 'The profile that was in use before the restore is deleted. This cannot be undone.',
      }),
      confirmLabel: t('profileArchive.keepAction', { defaultValue: 'Keep it' }),
      tone: 'danger',
    })
    if (confirmed) await keepRestoredProfile()
  }

  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 bg-warning-soft px-3.5 py-2">
      <span className="text-xs text-primary">
        {t('profileArchive.activeNotice', {
          defaultValue: 'A restored profile is in use. The previous one is kept until you decide.',
        })}
      </span>
      <span className="flex gap-1.5">
        <button type="button" className={action} onClick={() => void undoRestore()}>
          {t('profileArchive.goBack', { defaultValue: 'Go back' })}
        </button>
        <button type="button" className={action} onClick={() => void keep()}>
          {t('profileArchive.keepAction', { defaultValue: 'Keep it' })}
        </button>
      </span>
    </div>
  )
}
