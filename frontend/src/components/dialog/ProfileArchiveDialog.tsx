import { useState } from 'react'
import { Archive, RefreshCw } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  activateRestore,
  checkProfile,
  closeProfileArchive,
  exportProfile,
  formatBytes,
  prepareRestore,
  profileArchive$,
  type ArchiveSummary,
} from '../../states/profileArchive'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'
import { Dialog } from './Dialog'

const MIN_PASSPHRASE = 8

/**
 * Backing up the whole profile, or checking an archive (ADR-0017). The
 * passphrase is required: the archive holds all mail kept on this computer.
 */
export function ProfileArchiveDialog() {
  const { t } = useTranslation()
  const step = useValue(profileArchive$.step)
  const busy = useValue(profileArchive$.busy)
  const error = useValue(profileArchive$.error)
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  if (!step) return null

  const exporting = step.kind === 'export'
  const tooShort = exporting && [...passphrase].length < MIN_PASSPHRASE
  const mismatched = exporting && passphrase !== confirmation
  const canSubmit = !busy && !!passphrase && !tooShort && !mismatched
  const submit = () => {
    if (!canSubmit) return
    void (exporting
      ? exportProfile(passphrase)
      : step.kind === 'restore'
        ? prepareRestore(passphrase)
        : checkProfile(passphrase))
  }
  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') submit()
  }

  if (step.kind === 'checked' || step.kind === 'ready') {
    const ready = step.kind === 'ready'
    return (
      <Dialog
        title={
          ready
            ? t('profileArchive.readyTitle', { defaultValue: 'Restore this profile?' })
            : t('profileArchive.checkedTitle', { defaultValue: 'The archive is whole' })
        }
        subtitle={step.path}
        icon={Archive}
        layer="raised"
        onClose={closeProfileArchive}
        closeDisabled={busy}
        footer={
          ready ? (
            <>
              <Button variant="ghost" onClick={closeProfileArchive} disabled={busy}>
                {t('buttons.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void activateRestore()} disabled={busy}>
                {busy && <RefreshCw size={14} className="animate-spin" strokeWidth={1.75} />}
                <span>{t('profileArchive.restoreNow', { defaultValue: 'Restore now' })}</span>
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={closeProfileArchive}>
              {t('common.close')}
            </Button>
          )
        }
      >
        <ArchiveDetails summary={step.summary} />
        {ready && (
          <p className="px-1 text-caption font-medium leading-relaxed text-secondary">
            {t('profileArchive.readyHint', {
              defaultValue:
                'The profile in use is set aside, not deleted, until you keep the restored one; you can go back until then. Accounts come back paused: reconnect each one to sync. Scheduled messages are held and not sent on their own.',
            })}
          </p>
        )}
        {error && (
          <p role="alert" className="px-1 text-caption font-medium text-danger">
            {error}
          </p>
        )}
      </Dialog>
    )
  }

  return (
    <Dialog
      title={
        exporting
          ? t('profileArchive.exportTitle', { defaultValue: 'Back up the whole profile' })
          : step.kind === 'restore'
            ? t('profileArchive.restoreTitle', { defaultValue: 'Restore a profile archive' })
            : t('profileArchive.checkTitle', { defaultValue: 'Check a profile archive' })
      }
      subtitle={
        exporting
          ? t('profileArchive.exportSubtitle', {
              defaultValue: 'Mail kept on this computer, drafts, contacts, tasks, notes, settings and pictures.',
            })
          : step.path
      }
      icon={Archive}
      layer="raised"
      onClose={closeProfileArchive}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={closeProfileArchive} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {busy && <RefreshCw size={14} className="animate-spin" strokeWidth={1.75} />}
            <span>
              {exporting
                ? t('profileArchive.exportAction', { defaultValue: 'Choose where to save' })
                : step.kind === 'restore'
                  ? t('profileArchive.prepareAction', { defaultValue: 'Check and continue' })
                  : t('profileArchive.checkAction', { defaultValue: 'Check' })}
            </span>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="profile-archive-passphrase" className="px-1 text-caption font-semibold text-secondary">
          {t('settings.backup.passphrase')}
        </label>
        <TextInput
          id="profile-archive-passphrase"
          autoFocus
          type="password"
          fieldSize="lg"
          surface="hover"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={onEnter}
        />
      </div>
      {exporting && (
        <div className="flex flex-col gap-2">
          <label htmlFor="profile-archive-confirm" className="px-1 text-caption font-semibold text-secondary">
            {t('settings.backup.passphraseConfirm')}
          </label>
          <TextInput
            id="profile-archive-confirm"
            type="password"
            fieldSize="lg"
            surface="hover"
            value={confirmation}
            invalid={mismatched && confirmation.length > 0}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={onEnter}
          />
        </div>
      )}
      <p className="px-1 text-caption font-medium leading-relaxed text-secondary">
        {exporting
          ? t('profileArchive.passphraseHint', {
              defaultValue:
                'At least 8 characters. Without it the archive cannot be opened; it is not kept anywhere. Passwords are not included: each account is reconnected after a restore.',
            })
          : t('profileArchive.checkHint', {
              defaultValue: 'The archive is opened in a private folder and checked; the profile in use is not touched.',
            })}
      </p>
      {exporting && passphrase.length > 0 && tooShort && (
        <p role="alert" className="px-1 text-caption font-medium text-danger">
          {t('profileArchive.tooShort', { defaultValue: 'Use at least 8 characters.' })}
        </p>
      )}
      {mismatched && confirmation.length > 0 && !tooShort && (
        <p role="alert" className="px-1 text-caption font-medium text-danger">
          {t('settings.backup.passphraseMismatch')}
        </p>
      )}
      {error && (
        <p role="alert" className="px-1 text-caption font-medium text-danger">
          {error}
        </p>
      )}
    </Dialog>
  )
}

function ArchiveDetails({ summary }: { summary: ArchiveSummary }) {
  const { t } = useTranslation()
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-1 text-caption">
        <dt className="text-secondary">{t('profileArchive.made', { defaultValue: 'Made' })}</dt>
        <dd className="text-primary">
          {new Date(summary.created_at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          {summary.app_version && ` · Oreneta ${summary.app_version}`}
        </dd>
        <dt className="text-secondary">{t('profileArchive.contents', { defaultValue: 'Contents' })}</dt>
        <dd className="text-primary">
          {t('profileArchive.counts', {
            accounts: summary.accounts,
            messages: summary.messages,
            size: formatBytes(summary.bytes),
            defaultValue: '{accounts} accounts, {messages} messages, {size}',
          })}
        </dd>
      </dl>
      <div className="px-1 text-caption">
        <p className="font-semibold text-secondary">
          {t('profileArchive.leftOut', { defaultValue: 'Not in the archive' })}
        </p>
        <ul className="mt-1 list-disc pl-5 text-secondary">
          {summary.excluded.map((item) => (
            <li key={item.what}>
              <span className="text-primary">{item.what}</span>: {item.why}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
