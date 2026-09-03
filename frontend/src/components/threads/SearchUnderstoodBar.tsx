import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { mail$ } from '../../states/mail'
import { Chip } from '../chip/Chip'

/** Turns `after:1767225600` back into a date the reader recognises. */
function readable(part: string, t: (key: string, vars?: Record<string, unknown>) => string): string {
  const [field, ...rest] = part.split(':')
  const value = rest.join(':')
  if (field === 'after' || field === 'before') {
    const at = Number(value)
    if (Number.isFinite(at)) {
      return `${t(`search.part.${field}`)} ${new Date(at * 1000).toLocaleDateString()}`
    }
  }
  if (field === 'is' || field === 'has') return t(`search.part.${field}.${value}`, { defaultValue: part })
  return `${t(`search.part.${field}`, { defaultValue: field })} ${value}`
}

/**
 * How the search box was read, shown back under it.
 *
 * Only once an operator was recognised — a plain search needs no explaining,
 * and a bar that appeared for every keystroke would be noise. What it is for
 * is the case that otherwise has no answer: a search that found nothing, where
 * the reader cannot tell "there is none" from "that is not what I meant".
 *
 * The parts come from the core, with the answer. Working them out again here
 * would be a second reading of the same query, and the one thing a reader must
 * be able to trust is that what they are shown is what was searched for.
 */
export function SearchUnderstoodBar() {
  const { t } = useTranslation()
  const understood = useValue(mail$.searchUnderstood)
  if (!understood?.hasOperators) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
      <span className="text-2xs font-semibold uppercase tracking-wide text-secondary">
        {t('search.understoodAs')}
      </span>
      {understood.parts.map((part) => (
        <Chip key={part} size="sm" tone={part.startsWith('text:') ? 'neutral' : 'accent'}>
          {readable(part, t)}
        </Chip>
      ))}
    </div>
  )
}
