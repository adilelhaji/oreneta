import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { accounts$ } from '../src/states/accounts'
import { connectivity$, requestAccountSync, setSyncError, syncObservation } from '../src/states/connectivity'
import { mail$, syncMail } from '../src/states/mail'
import { kanban$ } from '../src/states/kanban'
import { ui$ } from '../src/states/ui'
import i18n from '../src/lib/i18n'
import { createFixture } from './fixtures'

const account = { ...createFixture().account, id: 'one', paused: false }
const originalGo = (window as any).go
const calls: Array<{ command: string; payload: Record<string, unknown> }> = []
let respond: (id: string) => Promise<unknown>
let listReply: () => Promise<unknown>
beforeEach(() => {
  i18n.changeLanguage('en')
  accounts$.set([account])
  connectivity$.set({ byAccount: {}, unattributed: null })
  ui$.selectedAccount.set('one')
  ui$.selectedFolder.set('INBOX')
  ui$.query.set('')
  ui$.filters.set([])
  ui$.busy.set(false)
  ui$.toast.set('')
  kanban$.activeBoardId.set('')
  ui$.selectedThread.set('')
  mail$.threads.set([])
  mail$.readThreads.set({ preserved: true })
  calls.length = 0
  respond = async () => ({ ok: true, online: true })
  listReply = async () => ({ threads: [], pagination: 'conversation-v1' })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: Record<string, unknown>) => {
          if (command === 'app.prefsSet') return { ok: true }
          calls.push({ command, payload })
          if (command === 'mail.threadList') return listReply()
          return respond(String(payload.account_id))
        },
      },
    },
  }
})
afterEach(() => {
  ;(window as any).go = originalGo
  ui$.toast.set('')
  i18n.changeLanguage('en')
})

describe('shared manual mail refresh', () => {
  it('reports accepted requests without claiming completion or clearing a failure', async () => {
    setSyncError('one')
    await syncMail()
    expect(calls.filter((call) => call.command === 'mail.sync')).toEqual([
      { command: 'mail.sync', payload: { account_id: 'one' } },
    ])
    expect(ui$.toast.peek()).toBe('Request accepted; completion not verified')
    expect(syncObservation('one')).toMatchObject({ failure: true, lastActivityAt: null, request: 'requested' })
    expect(ui$.busy.peek()).toBe(false)
    expect(ui$.toastTone.peek()).toBe('info')
  })
  it('does not announce success for missing, false or rejected confirmation and hides raw errors', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const value of [{ ok: true, online: false }, { ok: true }, undefined]) {
        respond = async () => value
        await syncMail()
        expect(ui$.toast.peek()).toBe('Request not confirmed. Check the connection and account settings.')
        expect(ui$.toastTone.peek()).toBe('error')
      }
      respond = async () => {
        throw new Error('synthetic-private-diagnostic')
      }
      await syncMail()
      expect(ui$.toast.peek()).not.toContain('synthetic-private-diagnostic')
      expect(log).not.toHaveBeenCalled()
      expect(mail$.readThreads.peek()).toEqual({ preserved: true })
      expect(ui$.busy.peek()).toBe(false)
    } finally {
      log.mockRestore()
    }
  })
  it('counts unified mixed outcomes and only checks included, eligible accounts', async () => {
    accounts$.set([
      account,
      { ...account, id: 'two' },
      { ...account, id: 'paused', paused: true },
      { ...account, id: 'auth', needs_reconnect: true },
      { ...account, id: 'excluded', included_in_unified: false },
    ])
    ui$.selectedAccount.set('unified')
    respond = async (id) => ({ online: id === 'one' })
    await syncMail()
    expect(calls.filter((call) => call.command === 'mail.sync').map((call) => call.payload.account_id)).toEqual([
      'one',
      'two',
    ])
    expect(ui$.toast.peek()).toContain('1 accepted, 1 unconfirmed, 0 already pending, 2 skipped')
    expect(syncObservation('one')?.request).toBe('requested')
    expect(syncObservation('two')?.request).toBe('unconfirmed')
  })
  it('skips paused, authentication-required and removed accounts without a false success', async () => {
    for (const flags of [{ paused: true }, { needs_reconnect: true }]) {
      accounts$.set([{ ...account, ...flags }])
      await syncMail()
      expect(ui$.toast.peek()).toStartWith('No mail check requested.')
      expect(ui$.toastTone.peek()).toBe('info')
    }
    accounts$.set([])
    await syncMail()
    expect(calls).toHaveLength(0)
    ui$.selectedAccount.set('unified')
    await syncMail()
    expect(ui$.toast.peek()).toStartWith('No mail check requested.')
  })
  it('deduplicates repeated manual actions and reports an existing account-panel request', async () => {
    let finish!: (value: unknown) => void
    respond = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const manual = syncMail()
    await syncMail()
    expect(calls).toHaveLength(1)
    expect(ui$.busy.peek()).toBe(true)
    finish({ online: true })
    await manual
    const panel = requestAccountSync('one')
    await syncMail()
    expect(calls.filter((call) => call.command === 'mail.sync')).toHaveLength(2)
    expect(ui$.toast.peek()).toBe('Requesting a mail check…')
    expect(ui$.toastTone.peek()).toBe('info')
    finish({ online: true })
    await panel
  })
  it('does not show stale feedback after changing the account, folder or unified membership', async () => {
    for (const change of [
      () => ui$.selectedAccount.set('two'),
      () => ui$.selectedFolder.set('Sent'),
      () => accounts$.set([]),
    ]) {
      accounts$.set([account])
      ui$.selectedAccount.set('one')
      ui$.selectedFolder.set('INBOX')
      ui$.toast.set('')
      let finish!: (value: unknown) => void
      respond = () =>
        new Promise((resolve) => {
          finish = resolve
        })
      const pending = syncMail()
      change()
      finish({ online: true })
      await pending
      expect(ui$.toast.peek()).toBe('')
      expect(ui$.busy.peek()).toBe(false)
    }
  })
  it('retains a newer failure while the request is in flight', async () => {
    let finish!: (value: unknown) => void
    respond = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = syncMail()
    setSyncError('one')
    finish({ online: true })
    await pending
    expect(ui$.toastTone.peek()).toBe('error')
    expect(syncObservation('one')).toMatchObject({ failure: true, request: 'idle' })
  })
  it('supports localized feedback and Graph read requests without send operations', async () => {
    i18n.changeLanguage('es')
    accounts$.set([{ ...account, auth_type: 'graph_oauth' }])
    await syncMail()
    expect(ui$.toast.peek()).toBe('Solicitud aceptada; finalización sin verificar')
    expect(calls.map((call) => call.command)).toEqual(['mail.sync', 'mail.threadList'])
  })
  it('preserves server refresh for a custom folder, unified Sent and live search', async () => {
    for (const target of [
      { account: 'one', folder: 'Projects/Reviews', query: '' },
      { account: 'unified', folder: 'sent', query: '' },
      { account: 'one', folder: 'INBOX', query: 'subject:report' },
    ]) {
      ui$.selectedAccount.set(target.account)
      ui$.selectedFolder.set(target.folder)
      ui$.query.set(target.query)
      calls.length = 0
      await syncMail()
      const reads = calls.filter((call) => call.command === 'mail.threadList')
      expect(
        reads.some(
          ({ payload }) =>
            payload.refresh === true &&
            payload.account_id === target.account &&
            payload.folder_id === target.folder &&
            payload.query === target.query,
        ),
      ).toBe(true)
      if (target.query) expect(reads.some(({ payload }) => payload.refresh === false)).toBe(true)
    }
  })
  it('suppresses feedback after a late folder refresh or changed unified membership', async () => {
    let finish!: (value: unknown) => void
    listReply = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = syncMail()
    await new Promise((resolve) => setTimeout(resolve, 0))
    ui$.selectedFolder.set('Sent')
    finish({ threads: [] })
    await pending
    expect(ui$.toast.peek()).toBe('')
    ui$.selectedAccount.set('unified')
    respond = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const unified = syncMail()
    accounts$.set([{ ...account, included_in_unified: false }])
    finish({ online: true })
    await unified
    expect(ui$.toast.peek()).toBe('')
  })
  it('omits raw list-load diagnostics when scoped refresh fails', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      listReply = async () => {
        throw new Error('synthetic-private-diagnostic')
      }
      await syncMail()
      expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-diagnostic')
      expect(ui$.toast.peek()).not.toContain('synthetic-private-diagnostic')
      expect(ui$.toast.peek()).not.toBe('Synced')
    } finally {
      log.mockRestore()
    }
  })
})
