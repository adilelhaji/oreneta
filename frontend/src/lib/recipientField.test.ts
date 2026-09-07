import { describe, expect, it } from 'bun:test'
import { commitPending, editAt, fieldParts, hasMalformed, removeAt, setPending } from './recipientField'

describe('what is a chip and what is still being typed', () => {
  it('leaves the last token alone until a separator ends it', () => {
    const parts = fieldParts('ana@x.com, ma')
    expect(parts.committed.map((r) => r.address)).toEqual(['ana@x.com'])
    expect(parts.pending).toBe('ma')
  })

  it('has nothing pending once a separator has been typed', () => {
    expect(fieldParts('ana@x.com, ').pending).toBe('')
  })

  it('treats a lone half-typed address as pending, not as a chip', () => {
    const parts = fieldParts('an')
    expect(parts.committed).toEqual([])
    expect(parts.pending).toBe('an')
  })

  it('does not split a quoted name into two chips', () => {
    expect(fieldParts('"Doe, John" <j@x.com>, ').committed).toHaveLength(1)
  })
})

describe('typing into the field', () => {
  it('replaces the token under the cursor without touching the chips', () => {
    expect(setPending('ana@x.com, ma', 'marc@x.com')).toBe('ana@x.com, marc@x.com')
  })

  it('commits the pending token when asked', () => {
    expect(commitPending('ana@x.com, marc@x.com')).toBe('ana@x.com, marc@x.com, ')
  })

  it('commits given text instead, which is how a suggestion lands', () => {
    expect(commitPending('ma', 'Marc <marc@x.com>')).toBe('Marc <marc@x.com>, ')
  })

  it('does nothing at all on an empty field', () => {
    expect(commitPending('')).toBe('')
    expect(commitPending('   ')).toBe('')
  })

  it('turns a pasted list into several chips at once', () => {
    expect(commitPending('', 'a@x.com, b@x.com; c@x.com')).toBe('a@x.com, b@x.com, c@x.com, ')
  })

  it('quietly ignores someone already in the field', () => {
    expect(commitPending('ana@x.com, ANA@x.com')).toBe('ana@x.com, ')
  })

  it('keeps text it cannot read rather than dropping it', () => {
    expect(commitPending('', 'nonsense')).toBe('nonsense, ')
  })
})

describe('changing what is already there', () => {
  it('removes a chip and leaves the typing alone', () => {
    expect(removeAt('a@x.com, b@x.com, ma', 0)).toBe('b@x.com, ma')
  })

  it('ignores a removal that points at nothing', () => {
    expect(removeAt('a@x.com, ', 5)).toBe('a@x.com, ')
  })

  it('takes a chip back apart so a typo can be fixed', () => {
    expect(editAt('a@x.com, b@x.com, ', 0)).toBe('b@x.com, a@x.com')
  })

  it('keeps a name when taking its chip apart', () => {
    expect(editAt('Ana Prat <ana@x.com>, ', 0)).toBe('Ana Prat <ana@x.com>')
  })

  it('does not throw away what was half-typed when reaching for a chip', () => {
    expect(editAt('a@x.com, b@x.com, marc@x.com', 0)).toBe('b@x.com, marc@x.com, a@x.com')
  })

  it('ignores an edit that points at nothing', () => {
    expect(editAt('a@x.com, ', 9)).toBe('a@x.com, ')
  })
})

describe('telling the writer something is wrong', () => {
  it('notices an entry that cannot be an address', () => {
    expect(hasMalformed('a@x.com, nonsense, ')).toBe(true)
  })

  it('says nothing about a field that is merely unusual', () => {
    expect(hasMalformed('root@localhost, user+tag@example.com, ')).toBe(false)
  })

  it('says nothing about a half-typed address still under the cursor', () => {
    expect(hasMalformed('a@x.com, an')).toBe(false)
  })
})
