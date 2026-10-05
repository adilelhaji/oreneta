import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { accounts$ } from '../src/states/accounts'
import {
  connectivity$,
  dismissSyncError,
  recordMailActivity,
  requestAccountSync,
  retainSyncAccounts,
  setSyncError,
  syncObservation,
} from '../src/states/connectivity'
import { createFixture } from './fixtures'

const account = { ...createFixture().account, id: 'one', paused: false }
const originalGo = (window as any).go
const requests: unknown[] = []
let reply: () => Promise<unknown>
beforeEach(() => {
  accounts$.set([account, { ...account, id: 'two' }])
  connectivity$.set({ byAccount: {}, unattributed: null })
  requests.length = 0
  reply = async () => ({ online: true })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: unknown) => {
          requests.push({ command, payload })
          return reply()
        },
      },
    },
  }
})
afterEach(() => {
  ;(window as any).go = originalGo
})

describe('session account sync observations', () => {
  it('preserves simultaneous failures and dismissal without storing diagnostics', () => {
    setSyncError('one', 'secret-synthetic-token')
    setSyncError('two', 'another failure')
    dismissSyncError('one')
    expect(syncObservation('one')).toMatchObject({ failure: true, dismissed: true })
    expect(syncObservation('two')).toMatchObject({ failure: true, dismissed: false })
    expect(JSON.stringify(connectivity$.peek())).not.toContain('secret-synthetic-token')
    setSyncError('one', 'new failure')
    expect(syncObservation('one')?.dismissed).toBe(false)
  })
  it('never resolves failures from partial, unrelated or unattributed activity', () => {
    setSyncError('one')
    setSyncError(null)
    recordMailActivity('two')
    recordMailActivity('one')
    recordMailActivity(null)
    expect(syncObservation('one')?.failure).toBe(true)
    expect(syncObservation('one')?.lastActivityAt).toBeNumber()
    expect(syncObservation('two')?.failure).toBe(false)
    expect(connectivity$.unattributed.peek()?.failure).toBe(true)
    dismissSyncError(null)
    expect(connectivity$.unattributed.peek()?.dismissed).toBe(true)
  })
  it('does not mistake an accepted queued request for activity or recovery', async () => {
    setSyncError('one')
    await requestAccountSync('one')
    expect(requests).toEqual([{ command: 'mail.sync', payload: { account_id: 'one' } }])
    expect(syncObservation('one')).toMatchObject({ failure: true, lastActivityAt: null, request: 'requested' })
    expect(syncObservation('two')).toBeUndefined()
  })
  it('reports false, missing and rejected confirmations without raw error leakage', async () => {
    for (const response of [{ ok: true, online: false }, { ok: true }, null]) {
      reply = async () => response
      await requestAccountSync('one')
      expect(syncObservation('one')?.request).toBe('unconfirmed')
    }
    reply = async () => {
      throw new Error('secret-synthetic-token')
    }
    await requestAccountSync('one')
    expect(syncObservation('one')?.request).toBe('unconfirmed')
    expect(JSON.stringify(connectivity$.peek())).not.toContain('secret-synthetic-token')
  })
  it('deduplicates in-flight requests and cannot overwrite a newer failure', async () => {
    let finish!: (value: unknown) => void
    reply = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = requestAccountSync('one')
    await requestAccountSync('one')
    expect(requests).toHaveLength(1)
    setSyncError('one')
    finish({ online: true })
    await pending
    expect(syncObservation('one')).toMatchObject({ failure: true, request: 'idle' })
  })
  it('prunes removed accounts and ignores late completion and stale events', async () => {
    let finish!: (value: unknown) => void
    reply = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = requestAccountSync('one')
    accounts$.set([{ ...account, id: 'two' }])
    retainSyncAccounts(['two'])
    setSyncError('one')
    recordMailActivity('one')
    finish({ online: true })
    await pending
    expect(syncObservation('one')).toBeUndefined()
  })
  it('does not retry removed, paused or authentication-required accounts, but permits Graph reads', async () => {
    await requestAccountSync('missing')
    for (const flags of [{ paused: true }, { needs_reconnect: true }]) {
      accounts$.set([{ ...account, ...flags }])
      await requestAccountSync('one')
    }
    expect(requests).toHaveLength(0)
    accounts$.set([{ ...account, auth_type: 'graph_oauth' }])
    await requestAccountSync('one')
    expect(requests).toEqual([{ command: 'mail.sync', payload: { account_id: 'one' } }])
  })
})
