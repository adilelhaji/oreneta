import { useState } from 'react'
import { ShieldCheck, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { Button } from '../button/Button'
import { Checkbox } from '../field/Checkbox'
import { TextInput } from '../field/Field'
import { Dialog } from './Dialog'

/**
 * Passphrase prompt shared by both halves of backup/restore.
 *
 * 'export' collects a passphrase (and whether to include account passwords);
 * 'restore' collects the passphrase for a file that turned out to be encrypted.
 * The parent owns the actual call, so this component never touches the bridge.
 */
export type BackupPassphraseMode = 'export' | 'restore'

type Props = {
  mode: BackupPassphraseMode
  busy?: boolean
  /** Shown under the fields, e.g. after a wrong passphrase. */
  error?: string
  onCancel: () => void
  onSubmit: (passphrase: string, includeSecrets: boolean) => void
}

export function BackupPassphraseDialog({ mode, busy = false, error, onCancel, onSubmit }: Props) {
  const { t } = useTranslation()
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(false)

  const exporting = mode === 'export'

  // Exporting: a passphrase is optional unless passwords are included, but once
  // typed it must be confirmed — a typo would produce a file nobody can open.
  // Restoring: whatever the user types is checked against the file immediately,
  // so no confirmation field.
  const mismatched = exporting && passphrase !== confirmation
  const missing = exporting ? includeSecrets && !passphrase : !passphrase
  const canSubmit = !busy && !missing && !mismatched

  const submit = () => {
    if (!canSubmit) return
    onSubmit(passphrase, exporting && includeSecrets)
  }
  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') submit()
  }

  return (
    <Dialog
      title={exporting ? t('settings.backup.exportTitle') : t('settings.backup.restoreTitle')}
      subtitle={exporting ? t('settings.backup.exportSubtitle') : t('settings.backup.restoreSubtitle')}
      icon={ShieldCheck}
      layer="raised"
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {busy && <RefreshCw size={11} className="animate-spin" />}
            <span>{exporting ? t('common.export') : t('settings.backup.restoreAction')}</span>
          </Button>
        </>
      }
    >
      {exporting && (
        <label className="flex cursor-pointer items-start gap-2.5 px-1">
          <Checkbox checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} className="mt-0.5" />
          <span className="min-w-0">
            <span className="block text-xs font-semibold">{t('settings.backup.includeSecrets')}</span>
            <span className="mt-0.5 block text-caption font-medium leading-relaxed text-secondary">
              {t('settings.backup.includeSecretsHint')}
            </span>
          </span>
        </label>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="backup-passphrase" className="px-1 text-caption font-semibold text-secondary">
          {t('settings.backup.passphrase')}
          {exporting && !includeSecrets && <span className="font-medium"> · {t('settings.network.optional')}</span>}
        </label>
        <TextInput
          id="backup-passphrase"
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
          <label htmlFor="backup-passphrase-confirm" className="px-1 text-caption font-semibold text-secondary">
            {t('settings.backup.passphraseConfirm')}
          </label>
          <TextInput
            id="backup-passphrase-confirm"
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
        {exporting ? t('settings.backup.passphraseHint') : t('settings.backup.restoreHint')}
      </p>
      {mismatched && confirmation.length > 0 && (
        <p role="alert" className="px-1 text-caption font-medium text-rose-500">
          {t('settings.backup.passphraseMismatch')}
        </p>
      )}
      {error && (
        <p role="alert" className="px-1 text-caption font-medium text-rose-500">
          {error}
        </p>
      )}
    </Dialog>
  )
}
