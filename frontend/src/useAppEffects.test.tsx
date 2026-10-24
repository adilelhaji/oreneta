import { afterEach, beforeEach, expect, it } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { messaging$ } from './states/messaging'
import { useChatAtStartup } from './useAppEffects'

// Chat's button in the module switcher counts Chat's unread messages (owner
// decision 2 on #352, #354): its conversations are read at startup once there
// is an account, not first when Chat opens.

const calls: string[] = []

beforeEach(() => {
  calls.length = 0
  messaging$.accounts.set([])
  messaging$.conversations.set([])
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string) => {
          calls.push(command)
          if (command === 'chat.accounts') return [{ id: 'c1', jid: 'ana@chat.test', host: '', port: 5222 }]
          if (command === 'chat.status') return { c1: { account: 'c1', state: 'online' } }
          if (command === 'chat.conversations')
            return [{ conversation: 'pau@chat.test', last_body: '', last_stamp: 0, last_direction: 'in', unread: 2 }]
          return []
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  messaging$.accounts.set([])
  messaging$.account.set('')
  messaging$.conversations.set([])
})

it("reads Chat's accounts and conversations once there is an account, and only once", async () => {
  const view = renderHook(({ hasAccount }) => useChatAtStartup(hasAccount), { initialProps: { hasAccount: false } })
  // No account yet (the first-account setup): nothing is asked of chat.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual([])
  view.rerender({ hasAccount: true })
  await waitFor(() => expect(calls).toContain('chat.accounts'))
  await waitFor(() => expect(messaging$.conversations.peek().map((c) => c.unread)).toEqual([2]))
  expect(calls).toContain('chat.conversations')
  // A second account, or a render, does not read it again: `chat.changed` keeps it.
  view.rerender({ hasAccount: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls.filter((command) => command === 'chat.accounts')).toHaveLength(1)
})
