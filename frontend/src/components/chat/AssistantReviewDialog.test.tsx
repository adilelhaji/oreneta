import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { Message } from '../../types'
import type { AssistantContextItem } from '../../states/assistant'
import { AssistantReviewDialog } from './AssistantReviewDialog'
import { contextFor, newestMessageIndex } from './assistantContext'

describe('assistant context review', () => {
  it('maps only the selected message content and attachment metadata', () => {
    const message = {
      id: 'local-1',
      message_id: '<stable@example.test>',
      account_id: 'account-a',
      from_addr: 'sender@example.test',
      from_name: 'Sender',
      subject: 'Hello',
      body: 'Untrusted message body',
      attachments: [{ filename: 'brief.pdf', mime: 'application/pdf', size: 42, key: null }],
    } as Message
    expect(contextFor([message])).toEqual([
      {
        message_id: '<stable@example.test>',
        account_id: 'account-a',
        sender: 'sender@example.test',
        subject: 'Hello',
        body: 'Untrusted message body',
        attachments: [{ name: 'brief.pdf', mime: 'application/pdf', size: 42 }],
      },
    ])
  })
})

function message(id: string, date: number, attachments: string[] = []): Message {
  return {
    id,
    message_id: `${id}@example.test`,
    account_id: 'account-a',
    thread_id: 'thread-1',
    from_addr: `${id}@example.test`,
    from_name: id,
    subject: `Subject ${id}`,
    body: `Body of ${id}`,
    date,
    attachments: attachments.map((filename) => ({ filename, mime: 'text/plain', size: 7, key: null })),
  } as Message
}

describe('the most recent message', () => {
  it('is the one with the latest date, wherever it is in the list', () => {
    expect(newestMessageIndex([message('a', 100), message('c', 300), message('b', 200)])).toBe(1)
  })

  it('is the later in the list when dates are equal or unknown', () => {
    expect(newestMessageIndex([message('a', 200), message('b', 200)])).toBe(1)
    expect(newestMessageIndex([message('a', 0), message('b', 0), message('c', 0)])).toBe(2)
  })

  it('does not exist in an empty conversation', () => {
    expect(newestMessageIndex([])).toBe(-1)
  })
})

describe('assistant review dialog', () => {
  // Every context the dialog asked to preview, in order.
  const previews: AssistantContextItem[][] = []

  beforeEach(() => {
    previews.length = 0
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            if (command !== 'assistant.preview') return {}
            previews.push(payload.context)
            if (payload.context.length === 0) throw new Error('assistant context cannot be empty')
            return {
              provider: payload.provider,
              action: payload.action,
              instruction: '',
              manifest: { items: [], total_bytes: 0, untrusted_input: true },
              // Stands in for the exact request the core would build.
              request_body: JSON.stringify(payload.context),
              requires_confirmation: true,
              will_transmit: false,
              automatic_mail_actions: false,
              preview_token: 'token',
            }
          },
        },
      },
    }
  })

  afterEach(() => {
    cleanup()
    delete (window as any).go
  })

  // Oldest first, as a conversation is shown, and every message has attachments.
  const conversation = [
    message('m1', 100, ['first.txt']),
    message('m2', 200, ['second.txt']),
    message('m3', 300, ['third.txt', 'fourth.txt']),
  ]
  const [first, , newest] = contextFor(conversation)
  const withoutAttachments = (item: AssistantContextItem) => ({ ...item, attachments: [] })

  async function open(messages: Message[]) {
    const screen = render(<AssistantReviewDialog messages={messages} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Subject m1')).toBeTruthy())
    return screen
  }

  // The checkbox in front of a message's subject.
  function messageBox(screen: Awaited<ReturnType<typeof open>>, subject: string) {
    const row = screen.getByText(subject).parentElement?.parentElement
    return row?.firstElementChild as HTMLInputElement
  }

  const lastPreview = () => previews[previews.length - 1]
  const shownRequest = () => document.querySelector('details pre')?.textContent

  it('starts with only the most recent message selected and no attachment details', async () => {
    const screen = await open(conversation)
    expect(messageBox(screen, 'Subject m1').checked).toBe(false)
    expect(messageBox(screen, 'Subject m2').checked).toBe(false)
    expect(messageBox(screen, 'Subject m3').checked).toBe(true)
    for (const name of ['first.txt', 'second.txt', 'third.txt', 'fourth.txt'])
      expect((screen.getByLabelText(name) as HTMLInputElement).checked).toBe(false)
    expect(lastPreview()).toEqual([withoutAttachments(newest)])
    expect(shownRequest()).toBe(JSON.stringify([withoutAttachments(newest)]))
  })

  it('picks the most recent message by date, not by its place in the list', async () => {
    const screen = await open([message('m1', 100), message('m3', 300), message('m2', 200)])
    expect(messageBox(screen, 'Subject m3').checked).toBe(true)
    expect(messageBox(screen, 'Subject m1').checked).toBe(false)
    expect(messageBox(screen, 'Subject m2').checked).toBe(false)
  })

  it('previews exactly what is selected as messages and attachments are added', async () => {
    const screen = await open(conversation)

    await act(async () => {
      fireEvent.click(messageBox(screen, 'Subject m1'))
    })
    await waitFor(() => expect(lastPreview()).toEqual([withoutAttachments(first), withoutAttachments(newest)]))
    await waitFor(() => expect(shownRequest()).toBe(JSON.stringify(lastPreview())))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('fourth.txt'))
    })
    const withFourth = { ...newest, attachments: [newest.attachments![1]] }
    await waitFor(() => expect(lastPreview()).toEqual([withoutAttachments(first), withFourth]))
    await waitFor(() => expect(shownRequest()).toBe(JSON.stringify(lastPreview())))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('first.txt'))
    })
    await waitFor(() => expect(lastPreview()).toEqual([first, withFourth]))
    await waitFor(() => expect(shownRequest()).toBe(JSON.stringify(lastPreview())))
    // Another message's attachments stay out until that message is chosen.
    expect(lastPreview().some((item) => item.message_id === 'm2@example.test')).toBe(false)
  })

  it('selects nothing in a conversation with no messages', async () => {
    render(<AssistantReviewDialog messages={[]} onClose={() => {}} />)
    await waitFor(() => expect(previews.length).toBeGreaterThan(0))
    expect(previews.every((context) => context.length === 0)).toBe(true)
  })
})
