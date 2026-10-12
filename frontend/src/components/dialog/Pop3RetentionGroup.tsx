import { useEffect, useState } from 'react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { confirmAction, showToast } from '../../states/ui'
import { SettingsGroup } from './AccountSettingsRows'

type Retention = { policy: 'keep' } | { policy: 'afterDays'; days: number } | { policy: 'whenDeletedHere' }

/**
 * When a POP3 account deletes mail from its server (#97, ADR-0035). Keeping
 * it there is the default; anything else is asked first, and the copy here
 * is never deleted by it.
 */
export function Pop3RetentionGroup({ accountId }: { accountId: string }) {
  const { t } = useTranslation()
  const [retention, setRetention] = useState<Retention | null>(null)

  useEffect(() => {
    void invoke<Retention>('pop3.retention', { account: accountId }).then(setRetention, () => setRetention(null))
  }, [accountId])

  if (!retention) return null

  const save = async (next: Retention) => {
    if (next.policy !== 'keep') {
      const ok = await confirmAction({
        title: t('pop3.deleteTitle', { defaultValue: 'Delete mail from the server?' }),
        message:
          next.policy === 'afterDays'
            ? t('pop3.deleteAfterMessage', {
                days: next.days,
                defaultValue:
                  'Messages downloaded here will be deleted from the server {days} days later. Other devices using this mailbox will no longer see them. The copies here stay.',
              })
            : t('pop3.deleteHereMessage', {
                defaultValue:
                  'A message you delete here (or move to Trash) will also be deleted from the server at the next check. Other devices will no longer see it.',
              }),
        confirmLabel: t('pop3.deleteConfirm', { defaultValue: 'Delete from the server' }),
        cancelLabel: t('buttons.cancel'),
      })
      if (!ok) return
    }
    try {
      setRetention(await invoke<Retention>('pop3.retention', { account: accountId, retention: next }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const days = retention.policy === 'afterDays' ? retention.days : 14
  return (
    <SettingsGroup title={t('pop3.title', { defaultValue: 'Mail on the POP3 server' })}>
      <div className="flex flex-col gap-2 px-3.5 py-3 text-caption">
        <label className="flex flex-wrap items-center gap-2 text-secondary">
          {t('pop3.policy', { defaultValue: 'After downloading' })}
          <select
            value={retention.policy}
            onChange={(e) => {
              const policy = e.target.value
              void save(
                policy === 'afterDays'
                  ? { policy: 'afterDays', days }
                  : policy === 'whenDeletedHere'
                    ? { policy: 'whenDeletedHere' }
                    : { policy: 'keep' },
              )
            }}
            className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
          >
            <option value="keep">{t('pop3.keep', { defaultValue: 'Keep it on the server' })}</option>
            <option value="afterDays">
              {t('pop3.afterDays', { defaultValue: 'Delete from the server after some days' })}
            </option>
            <option value="whenDeletedHere">
              {t('pop3.whenDeletedHere', { defaultValue: 'Delete from the server when deleted here' })}
            </option>
          </select>
          {retention.policy === 'afterDays' && (
            <input
              type="number"
              min={1}
              aria-label={t('pop3.days', { defaultValue: 'Days' })}
              defaultValue={retention.days}
              onBlur={(e) => {
                const value = Math.max(1, Number(e.target.value) || 1)
                if (value !== retention.days) void save({ policy: 'afterDays', days: value })
              }}
              className="w-16 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
            />
          )}
        </label>
        <p className="text-secondary">
          {t('pop3.hint', {
            defaultValue:
              'Messages are only ever deleted from the server when the session ends cleanly; a broken connection deletes nothing. Copies here are not affected.',
          })}
        </p>
      </div>
    </SettingsGroup>
  )
}
