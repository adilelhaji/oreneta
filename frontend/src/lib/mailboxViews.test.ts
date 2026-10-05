import { describe, expect, it } from 'bun:test'
import {
  changeMailboxColumns,
  DEFAULT_MAILBOX_COLUMNS,
  parseMailboxViews,
  resolveMailboxColumns,
  sanitizeMailboxColumns,
} from './mailboxViews'

const defaults = () => DEFAULT_MAILBOX_COLUMNS.map((column) => ({ ...column }))
describe('mailbox view contract', () => {
  it('preserves legacy proportional layout for absent and malformed preferences', () => {
    for (const raw of [
      null,
      undefined,
      [],
      'bad',
      {},
      { version: 0 },
      { version: '1' },
      { version: 1, defaultColumns: [], folders: [] },
    ]) {
      expect(parseMailboxViews(raw).kind).toBe('legacy')
      expect(resolveMailboxColumns(raw, { accountId: 'a', folderId: 'f' })).toBeNull()
    }
  })
  it('validates all columns, visibility, subject and exact width boundaries', () => {
    expect(sanitizeMailboxColumns(defaults())).toEqual(defaults())
    for (const width of [64, 640, 100.5])
      expect(sanitizeMailboxColumns(defaults().map((c) => (c.id === 'sender' ? { ...c, width } : c)))).not.toBeNull()
    for (const width of [63, 641, NaN, Infinity, '120', 'auto', null]) {
      expect(sanitizeMailboxColumns(defaults().map((c) => (c.id === 'sender' ? { ...c, width } : c)))).toBeNull()
    }
    expect(sanitizeMailboxColumns(defaults().slice(1))).toBeNull()
    expect(sanitizeMailboxColumns([...defaults(), defaults()[0]])).toBeNull()
    expect(sanitizeMailboxColumns(defaults().map((c) => ({ ...c, id: 'subject' })))).toBeNull()
    expect(
      sanitizeMailboxColumns(defaults().map((c) => (c.id === 'subject' ? { ...c, visible: false } : c))),
    ).toBeNull()
    expect(
      sanitizeMailboxColumns(defaults().map((c) => (c.id === 'account' ? { ...c, id: '__proto__' } : c))),
    ).toBeNull()
  })
  it('isolates exact account/folder pairs, snapshots inheritance and removes exceptions', () => {
    const scope = { accountId: '__proto__', folderId: 'a:b/Inbox' }
    const custom = defaults().reverse()
    const first = changeMailboxColumns(null, scope, custom)
    const nextDefault = defaults().map((c) => ({ ...c, visible: true }))
    const next = changeMailboxColumns(first, null, nextDefault)
    expect(resolveMailboxColumns(next, scope)).toEqual(custom)
    expect(resolveMailboxColumns(next, { ...scope, accountId: 'other' })).toEqual(nextDefault)
    expect(resolveMailboxColumns(next, { accountId: '__proto__:a', folderId: 'b/Inbox' })).toEqual(nextDefault)
    expect(resolveMailboxColumns(changeMailboxColumns(next, scope, null), scope)).toEqual(nextDefault)
    expect(first.defaultColumns).toEqual(defaults())
    expect(next.folders).toHaveLength(1)
  })
  it('ignores invalid and duplicate folder entries without poisoning valid layouts', () => {
    const entry = { accountId: 'a', folderId: 'Inbox', columns: defaults().reverse() }
    const raw = {
      version: 1,
      defaultColumns: defaults(),
      folders: [
        null,
        {},
        { ...entry, accountId: '' },
        { ...entry, columns: [] },
        entry,
        { ...entry, columns: defaults() },
      ],
    }
    const parsed = parseMailboxViews(raw)
    expect(parsed.kind).toBe('ready')
    if (parsed.kind === 'ready') expect(parsed.value.folders).toEqual([entry])
  })
  it('blocks future-version edits until explicit reset and rejects invalid mutations', () => {
    const future = { version: 2, unfamiliar: ['keep'] }
    expect(parseMailboxViews(future).kind).toBe('unsupported')
    expect(() => changeMailboxColumns(future, null, defaults())).toThrow()
    expect(future).toEqual({ version: 2, unfamiliar: ['keep'] })
    expect(() => changeMailboxColumns(null, { accountId: '', folderId: 'x' }, defaults())).toThrow()
    expect(() => changeMailboxColumns(null, null, [])).toThrow()
  })
})
