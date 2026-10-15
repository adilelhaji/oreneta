import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { accounts$ } from './accounts'
import { settings$ } from './settings'
import { proxyProblemFromSyncError, proxyProblemScope, type ProxyProblem } from '../lib/proxyProblems'

export type SyncObservation = {
  failure: boolean
  dismissed: boolean
  lastActivityAt: number | null
  request: 'idle' | 'pending' | 'requested' | 'unconfirmed'
  revision: number
  // The last failure was the proxy's (#201), so the banner can say so and open
  // the setting that fixes it. Null for any other failure.
  proxy: ProxyProblem | null
}

// Session observations, not proof of complete mailbox/service freshness. Raw
// server diagnostics are deliberately not retained or rendered by this surface:
// of an error only whether it was the proxy's is kept, with the proxy's own
// address when it did not answer.
export const connectivity$ = observable({
  byAccount: {} as Record<string, SyncObservation>,
  unattributed: null as SyncObservation | null,
})
let revision = 0
const emptyObservation = (): SyncObservation => ({
  failure: false,
  dismissed: false,
  lastActivityAt: null,
  request: 'idle',
  revision: ++revision,
  proxy: null,
})

export function syncObservation(account: string): SyncObservation | undefined {
  const records = connectivity$.byAccount.peek()
  return Object.hasOwn(records, account) ? records[account] : undefined
}
function knownAccount(account: string) {
  return accounts$.peek().some((item) => item.id === account)
}
function store(account: string, observation: SyncObservation) {
  connectivity$.byAccount.set({ ...connectivity$.byAccount.peek(), [account]: observation })
}

export function setSyncError(account: string | null, message = '') {
  if (account && !knownAccount(account)) return
  const previous = account ? syncObservation(account) : connectivity$.unattributed.peek()
  const observation: SyncObservation = {
    ...(previous ?? emptyObservation()),
    failure: true,
    dismissed: false,
    request: 'idle',
    revision: ++revision,
    // Replaced, not merged: a later failure that is not the proxy's must not
    // keep sending the person to the proxy setting.
    proxy: proxyProblemFromSyncError(message),
  }
  if (account) store(account, observation)
  else connectivity$.unattributed.set(observation)
}

/**
 * A proxy setting was saved: the failures it may have caused no longer say
 * the proxy is at fault. They stay failures, unverified, until mail activity
 * or a new error says more. `account` names the account whose own setting
 * changed; without it, the app-wide proxy changed.
 */
export function forgetProxyProblems(account?: string) {
  const current = connectivity$.byAccount.peek()
  const accounts = accounts$.peek()
  const caused = (id: string, problem: ProxyProblem) =>
    account ? id === account : proxyProblemScope(problem, accounts.find((item) => item.id === id)) === 'app'
  const cleared = Object.entries(current).filter(([id, observation]) => observation.proxy && caused(id, observation.proxy))
  if (cleared.length) {
    connectivity$.byAccount.set({
      ...current,
      ...Object.fromEntries(cleared.map(([id, observation]) => [id, { ...observation, proxy: null }])),
    })
  }
  const unattributed = connectivity$.unattributed.peek()
  if (!account && unattributed?.proxy) connectivity$.unattributed.set({ ...unattributed, proxy: null })
}

// Every change to the app-wide proxy is saved as it is made (settings.ts).
settings$.proxy.onChange(() => forgetProxyProblems())

export function dismissSyncError(account: string | null) {
  const previous = account ? syncObservation(account) : connectivity$.unattributed.peek()
  if (!previous) return
  if (account) store(account, { ...previous, dismissed: true })
  else connectivity$.unattributed.set({ ...previous, dismissed: true })
}

// Errors have no structured folder scope. Even another successful folder from
// this account cannot resolve them. Unknown-account events cannot clear anything.
export function recordMailActivity(account: string | null) {
  if (!account || !knownAccount(account)) return
  store(account, { ...(syncObservation(account) ?? emptyObservation()), lastActivityAt: Date.now() })
}

export function retainSyncAccounts(accountIds: string[]) {
  const allowed = new Set(accountIds)
  const current = connectivity$.byAccount.peek()
  if (Object.keys(current).some((id) => !allowed.has(id))) {
    connectivity$.byAccount.set(Object.fromEntries(Object.entries(current).filter(([id]) => allowed.has(id))))
  }
}

export type SyncRequestOutcome = 'requested' | 'unconfirmed' | 'pending' | 'skipped'

export async function requestAccountSync(accountId: string): Promise<SyncRequestOutcome> {
  const account = accounts$.peek().find((item) => item.id === accountId)
  const previous = syncObservation(accountId)
  if (!account || account.paused || account.needs_reconnect) return 'skipped'
  if (previous?.request === 'pending') return 'pending'
  const requestRevision = ++revision
  store(accountId, { ...(previous ?? emptyObservation()), request: 'pending', revision: requestRevision })
  let accepted = false
  try {
    const result = await invoke<{ online?: boolean }>('mail.sync', { account_id: accountId })
    // The bridge may return ok:true/online:false; online:true only means queued.
    accepted = result?.online === true
  } catch {
    // Keep raw diagnostics out of UI/toasts; the record describes the uncertainty.
  }
  const latest = syncObservation(accountId)
  if (!knownAccount(accountId) || !latest || latest.revision !== requestRevision) return 'unconfirmed'
  const outcome = accepted ? 'requested' : 'unconfirmed'
  store(accountId, { ...latest, request: outcome })
  return outcome
}
