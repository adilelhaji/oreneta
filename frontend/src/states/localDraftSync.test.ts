import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  decodedSize,
  discardLocalDraft,
  draftDocument,
  flushLocalDrafts,
  hydrateLocalDrafts,
  keepThisVersion,
  localDrafts$,
  resetLocalDraftsForTests,
  scheduleLocalDraftSave,
  setLocalDraftDebounceForTests,
  tabFromDocument,
} from './localDraftSync'
import type { ComposeDraft, MessageTab } from '../types'

// The core's rules, as meron-core/src/store/local_drafts.rs applies them: a
// write names the revision it expects, a mismatch or a tombstone is refused
// without changing anything, and a delete leaves a tombstone behind.
type Row = { revision: number; deleted: boolean; document: any }
let store: Map<string, Row>
let calls: { command: string; payload: any }[]
let failNext: Record<string, string>
let holdSave: Promise<void> | null

function fakeCore() {
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload: structuredClone(payload) })
          if (failNext[command]) {
            const message = failNext[command]
            delete failNext[command]
            throw new Error(message)
          }
          if (command === 'localDrafts.save' || command === 'localDrafts.delete') {
            if (command === 'localDrafts.save' && holdSave) await holdSave
            const current = store.get(payload.id)
            const revision = current?.revision ?? 0
            const deleted = current?.deleted ?? false
            if (payload.expected_revision !== revision || deleted) return { applied: false, revision, deleted }
            const removing = command === 'localDrafts.delete'
            store.set(payload.id, {
              revision: revision + 1,
              deleted: removing,
              document: removing ? null : structuredClone(payload.document),
            })
            return { applied: true, revision: revision + 1, deleted: removing }
          }
          if (command === 'localDrafts.get') {
            const row = store.get(payload.id)
            return { draft: row ? { id: payload.id, ...structuredClone(row) } : null }
          }
          if (command === 'localDrafts.list') {
            return {
              drafts: [...store.entries()]
                .filter(([, row]) => !row.deleted)
                .map(([id, row]) => ({ id, revision: row.revision })),
            }
          }
          throw new Error(`unexpected ${command}`)
        },
      },
    },
  }
}

const draft = (overrides: Partial<ComposeDraft> = {}): ComposeDraft => ({
  accountId: 'acc',
  fromEmail: '',
  to: 'ana@example.com',
  cc: '',
  bcc: '',
  replyTo: '',
  subject: 'Quarterly numbers',
  rich: false,
  html: '',
  text: 'Draft body',
  showCcBcc: false,
  inReplyTo: '',
  references: '',
  draftMessageId: 'draft-1@example.com',
  attachments: [],
  pgpSign: false,
  pgpEncrypt: false,
  ...overrides,
})

const tab = (id: string, overrides: Partial<ComposeDraft> = {}): MessageTab => ({
  id,
  kind: 'compose',
  messageId: '',
  threadId: '',
  subject: overrides.subject ?? 'Quarterly numbers',
  from: '',
  body: '',
  viewMode: 'plain',
  compose: draft(overrides),
})

// "hello world" — 11 bytes, one byte of padding.
const HELLO = 'aGVsbG8gd29ybGQ='

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const saves = () => calls.filter((call) => call.command === 'localDrafts.save')

describe('local drafts kept in the core store (#170)', () => {
  beforeEach(() => {
    store = new Map()
    calls = []
    failNext = {}
    holdSave = null
    resetLocalDraftsForTests()
    setLocalDraftDebounceForTests(0)
    fakeCore()
  })

  afterEach(() => {
    resetLocalDraftsForTests()
    setLocalDraftDebounceForTests(600)
  })

  it('counts the bytes a base64 string decodes to exactly, as the store checks', () => {
    expect(decodedSize('')).toBe(0)
    expect(decodedSize(HELLO)).toBe(11)
    expect(decodedSize('YWJj')).toBe(3)
    expect(decodedSize('YQ==')).toBe(1)
  })

  it('writes nothing before the stored drafts have been read back', async () => {
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    expect(saves()).toHaveLength(0)
  })

  it('keeps the whole draft, files included, and each write names the last revision', async () => {
    await hydrateLocalDrafts(() => [])
    const withFile = tab('compose-1', {
      attachments: [{ id: 'a1', filename: 'notes.txt', mime: 'text/plain', size: 11, data: HELLO }],
    })
    scheduleLocalDraftSave(withFile)
    await settle()
    expect(store.get('compose-1')?.revision).toBe(1)
    expect(store.get('compose-1')?.document.compose.attachments[0]).toEqual({
      id: 'a1',
      filename: 'notes.txt',
      mime: 'text/plain',
      size: 11,
      data: HELLO,
    })
    expect(localDrafts$.status['compose-1'].peek()).toEqual({ state: 'saved' })

    scheduleLocalDraftSave(tab('compose-1', { text: 'Changed' }))
    await settle()
    expect(saves().map((call) => call.payload.expected_revision)).toEqual([0, 1])
    expect(store.get('compose-1')?.document.compose.text).toBe('Changed')
  })

  it('skips a write that would store what is already stored', async () => {
    await hydrateLocalDrafts(() => [])
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    expect(saves()).toHaveLength(1)
  })

  it('waits out a pause in typing and writes only the last state', async () => {
    setLocalDraftDebounceForTests(20)
    await hydrateLocalDrafts(() => [])
    scheduleLocalDraftSave(tab('compose-1', { text: 'H' }))
    scheduleLocalDraftSave(tab('compose-1', { text: 'He' }))
    scheduleLocalDraftSave(tab('compose-1', { text: 'Hello' }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    await settle()
    expect(saves()).toHaveLength(1)
    expect(store.get('compose-1')?.document.compose.text).toBe('Hello')
  })

  it('flushes a pending write at once when the app closes', async () => {
    setLocalDraftDebounceForTests(60_000)
    await hydrateLocalDrafts(() => [])
    const pending = tab('compose-1', { text: 'Typed just before quitting' })
    scheduleLocalDraftSave(pending)
    await flushLocalDrafts([pending])
    expect(store.get('compose-1')?.document.compose.text).toBe('Typed just before quitting')
  })

  it('a newer copy elsewhere stops autosave; nothing is overwritten until the reader keeps this version', async () => {
    await hydrateLocalDrafts(() => [])
    scheduleLocalDraftSave(tab('compose-1', { text: 'Mine' }))
    await settle()
    // Another window writes revision 2.
    store.set('compose-1', { revision: 2, deleted: false, document: { other: true } })

    scheduleLocalDraftSave(tab('compose-1', { text: 'Mine, edited' }))
    await settle()
    expect(store.get('compose-1')?.document).toEqual({ other: true })
    expect(localDrafts$.status['compose-1'].peek()).toEqual({ state: 'conflict', conflict: 'newer' })

    // Paused: further typing writes nothing.
    scheduleLocalDraftSave(tab('compose-1', { text: 'Mine, edited again' }))
    await settle()
    expect(store.get('compose-1')?.document).toEqual({ other: true })

    await keepThisVersion(tab('compose-1', { text: 'Mine, kept' }))
    expect(store.get('compose-1')?.revision).toBe(3)
    expect(store.get('compose-1')?.document.compose.text).toBe('Mine, kept')
    expect(localDrafts$.status['compose-1'].peek()).toEqual({ state: 'saved' })
  })

  it('a draft discarded elsewhere is said so, and its tombstone is never written over', async () => {
    await hydrateLocalDrafts(() => [])
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    store.set('compose-1', { revision: 2, deleted: true, document: null })

    scheduleLocalDraftSave(tab('compose-1', { text: 'Edited' }))
    await settle()
    expect(localDrafts$.status['compose-1'].peek()).toEqual({ state: 'conflict', conflict: 'discarded' })
    await keepThisVersion(tab('compose-1', { text: 'Edited' }))
    expect(store.get('compose-1')).toEqual({ revision: 2, deleted: true, document: null })
    expect(localDrafts$.status['compose-1'].peek()?.conflict).toBe('discarded')
  })

  it('a failed write is reported and the next change tries again', async () => {
    await hydrateLocalDrafts(() => [])
    failNext['localDrafts.save'] = 'local draft attachments exceed limit'
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    expect(localDrafts$.status['compose-1'].peek()).toEqual({
      state: 'error',
      error: 'local draft attachments exceed limit',
    })
    expect(store.has('compose-1')).toBe(false)

    // Even the same content is written again: the failed one never landed.
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    expect(store.get('compose-1')?.revision).toBe(1)
    expect(localDrafts$.status['compose-1'].peek()).toEqual({ state: 'saved' })
  })

  it('closing the tab deletes the copy after a write in flight, and that write cannot bring it back', async () => {
    await hydrateLocalDrafts(() => [])
    let release!: () => void
    holdSave = new Promise((resolve) => (release = resolve))
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    discardLocalDraft('compose-1')
    // Typing after close (a late onChange) is ignored.
    scheduleLocalDraftSave(tab('compose-1', { text: 'late' }))
    release()
    holdSave = null
    await settle()

    expect(calls.map((call) => call.command)).toEqual(['localDrafts.list', 'localDrafts.save', 'localDrafts.delete'])
    expect(calls[2].payload).toEqual({ id: 'compose-1', expected_revision: 1 })
    expect(store.get('compose-1')).toEqual({ revision: 2, deleted: true, document: null })
    expect(localDrafts$.status['compose-1'].peek()).toBeUndefined()
  })

  it('a pending write is dropped when the tab closes before it starts', async () => {
    setLocalDraftDebounceForTests(60_000)
    await hydrateLocalDrafts(() => [])
    scheduleLocalDraftSave(tab('compose-1'))
    discardLocalDraft('compose-1')
    await settle()
    // Nothing of this tab was ever stored, so nothing is deleted either.
    expect(saves()).toHaveLength(0)
    expect(calls.some((call) => call.command === 'localDrafts.delete')).toBe(false)
  })

  it('brings stored drafts back at startup with their files, in place of the text-only copy', async () => {
    const stored = tab('compose-1', {
      text: 'Stored body',
      attachments: [{ id: 'a1', filename: 'notes.txt', mime: 'text/plain', size: 11, data: HELLO }],
    })
    store.set('compose-1', { revision: 4, deleted: false, document: draftDocument(stored) })
    store.set('compose-2', {
      revision: 1,
      deleted: false,
      document: draftDocument(tab('compose-2', { subject: 'Only in the store' })),
    })
    const legacy = tab('compose-1', { text: 'Stored body' })

    const tabs = await hydrateLocalDrafts(() => [legacy])
    expect(tabs.map((t) => t.id)).toEqual(['compose-1', 'compose-2'])
    expect(tabs[0].compose?.attachments).toEqual([
      { id: 'a1', filename: 'notes.txt', mime: 'text/plain', size: 11, data: HELLO },
    ])
    expect(tabs[1].subject).toBe('Only in the store')
    expect(localDrafts$.hydrated.peek()).toBe(true)
    await settle()
    // Already stored: nothing is written back.
    expect(saves()).toHaveLength(0)

    // The next change continues from the stored revision.
    scheduleLocalDraftSave({ ...tabs[0], compose: { ...tabs[0].compose!, text: 'Edited' } })
    await settle()
    expect(saves()[0].payload.expected_revision).toBe(4)
    expect(store.get('compose-1')?.revision).toBe(5)
  })

  it('migrates a tab that only localStorage had into the store', async () => {
    const legacy = tab('compose-9', { text: 'From before #170' })
    const tabs = await hydrateLocalDrafts(() => [legacy])
    expect(tabs).toEqual([legacy])
    expect(store.has('compose-9')).toBe(false)
    await settle()
    expect(store.get('compose-9')?.document.compose.text).toBe('From before #170')
    expect(localDrafts$.status['compose-9'].peek()).toEqual({ state: 'saved' })
  })

  it('a tab closed before startup read the store is deleted then, not brought back', async () => {
    store.set('compose-1', { revision: 3, deleted: false, document: draftDocument(tab('compose-1')) })
    discardLocalDraft('compose-1')
    expect(calls).toHaveLength(0)

    const tabs = await hydrateLocalDrafts(() => [])
    expect(tabs).toEqual([])
    expect(store.get('compose-1')).toEqual({ revision: 4, deleted: true, document: null })
  })

  it('an unreadable stored draft is reported, never shown as an empty one', async () => {
    store.set('compose-1', { revision: 1, deleted: false, document: draftDocument(tab('compose-1')) })
    failNext['localDrafts.get'] = 'invalid stored local draft document'
    const tabs = await hydrateLocalDrafts(() => [])
    expect(tabs).toEqual([])
    expect(localDrafts$.status['compose-1'].peek()).toEqual({
      state: 'error',
      error: 'invalid stored local draft document',
    })
  })

  it('a failed listing leaves startup to try again and writes nothing meanwhile', async () => {
    failNext['localDrafts.list'] = 'core not ready'
    await expect(hydrateLocalDrafts(() => [tab('compose-1')])).rejects.toThrow('core not ready')
    expect(localDrafts$.hydrated.peek()).toBe(false)
    scheduleLocalDraftSave(tab('compose-1'))
    await settle()
    expect(saves()).toHaveLength(0)
  })

  it('reads the open tabs after the store, so one opened meanwhile is kept', async () => {
    let open = [tab('compose-1')]
    const pending = hydrateLocalDrafts(() => open)
    open = [...open, tab('compose-2')]
    const tabs = await pending
    expect(tabs.map((t) => t.id)).toEqual(['compose-1', 'compose-2'])
  })

  it('round-trips a document into the same tab', () => {
    const original = tab('compose-1', {
      rich: true,
      html: '<p>Hi</p>',
      attachments: [{ id: 'img', filename: 'a.png', mime: 'image/png', size: 11, data: HELLO, inlineId: 'cid-1' }],
    })
    const back = tabFromDocument('compose-1', draftDocument(original)!)
    expect(back?.compose).toEqual(original.compose)
    expect(back?.subject).toBe(original.subject)
  })

  it('only compose tabs with a valid identifier are kept', async () => {
    await hydrateLocalDrafts(() => [])
    scheduleLocalDraftSave({ ...tab('compose-1'), kind: 'reader' })
    scheduleLocalDraftSave(tab('bad id with spaces'))
    await settle()
    expect(saves()).toHaveLength(0)
  })
})
