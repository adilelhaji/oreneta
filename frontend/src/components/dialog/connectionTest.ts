import type { MailSecurity } from './accountSecurity'
import type { newAccountForm } from './accountSetup'

// The connection test of the manual IMAP/POP3/SMTP setup (#269): the shape of
// the core's report (meron-core/src/connection_test.rs) and the corrections
// the dialog offers for a failed step. Nothing here saves anything — a fix
// only changes the form, and the person decides whether to test again and save.

export type ConnectionStep = 'dns' | 'tcp' | 'tls' | 'auth'
export type StepStatus = 'ok' | 'failed' | 'skipped' | 'not_run'
export type StepKind =
  | 'name_not_found'
  | 'refused'
  | 'unreachable'
  | 'timeout'
  | 'proxy'
  | 'not_tls'
  | 'certificate'
  | 'starttls_unsupported'
  | 'no_greeting'
  | 'plaintext_refused'
  | 'rejected'
  | 'via_proxy'
  | 'no_encryption'
  | 'auth_not_offered'
  | 'other'

export type StepReport = { step: ConnectionStep; status: StepStatus; kind?: StepKind; detail?: string }
export type ServerProtocol = 'imap' | 'pop3' | 'smtp'
export type ServerReport = {
  protocol: ServerProtocol
  host: string
  port: number
  security: MailSecurity
  ok: boolean
  steps: StepReport[]
}
export type ConnectionReport = { ok: boolean; incoming: ServerReport; outgoing: ServerReport }
export type ServerSide = 'incoming' | 'outgoing'

export type ConnectionFix =
  | { kind: 'server'; port: number; security: Exclude<MailSecurity, 'none'> }
  | { kind: 'username'; username: string }
  | { kind: 'certificate' }

type AccountForm = ReturnType<typeof newAccountForm>

// The usual port of each protocol for TLS from the start and for STARTTLS.
// Plaintext is never suggested: a fix must not lower the protection chosen.
const standardPairs: Record<ServerProtocol, { port: number; security: 'tls' | 'starttls' }[]> = {
  imap: [
    { port: 993, security: 'tls' },
    { port: 143, security: 'starttls' },
  ],
  pop3: [
    { port: 995, security: 'tls' },
    { port: 110, security: 'starttls' },
  ],
  smtp: [
    { port: 465, security: 'tls' },
    { port: 587, security: 'starttls' },
  ],
}

export function failedStep(server: ServerReport): StepReport | undefined {
  return server.steps.find((step) => step.status === 'failed')
}

// What to offer for a server's failed step. A connection or security failure
// offers the protocol's usual port and security pairs (the same port with the
// other security first, when that is the likely mistake); a refused sign-in
// offers the other usual form of the user name; an untrusted certificate
// offers to inspect it. A name that does not resolve has no guess: only the
// person knows the right server.
export function connectionFixes(
  server: ServerReport,
  form: Pick<AccountForm, 'username' | 'email'>,
): ConnectionFix[] {
  const failed = failedStep(server)
  if (!failed?.kind) return []
  if (failed.kind === 'certificate') return [{ kind: 'certificate' }]
  if (failed.kind === 'rejected') {
    const username = alternativeUsername(form.username, form.email)
    return username ? [{ kind: 'username', username }] : []
  }
  const connectionKinds: StepKind[] = [
    'refused',
    'unreachable',
    'timeout',
    'not_tls',
    'no_greeting',
    'starttls_unsupported',
    'plaintext_refused',
  ]
  if (failed.step === 'dns' || !connectionKinds.includes(failed.kind)) return []
  const candidates: { port: number; security: 'tls' | 'starttls' }[] = []
  if (failed.kind === 'not_tls' || failed.kind === 'plaintext_refused') {
    candidates.push({ port: server.port, security: 'starttls' })
  } else if (failed.kind === 'no_greeting' && server.security === 'starttls') {
    candidates.push({ port: server.port, security: 'tls' })
  }
  candidates.push(...standardPairs[server.protocol])
  const seen = new Set<string>()
  return candidates
    .filter((pair) => {
      const key = `${pair.port}/${pair.security}`
      const current = pair.port === server.port && pair.security === server.security
      if (current || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((pair) => ({ kind: 'server' as const, ...pair }))
}

// Servers differ on whether they want the whole address or only the part
// before the @; a rejected sign-in tries the other.
export function alternativeUsername(username: string, email: string): string {
  const current = (username || email).trim()
  if (current.includes('@')) {
    const local = current.slice(0, current.lastIndexOf('@'))
    return local && local !== current ? local : ''
  }
  const address = email.trim()
  return address.includes('@') && address !== current ? address : ''
}

// A fix changes only the form, and marks what it changed as chosen by the
// person, so a later port edit or lookup does not undo it.
export function applyConnectionFix(form: AccountForm, side: ServerSide, fix: ConnectionFix): AccountForm {
  if (fix.kind === 'username') return { ...form, username: fix.username, username_touched: true }
  if (fix.kind !== 'server') return form
  return side === 'incoming'
    ? {
        ...form,
        imap_port: String(fix.port),
        imap_port_touched: true,
        imap_security: fix.security,
        imap_security_touched: true,
      }
    : {
        ...form,
        smtp_port: String(fix.port),
        smtp_port_touched: true,
        smtp_security: fix.security,
        smtp_security_touched: true,
      }
}

// What a test result is about. A result whose settings have changed since is
// stale: it says nothing about what would now be saved. The password enters
// only as a short checksum, so the key is not a second copy of it.
export function connectionTestKey(form: AccountForm): string {
  return JSON.stringify([
    form.email.trim().toLowerCase(),
    form.incoming,
    form.imap_host.trim(),
    form.imap_port,
    form.imap_security,
    form.smtp_host.trim(),
    form.smtp_port,
    form.smtp_security,
    form.username.trim(),
    checksum(form.password),
  ])
}

function checksum(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return `${text.length}:${hash.toString(36)}`
}
