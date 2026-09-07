import { useValue } from '@legendapp/state/react'
import { labels$, labelById } from '../../states/labels'
import { Chip } from '../chip/Chip'

/**
 * The labels on a conversation, as small coloured chips.
 *
 * Painted from the label set rather than from anything stored on the row, so
 * renaming or recolouring a label shows everywhere at once instead of only
 * where the list happened to reload.
 *
 * A label whose id the row still carries but which no longer exists is left
 * out rather than drawn blank: the core prunes those, and until the row is
 * next read the honest thing is to show nothing.
 */
export function LabelChips({ ids, max = 3 }: { ids?: string[]; max?: number }) {
  const labels = useValue(labels$.labels)
  if (!ids?.length) return null

  const known = ids.map((id) => labelById(labels, id)).filter((label) => !!label)
  if (known.length === 0) return null

  const shown = known.slice(0, max)
  const hidden = known.length - shown.length

  return (
    <span className="flex min-w-0 shrink items-center gap-1">
      {shown.map((label) => (
        <Chip key={label.id} size="sm" colour={label.colour} title={label.name} className="max-w-[8rem]">
          {label.name}
        </Chip>
      ))}
      {hidden > 0 && <span className="shrink-0 text-2xs font-semibold text-secondary">+{hidden}</span>}
    </span>
  )
}
