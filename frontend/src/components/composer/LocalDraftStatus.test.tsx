import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { accounts$ } from '../../states/accounts'
import {
  compose$,
  finishClosingMessageTab,
  openComposeTab,
  restoreLocalDrafts,
  updateComposeDraft,
} from '../../states/compose'
import {
  draftDocument,
  localDrafts$,
  resetLocalDraftsForTests,
  setLocalDraftDebounceForTests,
} from '../../states/localDraftSync'
import { ui$ } from '../../states/ui'
import { LocalDraftStatus } from './LocalDraftStatus'

type Row = { revision: number; deleted: boolean; document: any }

describe('the composer and its local copy (#170)', () => {
  let calls: { command: string; payload: any }[]
  let store: Map<string, Row>

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })

  beforeEach(() => {
    calls = []
    store = new Map()
    compose$.tabs.set([])
    compose$.activeTab.set('')
    resetLocalDraftsForTests()
    setLocalDraftDebounceForTests(0)
    ui$.selectedAccount.set('a')
    accounts$.set([
      {
        id: 'a',
        email: 'a@example.com',
        display_name: 'A',
        provider: 'custom',
        auth_type: 'password',
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 465,
        tls: true,
      } as any,
    ])
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            calls.push({ command, payload })
            if (command === 'localDrafts.list')
              return {
                drafts: [...store.entries()]
                  .filter(([, row]) => !row.deleted)
                  .map(([id, row]) => ({ id, revision: row.revision })),
              }
            if (command === 'localDrafts.save' || command === 'localDrafts.delete') {
              const row = store.get(payload.id)
              const revision = row?.revision ?? 0
              if (payload.expected_revision !== revision || row?.deleted)
                return { applied: false, revision, deleted: !!row?.deleted }
              const deleted = command === 'localDrafts.delete'
              store.set(payload.id, { revision: revision + 1, deleted, document: deleted ? null : payload.document })
              return { applied: true, revision: revision + 1, deleted }
            }
            if (command === 'localDrafts.get') {
              const row = store.get(payload.id)
              return { draft: row ? { id: payload.id, ...row } : null }
            }
            return {}
          },
        },
      },
    }
  })

  afterEach(() => {
    cleanup()
    compose$.tabs.set([])
    resetLocalDraftsForTests()
    setLocalDraftDebounceForTests(600)
    delete (window as any).go
  })

  it('a new message is kept as it is typed, and closing it deletes the copy', async () => {
    expect(await restoreLocalDrafts(0)).toBe(true)
    const id = openComposeTab({ to: 'x@example.com', subject: 'Hello', text: 'hi' })!
    await settle()
    expect(store.get(id)?.document.compose.text).toBe('hi')

    updateComposeDraft(id, { text: 'hi there' })
    await settle()
    expect(store.get(id)?.revision).toBe(2)
    expect(store.get(id)?.document.compose.text).toBe('hi there')

    finishClosingMessageTab(id)
    await settle()
    expect(store.get(id)).toEqual({ revision: 3, deleted: true, document: null })
  })

  it('inline images of a draft only the store holds are not pruned as orphans at startup', async () => {
    store.set('compose-7', {
      revision: 2,
      deleted: false,
      document: draftDocument({
        id: 'compose-7',
        kind: 'compose',
        messageId: '',
        threadId: '',
        subject: 'Photos',
        from: '',
        body: '',
        viewMode: 'plain',
        compose: {
          accountId: 'a',
          fromEmail: '',
          to: 'x@example.com',
          cc: '',
          bcc: '',
          replyTo: '',
          subject: 'Photos',
          rich: true,
          html: '<p><img src="/media/pasted-123.png"></p>',
          text: '',
          showCcBcc: false,
          inReplyTo: '',
          references: '',
          draftMessageId: 'd@example.com',
          attachments: [],
          pgpSign: false,
          pgpEncrypt: false,
        },
      }),
    })
    expect(await restoreLocalDrafts(0)).toBe(true)
    await settle()
    const prune = calls.find((call) => call.command === 'composer.pruneMedia')
    expect(prune?.payload).toEqual({ keys: ['pasted-123.png'] })
    // And the list was read before anything was pruned.
    const order = calls.map((call) => call.command)
    expect(order.indexOf('localDrafts.list')).toBeLessThan(order.indexOf('composer.pruneMedia'))
  })

  it('startup that cannot reach the store gives up after its retries and writes nothing', async () => {
    ;(window as any).go.main.App.Invoke = async (command: string) => {
      calls.push({ command, payload: null })
      throw new Error('core not ready')
    }
    const originalError = console.error
    console.error = () => {}
    try {
      expect(await restoreLocalDrafts(1, 1)).toBe(false)
    } finally {
      console.error = originalError
    }
    expect(calls.map((call) => call.command)).toEqual(['localDrafts.list', 'localDrafts.list'])
    expect(localDrafts$.hydrated.peek()).toBe(false)
  })

  it('shows that a copy is kept, an error in full, and a conflict with the way out', async () => {
    const view = render(<LocalDraftStatus tabId="compose-1" />)
    expect(view.container.textContent).toBe('')

    act(() => localDrafts$.status['compose-1'].set({ state: 'saved' }))
    expect(view.getByRole('status').textContent).toBe('Copy kept on this device')

    act(() => localDrafts$.status['compose-1'].set({ state: 'error', error: 'local draft attachments exceed limit' }))
    expect(view.getByRole('alert').textContent).toBe(
      'Could not keep a copy on this device: local draft attachments exceed limit',
    )

    act(() => localDrafts$.status['compose-1'].set({ state: 'conflict', conflict: 'discarded' }))
    expect(view.getByRole('alert').textContent).toContain('discarded elsewhere')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('keep this version writes what the composer shows over the newer copy', async () => {
    expect(await restoreLocalDrafts(0)).toBe(true)
    const id = openComposeTab({ to: 'x@example.com', subject: 'Hello', text: 'mine' })!
    await settle()
    store.set(id, { revision: 7, deleted: false, document: { from: 'another window' } })
    updateComposeDraft(id, { text: 'mine, edited' })
    await settle()
    expect(localDrafts$.status[id].peek()).toEqual({ state: 'conflict', conflict: 'newer' })

    const view = render(<LocalDraftStatus tabId={id} />)
    expect(view.getByRole('alert').textContent).toContain('newer copy')
    fireEvent.click(view.getByRole('button', { name: 'Keep this version' }))
    await settle()
    expect(store.get(id)?.revision).toBe(8)
    expect(store.get(id)?.document.compose.text).toBe('mine, edited')
    expect(view.getByRole('status').textContent).toBe('Copy kept on this device')
  })
})
