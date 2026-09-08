import { X, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { ui$ } from '../../states/ui'
import { Field } from '../field/Field'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { useAccountDialog, type AccountDialogController } from './useAccountDialog'
import { dialogClasses, type DialogClasses } from './accountDialogStyles'
import { AccountDialogOAuth } from './AccountDialogOAuth'
import { AccountDialogCustom } from './AccountDialogCustom'
import { AccountDialogEWS } from './AccountDialogEWS'
import { AccountSetupWizard } from './AccountSetupWizard'
import { PROVIDERS } from './providerIcons'
import { CertificateTrustPanel } from './CertificateTrustPanel'

type AccountDialogProps = {
  variant?: 'dialog' | 'setup'
}

export function AccountDialog({ variant = 'dialog' }: AccountDialogProps) {
  const { t } = useTranslation()
  const isSetup = variant === 'setup'
  const ctl = useAccountDialog()
  const { mode } = ctl
  // Both reuse the existing-account layout (no provider rail); only the wording
  // differs — see `editing` in useAccountDialog.
  const reconnecting = !!ctl.reconnectAccount
  const classes = dialogClasses(isSetup)

  // OAuth providers sign in *and* save in one step (pollProfile saves the account
  // and closes the dialog on success), so the standalone "Save Account" button is
  // never reachable for them — the in-form sign-in button is the only CTA. Manual
  // setups (IMAP, RSS) still need the explicit Save button.
  const isOAuth = mode === 'gmail' || mode === 'outlook'

  const onClose = () => {
    if (isSetup || ctl.loading) return
    ctl.stopOAuth()
    ui$.reconnectAccountId.set('')
    ui$.setupOpen.set(false)
  }

  // Esc closes the layered add-account dialog. The full-screen onboarding setup
  // variant has no close affordance, so it ignores Esc.
  useEscapeKey(onClose, !isSetup)

  if (!reconnecting) {
    return (
      <AccountSetupWizard
        ctl={ctl}
        isSetup={isSetup}
        onClose={onClose}
        form={
          isOAuth ? (
            <AccountDialogOAuth ctl={ctl} isSetup={isSetup} provider={mode as 'gmail' | 'outlook'} />
          ) : (
            <AccountDialogForm ctl={ctl} classes={classes} isSetup={isSetup} />
          )
        }
        feedback={
          <>
            <AccountDialogError error={ctl.error} />
            {ctl.certPrompt && (
              <CertificateTrustPanel
                prompt={ctl.certPrompt}
                onTrust={ctl.trustCertificate}
                onDismiss={ctl.dismissCertPrompt}
              />
            )}
          </>
        }
        saveButton={<SaveButton ctl={ctl} isSetup={false} />}
      />
    )
  }

  // Existing accounts retain their server-settings/reconnect form; the provider
  // is already known and must not be changed by the new-account assistant.
  const active = PROVIDERS.find((p) => p.isActive(mode))
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-[3px] z-50 p-4 select-none animate-fade-in">
      <div className="bg-chats border border-border text-primary w-full max-w-[760px] max-h-[92vh] rounded-dialog shadow-2xl animate-slide-up flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border/70 shrink-0">
          <h2 className="text-title font-bold tracking-tight leading-tight">
            {ctl.editing
              ? t('accounts.actions.editAccountTitle', { defaultValue: 'Account server settings' })
              : t('accounts.actions.reconnectAccountTitle', { defaultValue: 'Reconnect account' })}
          </h2>
          <IconButton icon={X} iconSize={15} label={t('buttons.close')} size="sm" onClick={onClose} />
        </div>

        {/* Reconnect/edit already knows the provider. */}
        <div className="flex h-[500px] min-h-0">
          <div className="flex-1 min-w-0 overflow-y-auto p-5 flex flex-col gap-4">
            <div>
              <h3 className="text-ui font-bold tracking-tight leading-tight">{active?.label}</h3>
              <p className="text-caption text-secondary mt-0.5 font-medium">
                {active ? t(active.descriptionKey, { defaultValue: active.defaultDescription }) : null}
              </p>
            </div>
            <div className="flex flex-col gap-3.5">
              <AccountDialogForm ctl={ctl} classes={classes} isSetup={false} />
            </div>
            <AccountDialogError error={ctl.error} />
            {ctl.certPrompt && (
              <CertificateTrustPanel
                prompt={ctl.certPrompt}
                onTrust={ctl.trustCertificate}
                onDismiss={ctl.dismissCertPrompt}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border/70 shrink-0 select-none">
          <Button variant="ghost" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          {!isOAuth && <SaveButton ctl={ctl} isSetup={false} />}
        </div>
      </div>
    </div>
  )
}

// The mode-specific form fields, shared by both layouts.
function AccountDialogForm({
  ctl,
  classes,
  isSetup,
}: {
  ctl: AccountDialogController
  classes: DialogClasses
  isSetup: boolean
}) {
  const { t } = useTranslation()
  const { mode, form, setForm } = ctl
  if (mode === 'rss') {
    return (
      <>
        <Field
          label={t('accounts.fields.accountName')}
          value={form.display_name}
          onChange={(display_name) => setForm((f) => ({ ...f, display_name }))}
          inputClassName={classes.inputClass}
          labelClassName={classes.fieldLabelClass}
        />
        <Field
          label={t('accounts.fields.firstFeedUrl')}
          value={form.feed_url}
          onChange={(feed_url) => setForm((f) => ({ ...f, feed_url }))}
          inputClassName={classes.inputClass}
          labelClassName={classes.fieldLabelClass}
        />
        <p className="text-caption text-secondary px-1 -mt-1">{t('accounts.setup.feedAccountHint')}</p>
      </>
    )
  }
  if (mode === 'gmail' || mode === 'outlook') {
    return <AccountDialogOAuth ctl={ctl} isSetup={isSetup} />
  }
  if (mode === 'ews') {
    return <AccountDialogEWS ctl={ctl} classes={classes} isSetup={isSetup} />
  }
  return <AccountDialogCustom ctl={ctl} classes={classes} isSetup={isSetup} />
}

function AccountDialogError({ error }: { error: string }) {
  if (!error) return null
  return (
    <p
      role="alert"
      className="rounded-control bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 p-3 text-caption leading-relaxed text-red-600 dark:text-red-400 font-medium"
    >
      {error}
    </p>
  )
}

function SaveButton({ ctl, isSetup }: { ctl: AccountDialogController; isSetup: boolean }) {
  const { t } = useTranslation()
  const { save, saveDisabled, loading, reconnectAccount, editing } = ctl
  return (
    <button
      onClick={save}
      disabled={saveDisabled}
      className={`${isSetup ? 'w-full rounded-panel py-4 text-lg' : 'rounded-control px-4.5 py-2 text-xs'} font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
        saveDisabled
          ? isSetup
            ? 'bg-hover text-secondary/70 cursor-not-allowed border border-transparent shadow-none'
            : 'bg-hover text-secondary/70 cursor-not-allowed shadow-none border border-transparent'
          : isSetup
            ? 'border border-accent bg-accent text-white hover:bg-accent-hover hover:border-accent-hover active:scale-[0.99] shadow-md shadow-accent/15'
            : 'bg-accent hover:bg-accent-hover text-white shadow-md shadow-accent/15 hover:shadow-lg hover:shadow-accent/20 active:scale-98'
      }`}
    >
      {loading && <RefreshCw size={11} className="animate-spin" />}
      <span>
        {editing
          ? t('buttons.save')
          : reconnectAccount
            ? t('accounts.actions.reconnectAccount', { defaultValue: 'Reconnect' })
            : t('accounts.actions.saveAccount')}
      </span>
    </button>
  )
}
