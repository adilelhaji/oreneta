import { useValue } from '@legendapp/state/react'
import { labels$, labelById } from '../../states/labels'

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
        <span
          key={label.id}
          title={label.name}
          style={{ color: label.colour, borderColor: `${label.colour}55`, backgroundColor: `${label.colour}14` }}
          className="max-w-[8rem] truncate rounded border px-1 py-px text-[0.625rem] font-semibold leading-tight"
        >
          {label.name}
        </span>
      ))}
      {hidden > 0 && <span className="shrink-0 text-[0.625rem] font-semibold text-secondary">+{hidden}</span>}
    </span>
  )
}
