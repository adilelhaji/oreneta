import { useState } from 'react'
import { PlaneTakeoff } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { getOof, setEwsOof, setImapOof, type EwsOofSettings, type ImapOofSettings } from '../../states/oof'
import { showToast } from '../../states/ui'
import type { Account } from '../../types'
import { Notice } from '../notice/Notice'
import { SegmentedRow, SettingRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

const DEFAULT_IMAP_SETTINGS: ImapOofSettings = { enabled: false, startAt: 0, endAt: 0, subject: '', body: '' }
const DEFAULT_EWS_SETTINGS: EwsOofSettings = {
  state: 'disabled',
  externalAudience: 'none',
  startAt: 0,
  endAt: 0,
  internalReply: '',
  externalReply: '',
}

/** Same check the reconnect flow already makes. */
function isEwsAccount(account: Account): boolean {
  return account.provider === 'exchange' || !!account.ews_url
}

function toDateInput(unixSeconds: number): string {
  if (!unixSeconds) return ''
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

function fromDateInput(value: string): number {
  if (!value) return 0
  const ms = Date.parse(`${value}T00:00:00`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

/**
 * Out-of-office / Automatic Replies. Which card renders depends on the
 * account's protocol, because the two are not the same feature wearing
 * different clothes: an Exchange account's settings live on the server
 * (real, reliable even when Oreneta is closed) while a plain IMAP/SMTP
 * account has no server-side equivalent at all — no Sieve, no standard
 * vacation-responder protocol this app can drive — so it gets this app's
 * own client-side substitute instead, which only works while Oreneta is
 * running (minimized to the tray still counts; fully quit does not).
 * Offering the client-side version for an Exchange account would be a
 * downgrade dressed up as a choice, so it never does.
 */
export function OofSettingsCard({ account }: { account: Account }) {
  return isEwsAccount(account) ? <EwsOofCard account={account} /> : <ImapOofCard account={account} />
}

function ImapOofCard({ account }: { account: Account }) {
  const { t } = useTranslation()
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [settings, setSettings] = useState<ImapOofSettings>(DEFAULT_IMAP_SETTINGS)
  const [failed, setFailed] = useState(false)

  // Re-seed during the render that brings a new account in, the same reason
  // AccountSignatureCard does: an effect leaves a render where this still
  // shows the previous account's settings.
  if (loadedFor !== account.id) {
    setLoadedFor(account.id)
    setSettings(DEFAULT_IMAP_SETTINGS)
    setFailed(false)
    void getOof(account.id)
      .then((result) => {
        if (result.kind === 'imap') setSettings(result.settings)
      })
      .catch(() => setFailed(true))
  }

  const commit = async (next: ImapOofSettings) => {
    setSettings(next)
    try {
      await setImapOof(account.id, next)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('oof.saveFailed'), 'error')
    }
  }

  return (
    <SettingsGroup title={t('oof.title')}>
      <ToggleRow
        icon={<PlaneTakeoff size={15} />}
        title={t('oof.enable')}
        checked={settings.enabled}
        onChange={() => void commit({ ...settings, enabled: !settings.enabled })}
      />
      {settings.enabled && (
        <>
          <div className="px-3.5 pt-2.5">
            <Notice tone="warning">{t('oof.onlyWhileRunning')}</Notice>
          </div>
          <SettingRow
            title={t('oof.dateRange')}
            hint={t('oof.dateRangeHint')}
            control={
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={toDateInput(settings.startAt)}
                  onChange={(event) => void commit({ ...settings, startAt: fromDateInput(event.target.value) })}
                  aria-label={t('oof.startDate')}
                  className="rounded-control border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent/50"
                />
                <span className="text-secondary">–</span>
                <input
                  type="date"
                  value={toDateInput(settings.endAt)}
                  onChange={(event) => void commit({ ...settings, endAt: fromDateInput(event.target.value) })}
                  aria-label={t('oof.endDate')}
                  className="rounded-control border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent/50"
                />
              </div>
            }
          />
          <div
            className="flex flex-col gap-2.5 px-3.5 py-2.5"
            onBlurCapture={(event) => {
              // Commit once focus actually leaves both fields, not on every
              // keystroke — this is a canned message someone is composing,
              // not a live preference, and every commit also resets every
              // sender's reply count (see clear_oof_replies's own doc).
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                void commit(settings)
              }
            }}
          >
            <div>
              <label className="mb-1.5 block text-xs font-normal text-primary" htmlFor={`oof-subject-${account.id}`}>
                {t('oof.subject')}
              </label>
              <input
                id={`oof-subject-${account.id}`}
                type="text"
                value={settings.subject}
                onChange={(event) => setSettings((current) => ({ ...current, subject: event.target.value }))}
                placeholder={t('oof.subjectPlaceholder')}
                className="w-full rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-normal text-primary" htmlFor={`oof-body-${account.id}`}>
                {t('oof.body')}
              </label>
              <textarea
                id={`oof-body-${account.id}`}
                value={settings.body}
                onChange={(event) => setSettings((current) => ({ ...current, body: event.target.value }))}
                placeholder={t('oof.bodyPlaceholder')}
                rows={4}
                className="w-full resize-y rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
              />
            </div>
          </div>
          {failed && <p className="px-3.5 pb-2 text-caption text-rose-600 dark:text-rose-400">{t('oof.loadFailed')}</p>}
        </>
      )}
    </SettingsGroup>
  )
}

/** The real, server-side Automatic Replies for an Exchange account. */
function EwsOofCard({ account }: { account: Account }) {
  const { t } = useTranslation()
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [settings, setSettings] = useState<EwsOofSettings>(DEFAULT_EWS_SETTINGS)
  const [failed, setFailed] = useState(false)

  if (loadedFor !== account.id) {
    setLoadedFor(account.id)
    setSettings(DEFAULT_EWS_SETTINGS)
    setFailed(false)
    void getOof(account.id)
      .then((result) => {
        if (result.kind === 'ews') setSettings(result.settings)
      })
      .catch(() => setFailed(true))
  }

  const commit = async (next: EwsOofSettings) => {
    setSettings(next)
    try {
      await setEwsOof(account.id, next)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('oof.saveFailed'), 'error')
    }
  }

  const active = settings.state !== 'disabled'

  return (
    <SettingsGroup title={t('oof.title')}>
      <SegmentedRow
        icon={<PlaneTakeoff size={15} />}
        title={t('oof.enable')}
        value={settings.state}
        options={[
          { value: 'disabled', label: t('oof.stateOff') },
          { value: 'enabled', label: t('oof.stateOn') },
          { value: 'scheduled', label: t('oof.stateScheduled') },
        ]}
        onChange={(state) => void commit({ ...settings, state })}
      />
      {active && (
        <>
          {settings.state === 'scheduled' && (
            <SettingRow
              title={t('oof.dateRange')}
              control={
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={toDateInput(settings.startAt)}
                    onChange={(event) => void commit({ ...settings, startAt: fromDateInput(event.target.value) })}
                    aria-label={t('oof.startDate')}
                    className="rounded-control border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent/50"
                  />
                  <span className="text-secondary">–</span>
                  <input
                    type="date"
                    value={toDateInput(settings.endAt)}
                    onChange={(event) => void commit({ ...settings, endAt: fromDateInput(event.target.value) })}
                    aria-label={t('oof.endDate')}
                    className="rounded-control border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent/50"
                  />
                </div>
              }
            />
          )}
          <SegmentedRow
            title={t('oof.externalAudience')}
            hint={t('oof.externalAudienceHint')}
            value={settings.externalAudience}
            options={[
              { value: 'none', label: t('oof.audienceNone') },
              { value: 'known', label: t('oof.audienceKnown') },
              { value: 'all', label: t('oof.audienceAll') },
            ]}
            onChange={(externalAudience) => void commit({ ...settings, externalAudience })}
          />
          <div
            className="flex flex-col gap-2.5 px-3.5 py-2.5"
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                void commit(settings)
              }
            }}
          >
            <div>
              <label className="mb-1.5 block text-xs font-normal text-primary" htmlFor={`oof-internal-${account.id}`}>
                {t('oof.internalReply')}
              </label>
              <textarea
                id={`oof-internal-${account.id}`}
                value={settings.internalReply}
                onChange={(event) => setSettings((current) => ({ ...current, internalReply: event.target.value }))}
                placeholder={t('oof.bodyPlaceholder')}
                rows={3}
                className="w-full resize-y rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
              />
            </div>
            {settings.externalAudience !== 'none' && (
              <div>
                <label className="mb-1.5 block text-xs font-normal text-primary" htmlFor={`oof-external-${account.id}`}>
                  {t('oof.externalReply')}
                </label>
                <textarea
                  id={`oof-external-${account.id}`}
                  value={settings.externalReply}
                  onChange={(event) => setSettings((current) => ({ ...current, externalReply: event.target.value }))}
                  placeholder={t('oof.bodyPlaceholder')}
                  rows={3}
                  className="w-full resize-y rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
                />
              </div>
            )}
          </div>
          {failed && <p className="px-3.5 pb-2 text-caption text-rose-600 dark:text-rose-400">{t('oof.loadFailed')}</p>}
        </>
      )}
    </SettingsGroup>
  )
}
