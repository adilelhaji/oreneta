import { CheckCircle2, CircleDashed, CircleMinus, XCircle } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { Button } from '../button/Button'
import {
  connectionFixes,
  type ConnectionFix,
  type ConnectionReport,
  type ServerReport,
  type ServerSide,
  type StepReport,
} from './connectionTest'

// The result of the manual setup's connection test (#269): both servers, each
// step with its outcome, what to change for a failed one and the corrections
// that can be applied to the form. Applying one saves nothing; "Save anyway" is
// the only way to store an account whose test did not pass, and it says so.
export function ConnectionTestPanel({
  report,
  stale,
  form,
  busy,
  onFix,
  onSaveAnyway,
}: {
  report: ConnectionReport
  stale: boolean
  form: { username: string; email: string }
  busy: boolean
  onFix: (side: ServerSide, fix: ConnectionFix) => void
  onSaveAnyway: () => void
}) {
  const { t } = useTranslation()
  return (
    <section
      aria-label={t('accounts.connectionTest.title')}
      className="rounded-control border border-border bg-raised p-3 flex flex-col gap-3 text-caption"
    >
      <p role="status" className={`font-semibold ${report.ok ? 'text-success' : 'text-danger'}`}>
        {report.ok ? t('accounts.connectionTest.passed') : t('accounts.connectionTest.failed')}
      </p>
      {stale && <p className="text-secondary">{t('accounts.connectionTest.stale')}</p>}
      {(['incoming', 'outgoing'] as const).map((side) => (
        <ServerResult
          key={side}
          side={side}
          server={report[side]}
          fixes={stale ? [] : connectionFixes(report[side], form)}
          busy={busy}
          onFix={(fix) => onFix(side, fix)}
        />
      ))}
      {!report.ok && !stale && (
        <div className="flex flex-col gap-2 border-t border-border/70 pt-3">
          <p className="text-secondary leading-relaxed">{t('accounts.connectionTest.saveAnywayHint')}</p>
          <Button variant="secondary" size="sm" className="self-start" disabled={busy} onClick={onSaveAnyway}>
            {t('accounts.connectionTest.saveAnyway')}
          </Button>
        </div>
      )}
    </section>
  )
}

function ServerResult({
  side,
  server,
  fixes,
  busy,
  onFix,
}: {
  side: ServerSide
  server: ServerReport
  fixes: ConnectionFix[]
  busy: boolean
  onFix: (fix: ConnectionFix) => void
}) {
  const { t } = useTranslation()
  const heading =
    side === 'incoming'
      ? t('accounts.connectionTest.incoming', { protocol: server.protocol.toUpperCase() })
      : t('accounts.connectionTest.outgoing')
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="font-semibold text-primary">
        {heading}{' '}
        <span className="font-normal text-secondary">
          {server.host}:{server.port}
        </span>
      </h4>
      <ul className="flex flex-col gap-1">
        {server.steps.map((step) => (
          <StepRow key={step.step} step={step} server={server} />
        ))}
      </ul>
      {fixes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 ps-5">
          {fixes.map((fix) => (
            <Button key={fixKey(fix)} variant="secondary" size="sm" disabled={busy} onClick={() => onFix(fix)}>
              {fixLabel(fix, t)}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function StepRow({ step, server }: { step: StepReport; server: ServerReport }) {
  const { t } = useTranslation()
  const Icon =
    step.status === 'ok'
      ? CheckCircle2
      : step.status === 'failed'
        ? XCircle
        : step.status === 'skipped'
          ? CircleMinus
          : CircleDashed
  const tone =
    step.status === 'ok'
      ? 'text-success'
      : step.status === 'failed'
        ? 'text-danger'
        : step.status === 'skipped' && step.kind === 'no_encryption'
          ? 'text-warning'
          : 'text-secondary'
  const note =
    step.status === 'failed'
      ? t(`accounts.connectionTest.advice.${step.kind ?? 'other'}`, {
          port: server.port,
          protocol: server.protocol.toUpperCase(),
        })
      : step.status === 'skipped' && step.kind
        ? t(`accounts.connectionTest.skip.${step.kind}`)
        : ''
  return (
    <li className="flex items-start gap-2">
      <Icon size={14} aria-hidden="true" className={`shrink-0 mt-px ${tone}`} strokeWidth={1.75} />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span>
          <span className="font-medium text-primary">{t(`accounts.connectionTest.step.${step.step}`)}</span>
          {': '}
          <span className={tone}>{t(`accounts.connectionTest.status.${step.status}`)}</span>
        </span>
        {note && <span className="text-secondary leading-relaxed">{note}</span>}
        {step.status === 'failed' && step.detail && (
          <span className="text-secondary/80 break-words">
            {t('accounts.connectionTest.serverSaid', { detail: step.detail })}
          </span>
        )}
      </div>
    </li>
  )
}

function fixKey(fix: ConnectionFix) {
  if (fix.kind === 'server') return `server:${fix.port}:${fix.security}`
  if (fix.kind === 'username') return `username:${fix.username}`
  return 'certificate'
}

function fixLabel(fix: ConnectionFix, t: ReturnType<typeof useTranslation>['t']) {
  if (fix.kind === 'server') {
    return t('accounts.connectionTest.fix.server', {
      port: fix.port,
      security: fix.security === 'tls' ? 'TLS' : 'STARTTLS',
    })
  }
  if (fix.kind === 'username') return t('accounts.connectionTest.fix.username', { username: fix.username })
  return t('accounts.connectionTest.fix.certificate')
}
