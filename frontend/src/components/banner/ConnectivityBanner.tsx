import { useId, useState } from 'react'
import { ChevronDown, RefreshCw, X } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { useValue } from '@legendapp/state/react'
import { accounts$ } from '../../states/accounts'
import { connectivity$, dismissSyncError, requestAccountSync, type SyncObservation } from '../../states/connectivity'
import { focusSettingsSection } from '../../states/ui'
import { connectivityAccountLabel } from './connectivityBannerHelpers'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'

export function ConnectivityBanner() {
  const { t } = useTranslation()
  const observations = useValue(connectivity$.byAccount)
  const unattributed = useValue(connectivity$.unattributed)
  const accounts = useValue(accounts$)
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const entries = accounts.map((account) => ({
    account,
    observation: Object.hasOwn(observations, account.id) ? observations[account.id] : undefined,
  }))
  const attention =
    entries.filter(
      ({ account, observation }) =>
        account.needs_reconnect || observation?.failure || observation?.request === 'unconfirmed',
    ).length + (unattributed ? 1 : 0)
  const prominent =
    entries.some(
      ({ account, observation }) => account.needs_reconnect || (observation?.failure && !observation.dismissed),
    ) ||
    (unattributed && !unattributed.dismissed)
  if (!accounts.length && !unattributed) return null

  const requestText = (observation?: SyncObservation) =>
    observation && observation.request !== 'idle' ? t(`connectivity.health.${observation.request}`) : null

  return (
    <section
      aria-label={t('connectivity.health.title')}
      className={`shrink-0 border-b border-border text-ui ${prominent ? 'bg-danger-soft' : 'bg-raised'}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
        <Button
          variant="ghost"
          size="sm"
          rightIcon={ChevronDown}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {t('connectivity.health.title')}
        </Button>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0 text-caption text-secondary wrap-anywhere"
        >
          {attention ? t('connectivity.health.attention', { count: attention }) : t('connectivity.health.unknown')}
        </span>
      </div>
      {expanded && (
        <div id={id} className="max-h-[40vh] overflow-auto border-t border-border px-3 py-2">
          <p className="mb-2 text-caption text-secondary">{t('connectivity.health.session')}</p>
          <ul className="space-y-2">
            {entries.map(({ account, observation }) => {
              const label = connectivityAccountLabel(account.id, accounts) ?? account.id
              const state = account.needs_reconnect
                ? 'auth'
                : account.paused
                  ? 'paused'
                  : observation?.failure
                    ? 'failed'
                    : observation?.lastActivityAt
                      ? 'partial'
                      : 'unknown'
              return (
                <li
                  key={account.id}
                  aria-label={label}
                  tabIndex={-1}
                  className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-chats p-3"
                >
                  <div className="min-w-0 flex-1 basis-52 wrap-anywhere">
                    <p className="font-semibold">{label}</p>
                    <p className="text-caption text-secondary">{t(`connectivity.health.${state}`)}</p>
                    {observation?.failure && state !== 'failed' && (
                      <p className="text-caption text-danger">{t('connectivity.health.failed')}</p>
                    )}
                    {requestText(observation) && (
                      <p role="status" className="text-caption text-secondary">
                        {requestText(observation)}
                      </p>
                    )}
                    {observation?.lastActivityAt && (
                      <p className="text-caption text-secondary">
                        {t('connectivity.health.activity', {
                          time: new Date(observation.lastActivityAt).toLocaleTimeString(),
                        })}
                      </p>
                    )}
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => focusSettingsSection('account', account.id)}>
                    {t('connectivity.health.settings')}
                  </Button>
                  {!account.paused && !account.needs_reconnect && (
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={RefreshCw}
                      disabled={observation?.request === 'pending'}
                      onClick={() => void requestAccountSync(account.id)}
                    >
                      {t('connectivity.retry')}
                    </Button>
                  )}
                  {observation?.failure && !observation.dismissed && (
                    <IconButton
                      size="sm"
                      icon={X}
                      label={t('connectivity.dismiss')}
                      onClick={(event) => {
                        event.currentTarget.closest('li')?.focus()
                        dismissSyncError(account.id)
                      }}
                    />
                  )}
                </li>
              )
            })}
            {unattributed && (
              <li tabIndex={-1} className="flex items-center gap-2 rounded-control border border-border bg-chats p-3">
                <p className="min-w-0 flex-1 text-caption wrap-anywhere">{t('connectivity.health.unattributed')}</p>
                {!unattributed.dismissed && (
                  <IconButton
                    size="sm"
                    icon={X}
                    label={t('connectivity.dismiss')}
                    onClick={(event) => {
                      event.currentTarget.closest('li')?.focus()
                      dismissSyncError(null)
                    }}
                  />
                )}
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}
