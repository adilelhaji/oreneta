import { beforeEach, expect, it } from 'bun:test'
import { accounts$ } from './accounts'
import { connectivity$, forgetProxyProblems, setSyncError, syncObservation } from './connectivity'
import type { Account } from '../types'

const account = (id: string, proxy?: Account['proxy']) =>
  ({ id, email: `${id}@example.test`, display_name: id, provider: 'imap', auth_type: 'password', proxy }) as Account

const own = { mode: 'socks5', host: 'proxy.own', port: 1080 } as const
const appRefusal = 'sync INBOX: proxy setting unusable (app): the app proxy is incomplete'
const accountRefusal = 'sync INBOX: proxy setting unusable (account): this account proxy is incomplete'

beforeEach(() => {
  accounts$.set([account('app'), account('own', own), account('follows'), account('reaches', own)])
  connectivity$.set({ byAccount: {}, unattributed: null })
  setSyncError('app', appRefusal)
  setSyncError('own', accountRefusal)
  // A proxy that did not answer: the app's for an account that follows it,
  // the account's own for one that has its own.
  setSyncError('follows', 'sync INBOX: connect to proxy 10.0.0.1:3128: Connection refused')
  setSyncError('reaches', 'sync INBOX: connect to proxy proxy.own:1080: Connection refused')
  setSyncError(null, appRefusal)
})

it('saving the app-wide proxy forgets only the failures it was blamed for (#201)', () => {
  forgetProxyProblems()
  expect(syncObservation('app')?.proxy).toBeNull()
  expect(syncObservation('follows')?.proxy).toBeNull()
  expect(connectivity$.unattributed.peek()?.proxy).toBeNull()
  expect(syncObservation('own')?.proxy).toEqual({ kind: 'unusable', scope: 'account' })
  expect(syncObservation('reaches')?.proxy).toEqual({ kind: 'unreachable', endpoint: 'proxy.own:1080' })
  // Still failures, still unverified: only the blame is gone.
  expect(syncObservation('app')).toMatchObject({ failure: true, dismissed: false })
  expect(connectivity$.unattributed.peek()?.failure).toBe(true)
})

it("saving one account's proxy forgets that account's proxy failure only", () => {
  forgetProxyProblems('own')
  expect(syncObservation('own')).toMatchObject({ failure: true, proxy: null })
  expect(syncObservation('reaches')?.proxy).not.toBeNull()
  expect(syncObservation('app')?.proxy).not.toBeNull()
  expect(syncObservation('follows')?.proxy).not.toBeNull()
  // A failure with no account is not that account's.
  expect(connectivity$.unattributed.peek()?.proxy).not.toBeNull()
})

it('changes nothing when no failure blamed a proxy', () => {
  connectivity$.set({ byAccount: {}, unattributed: null })
  setSyncError('app', 'sync INBOX: connect imap.example:993: timed out')
  const before = connectivity$.peek()
  forgetProxyProblems()
  forgetProxyProblems('app')
  expect(connectivity$.peek()).toEqual(before)
})
