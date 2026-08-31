import { Plus, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { SelectInput, TextInput } from '../field/Field'
import {
  RULE_FIELDS,
  RULE_OPS,
  ruleProblem,
  type Rule,
  type RuleAction,
  type RuleCondition,
} from '../../states/rules'
import type { Account } from '../../types'
import { labels$ } from '../../states/labels'

const ACTION_TYPES: RuleAction['type'][] = ['moveTo', 'markRead', 'star', 'addLabel', 'stop']

function blankAction(type: RuleAction['type'], firstLabelId: string): RuleAction {
  if (type === 'moveTo') return { type: 'moveTo', folder: '' }
  // Seeded with a label rather than left blank: the picker below can only
  // offer labels that exist, and an empty one would be a rule that cannot be
  // saved for a reason the reader did not choose.
  if (type === 'addLabel') return { type: 'addLabel', labelId: firstLabelId }
  return { type } as RuleAction
}

/**
 * The form for one rule: what it looks at, and what it does.
 *
 * It says what is wrong while the rule is being written rather than after
 * pressing save. The core refuses the same things and is the authority; this
 * is so the reader finds out at the moment they can still fix it.
 */
export function RuleEditor({
  rule,
  accounts,
  onChange,
}: {
  rule: Rule
  accounts: Account[]
  onChange: (rule: Rule) => void
}) {
  const { t } = useTranslation()
  const labels = useValue(labels$.labels)
  const problem = ruleProblem(rule)

  const setCondition = (index: number, condition: RuleCondition) =>
    onChange({ ...rule, conditions: rule.conditions.map((c, i) => (i === index ? condition : c)) })
  const setAction = (index: number, action: RuleAction) =>
    onChange({ ...rule, actions: rule.actions.map((a, i) => (i === index ? action : a)) })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <TextInput
          value={rule.name}
          onChange={(event) => onChange({ ...rule, name: event.target.value })}
          placeholder={t('rules.namePlaceholder')}
          aria-label={t('rules.name')}
        />
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[0.6875rem] font-semibold text-secondary">
            {t('rules.appliesTo')}
          </span>
          <SelectInput
            value={rule.account}
            onChange={(event) => onChange({ ...rule, account: event.target.value })}
            className="min-w-0 flex-1 rounded-xl py-1.5 pl-3 text-[0.8125rem]"
          >
            <option value="">{t('rules.allAccounts')}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.display_name || account.email}
              </option>
            ))}
          </SelectInput>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[0.6875rem] font-bold uppercase tracking-wide text-secondary">
            {t('rules.when')}
          </span>
          <SelectInput
            value={rule.matchMode}
            onChange={(event) => onChange({ ...rule, matchMode: event.target.value as Rule['matchMode'] })}
            className="rounded-xl py-1 pl-2.5 text-[0.75rem]"
          >
            <option value="all">{t('rules.match.all')}</option>
            <option value="any">{t('rules.match.any')}</option>
          </SelectInput>
        </div>

        {rule.conditions.map((condition, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <SelectInput
              value={condition.field}
              onChange={(event) =>
                setCondition(index, { ...condition, field: event.target.value as RuleCondition['field'] })
              }
              className="w-32 shrink-0 rounded-xl py-1.5 pl-2.5 text-[0.75rem]"
            >
              {RULE_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {t(`rules.field.${field}`)}
                </option>
              ))}
            </SelectInput>
            <SelectInput
              value={condition.op}
              onChange={(event) =>
                setCondition(index, { ...condition, op: event.target.value as RuleCondition['op'] })
              }
              className="w-36 shrink-0 rounded-xl py-1.5 pl-2.5 text-[0.75rem]"
            >
              {RULE_OPS.map((op) => (
                <option key={op} value={op}>
                  {t(`rules.op.${op}`)}
                </option>
              ))}
            </SelectInput>
            <TextInput
              value={condition.value}
              onChange={(event) => setCondition(index, { ...condition, value: event.target.value })}
              placeholder={t('rules.valuePlaceholder')}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              title={t('rules.remove')}
              aria-label={t('rules.remove')}
              onClick={() =>
                onChange({ ...rule, conditions: rule.conditions.filter((_, i) => i !== index) })
              }
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange({
              ...rule,
              conditions: [...rule.conditions, { field: 'from', op: 'contains', value: '' }],
            })
          }
          className="flex w-fit items-center gap-1 rounded-lg px-2 py-1 text-[0.6875rem] font-semibold text-accent transition-colors hover:bg-accent/10 cursor-pointer"
        >
          <Plus size={12} />
          {t('rules.addCondition')}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-[0.6875rem] font-bold uppercase tracking-wide text-secondary">
          {t('rules.then')}
        </span>
        {rule.actions.map((action, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <SelectInput
              value={action.type}
              onChange={(event) =>
                setAction(index, blankAction(event.target.value as RuleAction['type'], labels[0]?.id ?? ''))
              }
              className="w-40 shrink-0 rounded-xl py-1.5 pl-2.5 text-[0.75rem]"
            >
              {ACTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`rules.action.${type}`)}
                </option>
              ))}
            </SelectInput>
            {action.type === 'moveTo' && (
              <TextInput
                value={action.folder}
                onChange={(event) => setAction(index, { type: 'moveTo', folder: event.target.value })}
                placeholder={t('rules.folderPlaceholder')}
                className="min-w-0 flex-1"
              />
            )}
            {action.type === 'addLabel' &&
              (labels.length === 0 ? (
                <span className="min-w-0 flex-1 text-[0.6875rem] text-secondary">{t('labels.noneYet')}</span>
              ) : (
                <SelectInput
                  value={action.labelId}
                  onChange={(event) => setAction(index, { type: 'addLabel', labelId: event.target.value })}
                  aria-label={t('labels.label')}
                  className="min-w-0 flex-1 rounded-xl py-1.5 pl-2.5 text-[0.75rem]"
                >
                  {labels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </SelectInput>
              ))}
            <button
              type="button"
              title={t('rules.remove')}
              aria-label={t('rules.remove')}
              onClick={() => onChange({ ...rule, actions: rule.actions.filter((_, i) => i !== index) })}
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange({ ...rule, actions: [...rule.actions, blankAction('markRead', '')] })}
          className="flex w-fit items-center gap-1 rounded-lg px-2 py-1 text-[0.6875rem] font-semibold text-accent transition-colors hover:bg-accent/10 cursor-pointer"
        >
          <Plus size={12} />
          {t('rules.addAction')}
        </button>
        <p className="text-[0.65625rem] text-secondary">{t('rules.noDelete')}</p>
      </section>

      {problem && (
        <p className="text-[0.6875rem] font-medium text-rose-500">{t(`rules.problem.${problem}`)}</p>
      )}
    </div>
  )
}
