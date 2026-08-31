// Rules the reader writes, applied to mail as it arrives.
//
// The deciding and the doing both live in the core, because a rule has to run
// when mail arrives — which is whenever the core is running, not whenever a
// window happens to be open. What this module holds is the editing of them,
// the dry run, and the record of what they did.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type RuleField = 'from' | 'to' | 'cc' | 'recipient' | 'subject'
export type RuleOp = 'contains' | 'notContains' | 'is' | 'startsWith' | 'endsWith'
export type RuleMatch = 'all' | 'any'

export type RuleCondition = {
  field: RuleField
  op: RuleOp
  value: string
}

/**
 * What a rule does to a message it matched.
 *
 * There is no delete: destroying mail is the one thing here a reader could not
 * undo, and moving to Trash says the same while leaving it recoverable.
 */
export type RuleAction =
  | { type: 'moveTo'; folder: string }
  | { type: 'markRead' }
  | { type: 'star' }
  /** Adds one of the reader's local labels, leaving the others in place. */
  | { type: 'addLabel'; labelId: string }
  | { type: 'stop' }

export type Rule = {
  id: string
  /** Which account it applies to. Empty means every account. */
  account: string
  name: string
  enabled: boolean
  matchMode: RuleMatch
  conditions: RuleCondition[]
  actions: RuleAction[]
}

/** One message a dry run would touch, and what would happen to it. */
export type RulePreviewHit = {
  uid: number
  subject: string
  from: string
  date: number
  actions: { ruleId: string; ruleName: string; action: string }[]
}

export type RulePreview = {
  examined: number
  matches: RulePreviewHit[]
}

/** One thing a rule actually did. */
export type RuleLogEntry = {
  at: number
  account: string
  ruleId: string
  ruleName: string
  folder: string
  uid: number
  subject: string
  from: string
  action: string
  /** `done`, or why it did not happen. */
  outcome: string
}

export const rules$ = observable({
  rules: [] as Rule[],
  loaded: false,
  log: [] as RuleLogEntry[],
})

export const RULE_FIELDS: RuleField[] = ['from', 'to', 'cc', 'recipient', 'subject']
export const RULE_OPS: RuleOp[] = ['contains', 'notContains', 'is', 'startsWith', 'endsWith']

/** A blank rule, ready to be filled in. */
export function newRule(): Rule {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    account: '',
    name: '',
    enabled: true,
    matchMode: 'all',
    conditions: [{ field: 'from', op: 'contains', value: '' }],
    actions: [{ type: 'moveTo', folder: '' }],
  }
}

/**
 * Why a rule cannot be saved, or null when it can.
 *
 * The core refuses these too, and is the authority. Checking here as well is
 * so the reader is told while they are still writing the rule, rather than
 * after pressing save.
 */
export function ruleProblem(
  rule: Rule,
): 'name' | 'conditions' | 'value' | 'actions' | 'folder' | 'label' | null {
  if (!rule.name.trim()) return 'name'
  if (rule.conditions.length === 0) return 'conditions'
  if (rule.conditions.some((condition) => !condition.value.trim())) return 'value'
  if (rule.actions.length === 0) return 'actions'
  if (rule.actions.some((action) => action.type === 'moveTo' && !action.folder.trim())) return 'folder'
  if (rule.actions.some((action) => action.type === 'addLabel' && !action.labelId.trim())) return 'label'
  return null
}

export async function loadRules() {
  try {
    const res = await invoke<{ rules?: Rule[] }>('rules.list', {})
    rules$.rules.set(res?.rules ?? [])
    rules$.loaded.set(true)
  } catch {
    // A list that cannot be read is not a list that is empty: showing no rules
    // would invite writing them again on top of the ones already there.
  }
}

/** Saves the whole list, in the order it is in. */
export async function saveRules(rules: Rule[]) {
  await invoke('rules.save', { rules })
  rules$.rules.set(rules)
}

/**
 * What the rules would do to mail already in a folder, without doing any of it.
 *
 * `rules` may be a draft that has never been saved, so a rule can be tried
 * against a real mailbox before it is trusted with one.
 */
export async function previewRules(args: {
  accountId: string
  folder: string
  rules?: Rule[]
  limit?: number
}): Promise<RulePreview> {
  const res = await invoke<RulePreview>('rules.preview', {
    account_id: args.accountId,
    folder: args.folder,
    ...(args.rules ? { rules: args.rules } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  })
  return { examined: res?.examined ?? 0, matches: res?.matches ?? [] }
}

export async function loadRuleLog(limit = 200) {
  try {
    const res = await invoke<{ entries?: RuleLogEntry[] }>('rules.log', { limit })
    rules$.log.set(res?.entries ?? [])
  } catch {
    // Same reasoning as the rule list: an empty record and an unreadable one
    // are different answers, and only one of them is reassuring.
  }
}

export async function clearRuleLog() {
  await invoke('rules.clearLog', {})
  rules$.log.set([])
}

/** Moves a rule up or down. Order matters: one rule can stop the rest. */
export function reorderRules(rules: Rule[], from: number, to: number): Rule[] {
  if (from === to || from < 0 || to < 0 || from >= rules.length || to >= rules.length) return rules
  const next = [...rules]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
