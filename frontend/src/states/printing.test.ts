import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Account, Message } from '../types'
import { DEFAULT_PRINT_OPTIONS } from '../lib/printOptions'
import { accounts$ } from './accounts'
import { mail$ } from './mail'
import { printFromReader } from './printing'
import { settings$ } from './settings'

const message = (over: Partial<Message> = {}): Message =>
  ({
    id: 'm-1',
    account_id: 'acct',
    folder_id: 'INBOX',
    thread_id: 't-1',
    from_name: 'Ann Example',
    from_addr: 'ann@example.com',
    to: 'me@example.com',
    cc: 'carl@example.com',
    subject: 'Lunch',
    preview: '',
    body: 'First thing',
    body_html: '<p>Hi</p><img src="https://cdn.example/logo.png">',
    date: 1_700_000_100,
    unread: false,
    starred: false,
    has_attachments: false,
    ...over,
  }) as Message

const first = message()
const second = message({
  id: 'm-2',
  subject: 'Re: Lunch',
  body_html: undefined,
  body: 'Second thing',
  date: 1_700_000_200,
})
const elsewhere = message({ id: 'x-1', thread_id: 't-2', body_html: undefined, body: 'Another thread' })

// What the print frame was handed; the frame itself is never printed here.
const printed = () => {
  const frames = [...document.querySelectorAll('iframe')]
  return new DOMParser().parseFromString(frames.at(-1)?.srcdoc ?? '', 'text/html')
}
const bodies = () => [...printed().querySelectorAll('.message .body')].map((body) => body.textContent?.trim())

beforeEach(() => {
  settings$.print.set(structuredClone(DEFAULT_PRINT_OPTIONS))
  mail$.messages.set([first, second, elsewhere])
  mail$.messagesCursor.set('')
  accounts$.set([{ id: 'acct', load_remote_images: false } as Account])
})

afterEach(() => {
  for (const frame of document.querySelectorAll('iframe')) frame.remove()
  settings$.print.set(structuredClone(DEFAULT_PRINT_OPTIONS))
  mail$.messages.set([])
  mail$.messagesCursor.set('')
  accounts$.set([])
})

describe('printing from the reader (SET-05)', () => {
  it('prints the open conversation as the remembered options say', () => {
    settings$.print.set({
      ...DEFAULT_PRINT_OPTIONS,
      order: 'newest',
      headers: { ...DEFAULT_PRINT_OPTIONS.headers, cc: false },
    })
    void printFromReader(first)
    expect(bodies()).toEqual(['Second thing', 'Hi'])
    expect(printed().body.textContent).not.toContain('carl@example.com')
    expect(printed().body.textContent).not.toContain('Another thread')
  })

  it('prints only the newest message from the conversation menu when one message is remembered', () => {
    settings$.print.set({ ...DEFAULT_PRINT_OPTIONS, scope: 'message' })
    void printFromReader(first)
    expect(bodies()).toEqual(['Second thing'])
    expect(printed().body.textContent).toContain('Only this message of the conversation is printed')
  })

  it("prints just the message from that message's own menu, whatever scope is remembered", () => {
    void printFromReader(first, first)
    expect(bodies()).toEqual(['Hi'])
    expect(printed().querySelector('h1')?.textContent).toBe('Lunch')
    expect(printed().body.textContent).toContain('Only this message of the conversation is printed')
  })

  it('prints the message asked about even when it is not among the loaded ones', () => {
    const unloaded = message({ id: 'z-1', thread_id: 't-9', body_html: undefined, body: 'Not loaded' })
    mail$.messagesCursor.set('cursor-of-the-open-conversation')
    void printFromReader(unloaded, unloaded)
    expect(bodies()).toEqual(['Not loaded'])
    // The cursor belongs to another conversation: nothing is claimed about
    // this one beyond that the rest of it, if any, is not on the page.
    expect(printed().querySelector('.incomplete')?.textContent).toBe(
      'Only this message is printed; other messages of the conversation, if any, are not.',
    )
  })

  it('says nothing is left out when the loaded conversation is that one message', () => {
    mail$.messages.set([first])
    void printFromReader(first, first)
    expect(bodies()).toEqual(['Hi'])
    expect(printed().querySelector('.incomplete')).toBeNull()
  })

  it('keeps remote images blocked for Print message… unless the account loads them', () => {
    void printFromReader(first, first)
    const csp = () =>
      printed().querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
    expect(csp()).not.toMatch(/img-src[^;]*https?:/)
    expect(csp()).toContain("script-src 'none'")

    accounts$.set([{ id: 'acct', load_remote_images: true } as Account])
    void printFromReader(first, first)
    expect(csp()).toMatch(/img-src[^;]*https:/)
  })

  it('leaves drafts and unsent copies out of "this message" and marks them when they print', () => {
    const draft = message({
      id: 'd-1',
      folder_id: 'Drafts',
      body_html: undefined,
      body: 'My draft',
      date: 1_700_000_400,
    })
    const unsent = message({ id: 'sent-1', body_html: undefined, body: 'In the undo window', date: 1_700_000_300 })
    mail$.messages.set([first, second, unsent, draft])

    settings$.print.set({ ...DEFAULT_PRINT_OPTIONS, scope: 'message' })
    void printFromReader(first)
    expect(bodies()).toEqual(['Second thing'])
    expect(printed().querySelector('.mark')).toBeNull()

    settings$.print.set(structuredClone(DEFAULT_PRINT_OPTIONS))
    void printFromReader(first)
    expect(bodies()).toEqual(['Hi', 'Second thing', 'In the undo window', 'My draft'])
    expect([...printed().querySelectorAll('.mark')].map((mark) => mark.textContent)).toEqual(['Not sent', 'Draft'])

    void printFromReader(draft, draft)
    expect(bodies()).toEqual(['My draft'])
    expect(printed().querySelector('.mark')?.textContent).toBe('Draft')
  })

  it('keeps remote images blocked unless the account loads them, and says older messages are missing', () => {
    mail$.messagesCursor.set('more-on-the-server')
    void printFromReader(first)
    const policy = printed().querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
    expect(policy).not.toMatch(/img-src[^;]*https?:/)
    expect(printed().querySelector('.incomplete')?.textContent).toBe(
      'Older messages of this conversation were not loaded and are not included.',
    )

    accounts$.set([{ id: 'acct', load_remote_images: true } as Account])
    void printFromReader(first)
    expect(printed().querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toMatch(
      /img-src[^;]*https:/,
    )
  })
})
