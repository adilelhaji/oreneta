// Putting kept text into a message being written.
//
// Two questions, and they are different. Where does a snippet land — which is
// arithmetic on a caret and belongs here, tested, rather than inline in an
// event handler. And what happens when a whole-message template meets a
// message that already has words in it — which is a question about not
// destroying somebody's work, and so must have an answer that is stated
// rather than assumed.

import type { ComposeDraft } from '../../types'
import type { Template } from '../../states/templates'

/**
 * Put text in at the caret, replacing a selection if there is one.
 *
 * Returns where the caret should end up, so the writer carries on from after
 * what was inserted instead of being sent back to the top of the box.
 */
export function insertAtCaret(
  value: string,
  insert: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  // A caret outside the text — a stale ref, a field that was never focused —
  // means nobody knows where they were, so the text goes at the end rather
  // than at a position invented for the occasion.
  const from = start >= 0 && start <= value.length ? start : value.length
  const to = end >= from && end <= value.length ? end : from
  return {
    text: `${value.slice(0, from)}${insert}${value.slice(to)}`,
    caret: from + insert.length,
  }
}

/** Whether the writer has put anything in the message yet. */
export function draftIsEmpty(draft: Pick<ComposeDraft, 'subject' | 'text' | 'html'>): boolean {
  if (draft.subject.trim()) return false
  if (draft.text.trim()) return false
  // An editor with nothing in it still reports a paragraph, so the markup is
  // read for its text rather than for its length.
  return !draft.html.replace(/<[^>]*>/g, '').trim()
}

/**
 * Whether applying a whole-message template would destroy work.
 *
 * A message template states a subject and a body; putting it into an empty
 * composer states them, and putting it into one somebody has been writing in
 * overwrites them. Only the second needs asking about, and it is asked rather
 * than guessed.
 */
export function messageTemplateOverwrites(
  draft: Pick<ComposeDraft, 'subject' | 'text' | 'html'>,
  template: Template,
): boolean {
  return template.kind === 'message' && !draftIsEmpty(draft)
}

/** The fields a message template states, in the mode the composer is in. */
export function messageTemplateFields(
  template: Template,
  rich: boolean,
): Pick<ComposeDraft, 'subject' | 'text' | 'html'> {
  return {
    subject: template.subject,
    // Both forms are kept precisely so neither mode has to derive the other.
    // Where one is missing the other stands in, because showing the text of a
    // template as plain is a smaller loss than showing nothing.
    html: rich ? template.bodyHtml || template.bodyText : '',
    text: rich ? '' : template.bodyText || template.bodyHtml.replace(/<[^>]*>/g, ''),
  }
}
