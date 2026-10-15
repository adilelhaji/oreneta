type AccountLabelSource = {
  id: string
  email: string
  display_name: string
}

export function connectivityAccountLabel(accountId: string | null, accounts: AccountLabelSource[]): string | null {
  if (!accountId) return null

  const account = accounts.find((candidate) => candidate.id === accountId)
  if (!account) return accountId

  const displayName = account.display_name.trim()
  const email = account.email.trim()
  if (!displayName) return email || account.id

  const duplicateName = accounts.some(
    (candidate) =>
      candidate.id !== account.id &&
      candidate.display_name.trim().localeCompare(displayName, undefined, { sensitivity: 'accent' }) === 0,
  )
  return duplicateName && email && email.localeCompare(displayName, undefined, { sensitivity: 'accent' }) !== 0
    ? `${displayName} (${email})`
    : displayName
}

// Core errors add one of these contexts around failures opening or negotiating
// the proxy connection. Extract only the host:port; the rest remains diagnostic
// detail in the log and may be too technical for the banner.
export function proxyEndpointFromSyncError(error: string): string | null {
  const endpoint = String.raw`(\[[^\]]+\]:\d+|[^\s:]+:\d+)`
  return (
    new RegExp(String.raw`\bconnect to proxy\s+${endpoint}`, 'i').exec(error)?.[1] ??
    new RegExp(String.raw`\b(?:http|socks5) proxy\s+${endpoint}`, 'i').exec(error)?.[1] ??
    null
  )
}

/** Whose proxy setting it is: the app-wide one or the account's own. */
export type ProxyScope = 'app' | 'account'

// The core refuses a proxy that was chosen but cannot be used (no server or
// port, an unknown type, a setting it could not read) with one form of text,
// defined as `UNUSABLE_PREFIX` in meron-core/src/proxy.rs (#201):
// "proxy setting unusable (app): …" or "proxy setting unusable (account): …".
// Change both together.
export function unusableProxyScopeFromSyncError(error: string): ProxyScope | null {
  const scope = /\bproxy setting unusable \((app|account)\)/.exec(error)?.[1]
  return scope === 'app' || scope === 'account' ? scope : null
}

/** A sync failure that was the proxy's: a setting the core refuses, or a proxy that did not answer. */
export type ProxyProblem = { kind: 'unusable'; scope: ProxyScope } | { kind: 'unreachable'; endpoint: string }

export function proxyProblemFromSyncError(error: string): ProxyProblem | null {
  const scope = unusableProxyScopeFromSyncError(error)
  if (scope) return { kind: 'unusable', scope }
  const endpoint = proxyEndpointFromSyncError(error)
  return endpoint ? { kind: 'unreachable', endpoint } : null
}

type ProxyAccount = { id: string; proxy?: { mode: string } }

/**
 * Where the person fixes a proxy problem: Settings → Network for the app-wide
 * proxy, or the account's own proxy settings. A refusal says whose setting it
 * is; for a proxy that did not answer, it is the account's own when the
 * account has one, otherwise the app-wide one it follows.
 */
export function proxyProblemScope(problem: ProxyProblem, account: ProxyAccount): ProxyScope {
  if (problem.kind === 'unusable') return problem.scope
  return account.proxy?.mode === 'http' || account.proxy?.mode === 'socks5' ? 'account' : 'app'
}

/** The settings section a proxy problem opens, as `focusSettingsSection` takes it. */
export function proxySettingsTarget(
  problem: ProxyProblem,
  account: ProxyAccount,
): { section: 'network' | 'accountNetwork'; accountId: string } {
  return proxyProblemScope(problem, account) === 'account'
    ? { section: 'accountNetwork', accountId: account.id }
    : { section: 'network', accountId: '' }
}
