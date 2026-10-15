import { describe, expect, it } from 'bun:test'
import {
  connectivityAccountLabel,
  proxyEndpointFromSyncError,
  proxyProblemFromSyncError,
  proxySettingsTarget,
  unusableProxyScopeFromSyncError,
} from './connectivityBannerHelpers'

const accounts = [
  { id: 'one', display_name: 'Ping Chen', email: 'ping.one@example.com' },
  { id: 'two', display_name: 'Ping Chen', email: 'ping.two@example.com' },
  { id: 'three', display_name: 'Ada', email: 'ada@example.com' },
]

describe('connectivityAccountLabel', () => {
  it('adds the email address when display names collide', () => {
    expect(connectivityAccountLabel('one', accounts)).toBe('Ping Chen (ping.one@example.com)')
    expect(connectivityAccountLabel('two', accounts)).toBe('Ping Chen (ping.two@example.com)')
  })

  it('keeps a unique display name concise and falls back safely', () => {
    expect(connectivityAccountLabel('three', accounts)).toBe('Ada')
    expect(connectivityAccountLabel('missing', accounts)).toBe('missing')
    expect(connectivityAccountLabel(null, accounts)).toBeNull()
  })
})

describe('proxyEndpointFromSyncError', () => {
  it('extracts proxy endpoints from connection and handshake errors', () => {
    expect(
      proxyEndpointFromSyncError(
        'sync inbox: connect to proxy 127.0.0.1:1: tcp connect: connect 127.0.0.1:1: Connection refused',
      ),
    ).toBe('127.0.0.1:1')
    expect(
      proxyEndpointFromSyncError('sync inbox: socks5 proxy proxy.example:1080 to imap.example:993: timed out'),
    ).toBe('proxy.example:1080')
    expect(proxyEndpointFromSyncError('sync inbox: connect to proxy [::1]:9050: Connection refused')).toBe('[::1]:9050')
  })

  it('does not misclassify a mail-server failure', () => {
    expect(proxyEndpointFromSyncError('sync inbox: connect imap.example:993: timed out')).toBeNull()
  })
})

describe('unusableProxyScopeFromSyncError', () => {
  it('reads whose proxy setting the core refused (#201)', () => {
    expect(
      unusableProxyScopeFromSyncError(
        "sync INBOX: proxy setting unusable (app): the app's proxy is incomplete (server or port missing)",
      ),
    ).toBe('app')
    expect(
      unusableProxyScopeFromSyncError(
        `folders sync: proxy setting unusable (account): this account's proxy has an unknown type "ftp"`,
      ),
    ).toBe('account')
    expect(unusableProxyScopeFromSyncError('folders sync: Microsoft Graph: proxy setting unusable (app)')).toBe('app')
    expect(unusableProxyScopeFromSyncError('Graph authorization: proxy setting unusable (account)')).toBe('account')
  })

  it('does not take other failures, or an unknown scope, for a refusal', () => {
    expect(unusableProxyScopeFromSyncError('sync INBOX: connect to proxy 127.0.0.1:1: Connection refused')).toBeNull()
    expect(unusableProxyScopeFromSyncError('Microsoft Graph: Transport')).toBeNull()
    expect(unusableProxyScopeFromSyncError('proxy setting unusable (other): x')).toBeNull()
    expect(unusableProxyScopeFromSyncError('')).toBeNull()
  })
})

describe('proxyProblemFromSyncError and proxySettingsTarget', () => {
  const follows = { id: 'work' }
  const own = { id: 'home', proxy: { mode: 'socks5' } }

  it('sends a refusal to the setting it names, whatever the account uses', () => {
    const app = proxyProblemFromSyncError('x: proxy setting unusable (app): y')!
    expect(app).toEqual({ kind: 'unusable', scope: 'app' })
    expect(proxySettingsTarget(app, own)).toEqual({ section: 'network', accountId: '' })
    const account = proxyProblemFromSyncError('x: proxy setting unusable (account): y')!
    expect(proxySettingsTarget(account, follows)).toEqual({ section: 'accountNetwork', accountId: 'work' })
  })

  it("sends a proxy that did not answer to the account's own proxy, or else the app's", () => {
    const unreachable = proxyProblemFromSyncError('sync INBOX: connect to proxy 127.0.0.1:1: refused')!
    expect(unreachable).toEqual({ kind: 'unreachable', endpoint: '127.0.0.1:1' })
    expect(proxySettingsTarget(unreachable, own)).toEqual({ section: 'accountNetwork', accountId: 'home' })
    expect(proxySettingsTarget(unreachable, follows)).toEqual({ section: 'network', accountId: '' })
    expect(proxySettingsTarget(unreachable, { id: 'x', proxy: { mode: 'global' } })).toEqual({
      section: 'network',
      accountId: '',
    })
  })

  it("is null for a failure that is not the proxy's", () => {
    expect(proxyProblemFromSyncError('sync inbox: connect imap.example:993: timed out')).toBeNull()
  })
})
