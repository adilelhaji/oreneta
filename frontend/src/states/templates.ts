// Text the writer keeps because they write it often.
//
// Two shapes, told apart by where the text lands. A snippet is a paragraph
// dropped in where the cursor is — the directions to the office, the standard
// closing. A message template is a whole mail with its own subject, opened
// rather than inserted.
//
// The core owns them and validates them; this is the cache the composer reads
// while it is open, so that picking one is instant rather than a round trip.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type TemplateKind = 'snippet' | 'message'

export type Template = {
  id: string
  kind: TemplateKind
  /** What it is called in the list — not its subject. */
  name: string
  subject: string
  bodyHtml: string
  bodyText: string
}

export const templates$ = observable({
  templates: [] as Template[],
  loaded: false,
})

export function newTemplate(kind: TemplateKind = 'snippet'): Template {
  return {
    id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name: '',
    subject: '',
    bodyHtml: '',
    bodyText: '',
  }
}

/**
 * What is missing from a template, or null when it can be saved.
 *
 * The same rule the core applies, so the writer is told what is wrong while
 * they are still in the editor instead of when the save comes back refused.
 * The core still checks: this is the message, not the guard.
 */
export function templateProblem(template: Template): 'name' | 'body' | 'subjectOrBody' | null {
  if (!template.name.trim()) return 'name'
  const empty = !template.bodyHtml.trim() && !template.bodyText.trim()
  if (template.kind === 'snippet' && empty) return 'body'
  if (template.kind === 'message' && empty && !template.subject.trim()) return 'subjectOrBody'
  return null
}

export async function loadTemplates() {
  try {
    const res = await invoke<{ templates?: Template[] }>('templates.list', {})
    templates$.templates.set(res?.templates ?? [])
    templates$.loaded.set(true)
  } catch {
    // A set that cannot be read is not an empty set. Showing none would invite
    // writing them again on top of the ones already there.
  }
}

/**
 * Saves the whole set, in the order it is in.
 *
 * Incomplete templates are dropped rather than sent: the core refuses the
 * whole save if any one of them is wrong, and losing four good templates to
 * a fifth half-written one is not what the writer asked for.
 */
export async function saveTemplates(templates: Template[]) {
  const complete = templates.filter((template) => templateProblem(template) === null)
  await invoke('templates.save', { templates: complete })
  templates$.templates.set(complete)
}
