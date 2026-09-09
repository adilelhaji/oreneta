import { useEffect, useState } from 'react'
import { invoke } from '../../lib/bridge'
import { GraphSetupFlow, type GraphProgress } from '../../lib/graphSetup'
import { useTranslation } from '../../lib/i18n'
import { boot } from '../../boot'
import { openMailAccount } from '../../states/kanban'
import { ui$ } from '../../states/ui'
import type { AccountDialogController } from './useAccountDialog'

export function AccountDialogGraph({ ctl }: { ctl: AccountDialogController }) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<GraphProgress>({ state: 'idle' })
  const [flow] = useState(
    () =>
      new GraphSetupFlow(invoke, setProgress, async (account, current) => {
        await boot()
        if (!current()) return
        openMailAccount(account)
        ui$.selectedThread.set('')
        ui$.reconnectAccountId.set('')
        ui$.setupOpen.set(false)
      }),
  )
  useEffect(
    () => () => {
      void flow.cancel().catch(console.error)
    },
    [flow],
  )
  const busy = progress.state === 'authorizing' || progress.state === 'syncing'
  const label = (key: string, defaultValue: string) => t(`accounts.graph.${key}`, { defaultValue })
  return (
    <section className="flex flex-col gap-3" aria-label="Microsoft Graph">
      <p className="text-ui font-semibold">Microsoft Graph — {label('readOnly', 'Read-only')}</p>
      <p className="text-caption text-secondary">
        {label(
          'scope',
          'Read folders and email, with offline access to cached messages. Sending, editing, attachments, calendars and contacts are not available yet.',
        )}
      </p>
      {!ctl.outlookConfigured && (
        <p role="status">
          {label('unconfigured', 'This build has no Microsoft client ID. Graph sign-in is unavailable.')}
        </p>
      )}
      <button
        type="button"
        disabled={busy || !ctl.outlookConfigured}
        className="rounded-control border border-border px-4 py-3 text-ui font-semibold hover:bg-hover disabled:opacity-50"
        onClick={() => void flow.begin(ctl.reconnectAccount?.id ?? '', ctl.form.display_name || 'Microsoft Graph')}
      >
        {label('signIn', 'Sign in with Microsoft Graph')}
      </button>
      {busy && (
        <p role="status" aria-live="polite" className="text-caption text-accent">
          {progress.state === 'authorizing'
            ? label('waiting', 'Complete sign-in in your browser.')
            : `${label('syncing', 'Preparing folders and Inbox…')} ${progress.pages ?? 0} ${label('pages', 'pages')}, ${progress.changes ?? 0} ${label('changes', 'changes')}`}
        </p>
      )}
      {progress.state === 'failed' && (
        <p role="alert" className="text-caption text-red-600">
          {label('failed', 'Setup did not finish. You can sign in again to retry.')} ({progress.error})
          {progress.retry_after_seconds
            ? ` ${label('retryAfter', 'Retry after seconds:')} ${progress.retry_after_seconds}`
            : ''}
        </p>
      )}
      {busy && (
        <button
          type="button"
          className="rounded-control border border-border px-4 py-2"
          onClick={() =>
            void flow
              .cancel()
              .then(() => setProgress({ state: 'cancelled' }))
              .catch(() => setProgress({ state: 'failed', error: 'cancel_failed' }))
          }
        >
          {t('buttons.cancel')}
        </button>
      )}
    </section>
  )
}
