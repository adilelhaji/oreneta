import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AssistantRewriteDialog } from './AssistantRewriteDialog'
import { assistant$ } from '../../states/assistant'

const calls: { command: string; payload: any }[] = []
let answers: Record<string, (payload: any) => unknown> = {}

beforeEach(() => {
  calls.length = 0
  assistant$.set({ mode: 'remote', endpoint: 'https://ai.example.test/v1/chat/completions', model: 'm' })
  answers = {
    'assistant.preview': (p) => ({
      provider: p.provider,
      action: 'rewrite',
      instruction: p.instruction,
      manifest: { items: [], total_bytes: 10, untrusted_input: true },
      request_body: `{"messages":[{"role":"user","content":"<mail>${p.context[0].body} (${p.instruction})</mail>"}]}`,
      requires_confirmation: true,
      will_transmit: true,
      automatic_mail_actions: false,
      preview_token: `token-${p.instruction}`,
    }),
    'assistant.execute': () => ({ response: '{"text":"Hi Ana, thanks for the notes."}', persisted: false }),
  }
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? {}
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('shows exactly what would be sent, sends only after confirming, and changes nothing until asked', async () => {
  const onApply = mock(() => {})
  const screen = render(
    <AssistantRewriteDialog
      accountId="acct"
      rich={false}
      text="hi ana thanks for teh notes"
      onApply={onApply}
      onClose={() => {}}
    />,
  )
  await waitFor(() => expect(screen.getByText(/will be sent over HTTPS to https:\/\/ai.example.test/)).toBeTruthy())
  expect(screen.getByText(/hi ana thanks for teh notes \(proofread\)/)).toBeTruthy()
  // Only the draft, under no message's name.
  expect(calls[0].payload.context).toEqual([
    { message_id: 'draft', account_id: 'acct', body: 'hi ana thanks for teh notes' },
  ])

  const rewrite = screen.getByRole('button', { name: 'Rewrite' }) as HTMLButtonElement
  expect(rewrite.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  // Another way of rewriting is another request: asked again, confirmed again.
  await act(async () => {
    fireEvent.change(screen.getByLabelText('How'), { target: { value: 'shorter' } })
  })
  await waitFor(() => expect(screen.getByText(/\(shorter\)/)).toBeTruthy())
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('Provider token (used once, never saved)'), { target: { value: 'k' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }))
  })
  const run = calls.find((c) => c.command === 'assistant.execute')!
  expect(run.payload).toMatchObject({
    action: 'rewrite',
    instruction: 'shorter',
    confirmed: true,
    preview_token: 'token-shorter',
    authorization: 'k',
  })
  await waitFor(() => expect(screen.getByText('Hi Ana, thanks for the notes.')).toBeTruthy())
  expect(onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use instead of what I wrote' }))
  expect(onApply).toHaveBeenCalledWith('Hi Ana, thanks for the notes.')
})

it('stopping cancels the request and keeps the draft', async () => {
  let release: (v: unknown) => void = () => {}
  answers['assistant.execute'] = () => new Promise((r) => (release = r))
  const onApply = mock(() => {})
  const screen = render(
    <AssistantRewriteDialog accountId="acct" rich text="Draft" onApply={onApply} onClose={() => {}} />,
  )
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite' }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  })
  expect(calls.some((c) => c.command === 'assistant.cancel')).toBe(true)
  await act(async () => release({ response: '{"text":"late"}' }))
  expect(screen.queryByText('late')).toBeNull()
  expect(onApply).not.toHaveBeenCalled()
})
