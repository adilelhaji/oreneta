import { useEffect, useState } from 'react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { confirmAction, showToast } from '../../states/ui'
import { Button } from '../button/Button'
import { SettingsGroup } from './AccountSettingsRows'

type ListInfo = { title: string; version: string; rules: number; source: 'bundled' | 'updated' }

/**
 * Tracking protection (#107, ADR-0029): which EasyPrivacy list is in use,
 * and a way to fetch a newer one, which only happens when asked.
 */
export function TrackingProtectionGroup() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<ListInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void invoke<ListInfo>('privacy.info', {}).then(setInfo, () => setInfo(null))
  }, [])

  const run = async (command: 'privacy.update' | 'privacy.reset') => {
    if (command === 'privacy.update') {
      const ok = await confirmAction({
        title: t('trackingList.updateTitle', { defaultValue: 'Fetch the current EasyPrivacy list?' }),
        message: t('trackingList.updateMessage', {
          defaultValue:
            'Oreneta will download it from easylist.to and check it before using it. Nothing else is sent. If anything is wrong with it, the list in use stays.',
        }),
        confirmLabel: t('trackingList.updateConfirm', { defaultValue: 'Fetch it' }),
        cancelLabel: t('buttons.cancel'),
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      setInfo(await invoke<ListInfo>(command, {}))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('trackingList.title', { defaultValue: 'Tracking protection' })}>
      <div className="flex flex-col gap-2 px-3.5 py-3 text-caption">
        <p className="text-secondary">
          {t('trackingList.hint', {
            defaultValue:
              'Images and styles that a message would load from known trackers are never requested, and the message says how many. Links are left as they are.',
          })}
        </p>
        {info && (
          <p className="text-primary">
            {info.source === 'bundled'
              ? t('trackingList.bundled', {
                  title: info.title,
                  version: info.version,
                  rules: info.rules,
                  defaultValue: '{title} {version}, included with Oreneta ({rules} rules)',
                })
              : t('trackingList.updated', {
                  title: info.title,
                  version: info.version,
                  rules: info.rules,
                  defaultValue: '{title} {version}, fetched on request ({rules} rules)',
                })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('privacy.update')}>
            {t('trackingList.update', { defaultValue: 'Fetch the current list' })}
          </Button>
          {info?.source === 'updated' && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('privacy.reset')}>
              {t('trackingList.reset', { defaultValue: 'Use the included list' })}
            </Button>
          )}
        </div>
      </div>
    </SettingsGroup>
  )
}
