import { useState } from 'react'
import { Server } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { confirmAction, showToast } from '../../states/ui'
import { Button } from '../button/Button'

type Plan = { script: string; included: string[]; left: { id: string; name: string; reasons: string[] }[] }
type Status = {
  ours: 'none' | 'current' | 'changedElsewhere'
  oursActive: boolean
  otherActive: string | null
  capabilities: { sieve: string[]; implementation: string }
}
type Answer =
  | { available: false; reason: string }
  | { available: true; status: Status; plan: Plan; state: { included: string[]; active: boolean } | null }
type Pushed =
  | { outcome: 'stored'; hash: string; active: boolean; otherActive: string | null }
  | { outcome: 'changedElsewhere'; onServer: string }

/**
 * The reader's rules on an account's server (#94, ADR-0027): what would go,
 * what stays here and why, and whether the server's copy is still the one
 * Oreneta wrote. Nothing is sent to the server until asked.
 */
export function ServerRulesPanel() {
  const { t } = useTranslation()
  const accounts = useValue(accounts$).filter(isSendableAccount)
  const [account, setAccount] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [onServer, setOnServer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = account || accounts[0]?.id || ''

  const look = async () => {
    setBusy(true)
    setOnServer(null)
    try {
      setAnswer(await invoke<Answer>('rules.serverStatus', { account: chosen }))
    } catch (e) {
      setAnswer({ available: false, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const push = async (overwrite: boolean) => {
    if (!answer?.available) return
    const ok = await confirmAction({
      title: t('serverRules.confirmTitle', { defaultValue: 'Run these rules on the server?' }),
      message: t('serverRules.confirmMessage', {
        count: answer.plan.included.length,
        defaultValue:
          '{count} rules will be applied by the server as mail arrives, even when Oreneta is closed, and no longer here. Rules that stay here keep running here.',
      }),
      confirmLabel: t('serverRules.confirm', { defaultValue: 'Run on the server' }),
      cancelLabel: t('buttons.cancel'),
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await invoke<{ pushed: Pushed }>('rules.serverPush', { account: chosen, overwrite })
      if (res.pushed.outcome === 'changedElsewhere') {
        setOnServer(res.pushed.onServer)
      } else {
        showToast(
          res.pushed.active
            ? t('serverRules.active', { defaultValue: 'The server now applies these rules' })
            : t('serverRules.storedInactive', {
                name: res.pushed.otherActive ?? '',
                defaultValue:
                  'Stored, but not switched on: the server runs another script ({name}), which Oreneta leaves alone',
              }),
          res.pushed.active ? 'success' : 'error',
        )
        await look()
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await invoke('rules.serverRemove', { account: chosen })
      showToast(t('serverRules.removed', { defaultValue: 'The rules run here again' }))
      await look()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (accounts.length === 0) return null

  return (
    <section
      aria-label={t('serverRules.title', { defaultValue: 'Rules on the server' })}
      className="mt-3 flex flex-col gap-2 rounded-control border border-border px-3 py-2.5 text-caption"
    >
      <p className="flex items-center gap-1.5 font-semibold text-primary">
        <Server size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('serverRules.title', { defaultValue: 'Rules on the server' })}
      </p>
      <p className="text-secondary">
        {t('serverRules.hint', {
          defaultValue:
            'On servers that offer ManageSieve, the rules can run on the server, even with Oreneta closed. A rule the server would read differently stays here, whole.',
        })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('serverRules.account', { defaultValue: 'Account' })}
          value={chosen}
          onChange={(e) => {
            setAccount(e.target.value)
            setAnswer(null)
          }}
          className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void look()}>
          {t('serverRules.look', { defaultValue: 'Check the server' })}
        </Button>
      </div>
      {answer && !answer.available && <p className="text-secondary">{answer.reason}</p>}
      {answer?.available && (
        <div className="flex flex-col gap-1.5">
          <p className="text-primary">
            {answer.status.ours === 'none'
              ? t('serverRules.none', { defaultValue: 'No Oreneta rules on this server yet.' })
              : answer.status.ours === 'current'
                ? answer.status.oursActive
                  ? t('serverRules.current', { defaultValue: 'The server applies the rules Oreneta wrote.' })
                  : t('serverRules.currentInactive', {
                      name: answer.status.otherActive ?? '',
                      defaultValue: 'Oreneta’s rules are stored but not switched on; the server runs {name}.',
                    })
                : t('serverRules.changed', {
                    defaultValue: 'The copy on the server was changed elsewhere since Oreneta wrote it.',
                  })}
          </p>
          <p className="text-secondary">
            {t('serverRules.wouldGo', {
              count: answer.plan.included.length,
              defaultValue: '{count} rules can run on the server.',
            })}
          </p>
          {answer.plan.left.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {answer.plan.left.map((left) => (
                <li key={left.id} className="text-secondary">
                  {t('serverRules.staysHere', { name: left.name, defaultValue: '“{name}” stays here:' })}{' '}
                  {left.reasons.join('; ')}
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary className="cursor-pointer text-secondary">
              {t('serverRules.script', { defaultValue: 'The script as it would be stored' })}
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-control-sm bg-hover p-2 font-mono text-2xs">
              {answer.plan.script}
            </pre>
          </details>
          {onServer !== null && (
            <div role="alert" className="flex flex-col gap-1 rounded-control-sm border border-border p-2">
              <p className="text-primary">
                {t('serverRules.changedShown', {
                  defaultValue:
                    'Not replaced: the copy on the server was changed elsewhere. This is what it holds now:',
                })}
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-2xs">{onServer}</pre>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void push(true)}>
                {t('serverRules.overwrite', { defaultValue: 'Replace it with Oreneta’s rules' })}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || answer.plan.included.length === 0} onClick={() => void push(false)}>
              {t('serverRules.push', { defaultValue: 'Run on the server' })}
            </Button>
            {answer.status.ours !== 'none' && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void remove()}>
                {t('serverRules.remove', { defaultValue: 'Take them off the server' })}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
