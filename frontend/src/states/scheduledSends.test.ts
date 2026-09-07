import { beforeEach, describe, expect, it } from 'bun:test'
import {
  cancelAndReopen,
  cancelScheduledSend,
  forgetScheduledSend,
  markScheduledSendFailed,
  refreshScheduledSends,
  scheduleComposed,
  scheduled$,
  sendLaterChoices,
  sendScheduledNow,
  type ScheduledSend,
} from './scheduledSends'
import { compose$ } from './compose'
import { accounts$ } from './accounts'

const waiting = (over: Partial<ScheduledSend> = {}): ScheduledSend => ({
  id: 's-1',
  account: 'acc',
  dueAt: 1_700_000_000,
  subject: 'Later',
  to: 'you@example.com',
  attempts: 0,
  lastError: '',
  gaveUp: false,
  ...over,
})

describe('messages written now to go later', () => {
  const calls: { command: string; payload: any }[] = []
  let answer: (command: string) => any = () => ({ ok: true })

  beforeEach(() => {
    calls.length = 0
    answer = () => ({ ok: true })
    scheduled$.messages.set([])
    scheduled$.loaded.set(false)
    compose$.tabs.set([])
    accounts$.set([
      { id: 'acc', email: 'me@example.com', display_name: 'Me', provider: 'custom', auth_type: 'password' },
    ] as any)
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

  it('offers only times that have not already gone by', () => {
    const lateEvening = new Date('2026-08-31T23:30:00')
    const keys = sendLaterChoices(lateEvening).map((choice) => choice.key)
    expect(keys).not.toContain('thisEvening')
    expect(keys).toContain('tomorrowMorning')

    const morning = new Date('2026-08-31T09:00:00')
    expect(sendLaterChoices(morning).map((choice) => choice.key)).toContain('thisEvening')
    // Every choice offered is one that can still happen.
    const now = Math.floor(morning.getTime() / 1000)
    for (const choice of sendLaterChoices(morning)) expect(choice.at).toBeGreaterThan(now)
  })

  it('sends the whole message to the core, not a summary of it', async () => {
    answer = (command) => (command === 'mail.scheduledSends' ? { messages: [waiting()] } : { ok: true })

    const id = await scheduleComposed(
      {
        accountId: 'acc',
        to: 'you@example.com',
        subject: 'Later',
        rich: false,
        content: 'Ping',
        attachments: [{ id: 'a1', filename: 'note.txt', mime: 'text/plain', size: 3, data: 'YWJj' }],
      },
      1_700_000_000,
    )

    const scheduled = calls.find((call) => call.command === 'mail.scheduleSend')
    expect(scheduled?.payload.id).toBe(id)
    expect(scheduled?.payload.due_at).toBe(1_700_000_000)
    expect(scheduled?.payload.message.to).toBe('you@example.com')
    expect(scheduled?.payload.message.body).toBe('Ping')
    expect(scheduled?.payload.message.attachments).toHaveLength(1)
    // Read back afterwards, so what is waiting is on screen without a reload.
    expect(scheduled$.messages.peek()).toHaveLength(1)
  })

  it('keeps the last known list when it cannot be read', async () => {
    scheduled$.messages.set([waiting()])
    answer = () => {
      throw new Error('engine unavailable')
    }

    await refreshScheduledSends()

    // A list that cannot be read is not a list that is empty.
    expect(scheduled$.messages.peek()).toHaveLength(1)
  })

  it('gives the message back when a send is called off, and opens it again', async () => {
    scheduled$.messages.set([waiting()])
    answer = (command) =>
      command === 'mail.cancelScheduledSend'
        ? {
            message: {
              account_id: 'acc',
              to: 'you@example.com',
              cc: 'boss@example.com',
              subject: 'Later',
              body: 'Ping',
              html: '',
              attachments: [{ filename: 'note.txt', mime: 'text/plain', data: 'YWJj' }],
            },
          }
        : { ok: true }

    await cancelAndReopen('s-1')

    expect(scheduled$.messages.peek()).toHaveLength(0)
    const tab = compose$.tabs.peek().at(-1)
    expect(tab?.compose?.to).toBe('you@example.com')
    expect(tab?.compose?.cc).toBe('boss@example.com')
    expect(tab?.compose?.text).toBe('Ping')
    expect(tab?.compose?.attachments).toHaveLength(1)
  })

  it('cancelling something already gone changes nothing', async () => {
    scheduled$.messages.set([waiting()])
    answer = () => ({ ok: true, message: null })

    expect(await cancelScheduledSend('s-1')).toBeNull()
    expect(scheduled$.messages.peek()).toHaveLength(0)
  })

  it('keeps a message that would not go, rather than dropping it quietly', async () => {
    scheduled$.messages.set([waiting()])
    answer = (command) => {
      if (command === 'mail.sendScheduledNow') throw new Error('mailbox unavailable')
      return { messages: [waiting({ attempts: 1, lastError: 'mailbox unavailable' })] }
    }

    await sendScheduledNow('s-1')

    const left = scheduled$.messages.peek()
    expect(left).toHaveLength(1)
    expect(left[0].lastError).toBe('mailbox unavailable')
  })

  it('drops a message from the list once the core says it has gone', () => {
    scheduled$.messages.set([waiting(), waiting({ id: 's-2' })])
    forgetScheduledSend('s-1')
    expect(scheduled$.messages.peek().map((message) => message.id)).toEqual(['s-2'])
  })

  it('marks a message the core gave up on, so the view can say so', () => {
    scheduled$.messages.set([waiting()])
    markScheduledSendFailed('s-1', 'no route to host')

    const [message] = scheduled$.messages.peek()
    expect(message.gaveUp).toBe(true)
    expect(message.lastError).toBe('no route to host')
  })
})
