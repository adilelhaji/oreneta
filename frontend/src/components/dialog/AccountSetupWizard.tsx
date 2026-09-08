import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Mail, Settings2, ShieldCheck } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { SetupMode } from '../../states/ui'
import type { AccountDialogController } from './useAccountDialog'
import { accountSetupAddress, newAccountForm, suggestedAccountMode } from './accountSetup'
import { GoogleIcon, MicrosoftIcon } from './providerIcons'
import { AccountProviderGrid } from './AccountProviderGrid'
import { Dialog } from './Dialog'
import logo from '../../assets/logo.png'

const actionClass =
  'inline-flex items-center justify-center gap-2 rounded-control px-4 py-2.5 text-ui font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:cursor-not-allowed'

export function AccountSetupWizard({
  ctl,
  isSetup,
  onClose,
  form,
  feedback,
  saveButton,
}: {
  ctl: AccountDialogController
  isSetup: boolean
  onClose: () => void
  form: ReactNode
  feedback: ReactNode
  saveButton: ReactNode
}) {
  const { t } = useTranslation()
  const [step, setStep] = useState<'email' | 'connect'>('email')
  const [address, setAddress] = useState(ctl.form.email)
  const [invalid, setInvalid] = useState(false)
  const [manual, setManual] = useState(false)
  const emailId = useId()
  const titleId = useId()
  const input = useRef<HTMLInputElement>(null)
  const connectionTitle = useRef<HTMLHeadingElement>(null)
  const busy = ctl.loading || ctl.waitingForGoogle
  const isOAuth = ctl.mode === 'gmail' || ctl.mode === 'outlook'

  useEffect(() => {
    if (step === 'email') input.current?.focus()
    else connectionTitle.current?.focus()
  }, [step])

  function connect(mode: SetupMode, email = address, useManual = false) {
    ctl.startNewAccount(mode, email.trim())
    setManual(useManual)
    setStep('connect')
    // Discovery is explicit and sends only the address, never the password.
    if (mode === 'custom' && accountSetupAddress(email)) void ctl.runDiscovery(email.trim())
  }

  function next() {
    const email = accountSetupAddress(address)
    if (!email) {
      setInvalid(true)
      input.current?.focus()
      return
    }
    setAddress(email)
    connect(suggestedAccountMode(email), email)
  }

  function back() {
    setAddress(ctl.form.email || address)
    ctl.setMode(ctl.mode) // Invalidate any in-flight discovery and old feedback.
    ctl.setForm(newAccountForm(ctl.form.email || address))
    setInvalid(false)
    setStep('email')
  }

  const content = (
    <>
      <ol aria-label={t('accounts.wizard.steps')} className="flex items-center gap-3 text-caption text-secondary">
        {[t('accounts.wizard.emailStep'), t('accounts.wizard.connectStep')].map((label, index) => (
          <li
            key={label}
            aria-current={(step === 'email' ? index === 0 : index === 1) ? 'step' : undefined}
            className="flex items-center gap-2 aria-[current=step]:text-accent aria-[current=step]:font-semibold"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current">
              {index + 1}
            </span>
            {label}
            {index === 0 && <ArrowRight size={14} aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {step === 'email' ? (
        <div className="flex flex-col gap-5">
          <p className="text-ui leading-relaxed text-secondary">{t('accounts.wizard.intro')}</p>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              next()
            }}
            className="flex flex-col gap-3"
          >
            <label htmlFor={emailId} className="text-ui font-semibold">
              {t('accounts.fields.emailAddress')}
            </label>
            <input
              ref={input}
              id={emailId}
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={address}
              onChange={(event) => {
                setAddress(event.target.value)
                setInvalid(false)
              }}
              aria-invalid={invalid}
              aria-describedby={`${emailId}-hint${invalid ? ` ${emailId}-error` : ''}`}
              placeholder="nombre@ejemplo.com"
              className="w-full rounded-control border border-border bg-raised px-4 py-3 text-title text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <p id={`${emailId}-hint`} className="text-caption leading-relaxed text-secondary">
              {t('accounts.wizard.discoveryPrivacy')}
            </p>
            {invalid && (
              <p id={`${emailId}-error`} role="alert" className="text-caption text-primary">
                {t('accounts.wizard.invalidEmail')}
              </p>
            )}
            <button type="submit" className={`${actionClass} w-full bg-accent text-white hover:bg-accent-hover`}>
              {t('accounts.wizard.continue')}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </form>
          <div className="border-t border-border pt-4">
            <p className="mb-3 text-caption text-secondary">{t('accounts.wizard.providerChoice')}</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => connect('gmail')}
                className={`${actionClass} border border-border hover:bg-hover`}
              >
                <GoogleIcon size={20} />
                Google
              </button>
              <button
                type="button"
                onClick={() => connect('outlook')}
                className={`${actionClass} border border-border hover:bg-hover`}
              >
                <MicrosoftIcon size={20} />
                Microsoft
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => connect('custom', address, true)}
            className={`${actionClass} border border-border text-secondary hover:bg-hover`}
          >
            <Settings2 size={16} aria-hidden="true" />
            {t('accounts.wizard.manual')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <h3 ref={connectionTitle} tabIndex={-1} className="text-title font-semibold outline-none">
              {isOAuth
                ? ctl.mode === 'gmail'
                  ? 'Google'
                  : 'Microsoft'
                : ctl.mode === 'ews'
                  ? 'Exchange'
                  : ctl.mode === 'rss'
                    ? 'RSS / Atom'
                    : 'IMAP / SMTP'}
            </h3>
            {ctl.form.email && <p className="mt-1 break-all text-ui text-secondary">{ctl.form.email}</p>}
            <p className="mt-2 text-caption leading-relaxed text-secondary">
              {t(isOAuth ? 'accounts.wizard.browserHint' : 'accounts.wizard.connectionHint')}
            </p>
          </div>
          {manual && (
            <fieldset disabled={busy}>
              <legend className="sr-only">{t('accounts.wizard.manual')}</legend>
              <AccountProviderGrid
                mode={ctl.mode}
                setMode={(mode) => connect(mode, ctl.form.email, true)}
                isSetup={false}
              />
            </fieldset>
          )}
          <fieldset disabled={ctl.loading} className="min-w-0 flex flex-col gap-4">
            {form}
          </fieldset>
          {feedback}
          {ctl.loading && (
            <p role="status" className="text-caption text-accent">
              {t('accounts.wizard.saving')}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
            <button
              type="button"
              disabled={ctl.loading}
              onClick={back}
              className={`${actionClass} text-secondary hover:bg-hover`}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {t('buttons.back')}
            </button>
            {!manual && (
              <button
                type="button"
                disabled={busy}
                onClick={() => connect('custom', ctl.form.email, true)}
                className={`${actionClass} text-secondary hover:bg-hover`}
              >
                {t('accounts.wizard.manual')}
              </button>
            )}
            {!isOAuth && saveButton}
          </div>
        </div>
      )}
      <p className="flex items-start gap-2 border-t border-border pt-4 text-caption leading-relaxed text-secondary">
        <ShieldCheck size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
        {t('accounts.wizard.securityHint')}
      </p>
    </>
  )

  if (!isSetup)
    return (
      <Dialog
        title={t('accounts.actions.addAccountTitle')}
        icon={Mail}
        width="lg"
        onClose={onClose}
        closeDisabled={ctl.loading}
      >
        {content}
      </Dialog>
    )
  return (
    <section
      aria-labelledby={titleId}
      className="m-auto flex w-full max-w-xl flex-col gap-5 rounded-dialog border border-border bg-chats p-6 text-primary shadow-raised sm:p-8"
    >
      <header className="flex items-center gap-4">
        <img src={logo} alt={t('app.logoAlt')} className="h-12 w-12 object-contain" />
        <h2 id={titleId} className="text-title font-bold leading-tight">
          {t('accounts.setup.connectMailAccount')}
        </h2>
      </header>
      {content}
    </section>
  )
}
