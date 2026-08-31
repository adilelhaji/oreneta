import { useEffect, useState } from 'react'
import { Plus, Tag, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { confirmAction, showToast } from '../../states/ui'
import { LABEL_COLOURS, labels$, loadLabels, newLabel, saveLabels, type Label } from '../../states/labels'
import { TextInput } from '../field/Field'
import { SettingsGroup } from './AccountSettingsRows'

/**
 * Making, naming and colouring labels.
 *
 * Edited in place and saved as a set, which is how they are stored: the order
 * here is the order they appear on a conversation, and a label whose name is
 * still blank is simply not saved.
 */
export function LabelsSettingsSection() {
  const { t } = useTranslation()
  const stored = useValue(labels$.labels)
  const [draft, setDraft] = useState<Label[] | null>(null)

  useEffect(() => {
    void loadLabels()
  }, [])

  const labels = draft ?? stored

  const persist = async (next: Label[]) => {
    setDraft(next)
    try {
      await saveLabels(next)
      setDraft(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('labels.saveFailed'), 'error')
      // Back to what the core actually holds, rather than leaving the screen
      // showing labels that were never saved.
      setDraft(null)
      void loadLabels()
    }
  }

  return (
    <SettingsGroup title={t('labels.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        {/* Said plainly, because the alternative is someone discovering it by
            not finding their labels on another machine. */}
        <p className="text-[0.65625rem] text-secondary">{t('labels.localOnly')}</p>

        {labels.length === 0 ? (
          <p className="py-2 text-[0.8125rem] text-secondary">{t('labels.noneYet')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {labels.map((label, index) => (
              <li key={label.id} className="flex items-center gap-2">
                <div className="flex shrink-0 items-center gap-1">
                  {LABEL_COLOURS.map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      aria-label={colour}
                      title={colour}
                      onClick={() =>
                        void persist(labels.map((item, i) => (i === index ? { ...item, colour } : item)))
                      }
                      style={{ backgroundColor: colour }}
                      className={clsx(
                        'h-4 w-4 rounded-full transition-transform cursor-pointer',
                        label.colour === colour
                          ? 'ring-2 ring-offset-2 ring-offset-panel ring-primary/40 scale-110'
                          : 'opacity-45 hover:opacity-100',
                      )}
                    />
                  ))}
                </div>
                <TextInput
                  value={label.name}
                  placeholder={t('labels.namePlaceholder')}
                  aria-label={t('labels.name')}
                  onChange={(event) =>
                    setDraft(labels.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))
                  }
                  onBlur={() => void persist(labels)}
                  className="min-w-0 flex-1"
                />
                <button
                  type="button"
                  title={t('labels.delete')}
                  aria-label={t('labels.delete')}
                  onClick={() => {
                    void confirmAction({
                      title: t('labels.delete'),
                      message: t('labels.deleteConfirm', { name: label.name || t('labels.unnamed') }),
                      confirmLabel: t('labels.delete'),
                      tone: 'danger',
                    }).then((confirmed) => {
                      if (confirmed) void persist(labels.filter((_, i) => i !== index))
                    })
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setDraft([...labels, newLabel(labels)])}
          className="flex w-fit items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-[0.6875rem] font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer"
        >
          <Plus size={12} />
          {t('labels.add')}
        </button>

        {/* Deleting is the one that cannot be shrugged off, so it is said here
            rather than only in the confirmation. */}
        <p className="flex items-start gap-1.5 text-[0.65625rem] text-secondary">
          <Tag size={11} className="mt-px shrink-0" />
          <span>{t('labels.deleteWarning')}</span>
        </p>
      </div>
    </SettingsGroup>
  )
}
