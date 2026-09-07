import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { showToast } from '../../states/ui'
import {
  loadTemplates,
  newTemplate,
  saveTemplates,
  templateProblem,
  templates$,
  type Template,
  type TemplateKind,
} from '../../states/templates'
import { SettingsGroup } from './AccountSettingsRows'
import { SelectInput, TextInput } from '../field/Field'

/** Move one item, returning a new list. */
function reorder<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Where kept text is written and arranged.
 *
 * Editing happens in place rather than behind a dialog: a template is a name
 * and some words, and putting three fields behind a modal would be more
 * ceremony than the thing deserves. The order is the order they appear in the
 * composer's menu, which is why it can be changed here.
 *
 * Templates are stored in plain text. The composer's rich mode will show them
 * as written, but nothing here formats: a snippet editor with its own bold
 * button would be a second, worse text editor to maintain beside the real one.
 */
export function TemplatesSettingsSection() {
  const { t } = useTranslation()
  const stored = useValue(templates$.templates)
  const loaded = useValue(templates$.loaded)
  const [drafts, setDrafts] = useState<Template[] | null>(null)

  useEffect(() => {
    if (!loaded) void loadTemplates()
  }, [loaded])

  // Edited locally and saved on demand, so a half-typed name is not sent to
  // the core on every keystroke and refused for being half-typed.
  const list = drafts ?? stored
  const dirty = drafts !== null

  const change = (id: string, partial: Partial<Template>) =>
    setDrafts(list.map((template) => (template.id === id ? { ...template, ...partial } : template)))

  const persist = async (next: Template[]) => {
    try {
      await saveTemplates(next)
      setDrafts(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('templates.saveFailed'), 'error')
    }
  }

  return (
    <SettingsGroup title={t('templates.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('templates.intro')}</p>

        {list.length === 0 ? (
          <p className="py-2 text-ui text-secondary">{t('templates.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((template, index) => {
              const problem = templateProblem(template)
              return (
                <li
                  key={template.id}
                  className="flex flex-col gap-2 rounded-control border border-border bg-panel px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <TextInput
                      value={template.name}
                      onChange={(event) => change(template.id, { name: event.target.value })}
                      placeholder={t('templates.namePlaceholder')}
                      className="min-w-0 flex-1"
                    />
                    <SelectInput
                      value={template.kind}
                      onChange={(event) =>
                        change(template.id, { kind: event.target.value as TemplateKind })
                      }
                      className="w-32 shrink-0"
                      aria-label={t('templates.kindLabel')}
                    >
                      <option value="snippet">{t('templates.kind.snippet')}</option>
                      <option value="message">{t('templates.kind.message')}</option>
                    </SelectInput>
                    <button
                      type="button"
                      title={t('templates.moveUp')}
                      aria-label={t('templates.moveUp')}
                      disabled={index === 0}
                      onClick={() => setDrafts(reorder(list, index, index - 1))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      title={t('templates.moveDown')}
                      aria-label={t('templates.moveDown')}
                      disabled={index === list.length - 1}
                      onClick={() => setDrafts(reorder(list, index, index + 1))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      type="button"
                      title={t('templates.remove')}
                      aria-label={t('templates.remove')}
                      onClick={() => setDrafts(list.filter((item) => item.id !== template.id))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  {/* A subject belongs to a whole message and means nothing on
                      a snippet, so it appears with the shape that has one. */}
                  {template.kind === 'message' && (
                    <TextInput
                      value={template.subject}
                      onChange={(event) => change(template.id, { subject: event.target.value })}
                      placeholder={t('templates.subjectPlaceholder')}
                    />
                  )}

                  <textarea
                    value={template.bodyText}
                    onChange={(event) => change(template.id, { bodyText: event.target.value })}
                    placeholder={t('templates.bodyPlaceholder')}
                    rows={3}
                    className="w-full resize-y rounded-control border border-border bg-app px-2.5 py-1.5 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
                  />

                  {problem && (
                    <p className="text-caption text-rose-600 dark:text-rose-400">
                      {t(`templates.problem.${problem}`)}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDrafts([...list, newTemplate()])}
            className="flex items-center gap-1.5 rounded-control px-3 py-1.5 text-caption font-semibold text-accent transition-colors hover:bg-accent/10 cursor-pointer"
          >
            <Plus size={14} /> {t('templates.add')}
          </button>
          {dirty && (
            <>
              <button
                type="button"
                onClick={() => void persist(list)}
                className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer"
              >
                {t('buttons.save')}
              </button>
              <button
                type="button"
                onClick={() => setDrafts(null)}
                className="rounded-control px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer"
              >
                {t('buttons.cancel')}
              </button>
              {/* Said plainly, because a save that quietly drops what is not
                  finished would be a save that lost work without saying so. */}
              {list.some((template) => templateProblem(template) !== null) && (
                <span className="text-caption text-secondary">{t('templates.incompleteDropped')}</span>
              )}
            </>
          )}
        </div>
      </div>
    </SettingsGroup>
  )
}
