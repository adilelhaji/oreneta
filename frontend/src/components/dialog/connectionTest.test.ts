import { describe, expect, it } from 'bun:test'
import { newAccountForm } from './accountSetup'
import {
  alternativeUsername,
  applyConnectionFix,
  connectionFixes,
  connectionTestKey,
  failedStep,
  type ServerReport,
  type StepKind,
} from './connectionTest'

function server(
  protocol: ServerReport['protocol'],
  port: number,
  security: ServerReport['security'],
  failed?: { step: 'dns' | 'tcp' | 'tls' | 'auth'; kind: StepKind },
): ServerReport {
  const order = ['dns', 'tcp', 'tls', 'auth'] as const
  const at = failed ? order.indexOf(failed.step) : order.length
  return {
    protocol,
    host: 'mail.example.test',
    port,
    security,
    ok: !failed,
    steps: order.map((step, i) =>
      i < at
        ? { step, status: 'ok' as const }
        : i === at
          ? { step, status: 'failed' as const, kind: failed!.kind, detail: 'what the server said' }
          : { step, status: 'not_run' as const },
    ),
  }
}

const form = { username: 'ana@example.test', email: 'ana@example.test' }

describe('connectionFixes', () => {
  it('offers nothing for a server that passed', () => {
    expect(connectionFixes(server('imap', 993, 'tls'), form)).toEqual([])
  })

  it('has no guess for a name that does not resolve', () => {
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'dns', kind: 'name_not_found' }), form)).toEqual([])
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'dns', kind: 'timeout' }), form)).toEqual([])
  })

  it('offers the other usual port and security when the port refuses', () => {
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'tcp', kind: 'refused' }), form)).toEqual([
      { kind: 'server', port: 143, security: 'starttls' },
    ])
    expect(connectionFixes(server('smtp', 587, 'starttls', { step: 'tcp', kind: 'timeout' }), form)).toEqual([
      { kind: 'server', port: 465, security: 'tls' },
    ])
    // A port of its own (a local bridge, say) gets both usual pairs.
    expect(connectionFixes(server('pop3', 1110, 'tls', { step: 'tcp', kind: 'unreachable' }), form)).toEqual([
      { kind: 'server', port: 995, security: 'tls' },
      { kind: 'server', port: 110, security: 'starttls' },
    ])
  })

  it('offers STARTTLS on the same port first when the port does not speak TLS', () => {
    expect(connectionFixes(server('smtp', 587, 'tls', { step: 'tls', kind: 'not_tls' }), form)).toEqual([
      { kind: 'server', port: 587, security: 'starttls' },
      { kind: 'server', port: 465, security: 'tls' },
    ])
  })

  it('offers TLS on the same port first when a STARTTLS client got no greeting', () => {
    expect(connectionFixes(server('smtp', 465, 'starttls', { step: 'tls', kind: 'no_greeting' }), form)).toEqual([
      { kind: 'server', port: 465, security: 'tls' },
      { kind: 'server', port: 587, security: 'starttls' },
    ])
  })

  it('offers TLS when STARTTLS is not offered, and never plaintext', () => {
    const fixes = connectionFixes(server('imap', 143, 'starttls', { step: 'tls', kind: 'starttls_unsupported' }), form)
    expect(fixes).toEqual([{ kind: 'server', port: 993, security: 'tls' }])
    const pop3 = connectionFixes(server('pop3', 110, 'none', { step: 'tls', kind: 'plaintext_refused' }), form)
    expect(pop3).toEqual([
      { kind: 'server', port: 110, security: 'starttls' },
      { kind: 'server', port: 995, security: 'tls' },
    ])
    for (const fix of [...fixes, ...pop3]) expect(fix).not.toMatchObject({ security: 'none' })
  })

  it('offers to inspect a certificate that does not validate', () => {
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'tls', kind: 'certificate' }), form)).toEqual([
      { kind: 'certificate' },
    ])
  })

  it('offers the other form of the user name when the sign-in is refused', () => {
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'auth', kind: 'rejected' }), form)).toEqual([
      { kind: 'username', username: 'ana' },
    ])
    expect(
      connectionFixes(server('smtp', 465, 'tls', { step: 'auth', kind: 'rejected' }), {
        username: 'ana',
        email: 'ana@example.test',
      }),
    ).toEqual([{ kind: 'username', username: 'ana@example.test' }])
  })

  it('offers nothing it cannot back for a proxy or an unclassified failure', () => {
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'tcp', kind: 'proxy' }), form)).toEqual([])
    expect(connectionFixes(server('imap', 993, 'tls', { step: 'auth', kind: 'other' }), form)).toEqual([])
  })
})

describe('alternativeUsername', () => {
  it('switches between the address and its local part', () => {
    expect(alternativeUsername('ana@example.test', 'ana@example.test')).toBe('ana')
    expect(alternativeUsername('ana', 'ana@example.test')).toBe('ana@example.test')
    // An empty user name means the address is used.
    expect(alternativeUsername('', 'ana@example.test')).toBe('ana')
    expect(alternativeUsername('DOMAIN\\ana', 'not-an-address')).toBe('')
    expect(alternativeUsername('@example.test', '@example.test')).toBe('')
  })
})

describe('applyConnectionFix', () => {
  it('changes only the form fields of the side it is for, marked as chosen', () => {
    const base = { ...newAccountForm('ana@example.test'), username: 'ana@example.test' }
    const incoming = applyConnectionFix(base, 'incoming', { kind: 'server', port: 143, security: 'starttls' })
    expect(incoming).toMatchObject({
      imap_port: '143',
      imap_port_touched: true,
      imap_security: 'starttls',
      imap_security_touched: true,
      smtp_port: base.smtp_port,
      smtp_security: base.smtp_security,
    })
    const outgoing = applyConnectionFix(base, 'outgoing', { kind: 'server', port: 587, security: 'starttls' })
    expect(outgoing).toMatchObject({ smtp_port: '587', smtp_security: 'starttls', imap_port: base.imap_port })
    expect(applyConnectionFix(base, 'incoming', { kind: 'username', username: 'ana' })).toMatchObject({
      username: 'ana',
      username_touched: true,
    })
    expect(applyConnectionFix(base, 'incoming', { kind: 'certificate' })).toBe(base)
  })
})

describe('connectionTestKey', () => {
  it('changes with every setting the test depends on, and does not hold the password', () => {
    const base = { ...newAccountForm('ana@example.test'), imap_host: 'imap.example.test', password: 'pa55word' }
    const key = connectionTestKey(base)
    expect(key).not.toContain('pa55word')
    expect(connectionTestKey({ ...base })).toBe(key)
    for (const change of [
      { imap_host: 'other.example.test' },
      { imap_port: '143' },
      { imap_security: 'starttls' as const },
      { smtp_host: 'smtp.example.test' },
      { smtp_port: '587' },
      { smtp_security: 'none' as const },
      { username: 'ana' },
      { password: 'pa55word!' },
      { incoming: 'pop3' as const },
    ]) {
      expect(connectionTestKey({ ...base, ...change })).not.toBe(key)
    }
    // Not what the test does not depend on.
    expect(connectionTestKey({ ...base, sender_name: 'Ana' })).toBe(key)
  })
})

describe('failedStep', () => {
  it('is the first failed step', () => {
    expect(failedStep(server('imap', 993, 'tls', { step: 'tls', kind: 'not_tls' }))?.step).toBe('tls')
    expect(failedStep(server('imap', 993, 'tls'))).toBeUndefined()
  })
})
