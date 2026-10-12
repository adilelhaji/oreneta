import { beforeEach, describe, expect, it } from 'bun:test'
import {
  isUnsettledOutcome,
  onOutgoingAttemptSettled,
  outgoing$,
  refreshOutgoingAttempts,
  resendOutgoingAttempt,
  resendPayload,
  settleOutgoingAttempt,
  type OutgoingAttempt,
} from './outgoingAttempts'
import { ui$ } from './ui'

const attempt = (over: Partial<OutgoingAttempt> = {}): OutgoingAttempt => ({
  id: '<m1@example.com>',
  account: 'acc',
  kind: 'now',
  messageId: '<m1@example.com>',
  subject: 'Hello',
  to: 'bob@example.com',
  state: 'uncertain',
  error: 'connection reset after the message was sent',
  archiveError: '',
  createdAt: 100,
  updatedAt: 101,
  message: {
    account: 'acc',
    to: 'bob@example.com',
    subject: 'Hello',
    body: 'hi',
    message_id: '<m1@example.com>',
    attachments: [{ filename: 'a.txt', mime: 'text/plain', data: 'YQ==', inline_id: '' }],
  },
  ...over,
})

describe('sends a person still has to settle', () => {
  const calls: { command: string; payload: any }[] = []
  let answer: (command: string, payload: any) => any = () => ({ ok: true })

  beforeEach(() => {
    calls.length = 0
    answer = () => ({ ok: true })
    outgoing$.attempts.set([])
    ui$.toast.set('')
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            calls.push({ command, payload })
            return answer(command, payload)
          },
        },
      },
    }
  })

  it('tells an unsettled outcome from a plain refusal and a success', () => {
    expect(isUnsettledOutcome({ ok: false, outcome: 'uncertain' })).toBe(true)
    expect(isUnsettledOutcome({ ok: false, outcome: 'already_attempted' })).toBe(true)
    expect(isUnsettledOutcome({ ok: false, outcome: 'rejected', error: 'no' })).toBe(false)
    expect(isUnsettledOutcome({ ok: true, outcome: 'archived' })).toBe(false)
    expect(isUnsettledOutcome(null)).toBe(false)
  })

  it('reads what the core still holds, and keeps the last list when it cannot', async () => {
    answer = () => ({ attempts: [attempt()] })
    await refreshOutgoingAttempts()
    expect(outgoing$.attempts.peek().map((entry) => entry.id)).toEqual(['<m1@example.com>'])
    expect(calls[0]).toEqual({ command: 'mail.outgoingAttempts', payload: { account_id: '' } })

    answer = () => {
      throw new Error('engine unavailable')
    }
    await refreshOutgoingAttempts()
    expect(outgoing$.attempts.peek()).toHaveLength(1)
  })

  it('puts the stored request into the shape the bridge takes, marked as a deliberate resend', () => {
    const payload = resendPayload(attempt().message!)
    expect(payload.account_id).toBe('acc')
    expect(payload.account).toBeUndefined()
    expect(payload.resend).toBe(true)
    expect(payload.message_id).toBe('<m1@example.com>')
    expect((payload.attachments as unknown[]).length).toBe(1)
  })

  it('sends again only on purpose, and announces the attempt as settled when accepted', async () => {
    outgoing$.attempts.set([attempt()])
    const settled: string[] = []
    const off = onOutgoingAttemptSettled((id) => settled.push(id))
    answer = () => ({ ok: true, outcome: 'archived' })

    expect(await resendOutgoingAttempt('<m1@example.com>')).toBe(true)

    expect(calls[0].command).toBe('mail.send')
    expect(calls[0].payload.resend).toBe(true)
    expect(calls[0].payload.account_id).toBe('acc')
    expect(outgoing$.attempts.peek()).toEqual([])
    expect(settled).toEqual(['<m1@example.com>'])
    off()
  })

  it('keeps an attempt that is uncertain a second time, and says so', async () => {
    outgoing$.attempts.set([attempt()])
    const settled: string[] = []
    const off = onOutgoingAttemptSettled((id) => settled.push(id))
    answer = (command) => {
      if (command === 'mail.send') return { ok: false, outcome: 'uncertain', error: 'reset again' }
      return { attempts: [attempt({ error: 'reset again' })] }
    }

    expect(await resendOutgoingAttempt('<m1@example.com>')).toBe(false)

    expect(settled).toEqual([])
    expect(outgoing$.attempts.peek()[0].error).toBe('reset again')
    expect(ui$.toast.peek()).not.toBe('')
    off()
  })

  it('does not send what it cannot read back', async () => {
    outgoing$.attempts.set([attempt({ message: null })])
    expect(await resendOutgoingAttempt('<m1@example.com>')).toBe(false)
    expect(calls).toEqual([])
  })

  it('marks an attempt settled without sending anything', async () => {
    outgoing$.attempts.set([attempt(), attempt({ id: 'other' })])
    const settled: string[] = []
    const off = onOutgoingAttemptSettled((id) => settled.push(id))

    await settleOutgoingAttempt('<m1@example.com>')

    expect(calls).toEqual([{ command: 'mail.resolveOutgoing', payload: { id: '<m1@example.com>' } }])
    expect(outgoing$.attempts.peek().map((entry) => entry.id)).toEqual(['other'])
    expect(settled).toEqual(['<m1@example.com>'])
    off()
  })
})
