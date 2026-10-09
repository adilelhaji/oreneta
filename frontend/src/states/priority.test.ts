import { beforeEach, describe, expect, it } from 'bun:test'
import { sweep, sweepPreview } from './priority'
import { ui$ } from './ui'

describe('sweeping older mail from a sender', () => {
  const calls: { command: string; payload: any }[] = []
  let answer: (command: string) => any = () => ({})

  beforeEach(() => {
    calls.length = 0
    ui$.toast.set('')
    ui$.toastTone.set('success')
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

  it('previews with the review the core issued, and confirms by that review alone', async () => {
    answer = (command) => {
      if (command === 'mail.sweepPreview')
        return { from: 'x@example.com', folder: 'INBOX', keepNewest: 1, reviewId: 'sweep-1', messages: [{ uid: 3 }] }
      if (command === 'mail.sweep') return { swept: 1, unresolved: [], complete: true }
      return {}
    }
    const preview = await sweepPreview({ accountId: 'acc', folder: 'INBOX', from: 'x@example.com', keepNewest: 1 })
    expect(preview.reviewId).toBe('sweep-1')

    const outcome = await sweep({ accountId: 'acc', reviewId: preview.reviewId })
    const confirm = calls.find((call) => call.command === 'mail.sweep')!
    // The sender and the count are not sent again: only the review is, so
    // the core acts on what was shown and nothing that arrived since.
    expect(confirm.payload).toEqual({ account_id: 'acc', review_id: 'sweep-1' })
    expect(outcome.complete).toBe(true)
    expect(ui$.toastTone.peek()).toBe('success')
  })

  it('a partial outcome is never shown as total success', async () => {
    answer = (command) => {
      if (command === 'mail.sweep') return { swept: 2, unresolved: [7], complete: false, error: 'move failed' }
      return {}
    }
    const outcome = await sweep({ accountId: 'acc', reviewId: 'sweep-2' })
    expect(outcome.swept).toBe(2)
    expect(outcome.unresolved).toEqual([7])
    expect(outcome.complete).toBe(false)
    expect(ui$.toastTone.peek()).toBe('error')
    expect(ui$.toast.peek()).toContain('move failed')
  })

  it('a refused review surfaces as the core’s own reason', async () => {
    answer = (command) => {
      if (command === 'mail.sweep')
        throw new Error('this sweep was already done or its preview is no longer current; preview it again')
      return {}
    }
    await expect(sweep({ accountId: 'acc', reviewId: 'sweep-used' })).rejects.toThrow('preview it again')
  })
})
