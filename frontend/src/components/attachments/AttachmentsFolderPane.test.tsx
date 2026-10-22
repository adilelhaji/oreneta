import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { default: i18n } = await import('../../lib/i18n')
const { settings$ } = await import('../../states/settings')
const { attachmentList$ } = await import('../../states/attachmentList')
const { accounts$ } = await import('../../states/accounts')
const { ui$ } = await import('../../states/ui')
const { FolderPane } = await import('../shell/FolderPane')
const { messages, supportedI18nLanguages } = await import('../../generated/locales')
const { AttachmentsView } = await import('./AttachmentsView')

// #339: the filters in the common folder pane (ADR-0068 §4), at the width
// every module shares. At 1024 px and below the pane is not drawn, and the
// filter bar stays under the header.

const item = (over: Record<string, unknown>) => ({
  account: 'a@x',
  folder: 'INBOX',
  uid: 2,
  thread_key: 'k',
  thread_id: 'a@x#INBOX#t.aw',
  subject: 'Quarterly',
  from_name: 'Ana',
  from_addr: 'ana@x.cat',
  date: 1_760_000_000,
  index: 0,
  filename: 'scan.pdf',
  mime: 'application/pdf',
  size: 900_000,
  key: 'a/INBOX/2/0.pdf',
  kind: 'pdf',
  unavailable: '',
  ...over,
})

let calls: { command: string; payload: any }[] = []

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })
const twoAccounts = [
  { id: 'a@x', email: 'a@x', auth_type: 'password' } as any,
  { id: 'b@z', email: 'b@z', auth_type: 'password' } as any,
]

beforeEach(async () => {
  calls = []
  await i18n.changeLanguage('en')
  settings$.folderPaneWidth.set(260)
  accounts$.set(twoAccounts)
  attachmentList$.assign({
    filter: { account: '', name: '', sender: '', kind: '', within: 0 },
    items: [],
    total: 0,
    coverage: { messages: 0, downloaded: 0 },
    loading: false,
    loaded: false,
  })
  ui$.module.set('attachments')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'attachments.list')
            return {
              items: [item({}), item({ uid: 3, index: 1, filename: 'photo.png' })],
              total: 2,
              coverage: { messages: 2, downloaded: 2 },
            }
          return { ok: true }
        },
      },
    },
  }
  setWidth(1440)
})

afterEach(() => {
  cleanup()
  // happy-dom's own window: 1024 px wide.
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
  settings$.folderPaneWidth.set(260)
  ui$.module.set('mail')
  delete (window as any).go
})

const written = (key: string) =>
  calls.filter((call) => call.command === 'app.prefsSet' && call.payload.key === key).map((call) => call.payload.value)
const listed = () => calls.filter((call) => call.command === 'attachments.list')

const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Attachment filters' })
const content = (screen: ReturnType<typeof render>) =>
  screen.container.querySelector<HTMLElement>('[data-region="content"]')!
const ready = async (screen: ReturnType<typeof render>) => {
  await waitFor(() => expect(screen.container.textContent).toContain('scan.pdf'))
}

describe('Attachments in the common folder pane (ADR-0068 §4, #339)', () => {
  it('is the "folders" region beside the list, named by its title row', async () => {
    const screen = render(<AttachmentsView />)
    await ready(screen)
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    expect(nav.hasAttribute('data-folder-pane')).toBe(true)
    expect(within(nav).getByRole('heading', { level: 2, name: 'Attachment filters' }).getAttribute('title')).toBe(
      'Attachment filters',
    )
    // Beside the list, not inside it: the pane comes first.
    expect(content(screen).contains(nav)).toBe(false)
    expect(nav.compareDocumentPosition(content(screen)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The pane is the only "folders" region.
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(content(screen).querySelectorAll('[data-region="folders"]')).toHaveLength(0)
    expect(nav.querySelectorAll('[data-region]')).toHaveLength(0)
    // The bar is gone from the content, and the header and the list stay.
    expect(within(content(screen)).queryByLabelText('File name')).toBeNull()
    expect(within(content(screen)).getByRole('heading', { level: 1, name: 'Attachments' })).toBeTruthy()
    expect(within(content(screen)).getByText('scan.pdf')).toBeTruthy()
  })

  it("has the five filters in the bar's order, one per row, each with a visible label", async () => {
    const screen = render(<AttachmentsView />)
    await ready(screen)
    const nav = pane(screen)
    const controls = [
      within(nav).getByRole('textbox', { name: 'File name' }),
      within(nav).getByRole('textbox', { name: 'From' }),
      within(nav).getByRole('combobox', { name: 'Type' }),
      within(nav).getByRole('combobox', { name: 'When' }),
      within(nav).getByRole('combobox', { name: 'Account' }),
    ]
    const everything = [...nav.querySelectorAll('*')]
    const at = controls.map((control) => everything.indexOf(control))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((x, y) => x - y))
    // A visible <label> for each, tied to its control, and the accessible
    // name the bar gives it.
    const labels = [...nav.querySelectorAll('label')]
    expect(labels.map((label) => label.textContent)).toEqual(['File name', 'From', 'Type', 'When', 'Account'])
    labels.forEach((label, index) => {
      expect(label.htmlFor).toBe(controls[index].id)
      // The visible label is the name, as the bar's aria-label is: one source, nothing to drift.
      expect(controls[index].getAttribute('aria-label')).toBeNull()
    })
    // Stacked: each control in a row of its own, which may shrink and fills the pane.
    for (const control of controls.slice(1)) expect(control.className).toContain('w-full')
    for (const control of controls.slice(1)) expect(control.className).toContain('min-w-0')
    expect(controls[0].className).toContain('min-w-0')
    expect(new Set(controls.map((control) => control.closest('label') ?? control.parentElement)).size).toBe(5)
    expect(within(nav).getByRole('option', { name: 'All types' })).toBeTruthy()
    expect(within(nav).getByRole('option', { name: 'Last 30 days' })).toBeTruthy()
    expect(within(nav).getByRole('option', { name: 'b@z' })).toBeTruthy()
  })

  it('offers the account filter only with more than one account', async () => {
    accounts$.set([twoAccounts[0]])
    const screen = render(<AttachmentsView />)
    await ready(screen)
    expect(within(pane(screen)).queryByRole('combobox', { name: 'Account' })).toBeNull()
    expect(within(pane(screen)).queryByText('Account')).toBeNull()
    expect(within(pane(screen)).getAllByRole('combobox')).toHaveLength(2)
    act(() => accounts$.set(twoAccounts))
    expect(within(pane(screen)).getByRole('combobox', { name: 'Account' })).toBeTruthy()
  })

  it("sets the filter and reloads the list from the pane, with the bar's debounce", async () => {
    const screen = render(<AttachmentsView />)
    await ready(screen)
    await waitFor(() => expect(listed()).toHaveLength(1))
    const nav = pane(screen)

    fireEvent.change(within(nav).getByRole('combobox', { name: 'Type' }), { target: { value: 'image' } })
    expect(attachmentList$.filter.kind.peek()).toBe('image')
    await waitFor(() => expect(listed().at(-1)!.payload).toMatchObject({ kind: 'image' }))

    fireEvent.change(within(nav).getByRole('combobox', { name: 'When' }), { target: { value: '30' } })
    expect(attachmentList$.filter.within.peek()).toBe(30)
    await waitFor(() => expect(listed().at(-1)!.payload.from).toBeGreaterThan(0))
    // Thirty days back from now.
    expect(Math.abs(listed().at(-1)!.payload.from - (Date.now() / 1000 - 30 * 86400))).toBeLessThan(120)
    expect(listed().at(-1)!.payload).toMatchObject({ kind: 'image' })

    fireEvent.change(within(nav).getByRole('combobox', { name: 'Account' }), { target: { value: 'b@z' } })
    expect(attachmentList$.filter.account.peek()).toBe('b@z')
    await waitFor(() => expect(listed().at(-1)!.payload).toMatchObject({ account: 'b@z' }))

    // The text fields wait 200 ms for the last key, as the bar does.
    const before = listed().length
    fireEvent.change(within(nav).getByRole('textbox', { name: 'File name' }), { target: { value: 'sc' } })
    fireEvent.change(within(nav).getByRole('textbox', { name: 'File name' }), { target: { value: 'scan' } })
    fireEvent.change(within(nav).getByRole('textbox', { name: 'From' }), { target: { value: 'ana' } })
    expect(attachmentList$.filter.name.peek()).toBe('scan')
    expect(attachmentList$.filter.sender.peek()).toBe('ana')
    // Nothing goes out before the wait is over, not even after 100 ms.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(listed()).toHaveLength(before)
    await waitFor(() => expect(listed().at(-1)!.payload).toMatchObject({ name: 'scan', sender: 'ana' }))
    expect(listed().length).toBe(before + 1)
  })

  it('has the width the other modules have, and shares it with them', async () => {
    settings$.folderPaneWidth.set(320)
    const screen = render(<AttachmentsView />)
    await ready(screen)
    expect(pane(screen).style.width).toBe('320px')
    const handle = within(pane(screen)).getByRole('separator', { name: 'Resize folder pane' })
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(written('folder_pane_width').at(-1)).toBe(200)
    expect(pane(screen).style.width).toBe('200px')
    // The list keeps 360 px as its basis, so the pane gives way first.
    expect(content(screen).className).toContain('flex-[1_1_360px]')
    expect(pane(screen).style.flexShrink).toBe('1000')
    cleanup()

    // The same pane, drawn by mail, is as wide.
    const other = render(
      <FolderPane title="Accounts and folders">
        <button type="button">Inbox</button>
      </FolderPane>,
    )
    expect(other.getByRole('navigation', { name: 'Accounts and folders' }).style.width).toBe('200px')
  })
})

describe('the name of Attachments\' "folders" region (ADR-0068 §1, #339)', () => {
  it('is in all 20 catalogs, and never the name of another region, pane or control, in any language', () => {
    // A screen reader reads two names that differ only in case or spacing the
    // same, so compare them as it would hear them.
    const others = [
      'shell.region.mail',
      'shell.region.modules',
      'mailNavigation.title',
      'calendar.title',
      'calendar.calendars',
      'people.title',
      'people.contactGroups',
      'people.groups',
      'tasks.title',
      'tasks.taskLists',
      'notes.title',
      'notes.listLabel',
      'notes.editorLabel',
      'notes.tags',
      'notes.tagsPane',
      'messaging.title',
      'messaging.conversations',
      'messaging.groups',
      'messaging.direct',
      'messaging.invitations',
      'messaging.noConversation',
      'attachmentsView.title',
      // Attachments' own controls.
      'attachmentsView.searchName',
      'attachmentsView.sender',
      'attachmentsView.type',
      'attachmentsView.when',
      'attachmentsView.account',
      'attachmentsView.kindAll',
      'attachmentsView.anyTime',
      'attachmentsView.allAccounts',
      'attachmentsView.more',
      'attachmentsView.preview',
      'attachmentsView.save',
      'attachmentsView.openMessage',
    ]
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog['attachmentsView.filters']
      if (!name?.trim()) return [`${language}: missing`]
      return others
        .filter((key) => heard(catalog[key]) === heard(name))
        .map((key) => `${language}: same as ${key}, "${name}"`)
    })
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes).toEqual([])
    expect(messages.ca['attachmentsView.filters']).toBe("Filtres d'adjunts")
    expect(messages.en['attachmentsView.filters']).toBe('Attachment filters')
  })
})

describe('Attachments at 1024 px and below (#339)', () => {
  it('keeps the filter bar under the header, as before', async () => {
    setWidth(1024)
    const screen = render(<AttachmentsView />)
    await ready(screen)
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.container.querySelector('[data-region="folders"]')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize folder pane' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Attachment filters' })).toBeNull()
    expect(content(screen).className).toContain('flex-1')
    expect(content(screen).className).not.toContain('360px')
    // The five controls are in the content, named by aria-label, with no visible label.
    for (const name of ['File name', 'From'])
      expect(within(content(screen)).getByRole('textbox', { name })).toBeTruthy()
    for (const name of ['Type', 'When', 'Account'])
      expect(within(content(screen)).getByRole('combobox', { name })).toBeTruthy()
    expect(content(screen).querySelectorAll('label')).toHaveLength(0)
    const header = content(screen).querySelector('header')!
    expect(header.nextElementSibling!.contains(screen.getByLabelText('File name'))).toBe(true)
    expect(header.nextElementSibling!.className).toContain('flex-wrap')
  })

  it('follows the window across 1025 px, keeping the list and the filter values', async () => {
    setWidth(1024)
    const screen = render(<AttachmentsView />)
    await ready(screen)
    const list = content(screen).querySelector('ul')!
    const scroller = list.parentElement!
    const row = screen.getByText('scan.pdf')
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'pdf' } })
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'scan' } })
    await waitFor(() => expect(listed().at(-1)!.payload).toMatchObject({ kind: 'pdf', name: 'scan' }))
    scroller.scrollTop = 40
    const requests = listed().length

    await act(async () => setWidth(1025))
    // The same nodes, not rebuilt ones: the list keeps its scroll position.
    expect(content(screen).querySelector('ul')).toBe(list)
    expect(list.parentElement).toBe(scroller)
    expect(screen.getByText('scan.pdf')).toBe(row)
    expect(scroller.scrollTop).toBe(40)
    expect(within(pane(screen)).getByRole('combobox', { name: 'Type' })).toHaveProperty('value', 'pdf')
    expect(within(pane(screen)).getByRole('textbox', { name: 'File name' })).toHaveProperty('value', 'scan')
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(screen.container.querySelectorAll('[data-region="content"]')).toHaveLength(1)
    expect(content(screen).className).toContain('flex-[1_1_360px]')

    await act(async () => setWidth(1024))
    expect(content(screen).querySelector('ul')).toBe(list)
    expect(list.parentElement).toBe(scroller)
    expect(screen.getByText('scan.pdf')).toBe(row)
    expect(scroller.scrollTop).toBe(40)
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.getByLabelText('Type')).toHaveProperty('value', 'pdf')
    expect(screen.getByLabelText('File name')).toHaveProperty('value', 'scan')
    // Crossing the width asks the core for nothing: the filters did not change.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(listed()).toHaveLength(requests)
  })
})
