import { expect, test } from 'bun:test'
import { GraphSetupFlow, type GraphProgress } from './graphSetup'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('failed activation cancellation retains its lease and prevents a replacement until retried', async () => {
  let rejectCancel = true
  let starts = 0
  let cancels = 0
  const states: GraphProgress[] = []
  const flow = new GraphSetupFlow(
    async <T>(command: string) => {
      if (command === 'oauth.graphBegin') {
        starts++
        return { attempt: `a${starts}` } as T
      }
      if (command === 'oauth.graphPoll') return { state: 'authorized' } as T
      if (command === 'graph.activationBegin') return { account: 'reader', generation: 'g' } as T
      if (command === 'graph.activationCancel') {
        cancels++
        if (rejectCancel) throw new Error('offline')
      }
      return {} as T
    },
    (s) => states.push(s),
    async () => {},
  )
  await flow.begin('', 'Reader')
  await flow.begin('', 'Replacement')
  expect(starts).toBe(1)
  expect(states.at(-1)?.error).toBe('cancel_failed')
  rejectCancel = false
  await flow.begin('', 'Replacement')
  expect(cancels).toBe(2)
  expect(starts).toBe(2)
  await flow.cancel()
})

test('closing while browser Begin is in flight cancels its eventual backend attempt', async () => {
  const begin = deferred<{ attempt: string }>()
  const calls: Array<[string, unknown]> = []
  const progress: GraphProgress[] = []
  const flow = new GraphSetupFlow(
    async <T>(command: string, payload: unknown) => {
      calls.push([command, payload])
      return (command === 'oauth.graphBegin' ? await begin.promise : {}) as T
    },
    (s) => progress.push(s),
    async () => {
      throw new Error('must not publish')
    },
  )
  const pending = flow.begin('', 'Reader')
  await tick()
  await flow.cancel()
  begin.resolve({ attempt: 'late' })
  await pending
  expect(calls).toContainEqual(['oauth.graphCancel', { attempt: 'late' }])
  expect(calls.some(([c]) => c === 'graph.activationBegin')).toBe(false)
  expect(progress.map((s) => s.state)).toEqual(['authorizing'])
})

test('authorization does not imply readiness and late activation is cancelled', async () => {
  const activation = deferred<{ account: string; generation: string }>()
  const calls: Array<[string, unknown]> = []
  const flow = new GraphSetupFlow(
    async <T>(command: string, payload: unknown) => {
      calls.push([command, payload])
      return (
        command === 'oauth.graphBegin'
          ? { attempt: 'a' }
          : command === 'oauth.graphPoll'
            ? { state: 'authorized' }
            : command === 'graph.activationBegin'
              ? await activation.promise
              : {}
      ) as T
    },
    () => {},
    async () => {
      throw new Error('must not publish')
    },
  )
  const pending = flow.begin('', 'Reader')
  await tick()
  await flow.cancel()
  activation.resolve({ account: 'reader', generation: 'late' })
  await pending
  expect(calls).toContainEqual(['graph.activationCancel', { account: 'reader', generation: 'late' }])
})

test('only ready plus mail_backend_ready finishes; errors retain typed retry information', async () => {
  const states: GraphProgress[] = []
  let ready = false
  const flow = new GraphSetupFlow(
    async <T>(command: string) =>
      (command === 'oauth.graphBegin'
        ? { attempt: 'a' }
        : command === 'oauth.graphPoll'
          ? { state: 'authorized' }
          : command === 'graph.activationBegin'
            ? { account: 'reader', generation: 'g' }
            : command === 'graph.activationPoll'
              ? { state: 'failed', error: 'throttled', retry_after_seconds: 60, mail_backend_ready: false }
              : {}) as T,
    (s) => states.push(s),
    async () => {
      ready = true
    },
  )
  await flow.begin('', 'Reader')
  expect(states.at(-1)?.state).toBe('syncing')
  expect(ready).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(states.at(-1)).toMatchObject({ state: 'failed', error: 'throttled', retry_after_seconds: 60 })
  expect(ready).toBe(false)
  await flow.cancel()
})

test('successful activation supplies a generation check to asynchronous UI refresh', async () => {
  let check: (() => boolean) | undefined
  const flow = new GraphSetupFlow(
    async <T>(command: string) =>
      (command === 'oauth.graphBegin'
        ? { attempt: 'a' }
        : command === 'oauth.graphPoll'
          ? { state: 'authorized' }
          : command === 'graph.activationBegin'
            ? { account: 'reader', generation: 'g' }
            : command === 'graph.activationPoll'
              ? { state: 'ready', mail_backend_ready: true }
              : {}) as T,
    () => {},
    async (account, current) => {
      expect(account).toBe('reader')
      check = current
    },
  )
  await flow.begin('', 'Reader')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(check?.()).toBe(true)
  await flow.cancel()
  expect(check?.()).toBe(false)
})
