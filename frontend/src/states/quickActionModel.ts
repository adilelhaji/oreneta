// The shape of a Quick Action (#92, ADR-0022), with no dependencies so the
// settings store can read stored ones without importing the mail state.

export type QuickStepKind = 'markRead' | 'markUnread' | 'star' | 'unstar' | 'archive' | 'move'
export type QuickStep = { kind: QuickStepKind; /** For `move`: the folder's name. */ folder?: string }
export type QuickAction = { id: string; name: string; steps: QuickStep[] }

export const MAX_STEPS = 8
export const MAX_ACTIONS = 9
const KINDS: QuickStepKind[] = ['markRead', 'markUnread', 'star', 'unstar', 'archive', 'move']

/** Why an action cannot be kept as it is, or `null` when it can. */
export function invalidReason(action: Pick<QuickAction, 'name' | 'steps'>): string | null {
  if (!action.name.trim()) return 'name'
  if (action.steps.length === 0) return 'empty'
  if (action.steps.length > MAX_STEPS) return 'tooLong'
  for (const step of action.steps) {
    if (!KINDS.includes(step.kind)) return 'unsupported'
    if (step.kind === 'move' && !step.folder?.trim()) return 'noFolder'
  }
  // A conversation that has left the folder cannot be acted on there: the
  // step that takes it away has to be the last, and there can be one.
  const leaving = action.steps.findIndex((step) => step.kind === 'archive' || step.kind === 'move')
  if (leaving !== -1 && leaving !== action.steps.length - 1) return 'leaveLast'
  return null
}

/** Keeps the stored actions that are valid, dropping anything else. */
export function sanitizeQuickActions(value: unknown): QuickAction[] | null {
  if (!Array.isArray(value)) return null
  const out: QuickAction[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<QuickAction>
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !Array.isArray(candidate.steps))
      continue
    const steps = candidate.steps
      .filter(
        (step): step is QuickStep => !!step && typeof step === 'object' && KINDS.includes((step as QuickStep).kind),
      )
      .map((step) =>
        step.kind === 'move' ? { kind: step.kind, folder: String(step.folder ?? '') } : { kind: step.kind },
      )
    const action = { id: candidate.id, name: candidate.name.trim(), steps }
    if (invalidReason(action) === null) out.push(action)
    if (out.length === MAX_ACTIONS) break
  }
  return out
}
