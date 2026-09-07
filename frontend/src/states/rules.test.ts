import { beforeEach, describe, expect, it } from 'bun:test'
import {
  clearRuleLog,
  loadRuleLog,
  loadRules,
  newRule,
  previewRules,
  reorderRules,
  ruleProblem,
  rules$,
  saveRules,
  type Rule,
} from './rules'

const rule = (over: Partial<Rule> = {}): Rule => ({
  ...newRule(),
  id: 'r-1',
  name: 'Reports',
  conditions: [{ field: 'from', op: 'contains', value: 'team' }],
  actions: [{ type: 'star' }],
  ...over,
})

describe('rules the reader writes', () => {
  const calls: { command: string; payload: any }[] = []
  let answer: (command: string) => any = () => ({ ok: true })

  beforeEach(() => {
    calls.length = 0
    answer = () => ({ ok: true })
    rules$.rules.set([])
    rules$.log.set([])
    rules$.loaded.set(false)
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            calls.push({ command, payload })
            return answer(command)
          },
        },
      },
    }
  })

  it('starts a new rule with something to fill in rather than nothing', () => {
    const blank = newRule()
    expect(blank.conditions).toHaveLength(1)
    expect(blank.actions).toHaveLength(1)
    expect(blank.enabled).toBe(true)
    // Every account until told otherwise.
    expect(blank.account).toBe('')
  })

  it('says why a rule cannot be saved yet', () => {
    expect(ruleProblem(rule())).toBeNull()
    expect(ruleProblem(rule({ name: '  ' }))).toBe('name')
    expect(ruleProblem(rule({ conditions: [] }))).toBe('conditions')
    // "Contains nothing" is true of every message: a half-written rule must
    // not be allowed to file a whole mailbox away.
    expect(ruleProblem(rule({ conditions: [{ field: 'from', op: 'contains', value: ' ' }] }))).toBe('value')
    expect(ruleProblem(rule({ actions: [] }))).toBe('actions')
    expect(ruleProblem(rule({ actions: [{ type: 'moveTo', folder: '' }] }))).toBe('folder')
    expect(ruleProblem(rule({ actions: [{ type: 'moveTo', folder: 'Reports' }] }))).toBeNull()
  })

  it('keeps the last known rules when the list cannot be read', async () => {
    rules$.rules.set([rule()])
    answer = () => {
      throw new Error('engine unavailable')
    }

    await loadRules()

    // Showing no rules would invite writing them again on top of the ones
    // already there.
    expect(rules$.rules.peek()).toHaveLength(1)
    expect(rules$.loaded.peek()).toBe(false)
  })

  it('saves the whole list at once, in order', async () => {
    const list = [rule({ id: 'r-1' }), rule({ id: 'r-2' })]
    await saveRules(list)

    const saved = calls.find((call) => call.command === 'rules.save')
    expect(saved?.payload.rules.map((r: Rule) => r.id)).toEqual(['r-1', 'r-2'])
    expect(rules$.rules.peek()).toHaveLength(2)
  })

  it('tries a rule that has never been saved', async () => {
    answer = () => ({ examined: 40, matches: [] })
    const draft = rule({ id: 'draft' })

    const preview = await previewRules({ accountId: 'acct', folder: 'INBOX', rules: [draft], limit: 40 })

    const asked = calls.find((call) => call.command === 'rules.preview')
    expect(asked?.payload.rules).toHaveLength(1)
    expect(asked?.payload.limit).toBe(40)
    expect(preview.examined).toBe(40)
    // Nothing was saved on the way: trying a rule is not adopting it.
    expect(calls.some((call) => call.command === 'rules.save')).toBe(false)
  })

  it('asks about the stored rules when no draft is given', async () => {
    answer = () => ({ examined: 10, matches: [] })
    await previewRules({ accountId: 'acct', folder: 'INBOX' })

    expect(calls.find((call) => call.command === 'rules.preview')?.payload.rules).toBeUndefined()
  })

  it('reads and clears the record of what the rules did', async () => {
    answer = () => ({
      entries: [
        {
          at: 1,
          account: 'acct',
          ruleId: 'r-1',
          ruleName: 'Reports',
          folder: 'INBOX',
          uid: 5,
          subject: 'Weekly',
          from: 'team@example.com',
          action: 'moveTo:Reports',
          outcome: 'done',
        },
      ],
    })
    await loadRuleLog()
    expect(rules$.log.peek()).toHaveLength(1)

    answer = () => ({ ok: true })
    await clearRuleLog()
    expect(rules$.log.peek()).toHaveLength(0)
  })

  it('moves a rule without disturbing the others', () => {
    const list = [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })]
    expect(reorderRules(list, 2, 0).map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(reorderRules(list, 0, 1).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    // Out of range or nowhere to go: the list is returned untouched.
    expect(reorderRules(list, 0, 0)).toBe(list)
    expect(reorderRules(list, 0, 9)).toBe(list)
    expect(reorderRules(list, -1, 0)).toBe(list)
  })
})
