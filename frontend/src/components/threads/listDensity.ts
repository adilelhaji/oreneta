// How much room a thread-list row is given.
//
// One table rather than conditionals scattered through the row: every measure
// a density changes is stated here, side by side, so a new density is a column
// to fill in and not a hunt through the markup.

import type { ListDensity } from '../../states/settings'

export type DensityStyle = {
  /** Vertical padding on the row button. */
  rowPadding: string
  /** Size of the sender avatar, in pixels. */
  avatarSize: number
  /** Gap between the sender line and the subject line. */
  rowGap: string
  /**
   * Whether the subject and the preview share one line.
   *
   * Compact goes further and puts the sender on that line too: one row per
   * thread is the point of it.
   */
  singleLine: boolean
  /** Whether the preview gets a line of its own, below the subject. */
  previewOnOwnLine: boolean
}

const STYLES: Record<ListDensity, DensityStyle> = {
  compact: {
    rowPadding: 'py-1.5',
    avatarSize: 24,
    rowGap: 'gap-0',
    singleLine: true,
    previewOnOwnLine: false,
  },
  cosy: {
    rowPadding: 'py-3',
    avatarSize: 40,
    rowGap: 'gap-1',
    singleLine: false,
    previewOnOwnLine: false,
  },
  relaxed: {
    rowPadding: 'py-3.5',
    avatarSize: 44,
    rowGap: 'gap-1',
    singleLine: false,
    previewOnOwnLine: true,
  },
}

/** The measures for a density, falling back to the default for an unknown one. */
export function densityStyle(density: ListDensity): DensityStyle {
  return STYLES[density] ?? STYLES.cosy
}
