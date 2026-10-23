import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, RefreshCw, X } from 'lucide-react'
import { observable } from '@legendapp/state'
import { intlLocale, useTranslation } from '../../lib/i18n'
import { useValue } from '@legendapp/state/react'
import { accounts$ } from '../../states/accounts'
import { connectivity$, dismissSyncError, requestAccountSync, type SyncObservation } from '../../states/connectivity'
import { focusSettingsSection } from '../../states/ui'
import { connectivityAccountLabel } from './connectivityBannerHelpers'
import { proxySettingsTarget } from '../../lib/proxyProblems'
import type { Account } from '../../types'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'

/** One account and what this session has observed of it. */
export type ConnectivityEntry = { account: Account; observation: SyncObservation | undefined }

/** What the summary rests on: numbers and flags only, which the band's button follows. */
export type ConnectivityState = {
  /** Accounts that need attention, and an unattributed problem. */
  attention: number
  /**
   * An account must sign in again, or a failure (or an unattributed problem)
   * has not been dismissed: the full-width bar under the header (#345).
   */
  prominent: boolean
  /** Whether there is anything to say: an account, or an unattributed problem. */
  shown: boolean
  /**
   * What is known, and only that (account-sync-health.md): «{count} need
   * attention» or «Complete sync status unknown». There is no signal of a
   * complete sync, so never «Synced».
   */
  summary: string
}

export type ConnectivitySummary = ConnectivityState & {
  accounts: Account[]
  entries: ConnectivityEntry[]
  unattributed: SyncObservation | null
}

function entriesOf(accounts: Account[], observations: Record<string, SyncObservation>): ConnectivityEntry[] {
  return accounts.map((account) => ({
    account,
    observation: Object.hasOwn(observations, account.id) ? observations[account.id] : undefined,
  }))
}

function attentionOf(entries: ConnectivityEntry[], unattributed: SyncObservation | null): number {
  return (
    entries.filter(
      ({ account, observation }) =>
        account.needs_reconnect || observation?.failure || observation?.request === 'unconfirmed',
    ).length + (unattributed ? 1 : 0)
  )
}

function prominentOf(entries: ConnectivityEntry[], unattributed: SyncObservation | null): boolean {
  return (
    entries.some(
      ({ account, observation }) => account.needs_reconnect || (observation?.failure && !observation.dismissed),
    ) || !!(unattributed && !unattributed.dismissed)
  )
}

function summaryText(t: ReturnType<typeof useTranslation>['t'], attention: number): string {
  return attention ? t('connectivity.health.attention', { count: attention }) : t('connectivity.health.unknown')
}

/**
 * The summary alone, for the band's button: it follows the count and the two
 * flags, so a change to an account that moves none of them (a new name, a mail
 * check observed) does not draw the band again (#344).
 */
export function useConnectivityState(): ConnectivityState {
  const { t } = useTranslation()
  const current = () => entriesOf(accounts$.get(), connectivity$.byAccount.get())
  const attention = useValue(() => attentionOf(current(), connectivity$.unattributed.get()))
  const prominent = useValue(() => prominentOf(current(), connectivity$.unattributed.get()))
  const shown = useValue(() => accounts$.get().length > 0 || !!connectivity$.unattributed.get())
  return { attention, prominent, shown, summary: summaryText(t, attention) }
}

/** The session's sync observations, account by account, and their summary: what the detail shows. */
export function useConnectivitySummary(): ConnectivitySummary {
  const { t } = useTranslation()
  const observations = useValue(connectivity$.byAccount)
  const unattributed = useValue(connectivity$.unattributed)
  const accounts = useValue(accounts$)
  const entries = entriesOf(accounts, observations)
  const attention = attentionOf(entries, unattributed)
  return {
    accounts,
    entries,
    unattributed,
    attention,
    prominent: prominentOf(entries, unattributed),
    shown: accounts.length > 0 || !!unattributed,
    summary: summaryText(t, attention),
  }
}

/**
 * Whether the band's sync status has its popover open (#345). The bar under
 * the header folds its own detail meanwhile: the two would say the same
 * thing twice, request announcements included.
 */
export const syncPopoverOpen$ = observable(false)

/** The band's sync status button (`components/shell/SyncStatus.tsx`). */
export const SYNC_STATUS_BUTTON = '[data-sync-status-button]'

/**
 * Each account, what this session observed of it, and what can be done about
 * it; then the problem no account could be given. The bar under the header
 * and the band's popover show it (#345). `onOpenSettings` runs before an
 * action opens Settings.
 */
export function ConnectivityDetail({
  summary,
  onOpenSettings,
}: {
  summary: ConnectivitySummary
  onOpenSettings?: () => void
}) {
  const { t } = useTranslation()
  const { accounts, entries, unattributed } = summary
  const openSettings = (...target: Parameters<typeof focusSettingsSection>) => {
    onOpenSettings?.()
    focusSettingsSection(...target)
  }

  const requestText = (observation?: SyncObservation) =>
    observation && observation.request !== 'idle' ? t(`connectivity.health.${observation.request}`) : null

  return (
    <>
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
          // A failure that was the proxy's is said to be so, and its action
          // opens the setting that fixes it instead of the account (#201).
          const proxy = state === 'failed' ? observation?.proxy : null
          const proxyTarget = proxy ? proxySettingsTarget(proxy, account) : null
          const stateText = !proxy
            ? t(`connectivity.health.${state}`)
            : proxy.kind === 'unreachable'
              ? t('connectivity.proxyFailedAccount', { proxy: proxy.endpoint, account: label })
              : t(proxy.scope === 'app' ? 'connectivity.proxyUnusableApp' : 'connectivity.proxyUnusableAccount', {
                  account: label,
                })
          return (
            <li
              key={account.id}
              aria-label={label}
              tabIndex={-1}
              className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-chats p-3"
            >
              <div className="min-w-0 flex-1 basis-52 wrap-anywhere">
                <p className="font-semibold">{label}</p>
                <p className={`text-caption ${proxy ? 'text-danger' : 'text-secondary'}`}>{stateText}</p>
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
                      time: new Date(observation.lastActivityAt).toLocaleTimeString(intlLocale()),
                    })}
                  </p>
                )}
              </div>
              {proxyTarget ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openSettings(proxyTarget.section, proxyTarget.accountId)}
                >
                  {t(
                    proxyTarget.section === 'network'
                      ? 'connectivity.networkSettings'
                      : 'connectivity.accountProxySettings',
                  )}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => openSettings('account', account.id)}>
                  {t('connectivity.health.settings')}
                </Button>
              )}
              {!account.paused && !account.needs_reconnect && (
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={RefreshCw}
                  disabled={observation?.request === 'pending'}
                  onClick={(event) => {
                    // Disabled while the request is pending, it would drop
                    // the focus to the page: the entry keeps it, as with
                    // Dismiss. In the popover that also keeps bare keys from
                    // the conversation behind; the bar lets them through.
                    event.currentTarget.closest('li')?.focus()
                    void requestAccountSync(account.id)
                  }}
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
    </>
  )
}

/**
 * The full-width bar under the header (ADR-0068 §2, #345): only when an
 * account must sign in again or a failure has not been dismissed (the
 * `prominent` case), until that is resolved or dismissed. A sign-in cannot be
 * dismissed. Otherwise the top band's sync status says it alone
 * (`components/shell/SyncStatus.tsx`), and this bar is not drawn.
 *
 * The bar is today's region, with its button and its detail. Its summary is
 * no longer a live region: the band's is, and it is there whether the bar is
 * or not, so each change is announced once.
 */
export function ConnectivityBanner() {
  const { shown, prominent } = useConnectivityState()
  if (!shown || !prominent) return null
  return <ProminentBar />
}

function ProminentBar() {
  const { t } = useTranslation()
  const summary = useConnectivitySummary()
  const [expanded, setExpanded] = useState(false)
  const popoverOpen = useValue(syncPopoverOpen$)
  const section = useRef<HTMLElement | null>(null)
  const id = useId()
  // One detail at a time: the band's popover folds this one.
  const open = expanded && !popoverOpen
  useEffect(() => {
    if (popoverOpen) setExpanded(false)
  }, [popoverOpen])
  // Gone with the focus in it (its last failure dismissed here): the focus
  // goes to the band's sync status, which still says what is known, rather
  // than to the page.
  useLayoutEffect(
    () => () => {
      const active = document.activeElement
      if (active && section.current?.contains(active))
        document.querySelector<HTMLElement>(SYNC_STATUS_BUTTON)?.focus({ preventScroll: true })
    },
    [],
  )

  return (
    <section
      ref={section}
      aria-label={t('connectivity.health.title')}
      data-sync-bar=""
      className="shrink-0 border-b border-border bg-danger-soft text-ui"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
        <Button
          variant="ghost"
          size="sm"
          rightIcon={ChevronDown}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setExpanded(!open)}
        >
          {t('connectivity.health.title')}
        </Button>
        <span className="min-w-0 text-caption text-secondary wrap-anywhere">{summary.summary}</span>
      </div>
      {open && (
        <div id={id} className="max-h-[40vh] overflow-auto border-t border-border px-3 py-2">
          <ConnectivityDetail summary={summary} />
        </div>
      )}
    </section>
  )
}
