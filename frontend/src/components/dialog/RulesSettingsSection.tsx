import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, FlaskConical, Plus, ScrollText, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { confirmAction, showToast, ui$ } from '../../states/ui'
import {
  loadRules,
  newRule,
  previewRules,
  reorderRules,
  ruleProblem,
  rules$,
  saveRules,
  type Rule,
  type RulePreview,
} from '../../states/rules'
import { isRssAccount } from '../../lib/threadActions'
import { SettingsGroup, Switch } from './AccountSettingsRows'
import { RuleEditor } from './RuleEditor'
import { Notice } from '../notice/Notice'

/**
 * The rules, in the order they run, with a way to try them before trusting
 * them with a mailbox.
 *
 * Trying is given as much room as writing. A rule is a standing instruction to
 * change a mailbox without being asked again, and the only honest way to offer
 * that is to let someone see what it would do first.
 */
export function RulesSettingsSection() {
  const { t } = useTranslation()
  const accounts = useValue(accounts$)
  const stored = useValue(rules$.rules)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [preview, setPreview] = useState<RulePreview | null>(null)
  const [trying, setTrying] = useState(false)

  useEffect(() => {
    void loadRules()
  }, [])

  // Feeds have no mailbox to file into, so they are not offered as a target.
  const mailAccounts = accounts.filter((account) => !isRssAccount(account, account.id))

  const persist = async (next: Rule[]) => {
    try {
      await saveRules(next)
      showToast(t('rules.saved'))
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('rules.saveFailed'), 'error')
      // Back to what the core actually holds, rather than leaving the screen
      // showing rules that were never saved.
      void loadRules()
    }
  }

  const tryRules = async (candidates: Rule[]) => {
    const account = mailAccounts[0]
    if (!account) return
    setTrying(true)
    setPreview(null)
    try {
      setPreview(await previewRules({ accountId: account.id, folder: 'INBOX', rules: candidates }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('rules.tryFailed'), 'error')
    } finally {
      setTrying(false)
    }
  }

  if (editing) {
    const problem = ruleProblem(editing)
    return (
      <SettingsGroup title={t('rules.edit')}>
        <div className="flex flex-col gap-4 px-3.5 py-3">
          <RuleEditor rule={editing} accounts={mailAccounts} onChange={setEditing} />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!!problem || trying}
              onClick={() => void tryRules([editing])}
              className="flex items-center gap-1.5 rounded-control px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FlaskConical size={12} />
              {trying ? t('rules.trying') : t('rules.try')}
            </button>
            <button
              type="button"
              disabled={!!problem}
              onClick={() => {
                const next = stored.some((rule) => rule.id === editing.id)
                  ? stored.map((rule) => (rule.id === editing.id ? editing : rule))
                  : [...stored, editing]
                setEditing(null)
                setPreview(null)
                void persist(next)
              }}
              className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('buttons.save')}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null)
                setPreview(null)
              }}
              className="rounded-control px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer"
            >
              {t('buttons.cancel')}
            </button>
          </div>

          <p className="text-caption text-secondary">{t('rules.tryHint')}</p>
          <PreviewResult preview={preview} />
        </div>
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup title={t('settings.sections.rules')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('rules.intro')}</p>

        {stored.length === 0 ? (
          <p className="py-2 text-ui text-secondary">{t('rules.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {stored.map((rule, index) => (
              <li
                key={rule.id}
                className="flex items-center gap-2 rounded-control border border-border bg-panel px-3 py-2"
              >
                <Switch
                  checked={rule.enabled}
                  onChange={() =>
                    void persist(
                      stored.map((item) =>
                        item.id === rule.id ? { ...item, enabled: !item.enabled } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() => setEditing(rule)}
                  className="min-w-0 flex-1 text-left cursor-pointer"
                >
                  <span className="block truncate text-ui font-semibold">{rule.name}</span>
                  <span className="block truncate text-caption text-secondary">
                    {ruleSummary(rule, t)}
                  </span>
                </button>
                <button
                  type="button"
                  title={t('rules.moveUp')}
                  aria-label={t('rules.moveUp')}
                  disabled={index === 0}
                  onClick={() => void persist(reorderRules(stored, index, index - 1))}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  title={t('rules.moveDown')}
                  aria-label={t('rules.moveDown')}
                  disabled={index === stored.length - 1}
                  onClick={() => void persist(reorderRules(stored, index, index + 1))}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  title={t('rules.delete')}
                  aria-label={t('rules.delete')}
                  onClick={() => {
                    void confirmAction({
                      title: t('rules.delete'),
                      message: t('rules.deleteConfirm', { name: rule.name }),
                      confirmLabel: t('rules.delete'),
                      tone: 'danger',
                    }).then((confirmed) => {
                      if (confirmed) void persist(stored.filter((item) => item.id !== rule.id))
                    })
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPreview(null)
              setEditing(newRule())
            }}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer"
          >
            <Plus size={12} />
            {t('rules.add')}
          </button>
          {stored.length > 0 && (
            <button
              type="button"
              disabled={trying}
              onClick={() => void tryRules(stored)}
              className="flex items-center gap-1.5 rounded-control px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer disabled:opacity-50"
            >
              <FlaskConical size={12} />
              {trying ? t('rules.trying') : t('rules.try')}
            </button>
          )}
          <button
            type="button"
            onClick={() => ui$.ruleLogOpen.set(true)}
            className="flex items-center gap-1.5 rounded-control px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer"
          >
            <ScrollText size={12} />
            {t('rules.log')}
          </button>
        </div>

        <PreviewResult preview={preview} />
      </div>
    </SettingsGroup>
  )
}

/** A short line saying what a rule looks at and does, for the list. */
function ruleSummary(rule: Rule, t: (key: string, vars?: Record<string, unknown>) => string): string {
  const when = rule.conditions
    .map((condition) => `${t(`rules.field.${condition.field}`)} ${t(`rules.op.${condition.op}`)} “${condition.value}”`)
    .join(rule.matchMode === 'all' ? ' · ' : ' / ')
  const then = rule.actions
    .map((action) =>
      action.type === 'moveTo' ? `${t('rules.action.moveTo')} ${action.folder}` : t(`rules.action.${action.type}`),
    )
    .join(' · ')
  return `${when} → ${then}`
}

/**
 * What a try found.
 *
 * It says how many messages were looked at, not only how many matched: "three
 * matches" means something quite different out of twenty than out of two
 * thousand, and a rule is being judged on both.
 */
function PreviewResult({ preview }: { preview: RulePreview | null }) {
  const { t } = useTranslation()
  if (!preview) return null

  if (preview.matches.length === 0) {
    return <Notice tone="success">{t('rules.tryNone', { examined: preview.examined })}</Notice>
  }

  return (
    <Notice tone="warning" title={t('rules.tryResult', { count: preview.matches.length, examined: preview.examined })}>
      <ul className="mt-1 flex max-h-56 flex-col gap-1 overflow-y-auto">
        {preview.matches.map((hit) => (
          <li key={hit.uid} className="min-w-0">
            <p className="truncate text-caption text-primary">{hit.subject}</p>
            <p className="truncate text-2xs text-secondary">
              {hit.from} · {hit.actions.map((action) => `${action.ruleName}: ${action.action}`).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </Notice>
  )
}
