// Names the reader puts on conversations.
//
// Local to this install, and the interface says so where it matters: an IMAP
// keyword is not carried by every server and an Exchange category is a
// different thing again, so a label that appeared on one device and silently
// not on another would be worse than one that never claimed to travel.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { mail$ } from './mail'

export type Label = {
  id: string
  name: string
  /** As `#rrggbb`; the interface paints the chip in it. */
  colour: string
  /** Shows as a chip in the quick filter bar, not only in the dropdown. */
  inBar: boolean
  /**
   * The remote concept this label is linked to, per account it has a link
   * on — a Gmail label name, an Exchange category, an IMAP keyword — keyed
   * by account id. Empty for a label that is purely local, which is every
   * label until it is linked. See docs/adr/0002-remote-label-linking.md.
   */
  links: Record<string, string>
}

export const labels$ = observable({
  labels: [] as Label[],
  loaded: false,
})

/**
 * The colours a new label can take.
 *
 * A short list rather than a colour picker: the point of a label's colour is
 * telling it apart from the others at a glance, and a hundred near-identical
 * blues defeats that before it starts.
 */
export const LABEL_COLOURS = [
  '#2056dd',
  '#0f9d58',
  '#e8830c',
  '#c2255c',
  '#7048e8',
  '#0b7285',
  '#5c7cfa',
  '#868e96',
] as const

export function newLabel(existing: Label[]): Label {
  return {
    id: `label-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    // Walks the list so two labels made in a row do not come out the same.
    colour: LABEL_COLOURS[existing.length % LABEL_COLOURS.length],
    inBar: false,
    links: {},
  }
}

/** The label of an id, for painting a chip the list already carries. */
export function labelById(labels: Label[], id: string): Label | undefined {
  return labels.find((label) => label.id === id)
}

export async function loadLabels() {
  try {
    const res = await invoke<{ labels?: Label[] }>('labels.list', {})
    labels$.labels.set(res?.labels ?? [])
    labels$.loaded.set(true)
  } catch {
    // A set that cannot be read is not an empty set: showing none would invite
    // making them again on top of the ones already there.
  }
}

/**
 * Saves the whole set, in the order it is in.
 *
 * Labels with no name are dropped rather than saved: the core refuses them,
 * and a nameless chip is one nobody could tell from another.
 */
export async function saveLabels(labels: Label[]) {
  const named = labels
    .map((label) => ({ ...label, name: label.name.trim() }))
    .filter((label) => label.name)
  await invoke('labels.save', { labels: named })
  labels$.labels.set(named)
  // A deleted label is off every conversation now, so the rows on screen must
  // stop showing it: they were painted from an answer that is no longer true.
  const kept = new Set(named.map((label) => label.id))
  mail$.threads.set(
    mail$.threads
      .peek()
      .map((thread) =>
        thread.labels?.some((id) => !kept.has(id))
          ? { ...thread, labels: thread.labels.filter((id) => kept.has(id)) }
          : thread,
      ),
  )
}

/**
 * Links a label to an account's remote concept, matched by the name given —
 * an explicit choice the reader makes, not a background guess. Re-linking
 * under a new name replaces the old one.
 */
export async function linkLabel(labelId: string, accountId: string, remoteName: string) {
  const trimmed = remoteName.trim()
  if (!trimmed) return
  await invoke('labels.link', { label_id: labelId, account_id: accountId, remote_name: trimmed })
  labels$.labels.set(
    labels$.labels
      .peek()
      .map((label) =>
        label.id === labelId ? { ...label, links: { ...label.links, [accountId]: trimmed } } : label,
      ),
  )
}

/**
 * Clears a label's link on one account. The label itself, and whatever it
 * was linked to on the server, are both left as they were.
 */
export async function unlinkLabel(labelId: string, accountId: string) {
  await invoke('labels.unlink', { label_id: labelId, account_id: accountId })
  labels$.labels.set(
    labels$.labels.peek().map((label) => {
      if (label.id !== labelId) return label
      const links = { ...label.links }
      delete links[accountId]
      return { ...label, links }
    }),
  )
}

/** States the whole set of labels on one conversation. */
export async function assignLabels(threadId: string, labelIds: string[]) {
  const res = await invoke<{ labels?: string[] }>('labels.assign', {
    thread_id: threadId,
    label_ids: labelIds,
  })
  const applied = res?.labels ?? labelIds
  // The list is repainted from what the core actually stored, not from what
  // was asked for: a label that no longer exists must not appear to stick.
  mail$.threads.set(
    mail$.threads
      .peek()
      .map((thread) => (thread.thread_id === threadId ? { ...thread, labels: applied } : thread)),
  )
  return applied
}
