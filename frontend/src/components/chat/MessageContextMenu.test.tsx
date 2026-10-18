import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { Message } from '../../types'
import { DEFAULT_PRINT_OPTIONS } from '../../lib/printOptions'
import { mail$ } from '../../states/mail'
import { settings$ } from '../../states/settings'
import { MessageContextMenu } from './MessageContextMenu'

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm-1',
  account_id: 'acc-1',
  folder_id: 'INBOX',
  thread_id: 't-1',
  from_name: 'Ana',
  from_addr: 'ana@example.test',
  to: 'me@example.test',
  subject: 'Thursday',
  preview: '',
  body: 'First',
  date: 1_700_000_100,
  unread: false,
  starred: false,
  has_attachments: false,
  ...over,
})

beforeEach(() => {
  settings$.print.set(structuredClone(DEFAULT_PRINT_OPTIONS))
})

afterEach(() => {
  cleanup()
  for (const frame of document.querySelectorAll('iframe')) frame.remove()
  mail$.messages.set([])
})

describe("a message's own Print message (SET-05)", () => {
  it('prints just that message and closes the menu', () => {
    const older = message()
    mail$.messages.set([older, message({ id: 'm-2', body: 'Second', date: 1_700_000_200 })])
    let closed = 0
    const view = render(
      <MessageContextMenu state={{ x: 0, y: 0, message: older }} isRSS={false} onClose={() => (closed += 1)} />,
    )
    fireEvent.click(view.getByRole('menuitem', { name: 'Print message…' }))
    expect(closed).toBe(1)
    const page = new DOMParser().parseFromString(document.querySelector('iframe')?.srcdoc ?? '', 'text/html')
    expect([...page.querySelectorAll('.message .body')].map((body) => body.textContent?.trim())).toEqual(['First'])
  })

  it('is not offered on a header-only row, which has no body to print', () => {
    const view = render(
      <MessageContextMenu
        state={{ x: 0, y: 0, message: message() }}
        isRSS={false}
        headerOnly
        onClose={() => undefined}
      />,
    )
    expect(view.getByRole('menu', { name: 'Thursday' })).toBeTruthy()
    expect(view.queryByRole('menuitem', { name: 'Print message…' })).toBeNull()
  })
})
