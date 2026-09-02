import { useEffect } from 'react'
import { AlertTriangle, ScrollText, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { ui$ } from '../../states/ui'
import { clearRuleLog, loadRuleLog, rules$ } from '../../states/rules'
import { IconButton } from '../button/IconButton'

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
  useEscapeKey(onClose, true)

  useEffect(() => {
    void loadRuleLog()
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[3px] select-none animate-fade-in dark:bg-black/60">
      <div className="flex w-full max-w-xl flex-col gap-5 rounded-3xl border border-border bg-chats p-6 text-primary shadow-2xl animate-slide-up">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <ScrollText size={17} />
            </div>
            <h2 className="text-title font-bold leading-tight tracking-tight">{t('rules.log')}</h2>
          </div>
          <IconButton icon={X} iconSize={16} label={t('buttons.close')} radius="xl" onClick={onClose} />
        </div>

        {entries.length === 0 ? (
          <p className="py-6 text-center text-ui text-secondary">{t('rules.logEmpty')}</p>
        ) : (
          <ul className="flex max-h-[24rem] flex-col gap-1.5 overflow-y-auto">
            {entries.map((entry, index) => {
              const failed = entry.outcome !== 'done'
              return (
                <li
                  key={`${entry.at}-${entry.uid}-${index}`}
                  className="rounded-xl border border-border bg-panel px-3 py-2"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold">{entry.subject}</span>
                    <time className="shrink-0 text-2xs text-secondary">
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

        {entries.length > 0 && (
          <button
            type="button"
            onClick={() => void clearRuleLog()}
            className="w-fit rounded-xl px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer"
          >
            {t('rules.logClear')}
          </button>
        )}
      </div>
    </div>
  )
}
