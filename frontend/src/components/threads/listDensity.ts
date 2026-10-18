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

/**
 * Compact in a narrow list of the automatic view (#283): two lines, the sender
 * and the date over the subject and the preview, about 56 px high. On one line
 * a list of 280 to 520 px cut the sender and the subject to a few characters.
 */
const NARROW_COMPACT: DensityStyle = {
  rowPadding: 'py-2',
  avatarSize: 32,
  rowGap: 'gap-1',
  singleLine: false,
  previewOnOwnLine: false,
}

/**
 * The measures for a density, falling back to the default for an unknown one.
 * `narrowAuto` says the rows are the automatic view's narrow rows, where
 * compact keeps two lines; the other densities already have two or more.
 */
export function densityStyle(density: ListDensity, narrowAuto = false): DensityStyle {
  if (narrowAuto && density === 'compact') return NARROW_COMPACT
  return STYLES[density] ?? STYLES.cosy
}
