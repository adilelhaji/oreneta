import { observable } from '@legendapp/state'
// Quick Actions (#92, ADR-0022): a named, ordered list of steps run over the
// conversations the person has reviewed. The set is frozen when the action is
// confirmed, so mail that arrives meanwhile is not touched. Nothing here
// sends, forwards or deletes, and an action cannot call another.
import { accounts$ } from './accounts'
import { messageChangesBlocked } from '../lib/mailCapabilities'
import {
  archiveThreadStep,
  mail$,
  markThreadRead,
  markThreadUnread,
  moveThreadStep,
  refreshAfterSteps,
  starThread,
} from './mail'
import type { BulkSelectionItem } from './ui'

import { invalidReason, type QuickAction, type QuickStep, type QuickStepKind } from './quickActionModel'

export { invalidReason, sanitizeQuickActions, MAX_ACTIONS, MAX_STEPS } from './quickActionModel'
export type { QuickAction, QuickStep, QuickStepKind } from './quickActionModel'

export type StepOutcome = { kind: QuickStepKind; ok: boolean; reason?: string }
export type RunReport = {
  action: string
  steps: QuickStep[]
  rows: { threadId: string; subject: string; outcomes: StepOutcome[]; skipped: number }[]
}

export function frozenTargets(items: BulkSelectionItem[]): BulkSelectionItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (item.kind !== 'mail' || !item.threadId || seen.has(item.threadId)) return false
    seen.add(item.threadId)
    return true
  })
}

/** Whether any of these conversations is in an account whose messages cannot be changed. */
export function blockedTargets(items: BulkSelectionItem[]): boolean {
  return items.some((item) => messageChangesBlocked(accounts$.peek(), item.accountId))
}

function folderIdByName(accountId: string, name: string): string | null {
  const folders = mail$.foldersByAccount.peek()?.[accountId] ?? []
  const wanted = name.trim().toLowerCase()
  const found = folders.find((folder) => folder.name.toLowerCase() === wanted || folder.id.toLowerCase() === wanted)
  return found?.id ?? null
}

async function runStep(item: BulkSelectionItem, step: QuickStep) {
  switch (step.kind) {
    case 'markRead':
      return markThreadRead(item.threadId)
    case 'markUnread':
      return markThreadUnread(item.threadId)
    case 'star':
      return starThread(item.threadId, true)
    case 'unstar':
      return starThread(item.threadId, false)
    case 'archive':
      return archiveThreadStep(item.threadId)
    case 'move': {
      const folder = folderIdByName(item.accountId, step.folder ?? '')
      if (!folder) throw new Error(`no folder named "${step.folder}" in ${item.accountId}`)
      return moveThreadStep(item.threadId, folder)
    }
  }
}

/**
 * Runs an action over a frozen set: each conversation's steps in order, its
 * chain stopping at its first failure; the others carry on. Says what
 * happened to every step of every conversation.
 */
export async function runQuickAction(
  action: QuickAction,
  targets: BulkSelectionItem[],
  subjects: Record<string, string> = {},
): Promise<RunReport> {
  if (invalidReason(action) !== null) throw new Error('this Quick Action cannot run as it is')
  if (blockedTargets(targets)) throw new Error('these messages cannot be changed from this account')
  const report: RunReport = { action: action.name, steps: action.steps, rows: [] }
  for (const item of targets) {
    const outcomes: StepOutcome[] = []
    for (const step of action.steps) {
      try {
        await runStep(item, step)
        outcomes.push({ kind: step.kind, ok: true })
      } catch (error) {
        outcomes.push({ kind: step.kind, ok: false, reason: error instanceof Error ? error.message : String(error) })
        break
      }
    }
    report.rows.push({
      threadId: item.threadId,
      subject: subjects[item.threadId] ?? '',
      outcomes,
      skipped: action.steps.length - outcomes.length,
    })
  }
  await refreshAfterSteps(targets[0]?.accountId)
  return report
}

export function failedRows(report: RunReport) {
  return report.rows.filter((row) => row.outcomes.some((outcome) => !outcome.ok))
}

// ---- Running from the interface ------------------------------------------------

export const quickRun$ = observable({
  /** Shown for confirmation: the action and the conversations, frozen. */
  pending: null as { action: QuickAction; targets: BulkSelectionItem[]; subjects: Record<string, string> } | null,
  running: false,
  report: null as RunReport | null,
  error: '',
})

/** Freezes the selection and asks for confirmation; runs nothing yet. */
export function startQuickAction(action: QuickAction, items: BulkSelectionItem[]) {
  const targets = frozenTargets(items)
  if (targets.length === 0) return
  const subjects: Record<string, string> = {}
  for (const thread of mail$.threads.peek()) {
    if (targets.some((item) => item.threadId === thread.thread_id)) subjects[thread.thread_id] = thread.subject
  }
  quickRun$.assign({ pending: { action, targets, subjects }, report: null, error: '', running: false })
}

export async function confirmQuickAction() {
  const pending = quickRun$.pending.peek()
  if (!pending || quickRun$.running.peek()) return
  quickRun$.running.set(true)
  try {
    const report = await runQuickAction(pending.action, pending.targets, pending.subjects)
    quickRun$.assign({ report, pending: null })
  } catch (error) {
    quickRun$.error.set(error instanceof Error ? error.message : String(error))
  } finally {
    quickRun$.running.set(false)
  }
}

export function closeQuickRun() {
  if (!quickRun$.running.peek()) quickRun$.assign({ pending: null, report: null, error: '' })
}
