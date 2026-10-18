import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Info, Network, RefreshCw, Search } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { Field } from '../field/Field'
import { securityAfterPortEdit, type MailSecurity } from './accountSecurity'
import type { AccountDialogController } from './useAccountDialog'
import type { DialogClasses } from './accountDialogStyles'
import { accountSetupAddress } from './accountSetup'
import { ConnectionTestPanel } from './ConnectionTestPanel'

// The custom IMAP/SMTP section: email, an explicit "Find settings" lookup,
// sender name, password, the app-password hint, and the collapsible advanced
// server settings.
//
// Looking settings up online sends the address to the mail domain and the
// domain to Mozilla's provider database, so it happens only when the person
// presses the button, never on typing or leaving the field. Entering the
// servers by hand needs no lookup at all.
export function AccountDialogCustom({
  ctl,
  classes,
  isSetup,
}: {
  ctl: AccountDialogController
  classes: DialogClasses
  isSetup: boolean
}) {
  const { t } = useTranslation()
  const [showPassword, setShowPassword] = useState(false)
  const findHintId = useId()
  const {
    form,
    setForm,
    discovering,
    discoverNote,
    appPasswordHint,
    advancedOpen,
    setAdvancedOpen,
    runDiscovery,
    save,
    saveDisabled,
    editing,
    loading,
    testing,
    testConnection,
    connectionReport,
    connectionReportStale,
    applyConnectionFix,
    saveAnyway,
  } = ctl
  const { inputClass, fieldLabelClass, serverGridClass } = classes
  // The test needs what a save needs: an address and a password (or, when
  // editing, the stored one).
  const testDisabled = saveDisabled

  return (
    <>
      <Field
        label={t('accounts.fields.emailAddress')}
        type="email"
        value={form.email}
        onChange={(email) => setForm((f) => ({ ...f, email }))}
        inputClassName={inputClass}
        labelClassName={fieldLabelClass}
        // The address is the account's primary key in the store, so letting it
        // be edited here would create a second account rather than change this
        // one. Renaming is Remove + Add, deliberately.
        disabled={editing}
      />
      {!ctl.reconnectAccount && form.email && !accountSetupAddress(form.email) && (
        <p role="alert" className="text-caption text-secondary">
          {t('accounts.wizard.invalidEmail')}
        </p>
      )}
      {!editing && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => void runDiscovery(form.email)}
            disabled={discovering || !accountSetupAddress(form.email)}
            aria-describedby={findHintId}
            className="flex items-center gap-1.5 self-start rounded-control border border-border px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-hover cursor-pointer disabled:cursor-default disabled:opacity-50"
          >
            <Search size={14} aria-hidden="true" strokeWidth={1.75} />
            {t('accounts.discovery.findSettings', { defaultValue: 'Find settings online' })}
          </button>
          <p id={findHintId} className="px-1 text-caption leading-relaxed text-secondary">
            {t('accounts.discovery.findSettingsHint', {
              domain:
                findSettingsDomain(form.email) ||
                t('accounts.discovery.yourMailDomain', { defaultValue: 'your mail domain' }),
              defaultValue:
                'Looks up the server settings by sending your address to {domain} and the domain to Mozilla’s provider database. Your password is not sent. You can also enter the servers yourself under Advanced server settings.',
            })}
          </p>
        </div>
      )}
      {(discovering || discoverNote) && (
        <p role="status" className="flex items-center gap-1.5 px-1 text-caption font-medium text-secondary">
          {discovering && <RefreshCw size={14} className="animate-spin" strokeWidth={1.75} />}
          {discovering ? t('accounts.discovery.lookingUp') : discoverNote}
        </p>
      )}
      <Field
        label={t('accounts.fields.senderNameOutgoing')}
        value={form.sender_name}
        onChange={(sender_name) => setForm((f) => ({ ...f, sender_name }))}
        inputClassName={inputClass}
        labelClassName={fieldLabelClass}
      />
      <label className="flex flex-col gap-1.5 w-full">
        <span className={`ps-0.5 ${fieldLabelClass ?? 'text-caption font-semibold text-secondary'}`}>
          {editing ? t('accounts.fields.passwordUnchanged') : t('accounts.fields.password')}
        </span>
        <span className="relative flex items-center">
          <input
            type={showPassword ? 'text' : 'password'}
            value={form.password}
            onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !saveDisabled) {
                e.preventDefault()
                void save()
              }
            }}
            className={`${inputClass ?? 'w-full text-xs py-2 px-3.5 rounded-control border border-border bg-raised text-primary placeholder-secondary focus:ring-1 focus:ring-accent focus:border-transparent focus:bg-chats transition-all outline-none'} pe-11`}
          />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setShowPassword((value) => !value)}
            className="absolute end-2.5 flex h-7 w-7 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
            aria-label={
              showPassword
                ? t('accounts.actions.hidePassword', { defaultValue: 'Hide password' })
                : t('accounts.actions.showPassword', { defaultValue: 'Show password' })
            }
          >
            {showPassword ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
          </button>
        </span>
      </label>

      {appPasswordHint && (
        <div
          className={`${isSetup ? 'rounded-panel p-4 text-sm gap-3' : 'rounded-control p-3 text-caption gap-2'} flex items-start bg-accent/[0.06] border border-accent/15 leading-relaxed text-secondary -mt-1`}
        >
          <Info size={isSetup ? 16 : 14} className="shrink-0 mt-0.5 text-accent" strokeWidth={1.75} />
          <p className="flex-1 font-medium">{t('accounts.appPasswordHint', { provider: appPasswordHint.provider })}</p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="flex items-center gap-1 self-start px-1 text-caption font-semibold text-secondary hover:text-primary transition-colors cursor-pointer"
      >
        <ChevronRight
          size={14}
          className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
          strokeWidth={1.75}
        />
        {t('accounts.advancedServerSettings')}
      </button>

      {advancedOpen && (
        <>
          <Field
            label={t('accounts.fields.displayNameMeronOnly')}
            value={form.display_name}
            onChange={(display_name) => setForm((f) => ({ ...f, display_name }))}
            inputClassName={inputClass}
            labelClassName={fieldLabelClass}
          />
          <label className={fieldLabelClass}>
            {t('accounts.fields.incoming', { defaultValue: 'Incoming mail' })}
            <select
              value={form.incoming}
              onChange={(e) => {
                const incoming = e.target.value === 'pop3' ? 'pop3' : 'imap'
                setForm((f) => ({
                  ...f,
                  incoming,
                  // The usual port for each, unless one was typed.
                  imap_port: f.imap_port_touched ? f.imap_port : incoming === 'pop3' ? '995' : '993',
                }))
              }}
              className={inputClass}
            >
              <option value="imap">IMAP</option>
              <option value="pop3">
                {t('accounts.incoming.pop3', { defaultValue: 'POP3 (downloaded to this computer)' })}
              </option>
            </select>
          </label>
          {form.incoming === 'pop3' && (
            <p className="text-caption text-secondary">
              {t('accounts.incoming.pop3Hint', {
                defaultValue:
                  'POP3 has no folders: mail is downloaded into this computer’s Inbox for the account. It stays on the server unless you choose otherwise in the account’s settings.',
              })}
            </p>
          )}
          <div className={serverGridClass}>
            <Field
              label={t('accounts.fields.imapHost')}
              value={form.imap_host}
              onChange={(imap_host) => setForm((f) => ({ ...f, imap_host, imap_host_touched: !!imap_host.trim() }))}
              inputClassName={inputClass}
              labelClassName={fieldLabelClass}
            />
            <Field
              label={t('accounts.fields.port')}
              value={form.imap_port}
              onChange={(imap_port) =>
                setForm((f) => ({
                  ...f,
                  imap_port,
                  imap_port_touched: !!imap_port.trim(),
                  imap_security: securityAfterPortEdit(f.imap_security, f.imap_security_touched, imap_port),
                }))
              }
              inputClassName={inputClass}
              labelClassName={fieldLabelClass}
            />
          </div>
          <SecurityField
            label={t('accounts.fields.imapSecurity')}
            value={form.imap_security}
            onChange={(imap_security) => setForm((f) => ({ ...f, imap_security, imap_security_touched: true }))}
            inputClassName={inputClass}
            labelClassName={fieldLabelClass}
            noneLabel={t('accounts.security.none')}
          />
          <div className={serverGridClass}>
            <Field
              label={t('accounts.fields.smtpHost')}
              value={form.smtp_host}
              onChange={(smtp_host) => setForm((f) => ({ ...f, smtp_host, smtp_host_touched: !!smtp_host.trim() }))}
              inputClassName={inputClass}
              labelClassName={fieldLabelClass}
            />
            <Field
              label={t('accounts.fields.port')}
              value={form.smtp_port}
              onChange={(smtp_port) =>
                setForm((f) => ({
                  ...f,
                  smtp_port,
                  smtp_port_touched: !!smtp_port.trim(),
                  smtp_security: securityAfterPortEdit(f.smtp_security, f.smtp_security_touched, smtp_port),
                }))
              }
              inputClassName={inputClass}
              labelClassName={fieldLabelClass}
            />
          </div>
          <SecurityField
            label={t('accounts.fields.smtpSecurity')}
            value={form.smtp_security}
            onChange={(smtp_security) => setForm((f) => ({ ...f, smtp_security, smtp_security_touched: true }))}
            inputClassName={inputClass}
            labelClassName={fieldLabelClass}
            noneLabel={t('accounts.security.none')}
          />
          <Field
            label={t('accounts.fields.username')}
            value={form.username}
            onChange={(username) => setForm((f) => ({ ...f, username, username_touched: !!username.trim() }))}
            inputClassName={inputClass}
            labelClassName={fieldLabelClass}
          />
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testDisabled}
          className="flex items-center gap-1.5 self-start rounded-control border border-border px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-hover cursor-pointer disabled:cursor-default disabled:opacity-50"
        >
          {testing ? (
            <RefreshCw size={14} aria-hidden="true" className="animate-spin" strokeWidth={1.75} />
          ) : (
            <Network size={14} aria-hidden="true" strokeWidth={1.75} />
          )}
          {testing ? t('accounts.connectionTest.testing') : t('accounts.connectionTest.action')}
        </button>
        <p className="px-1 text-caption leading-relaxed text-secondary">{t('accounts.connectionTest.hint')}</p>
      </div>
      {connectionReport && (
        <ConnectionTestPanel
          report={connectionReport}
          stale={connectionReportStale}
          form={{ username: form.username, email: form.email }}
          busy={loading || testing}
          onFix={(side, fix) => void applyConnectionFix(side, fix)}
          onSaveAnyway={() => void saveAnyway()}
        />
      )}
    </>
  )
}

function SecurityField({
  label,
  value,
  onChange,
  inputClassName,
  labelClassName,
  noneLabel,
}: {
  label: string
  value: MailSecurity
  onChange: (value: MailSecurity) => void
  inputClassName?: string
  labelClassName?: string
  noneLabel: string
}) {
  return (
    <label className="flex flex-col gap-1.5 w-full">
      <span className={`ps-0.5 ${labelClassName ?? 'text-caption font-semibold text-secondary'}`}>{label}</span>
      <span className="relative flex items-center">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as MailSecurity)}
          className={`${
            inputClassName ??
            'w-full text-xs py-2 px-3.5 rounded-control border border-border bg-raised text-primary focus:ring-1 focus:ring-accent focus:border-transparent focus:bg-chats transition-all outline-none'
          } appearance-none pe-10 cursor-pointer`}
        >
          <option value="tls">TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">{noneLabel}</option>
        </select>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute end-3 text-secondary"
          strokeWidth={1.75}
        />
      </span>
    </label>
  )
}

// The mail domain named in the "Find settings" hint, so the person sees which
// server would be asked before asking it.
function findSettingsDomain(email: string): string {
  const address = accountSetupAddress(email)
  return address ? address.slice(address.lastIndexOf('@') + 1).toLowerCase() : ''
}
