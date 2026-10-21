import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  categories$,
  categoryProblem,
  fieldLabel,
  opLabel,
  MAX_CATEGORIES,
  newCategory,
  saveCategories,
  type Category,
  type CategoryCondition,
  type ConditionField,
  type ConditionOp,
} from '../../states/categories'
import { SettingsGroup } from '../dialog/AccountSettingsRows'
import { handleGroupArrowKeys } from '../../lib/direction'

const FIELDS: ConditionField[] = ['from', 'to', 'cc', 'recipient', 'subject']
const OPS: ConditionOp[] = ['contains', 'notContains', 'is', 'startsWith', 'endsWith']
const COLOURS = ['#2056dd', '#0f9d58', '#e8830c', '#c2255c', '#7048e8', '#0b7285', '#5c7cfa', '#868e96']
const button =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'
const field = 'rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary'

/**
 * Inbox categories (#91, ADR-0023): the tabs, in the order their rules are
 * tried, and what brings mail into each. A category without conditions is
 * filled only by hand.
 */
export function CategoriesGroup() {
  const { t } = useTranslation()
  const list = useValue(categories$.list)
  const [editing, setEditing] = useState<Category | null>(null)

  const next = editing
    ? list.some((c) => c.id === editing.id)
      ? list.map((c) => (c.id === editing.id ? editing : c))
      : [...list, editing]
    : list
  const problem = editing ? categoryProblem(next) : null
  const problems: Record<string, string> = {
    tooMany: t('categories.tooMany', { max: MAX_CATEGORIES, defaultValue: 'At most {max} categories.' }),
    name: t('categories.needsName', { defaultValue: 'Give it a name.' }),
    sameName: t('categories.sameName', { defaultValue: 'Another category already has that name.' }),
    emptyCondition: t('categories.emptyCondition', { defaultValue: 'Each condition needs something to look for.' }),
  }

  const setConditions = (conditions: CategoryCondition[]) => editing && setEditing({ ...editing, conditions })
  const move = (index: number, by: number) => {
    const order = [...list]
    ;[order[index], order[index + by]] = [order[index + by], order[index]]
    void saveCategories(order)
  }

  return (
    <SettingsGroup title={t('categories.title', { defaultValue: 'Inbox categories' })}>
      <p className="px-3.5 py-2 text-caption text-secondary">
        {t('categories.hint', {
          defaultValue:
            'Tabs for the inbox. Each conversation goes to the first category whose rules match, unless you put it or its sender somewhere yourself; the rest is in Other. All mail stays under All. Kept on this computer only.',
        })}
      </p>
      <ul>
        {list.map((category, index) => (
          <li key={category.id} className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2">
            <span className="flex min-w-0 items-center gap-2 truncate text-xs text-primary">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: category.colour }}
              />
              {category.name}
              <span className="text-2xs text-secondary">
                {category.conditions.length === 0
                  ? t('categories.byHand', { defaultValue: 'by hand only' })
                  : t('categories.nRules', { n: category.conditions.length, defaultValue: '{n} conditions' })}
              </span>
            </span>
            <span className="flex shrink-0 gap-1.5">
              <button
                type="button"
                className={button}
                disabled={index === 0}
                aria-label={t('categories.up', { name: category.name, defaultValue: 'Move {name} up' })}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={button}
                disabled={index === list.length - 1}
                aria-label={t('categories.down', { name: category.name, defaultValue: 'Move {name} down' })}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={button}
                aria-label={t('categories.edit', { name: category.name, defaultValue: 'Edit {name}' })}
                onClick={() => setEditing(category)}
              >
                <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={button}
                aria-label={t('categories.delete', { name: category.name, defaultValue: 'Delete {name}' })}
                onClick={() => void saveCategories(list.filter((c) => c.id !== category.id))}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              aria-label={t('categories.name', { defaultValue: 'Name' })}
              placeholder={t('categories.name', { defaultValue: 'Name' })}
              className={`${field} outline-none focus:border-accent-fg`}
            />
            <span
              role="radiogroup"
              aria-label={t('categories.colour', { defaultValue: 'Colour' })}
              className="flex gap-1"
              // Arrows pick the next colour, sideways in reading order (ADR-0061).
              onKeyDown={(event) => handleGroupArrowKeys(event, '[role="radio"]')}
            >
              {COLOURS.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  role="radio"
                  aria-checked={editing.colour === colour}
                  aria-label={colour}
                  onClick={() => setEditing({ ...editing, colour })}
                  className="h-5 w-5 rounded-full border-2 cursor-pointer"
                  style={{
                    backgroundColor: colour,
                    borderColor: editing.colour === colour ? 'currentColor' : 'transparent',
                  }}
                />
              ))}
            </span>
          </div>
          <label className="flex items-center gap-2 text-caption text-secondary">
            {t('categories.matchLabel', { defaultValue: 'Takes mail when' })}
            <select
              value={editing.matchMode}
              onChange={(e) => setEditing({ ...editing, matchMode: e.target.value as 'any' | 'all' })}
              className={field}
            >
              <option value="any">{t('categories.matchAny', { defaultValue: 'any condition holds' })}</option>
              <option value="all">{t('categories.matchAll', { defaultValue: 'every condition holds' })}</option>
            </select>
          </label>
          <ol className="flex flex-col gap-1.5">
            {editing.conditions.map((condition, index) => (
              <li key={index} className="flex flex-wrap items-center gap-1.5">
                <select
                  value={condition.field}
                  aria-label={t('categories.conditionField', { n: index + 1, defaultValue: 'Condition {n}: field' })}
                  onChange={(e) =>
                    setConditions(
                      editing.conditions.map((c, i) =>
                        i === index ? { ...c, field: e.target.value as ConditionField } : c,
                      ),
                    )
                  }
                  className={field}
                >
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {fieldLabel(f)}
                    </option>
                  ))}
                </select>
                <select
                  value={condition.op}
                  aria-label={t('categories.conditionOp', { n: index + 1, defaultValue: 'Condition {n}: comparison' })}
                  onChange={(e) =>
                    setConditions(
                      editing.conditions.map((c, i) => (i === index ? { ...c, op: e.target.value as ConditionOp } : c)),
                    )
                  }
                  className={field}
                >
                  {OPS.map((o) => (
                    <option key={o} value={o}>
                      {opLabel(o)}
                    </option>
                  ))}
                </select>
                <input
                  value={condition.value}
                  aria-label={t('categories.conditionValue', { n: index + 1, defaultValue: 'Condition {n}: text' })}
                  onChange={(e) =>
                    setConditions(editing.conditions.map((c, i) => (i === index ? { ...c, value: e.target.value } : c)))
                  }
                  className={`${field} w-44`}
                />
                <button
                  type="button"
                  className={button}
                  aria-label={t('categories.removeCondition', { n: index + 1, defaultValue: 'Remove condition {n}' })}
                  onClick={() => setConditions(editing.conditions.filter((_, i) => i !== index))}
                >
                  <X size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              onClick={() => setConditions([...editing.conditions, { field: 'from', op: 'contains', value: '' }])}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('categories.addCondition', { defaultValue: 'Add condition' })}
            </button>
          </div>
          {problem && (
            <p role="alert" className="text-caption text-danger">
              {problems[problem]}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={button} onClick={() => setEditing(null)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              className={button}
              disabled={!!problem}
              onClick={() => {
                void saveCategories(next).then((ok) => ok && setEditing(null))
              }}
            >
              {t('categories.save', { defaultValue: 'Save category' })}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3.5 py-3">
          <button
            type="button"
            className={button}
            disabled={list.length >= MAX_CATEGORIES}
            onClick={() => setEditing(newCategory(list))}
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('categories.add', { defaultValue: 'New category' })}
          </button>
        </div>
      )}
    </SettingsGroup>
  )
}
