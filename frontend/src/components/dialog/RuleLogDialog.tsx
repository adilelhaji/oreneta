import { useEffect } from 'react'
import { AlertTriangle, ScrollText } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { ui$ } from '../../states/ui'
import { clearRuleLog, loadRuleLog, rules$ } from '../../states/rules'
import { Button } from '../button/Button'
import { Dialog } from './Dialog'

/**
 * What the rules actually did.
 *
 * Not an extra. A rule changes a mailbox without being asked again, and a
 * reader who cannot find out what moved their mail has been handed a mailbox
 * that changes by itself. Failures are listed beside successes, because a rule
 * that quietly did not run is the one worth knowing about.
 */
export function RuleLogDialog() {
  const { t } = useTranslation()
  const entries = useValue(rules$.log)

  const onClose = () => ui$.ruleLogOpen.set(false)

  useEffect(() => {
    void loadRuleLog()
  }, [])

  return (
    <Dialog
      title={t('rules.log')}
      icon={ScrollText}
      width="xl"
      onClose={onClose}
      footer={
        entries.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => void clearRuleLog()}>
            {t('rules.logClear')}
          </Button>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <p className="py-6 text-center text-ui text-secondary">{t('rules.logEmpty')}</p>
      ) : (
        <ul className="flex max-h-[24rem] flex-col gap-1.5 overflow-y-auto">
          {entries.map((entry, index) => {
            const failed = entry.outcome !== 'done'
            return (
              <li key={`${entry.at}-${entry.uid}-${index}`} className="rounded-control border border-border bg-raised px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-semibold">{entry.subject}</span>
                  <time className="shrink-0 text-2xs text-secondary tabular-nums">
                    {new Date(entry.at * 1000).toLocaleString()}
                  </time>
                </div>
                <p className="truncate text-caption text-secondary">{entry.from}</p>
                <p
                  className={`mt-0.5 flex items-center gap-1 text-caption font-medium ${
                    failed ? 'text-rose-500' : 'text-secondary'
                  }`}
                >
                  {failed && <AlertTriangle size={11} className="shrink-0" />}
                  <span className="min-w-0 truncate">
                    {entry.ruleName} · {entry.action}
                    {failed ? ` · ${t('rules.logFailed')}: ${entry.outcome}` : ''}
                  </span>
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
