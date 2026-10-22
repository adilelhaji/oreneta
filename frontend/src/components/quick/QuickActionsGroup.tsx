import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$ } from '../../states/settings'
import {
  invalidReason,
  MAX_ACTIONS,
  MAX_STEPS,
  type QuickAction,
  type QuickStep,
  type QuickStepKind,
} from '../../states/quickActionModel'
import { SettingsGroup } from '../dialog/AccountSettingsRows'
import { useStepLabel } from './QuickActionDialog'
import { forwardArrow } from '../../lib/direction'

const KINDS: QuickStepKind[] = ['markRead', 'markUnread', 'star', 'unstar', 'archive', 'move']
const action =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'

/** Quick Actions (#92): named step lists, run on a selection with Alt+1…9. */
export function QuickActionsGroup() {
  const { t } = useTranslation()
  const actions = useValue(settings$.quickActions)
  const [editing, setEditing] = useState<QuickAction | null>(null)
  const label = useStepLabel()

  const reasons: Record<string, string> = {
    name: t('quick.needsName', { defaultValue: 'Give it a name.' }),
    empty: t('quick.needsStep', { defaultValue: 'Add at least one step.' }),
    tooLong: t('quick.tooLong', { max: MAX_STEPS, defaultValue: 'At most {max} steps.' }),
    noFolder: t('quick.needsFolder', { defaultValue: 'Name the folder to move to.' }),
    leaveLast: t('quick.leaveLast', {
      defaultValue:
        'Archiving or moving takes the conversation away, so it has to be the last step, and there can be one.',
    }),
    unsupported: t('quick.unsupported', { defaultValue: 'That step is not available.' }),
  }
  const problem = editing ? invalidReason(editing) : null

  const save = () => {
    if (!editing || problem) return
    const others = actions.filter((a) => a.id !== editing.id)
    const index = actions.findIndex((a) => a.id === editing.id)
    settings$.quickActions.set(
      index === -1 ? [...others, editing] : actions.map((a) => (a.id === editing.id ? editing : a)),
    )
    setEditing(null)
  }
  const setSteps = (steps: QuickStep[]) => editing && setEditing({ ...editing, steps })

  return (
    <SettingsGroup title={t('quick.title', { defaultValue: 'Quick Actions' })}>
      <p className="px-3.5 py-2 text-caption text-secondary">
        {t('quick.hint', {
          defaultValue:
            'Steps run in order on the conversations you select, with Alt+1…9 or from the selection menu, after you confirm. They never send or delete.',
        })}
      </p>
      <ul>
        {actions.map((quick, index) => (
          <li key={quick.id} className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2">
            <span className="min-w-0 truncate text-xs text-primary">
              <span className="me-2 text-2xs text-secondary">Alt+{index + 1}</span>
              {quick.name}
              <span className="ms-2 text-2xs text-secondary">{quick.steps.map(label).join(` ${forwardArrow()} `)}</span>
            </span>
            <span className="flex shrink-0 gap-1.5">
              <button
                type="button"
                className={action}
                aria-label={t('quick.edit', { name: quick.name, defaultValue: 'Edit {name}' })}
                onClick={() => setEditing(quick)}
              >
                <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={action}
                aria-label={t('quick.delete', { name: quick.name, defaultValue: 'Delete {name}' })}
                onClick={() => settings$.quickActions.set(actions.filter((a) => a.id !== quick.id))}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            aria-label={t('quick.name', { defaultValue: 'Name' })}
            placeholder={t('quick.name', { defaultValue: 'Name' })}
            className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
          />
          <ol className="flex flex-col gap-1.5">
            {editing.steps.map((step, index) => (
              <li key={index} className="flex flex-wrap items-center gap-1.5">
                <span className="w-5 text-2xs text-secondary">{index + 1}.</span>
                <select
                  value={step.kind}
                  aria-label={t('quick.stepN', { n: index + 1, defaultValue: 'Step {n}' })}
                  onChange={(e) => {
                    const kind = e.target.value as QuickStepKind
                    setSteps(
                      editing.steps.map((s, i) =>
                        i === index ? (kind === 'move' ? { kind, folder: s.folder ?? '' } : { kind }) : s,
                      ),
                    )
                  }}
                  className="rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {label({ kind, folder: '…' })}
                    </option>
                  ))}
                </select>
                {step.kind === 'move' && (
                  <input
                    value={step.folder ?? ''}
                    aria-label={t('quick.folder', { defaultValue: 'Folder' })}
                    placeholder={t('quick.folder', { defaultValue: 'Folder' })}
                    onChange={(e) =>
                      setSteps(editing.steps.map((s, i) => (i === index ? { ...s, folder: e.target.value } : s)))
                    }
                    className="w-36 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary"
                  />
                )}
                <button
                  type="button"
                  className={action}
                  disabled={index === 0}
                  aria-label={t('quick.up', { defaultValue: 'Move up' })}
                  onClick={() => {
                    const steps = [...editing.steps]
                    ;[steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]
                    setSteps(steps)
                  }}
                >
                  <ArrowUp size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={action}
                  disabled={index === editing.steps.length - 1}
                  aria-label={t('quick.down', { defaultValue: 'Move down' })}
                  onClick={() => {
                    const steps = [...editing.steps]
                    ;[steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]
                    setSteps(steps)
                  }}
                >
                  <ArrowDown size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={action}
                  aria-label={t('quick.removeStep', { defaultValue: 'Remove step' })}
                  onClick={() => setSteps(editing.steps.filter((_, i) => i !== index))}
                >
                  <X size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={action}
              disabled={editing.steps.length >= MAX_STEPS}
              onClick={() => setSteps([...editing.steps, { kind: 'markRead' }])}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('quick.addStep', { defaultValue: 'Add step' })}
            </button>
            <button type="button" className={action} disabled={!!problem} onClick={save}>
              {t('quick.save', { defaultValue: 'Save' })}
            </button>
            <button type="button" className={action} onClick={() => setEditing(null)}>
              {t('buttons.cancel')}
            </button>
          </div>
          {problem && <p className="text-caption text-secondary">{reasons[problem]}</p>}
        </div>
      ) : (
        actions.length < MAX_ACTIONS && (
          <div className="px-3.5 py-2">
            <button
              type="button"
              className={action}
              onClick={() =>
                setEditing({ id: `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: '', steps: [] })
              }
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('quick.new', { defaultValue: 'New Quick Action' })}
            </button>
          </div>
        )
      )}
    </SettingsGroup>
  )
}
