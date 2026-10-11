import { afterEach, beforeEach, expect, it, mock } from 'bun:test'

mock.module('../boot', () => ({ boot: async () => {} }))

const { invalidReason, sanitizeQuickActions, runQuickAction, frozenTargets, failedRows, startQuickAction, quickRun$ } =
  await import('./quickActions')
const { mail$ } = await import('./mail')
const { accounts$ } = await import('./accounts')

const item = (threadId: string, accountId = 'a@x') =>
  ({ key: threadId, kind: 'mail', threadId, accountId, folderId: 'INBOX' }) as any

function bridge(answer: (command: string, payload: any) => unknown) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), answer(command, payload)),
      },
    },
  }
  return calls
}

beforeEach(() => {
  accounts$.set([{ id: 'a@x', email: 'a@x', auth_type: 'password' } as any])
  mail$.foldersByAccount.set({
    'a@x': [{ id: 'Clients/Acme', name: 'Acme', account_id: 'a@x', role: '', unread: 0 }],
  } as any)
  mail$.threads.set([])
})
afterEach(() => {
  delete (window as any).go
})

it('accepts only chains that can run, with the step that takes mail away last', () => {
  expect(invalidReason({ name: 'Done', steps: [{ kind: 'markRead' }, { kind: 'archive' }] })).toBeNull()
  expect(invalidReason({ name: ' ', steps: [{ kind: 'markRead' }] })).toBe('name')
  expect(invalidReason({ name: 'x', steps: [] })).toBe('empty')
  expect(invalidReason({ name: 'x', steps: [{ kind: 'archive' }, { kind: 'star' }] })).toBe('leaveLast')
  expect(invalidReason({ name: 'x', steps: [{ kind: 'archive' }, { kind: 'move', folder: 'A' }] })).toBe('leaveLast')
  expect(invalidReason({ name: 'x', steps: [{ kind: 'move', folder: ' ' }] })).toBe('noFolder')
  expect(invalidReason({ name: 'x', steps: [{ kind: 'send' as any }] })).toBe('unsupported')
  expect(invalidReason({ name: 'x', steps: Array(9).fill({ kind: 'star' }) })).toBe('tooLong')
})

it('stored actions that could not run, or that ask for more, are dropped', () => {
  const kept = sanitizeQuickActions([
    { id: '1', name: 'Done', steps: [{ kind: 'markRead' }, { kind: 'archive' }] },
    { id: '2', name: 'Bad', steps: [{ kind: 'archive' }, { kind: 'markRead' }] },
    { id: '3', name: 'Sends', steps: [{ kind: 'forward' }] },
    'junk',
  ])
  expect(kept?.map((a) => a.id)).toEqual(['1'])
  expect(sanitizeQuickActions('nope')).toBeNull()
})

it('runs each conversation’s steps in order, stops a chain at its failure and goes on with the others', async () => {
  const calls = bridge((command, payload) => {
    if (command === 'mail.markStarred' && payload.thread_id === 't2') throw new Error('server said no')
    if (command === 'mail.move') return { moved: 1 }
    return {}
  })
  const action = {
    id: 'q',
    name: 'File',
    steps: [{ kind: 'markRead' as const }, { kind: 'star' as const }, { kind: 'move' as const, folder: 'acme' }],
  }
  const report = await runQuickAction(action, [item('t1'), item('t2'), item('t3')], { t2: 'Second' })
  expect(report.rows.map((r) => r.outcomes.map((o) => o.ok))).toEqual([
    [true, true, true],
    [true, false],
    [true, true, true],
  ])
  expect(failedRows(report)).toHaveLength(1)
  expect(failedRows(report)[0]).toMatchObject({ subject: 'Second', skipped: 1 })
  expect(failedRows(report)[0].outcomes[1].reason).toBe('server said no')
  expect(calls.filter((c) => c.command === 'mail.move').map((c) => c.payload)).toEqual([
    { thread_id: 't1', target_folder_id: 'Clients/Acme' },
    { thread_id: 't3', target_folder_id: 'Clients/Acme' },
  ])
  expect(calls.some((c) => c.command.includes('send') || c.command.includes('delete'))).toBe(false)
})

it('a folder that does not exist in an account fails that step, by name', async () => {
  bridge(() => ({}))
  const report = await runQuickAction({ id: 'q', name: 'Move', steps: [{ kind: 'move', folder: 'Nowhere' }] }, [
    item('t1'),
  ])
  expect(report.rows[0].outcomes[0]).toMatchObject({ ok: false })
  expect(report.rows[0].outcomes[0].reason).toContain('Nowhere')
})

it('the set is frozen when the action is started: what arrives later is not in it', () => {
  const selection = [item('t1'), item('t1'), { ...item('f1'), kind: 'rss' }, item('t2')]
  expect(frozenTargets(selection).map((i) => i.threadId)).toEqual(['t1', 't2'])
  startQuickAction({ id: 'q', name: 'Read', steps: [{ kind: 'markRead' }] }, selection)
  selection.push(item('t9'))
  expect(quickRun$.pending.get()!.targets.map((i) => i.threadId)).toEqual(['t1', 't2'])
})

it('refuses to run on an account whose messages cannot be changed', async () => {
  accounts$.set([{ id: 'g@x', email: 'g@x', auth_type: 'graph_oauth' } as any])
  await expect(
    runQuickAction({ id: 'q', name: 'Read', steps: [{ kind: 'markRead' }] }, [item('t1', 'g@x')]),
  ).rejects.toThrow()
})
