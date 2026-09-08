import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SpamNotice } from './SpamNotice'
import type { Message } from '../../types'

afterEach(() => {
  cleanup()
  delete (window as any).go
})

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'acct#INBOX#42',
    account_id: 'acct',
    folder_id: 'INBOX',
    thread_id: 'acct#INBOX#k1',
    from_name: 'Spammer',
    from_addr: 'spammer@example.com',
    to: '',
    subject: 'Claim your prize',
    preview: '',
    body: '',
    date: 0,
    unread: false,
    starred: false,
    has_attachments: false,
    ...over,
  } as Message
}

/** Stub the bridge, recording every command invoked. */
function stubBridge(responses: Record<string, unknown>) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return responses[command] ?? {}
        },
      },
    },
  }
  return calls
}

describe('the spam suggestion notice', () => {
  it('says nothing about a message nobody has judged', () => {
    expect(render(<SpamNotice message={message()} />).container.textContent).toBe('')
  });

  it('says nothing about a message judged clean', () => {
    expect(render(<SpamNotice message={message({ spam: false })} />).container.textContent).toBe('')
  })

  it('explains a flagged message and offers both actions', async () => {
    stubBridge({
      'mail.spamReason': {
        spam: true,
        reasons: ['senderMarkedBefore', 'triggerWords'],
        sender: 'spammer@example.com',
      },
    })
    const view = render(<SpamNotice message={message({ spam: true })} />)
    await waitFor(() => expect(view.container.textContent).toContain('This might be spam'))
    expect(view.container.textContent).toContain('spammer@example.com')
    expect(view.getByText('Move to Junk')).toBeTruthy()
    expect(view.getByText('Not spam')).toBeTruthy()
  })

  it('does not show the notice when the reason lookup no longer agrees', async () => {
    // The column said spam at sync time, but the reader's own signals answer
    // "no" by the time anyone asks why — the fresher answer must win rather
    // than showing a suggestion the app itself no longer stands behind.
    stubBridge({ 'mail.spamReason': { spam: false, reasons: ['nothingKnown'], sender: '' } })
    const view = render(<SpamNotice message={message({ spam: true })} />)
    await waitFor(() => {
      // Nothing to assert on yet other than absence, so just let the effect settle.
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.container.textContent).toBe('')
  })

  it('dismissing records "not spam" without moving anything, and hides itself', async () => {
    const calls = stubBridge({
      'mail.spamReason': { spam: true, reasons: ['triggerWords'], sender: 'spammer@example.com' },
    })
    const view = render(<SpamNotice message={message({ spam: true })} />)
    await waitFor(() => expect(view.container.textContent).toContain('This might be spam'))

    fireEvent.click(view.getByText('Not spam'))
    expect(view.container.textContent).toBe('')
    await waitFor(() => expect(calls.some((c) => c.command === 'mail.recordSpamJudgment')).toBe(true))
    const judgment = calls.find((c) => c.command === 'mail.recordSpamJudgment')
    expect(judgment?.payload).toMatchObject({ thread_id: 'acct#INBOX#k1', spam: false })
    expect(calls.some((c) => c.command === 'mail.markJunk')).toBe(false)
  })

  it('"Move to Junk" calls the same mark-junk bridge command as the context menu', async () => {
    const calls = stubBridge({
      'mail.spamReason': { spam: true, reasons: ['triggerWords'], sender: 'spammer@example.com' },
      'mail.markJunk': { ok: true, moved: 1, folder: 'Junk' },
    })
    const view = render(<SpamNotice message={message({ spam: true })} />)
    await waitFor(() => expect(view.container.textContent).toContain('This might be spam'))

    fireEvent.click(view.getByText('Move to Junk'))
    await waitFor(() => expect(calls.some((c) => c.command === 'mail.markJunk')).toBe(true))
    const move = calls.find((c) => c.command === 'mail.markJunk')
    expect(move?.payload).toMatchObject({ thread_id: 'acct#INBOX#k1', junk: true })
  })
})
