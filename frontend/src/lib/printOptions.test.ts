import { describe, expect, it } from 'bun:test'
import { DEFAULT_PRINT_OPTIONS, sanitizePrintOptions } from './printOptions'

describe('reading the stored print options back (SET-05)', () => {
  it('keeps every valid choice', () => {
    const stored = {
      headers: { subject: false, date: false, to: false, cc: false, bcc: true },
      scope: 'message',
      order: 'newest',
      attachments: false,
    }
    expect(sanitizePrintOptions(stored)).toEqual(stored as never)
  })

  it('defaults each missing or invalid field on its own', () => {
    expect(
      sanitizePrintOptions({ headers: { cc: false, bcc: 'yes', from: false }, scope: 'thread', order: 'newest' }),
    ).toEqual({
      ...DEFAULT_PRINT_OPTIONS,
      headers: { ...DEFAULT_PRINT_OPTIONS.headers, cc: false },
      order: 'newest',
    })
    expect(sanitizePrintOptions({ headers: [] })).toEqual(DEFAULT_PRINT_OPTIONS)
  })

  it('rejects what is not an options object', () => {
    for (const raw of [null, undefined, 'conversation', 3, []]) expect(sanitizePrintOptions(raw)).toBeNull()
  })

  it('does not share the default headers object with what it returns', () => {
    const read = sanitizePrintOptions({})!
    read.headers.cc = false
    expect(DEFAULT_PRINT_OPTIONS.headers.cc).toBe(true)
  })
})
