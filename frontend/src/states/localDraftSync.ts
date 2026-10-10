// Full-editor drafts kept in the core's durable local store (#170).
//
// The compose tabs were mirrored to localStorage as text only — attachments
// were dropped because their bytes would not fit — so a restart lost every
// attached file and anything typed after the last mirror. This keeps the
// whole draft, files included, in the encrypted store that #169 built:
// written after each pause in typing, with the revision the store returned
// last, so a second window or a late write cannot overwrite a newer copy;
// deleted (leaving a tombstone) when the tab closes, so a save still in
// flight cannot bring a sent or discarded draft back.
//
// Nothing here sends, uploads or touches a provider. The server Drafts copy
// is the composer's own business (mail.saveDraft) and is unchanged.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import type { ComposeDraft, ComposerAttachment, MessageTab } from '../types'

export type LocalDraftState = 'saving' | 'saved' | 'error' | 'conflict'
/** Why autosave stopped: a newer copy exists, or the draft was discarded. */
export type LocalDraftConflict = 'newer' | 'discarded'
export type LocalDraftStatus = { state: LocalDraftState; conflict?: LocalDraftConflict; error?: string }

/** What the composer shows about its local copy, by tab id. */
export const localDrafts$ = observable({
  status: {} as Record<string, LocalDraftStatus>,
  /** True once the stored drafts have been read back at startup; no save is
   * attempted before, because the revision each one must start from is not
   * known until then. */
  hydrated: false,
})

type Entry = {
  /** The revision the store last confirmed; the next write must name it. */
  revision: number
  /** Writes for one draft run one after another, never side by side. */
  chain: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  /** The last document confirmed or queued, to skip writes that change nothing. */
  lastSerialized?: string
  /** Set when the tab is gone: nothing is written for it again. */
  closed: boolean
  /** Set on a conflict: autosave stops until the reader chooses. */
  paused: boolean
}

const entries = new Map<string, Entry>()
let debounceMs = 600

/** Tests only: no waiting between a change and its write. */
export function setLocalDraftDebounceForTests(ms: number) {
  debounceMs = ms
}

/** Tests only: forget every draft this module knows about. */
export function resetLocalDraftsForTests() {
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer)
  entries.clear()
  localDrafts$.status.set({})
  localDrafts$.hydrated.set(false)
}

const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/

function entryFor(id: string): Entry {
  let entry = entries.get(id)
  if (!entry) {
    entry = { revision: 0, chain: Promise.resolve(), closed: false, paused: false }
    entries.set(id, entry)
  }
  return entry
}

function setStatus(id: string, state: LocalDraftState, detail: { conflict?: LocalDraftConflict; error?: string } = {}) {
  localDrafts$.status[id].set({ state, ...detail })
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Bytes a base64 string decodes to, exactly — the store checks the size it
 * is told against the bytes it is given and refuses any mismatch. */
export function decodedSize(data: string): number {
  if (!data) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/** The document the store keeps for one compose tab: version 1, every field
 * of the draft, and each attachment with its bytes. */
export function draftDocument(tab: MessageTab): Record<string, unknown> | null {
  const compose = tab.compose
  if (tab.kind !== 'compose' || !compose) return null
  return {
    version: 1,
    context: { kind: 'compose', tabSubject: tab.subject, threadId: tab.threadId },
    compose: {
      ...compose,
      fromEmail: compose.fromEmail ?? '',
      replyTo: compose.replyTo ?? '',
      inReplyTo: compose.inReplyTo ?? '',
      references: compose.references ?? '',
      draftMessageId: compose.draftMessageId ?? '',
      pgpSign: !!compose.pgpSign,
      pgpEncrypt: !!compose.pgpEncrypt,
      showCcBcc: !!compose.showCcBcc,
      rich: !!compose.rich,
      attachments: compose.attachments.map((file) => ({
        id: file.id,
        filename: file.filename,
        mime: file.mime || 'application/octet-stream',
        size: decodedSize(file.data),
        data: file.data,
        ...(file.inlineId ? { inlineId: file.inlineId } : {}),
      })),
    },
  }
}

/** A compose tab rebuilt from a stored document. */
export function tabFromDocument(id: string, document: Record<string, any>): MessageTab | null {
  const compose = document?.compose as (ComposeDraft & { attachments: ComposerAttachment[] }) | undefined
  if (!compose || typeof compose.to !== 'string') return null
  const context = (document.context ?? {}) as { tabSubject?: string; threadId?: string }
  return {
    id,
    kind: 'compose',
    messageId: '',
    threadId: context.threadId ?? '',
    subject: context.tabSubject || compose.subject || 'New message',
    from: '',
    body: '',
    viewMode: 'plain',
    compose: {
      ...compose,
      attachments: (compose.attachments ?? []).map((file) => ({
        id: file.id,
        filename: file.filename,
        mime: file.mime,
        size: decodedSize(file.data),
        data: file.data,
        ...(file.inlineId ? { inlineId: file.inlineId } : {}),
      })),
    },
  }
}

type SaveReply = { applied?: boolean; revision?: number; deleted?: boolean }

async function write(id: string, entry: Entry, serialized: string, document: Record<string, unknown>) {
  if (entry.closed || entry.paused) return
  setStatus(id, 'saving')
  try {
    const reply = await invoke<SaveReply>('localDrafts.save', {
      id,
      expected_revision: entry.revision,
      document,
    })
    if (reply?.applied) {
      entry.revision = reply.revision ?? entry.revision + 1
      entry.lastSerialized = serialized
      if (!entry.closed) setStatus(id, 'saved')
      return
    }
    // The store holds a newer revision than this tab knew about, or the
    // draft was discarded elsewhere. Nothing is overwritten: the tab keeps
    // its text, autosave stops, and the reader decides.
    entry.paused = true
    entry.revision = reply?.revision ?? entry.revision
    setStatus(id, 'conflict', { conflict: reply?.deleted ? 'discarded' : 'newer' })
  } catch (error) {
    // Kept as it is on screen; the next change tries again.
    entry.lastSerialized = undefined
    setStatus(id, 'error', { error: message(error) })
  }
}

/** Queue a write of this tab's draft after a pause in changes. */
export function scheduleLocalDraftSave(tab: MessageTab) {
  if (!localDrafts$.hydrated.peek()) return
  if (!VALID_ID.test(tab.id)) return
  const document = draftDocument(tab)
  if (!document) return
  const entry = entryFor(tab.id)
  if (entry.closed || entry.paused) return
  const serialized = JSON.stringify(document)
  if (serialized === entry.lastSerialized) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    entry.chain = entry.chain.then(() => write(tab.id, entry, serialized, document))
  }, debounceMs)
}

/** Write every pending draft now, without waiting out the pause. */
export async function flushLocalDrafts(tabs: MessageTab[]) {
  for (const tab of tabs) {
    const entry = entries.get(tab.id)
    if (!entry?.timer) continue
    clearTimeout(entry.timer)
    entry.timer = undefined
    const document = draftDocument(tab)
    if (!document) continue
    const serialized = JSON.stringify(document)
    entry.chain = entry.chain.then(() => write(tab.id, entry, serialized, document))
  }
  await Promise.all([...entries.values()].map((entry) => entry.chain))
}

/**
 * The tab is gone — sent, discarded, or closed with its server draft kept.
 * The local copy goes with it, after any write already under way, and the
 * store's tombstone stops a later write from bringing it back.
 */
export function discardLocalDraft(id: string) {
  if (!VALID_ID.test(id)) return
  const entry = entryFor(id)
  if (entry.closed) return
  entry.closed = true
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
  // Before startup has read the store back, the revision to delete is not
  // known yet; hydration deletes it then, and does not restore it.
  if (!localDrafts$.hydrated.peek()) return
  entry.chain = entry.chain.then(async () => {
    // Runs after any write already under way. Nothing this tab wrote was
    // confirmed, so there is nothing of its own to delete.
    if (entry.revision === 0) {
      localDrafts$.status[id].delete()
      return
    }
    try {
      await invoke('localDrafts.delete', { id, expected_revision: entry.revision })
    } catch {
      // A copy left behind is recovered at the next start and can be closed
      // again; nothing is lost by failing here.
    }
    localDrafts$.status[id].delete()
  })
}

/**
 * After a conflict: keep what this tab shows, replacing the stored copy.
 * The only way past a conflict, and only on the reader's say-so.
 */
export async function keepThisVersion(tab: MessageTab) {
  const entry = entryFor(tab.id)
  const document = draftDocument(tab)
  if (!document || entry.closed) return
  let current: { draft?: { revision?: number; deleted?: boolean } | null } | null = null
  try {
    current = await invoke('localDrafts.get', { id: tab.id })
  } catch (error) {
    setStatus(tab.id, 'error', { error: message(error) })
    return
  }
  if (current?.draft?.deleted) {
    // A tombstone cannot be written over: said plainly rather than hidden.
    // The text stays on screen; sending it or copying it out still works.
    setStatus(tab.id, 'conflict', { conflict: 'discarded' })
    return
  }
  entry.revision = current?.draft?.revision ?? 0
  entry.paused = false
  entry.lastSerialized = undefined
  const serialized = JSON.stringify(document)
  entry.chain = entry.chain.then(() => write(tab.id, entry, serialized, document))
  await entry.chain
}

type ListReply = { drafts?: { id: string; revision: number }[] }
type GetReply = {
  draft?: { id: string; revision: number; deleted: boolean; document: Record<string, any> | null } | null
}

/**
 * Read the stored drafts back at startup.
 *
 * Returns the tabs to show: each stored draft as a compose tab, with its
 * files, in place of the text-only copy localStorage kept of the same tab;
 * and tabs that exist only in localStorage (from before #170) kept as they
 * are and written to the store, which is their migration. The text-only
 * localStorage copy is left alone: it stays the fallback for a store that
 * cannot be read.
 */
export async function hydrateLocalDrafts(currentTabs: () => MessageTab[]): Promise<MessageTab[]> {
  if (localDrafts$.hydrated.peek()) return currentTabs()
  const listed = await invoke<ListReply>('localDrafts.list', {})
  const stored = new Map<string, MessageTab>()
  for (const summary of listed?.drafts ?? []) {
    let reply: GetReply
    try {
      reply = await invoke<GetReply>('localDrafts.get', { id: summary.id })
    } catch (error) {
      // An unreadable draft is reported, never turned into an empty one.
      setStatus(summary.id, 'error', { error: message(error) })
      continue
    }
    const draft = reply?.draft
    if (!draft || draft.deleted || !draft.document) continue
    if (entries.get(draft.id)?.closed) {
      // Closed before the store was read: delete it now, at the revision
      // just read, rather than bring it back.
      await invoke('localDrafts.delete', { id: draft.id, expected_revision: draft.revision }).catch(() => {})
      continue
    }
    const tab = tabFromDocument(draft.id, draft.document)
    if (!tab) continue
    const entry = entryFor(draft.id)
    entry.revision = draft.revision
    const document = draftDocument(tab)
    entry.lastSerialized = document ? JSON.stringify(document) : undefined
    setStatus(draft.id, 'saved')
    stored.set(draft.id, tab)
  }

  // Read the tabs only now, after the last wait, so a tab opened or closed
  // while the store was being read is neither lost nor brought back.
  const result: MessageTab[] = []
  for (const tab of currentTabs()) {
    const restored = stored.get(tab.id)
    if (restored) {
      result.push(restored)
      stored.delete(tab.id)
    } else {
      result.push(tab)
    }
  }
  result.push(...stored.values())
  localDrafts$.hydrated.set(true)

  // Anything shown that the store does not hold yet — tabs from before #170 —
  // is written now, which is the migration.
  for (const tab of result) {
    if (tab.kind === 'compose' && !entries.get(tab.id)?.lastSerialized) scheduleLocalDraftSave(tab)
  }
  return result
}
