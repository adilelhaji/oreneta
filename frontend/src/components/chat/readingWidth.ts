// How wide a message body is allowed to run.
//
// Long lines are hard to read: past roughly seventy characters the eye starts
// losing the beginning of the next line, and a maximised window otherwise
// gives a plain-text message lines hundreds of characters across. The cap is
// in `ch` so it follows the reader's font size rather than fighting it.

import type { ReadingWidth } from '../../states/settings'

/** The measure a body is held to, or null to let it fill the pane. */
const MEASURE: Record<ReadingWidth, string | null> = {
  comfortable: '72ch',
  wide: '96ch',
  full: null,
}

export function readingMeasure(width: ReadingWidth): string | null {
  // `null` is an answer — "no cap" — so an unknown width has to be told apart
  // from `full` rather than folded into it by a `??`.
  const measure = MEASURE[width]
  return measure === undefined ? MEASURE.comfortable : measure
}

/**
 * The cap for a chat bubble, which is already a share of the pane.
 *
 * Whichever is narrower: the bubble should not grow past its share on a wide
 * window, nor past a readable measure on a very wide one.
 */
export function bubbleMaxWidth(width: ReadingWidth, share: string): string {
  const measure = readingMeasure(width)
  return measure ? `min(${share}, ${measure})` : share
}
