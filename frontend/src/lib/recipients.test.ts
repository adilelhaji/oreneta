import { describe, expect, it } from 'bun:test'
import {
  addRecipient,
  formatRecipient,
  formatRecipients,
  parseRecipient,
  parseRecipients,
  splitRecipients,
} from './recipients'

describe('splitting a recipient field', () => {
  it('splits on commas', () => {
    expect(splitRecipients('a@x.com, b@x.com').map((s) => s.trim())).toEqual(['a@x.com', 'b@x.com'])
  })

  it('splits on semicolons, which is what Outlook writes', () => {
    expect(splitRecipients('a@x.com; b@x.com').map((s) => s.trim())).toEqual(['a@x.com', 'b@x.com'])
  })

  it('keeps a quoted name with a comma in it as one person', () => {
    expect(splitRecipients('"Doe, John" <j@x.com>, b@x.com')).toHaveLength(2)
  })

  it('keeps a comma inside angle brackets out of it', () => {
    expect(splitRecipients('Ana <a,b@x.com>, c@x.com')).toHaveLength(2)
  })

  it('does not treat an escaped quote as the end of a quoted name', () => {
    expect(splitRecipients('"He said \\"hi\\", loudly" <h@x.com>, b@x.com')).toHaveLength(2)
  })
})

describe('reading one recipient', () => {
  it('reads a bare address', () => {
    expect(parseRecipient('ana@example.com')).toMatchObject({
      name: '',
      address: 'ana@example.com',
      status: 'ok',
    })
  })

  it('reads a name and an address', () => {
    expect(parseRecipient('Ana Prat <ana@example.com>')).toMatchObject({
      name: 'Ana Prat',
      address: 'ana@example.com',
    })
  })

  it('unquotes a quoted name', () => {
    expect(parseRecipient('"Doe, John" <j@x.com>')).toMatchObject({ name: 'Doe, John', address: 'j@x.com' })
  })

  it('unescapes what was escaped inside the quotes', () => {
    expect(parseRecipient('"Say \\"hi\\"" <h@x.com>')?.name).toBe('Say "hi"')
  })

  it('is nothing at all for blank text', () => {
    expect(parseRecipient('   ')).toBeNull()
  })

  it('accepts the unusual but real', () => {
    for (const address of ['user+tag@example.com', 'root@localhost', 'ana@correo.españa', "o'brien@example.com"]) {
      expect(parseRecipient(address)?.status).toBe('ok')
    }
  })

  it('calls malformed only what cannot be an address', () => {
    for (const bad of ['nobody', '@example.com', 'ana@', 'a@b@c.com', 'ana prat@example.com']) {
      expect(parseRecipient(bad)?.status).toBe('malformed')
    }
  })

  it('keeps the text it could not parse', () => {
    expect(parseRecipient('not an address')?.raw).toBe('not an address')
  })
})

describe('writing recipients back out', () => {
  it('leaves a bare address bare', () => {
    expect(formatRecipient({ name: '', address: 'a@x.com', status: 'ok', raw: 'a@x.com' })).toBe('a@x.com')
  })

  it('quotes a name that would otherwise split in two', () => {
    expect(formatRecipient({ name: 'Doe, John', address: 'j@x.com', status: 'ok', raw: '' })).toBe(
      '"Doe, John" <j@x.com>',
    )
  })

  it('escapes a quote inside a name', () => {
    expect(formatRecipient({ name: 'Say "hi"', address: 'h@x.com', status: 'ok', raw: '' })).toBe(
      '"Say \\"hi\\"" <h@x.com>',
    )
  })

  it('hands back untouched what it never understood', () => {
    expect(formatRecipient({ name: '', address: 'nonsense', status: 'malformed', raw: 'nonsense' })).toBe('nonsense')
  })

  it('survives a round trip', () => {
    for (const field of [
      'a@x.com, b@x.com',
      'Ana Prat <ana@example.com>, b@x.com',
      '"Doe, John" <j@x.com>, "Say \\"hi\\"" <h@x.com>',
      'root@localhost',
    ]) {
      const once = formatRecipients(parseRecipients(field))
      expect(formatRecipients(parseRecipients(once))).toBe(once)
    }
  })

  it('does not lose an unparseable entry on a round trip', () => {
    expect(formatRecipients(parseRecipients('nonsense, a@x.com'))).toBe('nonsense, a@x.com')
  })

  it('drops the empty entries a trailing comma leaves behind', () => {
    expect(formatRecipients(parseRecipients('a@x.com, , '))).toBe('a@x.com')
  })
})

describe('adding a recipient', () => {
  const ana = { name: 'Ana', address: 'ana@x.com', status: 'ok' as const, raw: '' }

  it('adds someone new', () => {
    expect(addRecipient([], ana)).toHaveLength(1)
  })

  it('quietly does nothing for someone already there', () => {
    expect(addRecipient([ana], { ...ana, name: 'Ana Prat' })).toHaveLength(1)
  })

  it('treats a differently-cased address as the same person', () => {
    expect(addRecipient([ana], { ...ana, address: 'ANA@X.COM' })).toHaveLength(1)
  })
})
