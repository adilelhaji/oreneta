import { useEffect, useState } from 'react'
import { observer } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { showToast } from '../../states/ui'
import {
  backupSchedule$,
  loadBackupSchedule,
  runBackupNow,
  saveBackupSchedule,
  type BackupSchedule,
} from '../../states/backupSchedule'
import { formatFileSize } from '../chat/messageHelpers'
import { SettingsGroup } from './AccountSettingsRows'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const when = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toLocaleString() : '')

/**
 * Scheduled backups of the whole profile (#173, ADR-0037): off until turned
 * on, each one checked before it counts, and the newest good one never
 * removed by the limits.
 */
export const BackupScheduleGroup = observer(function BackupScheduleGroup() {
  const { t } = useTranslation()
  const status = backupSchedule$.get()
  const [draft, setDraft] = useState<BackupSchedule | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadBackupSchedule().catch(() => {})
  }, [])
  useEffect(() => {
    if (status && !draft) setDraft(status.schedule)
  }, [status, draft])

  if (!status || !draft) return null

  const passwordError =
    password && password.length < 8
      ? t('backupSchedule.passwordShort', { defaultValue: 'At least 8 characters.' })
      : password && password !== confirm
        ? t('backupSchedule.passwordMismatch', { defaultValue: 'The passwords do not match.' })
        : ''
  const needsPassword = draft.enabled && !status.password_saved && !password
  const changed = JSON.stringify(draft) !== JSON.stringify(status.schedule) || !!password

  const save = async () => {
    setBusy(true)
    try {
      await saveBackupSchedule(draft, password || undefined)
      setPassword('')
      setConfirm('')
      setDraft(null)
    } catch (error) {
      showToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const pickFolder = async () => {
    try {
      const picked = await invoke<{ path?: string; cancelled?: boolean }>('backupSchedule.pickFolder', {})
      if (picked?.path) setDraft({ ...draft, folder: picked.path })
    } catch (error) {
      showToast(errorText(error), 'error')
    }
  }

  const runNow = async () => {
    try {
      await runBackupNow()
      showToast(t('backupSchedule.done', { defaultValue: 'Backup written and checked.' }), 'success')
    } catch (error) {
      showToast(errorText(error), 'error')
    }
  }

  const input = 'rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary'
  const button =
    'px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const limitMb = draft.max_bytes ? Math.round(draft.max_bytes / (1024 * 1024)) : ''

  return (
    <SettingsGroup title={t('backupSchedule.title', { defaultValue: 'Scheduled backups' })}>
      <div className="flex flex-col gap-3 px-3.5 py-3 text-caption">
        <p className="text-secondary">
          {t('backupSchedule.hint', {
            defaultValue:
              'The whole profile, encrypted, written to a folder you choose and checked before it counts. The newest good backup is never removed. Oreneta has to be open for a backup to run; one missed while it was closed runs soon after it opens.',
          })}
        </p>
        <label className="flex items-center gap-2 text-primary">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          {t('backupSchedule.enabled', { defaultValue: 'Back up the profile on a schedule' })}
        </label>
        <div className="flex flex-wrap items-center gap-2 text-secondary">
          <span>{t('backupSchedule.folder', { defaultValue: 'Folder' })}</span>
          <span className="min-w-0 flex-1 truncate text-primary" title={draft.folder}>
            {draft.folder || t('backupSchedule.noFolder', { defaultValue: 'None chosen' })}
          </span>
          <button type="button" className={button} onClick={() => void pickFolder()}>
            {t('backupSchedule.chooseFolder', { defaultValue: 'Choose…' })}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-secondary">
          <label className="flex items-center gap-2">
            {t('backupSchedule.every', { defaultValue: 'Every' })}
            <select
              value={draft.every_hours}
              onChange={(e) => setDraft({ ...draft, every_hours: Number(e.target.value) })}
              className={input}
            >
              <option value={24}>{t('backupSchedule.daily', { defaultValue: 'day' })}</option>
              <option value={168}>{t('backupSchedule.weekly', { defaultValue: 'week' })}</option>
              {![24, 168].includes(draft.every_hours) && (
                <option value={draft.every_hours}>
                  {t('backupSchedule.hours', { hours: draft.every_hours, defaultValue: '{hours} hours' })}
                </option>
              )}
            </select>
          </label>
          <label className="flex items-center gap-2">
            {t('backupSchedule.keep', { defaultValue: 'Keep' })}
            <input
              type="number"
              min={1}
              max={30}
              value={draft.keep}
              onChange={(e) => setDraft({ ...draft, keep: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })}
              className={`${input} w-16`}
            />
          </label>
          <label className="flex items-center gap-2">
            {t('backupSchedule.limit', { defaultValue: 'Space limit (MB, empty for none)' })}
            <input
              type="number"
              min={1}
              value={limitMb}
              onChange={(e) => {
                const mb = Number(e.target.value)
                setDraft({ ...draft, max_bytes: mb > 0 ? Math.round(mb * 1024 * 1024) : null })
              }}
              className={`${input} w-24`}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-secondary">
          <span>
            {status.password_saved
              ? t('backupSchedule.passwordSaved', {
                  defaultValue: 'Password saved in the system keychain. Type a new one to change it.',
                })
              : t('backupSchedule.passwordNeeded', {
                  defaultValue: 'Choose a password. Without it a backup cannot be opened, so keep it somewhere safe.',
                })}
          </span>
          <input
            type="password"
            aria-label={t('backupSchedule.password', { defaultValue: 'Backup password' })}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
            autoComplete="new-password"
          />
          <input
            type="password"
            aria-label={t('backupSchedule.confirmPassword', { defaultValue: 'Confirm the backup password' })}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={input}
            autoComplete="new-password"
          />
        </div>
        {passwordError && <p className="text-danger">{passwordError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={button}
            disabled={busy || !changed || !!passwordError || needsPassword || (draft.enabled && !draft.folder)}
            onClick={() => void save()}
          >
            {t('buttons.save')}
          </button>
          <button
            type="button"
            className={button}
            disabled={status.running || changed || !status.schedule.folder || !status.password_saved}
            onClick={() => void runNow()}
          >
            {status.running
              ? t('backupSchedule.running', { defaultValue: 'Backing up…' })
              : t('backupSchedule.runNow', { defaultValue: 'Back up now' })}
          </button>
        </div>
        <div role="status" className="flex flex-col gap-1 text-secondary">
          {status.last_success && (
            <span>
              {t('backupSchedule.lastGood', {
                when: when(status.last_success),
                defaultValue: 'Last good backup: {when}',
              })}
            </span>
          )}
          {status.last_error && (status.last_attempt ?? 0) > (status.last_success ?? 0) && (
            <span className="text-danger">
              {t('backupSchedule.lastFailed', {
                when: when(status.last_attempt),
                error: status.last_error,
                defaultValue: 'The backup of {when} failed: {error}. Earlier backups are kept.',
              })}
            </span>
          )}
          {status.next_run !== null && status.schedule.enabled && (
            <span>
              {t('backupSchedule.next', {
                when: when(Math.max(status.next_run, Math.floor(Date.now() / 1000))),
                defaultValue: 'Next: {when}',
              })}
            </span>
          )}
        </div>
        {status.backups.length > 0 && (
          <ul className="flex flex-col gap-0.5" aria-label={t('backupSchedule.kept', { defaultValue: 'Kept backups' })}>
            {status.backups.map((backup) => (
              <li key={backup.path} className="flex items-center gap-2" title={backup.path}>
                <span className="min-w-0 flex-1 truncate text-primary">{when(backup.created_at)}</span>
                <span className="text-secondary">{formatFileSize(backup.bytes)}</span>
                {!backup.present && (
                  <span className="text-danger">{t('backupSchedule.missing', { defaultValue: 'missing' })}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  )
})
