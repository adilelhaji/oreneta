import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { StrictMode } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useValue } from '@legendapp/state/react'
import i18n from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { mail$ } from '../../states/mail'
import { clearThreadSearchRequest, pendingThreadSearch, requestThreadSearch, thread$ } from '../../states/thread'
import { ui$ } from '../../states/ui'
import type { Account, Message } from '../../types'
import { useCommandList } from '../palette/useCommandList'
import { MessagePane } from './MessagePane'

// «Search current thread» from another module (#344): the palette goes to mail
// first, where the conversation pane mounts and resets its view, and opens the
// conversation's search after that reset. In development, StrictMode replays
// the pane's mount effect, and with it the reset: the search must survive it.

const account: Account = {
  id: 'synthetic-account',
  email: 'alex@example.test',
  display_name: 'Alex',
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
  paused: true,
  conversation_html: false,
  load_remote_images: false,
}

const message = (threadId: string, subject: string): Message =>
  ({
    id: `${threadId}#1`,
    account_id: account.id,
    folder_id: 'INBOX',
    thread_id: threadId,
    from_name: 'Morgan',
    from_addr: 'morgan@example.test',
    to: 'alex@example.test',
    subject,
    preview: 'Thanks',
    body: 'Thanks Morgan.',
    date: 1_760_000_000,
    unread: false,
    starred: false,
    has_attachments: false,
  }) as Message

const pilot = message('synthetic-account#INBOX#1', 'Pilot checklist')
const other = message('synthetic-account#INBOX#2', 'Quarterly numbers')

beforeEach(async () => {
  await i18n.changeLanguage('en')
  ;(window as any).happyDOM.setViewport({ width: 1440, height: 900 })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) =>
          command === 'mail.threadRead'
            ? { messages: [payload.thread_id === other.thread_id ? other : pilot], next_cursor: '' }
            : { ok: true },
      },
    },
  }
  accounts$.set([account])
  mail$.threads.set([pilot, other])
  ui$.assign({
    module: 'mail',
    selectedAccount: account.id,
    selectedFolder: 'INBOX',
    selectedThread: pilot.thread_id,
    filters: [],
    query: '',
  })
  thread$.searchOpen.set(false)
  clearThreadSearchRequest()
})

afterEach(() => {
  cleanup()
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
  clearThreadSearchRequest()
  thread$.searchOpen.set(false)
  accounts$.set([])
  mail$.threads.set([])
  ui$.assign({ module: 'mail', selectedAccount: '', selectedFolder: 'inbox', selectedThread: '' })
  delete (window as any).go
})

/** Mail as App draws it: the conversation pane only while mail is on screen. */
function Mail() {
  const module = useValue(ui$.module)
  return module === 'mail' ? <MessagePane /> : null
}

const searchField = (view: ReturnType<typeof render>) =>
  view.queryAllByPlaceholderText('Search thread').filter((input) => input.closest('[hidden]') === null)

describe("the conversation's search asked for from another module (#344)", () => {
  it("opens once the pane shows the conversation, through StrictMode's replayed reset", async () => {
    ui$.module.set('notes')
    let commands: ReturnType<typeof useCommandList> = []
    function Probe() {
      commands = useCommandList()
      return null
    }
    const view = render(
      <StrictMode>
        <Probe />
        <Mail />
      </StrictMode>,
    )
    const command = commands.find((item) => item.id === 'search.thread')!
    // The request names its conversation, before mail is shown.
    act(() => command.run())
    expect(ui$.module.peek()).toBe('mail')
    await waitFor(() => expect(thread$.searchOpen.peek()).toBe(true))
    expect(searchField(view).length).toBeGreaterThan(0)
    // Answered: nothing left to open later.
    expect(pendingThreadSearch()).toBe('')
  })

  it('opens it when the pane mounts after the request, in StrictMode', async () => {
    requestThreadSearch(pilot.thread_id)
    const view = render(
      <StrictMode>
        <MessagePane />
      </StrictMode>,
    )
    await waitFor(() => expect(thread$.searchOpen.peek()).toBe(true))
    expect(searchField(view).length).toBeGreaterThan(0)
    expect(pendingThreadSearch()).toBe('')
  })

  it('opens nothing for a request for another conversation, and drops it', async () => {
    requestThreadSearch(other.thread_id)
    render(
      <StrictMode>
        <MessagePane />
      </StrictMode>,
    )
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
    expect(thread$.searchOpen.peek()).toBe(false)
    expect(pendingThreadSearch()).toBe('')
  })

  it('does not open it again when the pane shows another conversation, or mounts again later', async () => {
    requestThreadSearch(pilot.thread_id)
    const view = render(
      <StrictMode>
        <Mail />
      </StrictMode>,
    )
    await waitFor(() => expect(thread$.searchOpen.peek()).toBe(true))
    // Another conversation: the view resets, and the search stays closed.
    act(() => ui$.selectedThread.set(other.thread_id))
    await waitFor(() => expect(thread$.searchOpen.peek()).toBe(false))
    // Back to the first one, then mail shown again: no search reopens.
    act(() => ui$.selectedThread.set(pilot.thread_id))
    act(() => ui$.module.set('notes'))
    act(() => ui$.module.set('mail'))
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
    expect(thread$.searchOpen.peek()).toBe(false)
    expect(searchField(view)).toHaveLength(0)
  })

  it('does not open it again after the pane showed no conversation for a while', async () => {
    requestThreadSearch(pilot.thread_id)
    render(
      <StrictMode>
        <Mail />
      </StrictMode>,
    )
    await waitFor(() => expect(thread$.searchOpen.peek()).toBe(true))
    act(() => thread$.searchOpen.set(false))
    // Another folder empties the selection; the pane stays mounted.
    act(() => ui$.selectedThread.set(''))
    act(() => ui$.selectedThread.set(pilot.thread_id))
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
    expect(thread$.searchOpen.peek()).toBe(false)
  })

  it('drops a request mail never answered once the person leaves mail', () => {
    act(() => ui$.module.set('mail'))
    requestThreadSearch(pilot.thread_id)
    act(() => ui$.module.set('notes'))
    expect(pendingThreadSearch()).toBe('')
  })
})

// #347: the conversation's search has two fields, the header's and the bar's
// under the header, and only one is drawn: the header's from 900 px in a header
// of 32 rem, the bar's otherwise. The focus goes to the drawn one, which the
// window's width alone does not tell: at the app's 200 % a 1025 px window has a
// 360 px reader, where the header's is hidden.
describe("the focus of the conversation's search (#347)", () => {
  const realRects = HTMLElement.prototype.getClientRects
  // The conversation on screen, not under a compose or reader tab another
  // file left open: there it is inert, and takes no focus.
  beforeEach(() => {
    compose$.tabs.set([])
    compose$.activeTab.set('')
  })
  afterEach(() => {
    HTMLElement.prototype.getClientRects = realRects
  })
  // Drawn or not, as the stylesheet would say (happy-dom has none).
  const drawHeaderField = (drawn: boolean) => {
    HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
      if (this.closest('header') && this.matches('input')) return (drawn ? realRects.call(this) : []) as DOMRectList
      return realRects.call(this)
    }
  }
  // The pane focuses the field in the frame after the search opens.
  const nextFrame = () => act(async () => await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  const fields = (view: ReturnType<typeof render>) => {
    const all = view.getAllByPlaceholderText('Search thread')
    return {
      header: all.find((input) => input.closest('header'))!,
      bar: all.find((input) => !input.closest('header'))!,
    }
  }

  it('goes to the bar under the header when the header does not draw its field, in a wide window', async () => {
    drawHeaderField(false)
    const view = render(<MessagePane />)
    act(() => thread$.searchOpen.set(true))
    const { header, bar } = fields(view)
    expect(header).toBeTruthy()
    await nextFrame()
    expect(document.activeElement).toBe(bar)
  })

  it("goes to the header's field where it is drawn", async () => {
    drawHeaderField(true)
    const view = render(<MessagePane />)
    act(() => thread$.searchOpen.set(true))
    const { header } = fields(view)
    await nextFrame()
    expect(document.activeElement).toBe(header)
  })
})
