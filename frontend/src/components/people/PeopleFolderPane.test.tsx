import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { people$ } from '../../states/people'
import { contactSources$ } from '../../states/contactSources'
import { settings$ } from '../../states/settings'
import { settleConfirm, ui$ } from '../../states/ui'
import { FolderPane } from '../shell/FolderPane'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import type { Account, ContactGroup, Person } from '../../types'
import { PeopleView } from './PeopleView'

// #326: People's groups in the common folder pane (ADR-0068 §4), at the width
// every module shares. At 1024 px and below the pane is not drawn, and the
// groups keep their filter under the list's header.

const person = (id: string, given: string, family: string, addr: string): Person => ({
  id,
  source: 'local',
  account: '',
  book: 'local',
  name: `${given} ${family}`,
  given,
  family,
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr, label: '' }],
  phones: [],
  version: '1',
  editable: true,
})

const zoe = person('local::local:z', 'Zoe', 'Adams', 'zoe@example.test')
const bob = person('local::local:b', 'Bob', 'Young', 'bob@example.test')
const member = (p: Person) => ({ id: p.id, name: p.name, given: p.given, family: p.family, addr: p.emails[0].addr })

const climbing: ContactGroup = {
  id: 'group:local::local:g1',
  source: 'local',
  account: '',
  book: 'local',
  name: 'Climbing',
  version: '4',
  editable: true,
  members: [member(bob), member(zoe)],
}
const shared: ContactGroup = {
  id: 'group:google::google-a:g2',
  source: 'google',
  account: 'acct',
  book: 'google-a',
  name: 'A group on a server with a name too long for the pane',
  version: '1',
  editable: false,
  members: [member(zoe)],
}

let calls: { command: string; payload: any }[] = []

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })

beforeEach(async () => {
  calls = []
  await i18n.changeLanguage('en')
  accounts$.set([
    {
      id: 'acct',
      email: 'ana@example.test',
      display_name: 'Ana',
      provider: 'imap',
      auth_type: 'password',
      paused: false,
    },
  ] as unknown as Account[])
  contactSources$.set({ sources: [], loaded: true })
  settings$.contactNameDisplay.set('auto')
  settings$.contactNameSort.set('auto')
  settings$.folderPaneWidth.set(260)
  people$.set({
    people: [zoe, bob],
    loaded: true,
    loading: false,
    query: '',
    selectedId: '',
    editing: null,
    importing: null,
    duplicates: [],
    duplicatesOpen: false,
    groups: [climbing, shared],
    groupsLoaded: true,
    groupFilter: '',
    groupEditing: null,
  })
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'people.groups') return { groups: [climbing, shared] }
          if (command === 'people.list') return { people: [zoe, bob] }
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
  accounts$.set([])
  people$.groupFilter.set('')
  settings$.folderPaneWidth.set(260)
  ui$.module.set('mail')
  delete (window as any).go
})

const written = (key: string) =>
  calls.filter((call) => call.command === 'app.prefsSet' && call.payload.key === key).map((call) => call.payload.value)

const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Contact groups' })
const content = (screen: ReturnType<typeof render>) =>
  screen.container.querySelector<HTMLElement>('[data-region="content"]')!
const rows = (screen: ReturnType<typeof render>) =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.querySelector('span span')?.textContent)

describe('People in the common folder pane (ADR-0068 §4, #326)', () => {
  it('is the "folders" region beside the whole module, named by its title row', () => {
    const screen = render(<PeopleView />)
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    expect(nav.hasAttribute('data-folder-pane')).toBe(true)
    expect(within(nav).getByRole('heading', { level: 2, name: 'Contact groups' }).getAttribute('title')).toBe(
      'Contact groups',
    )
    // Beside the module, not inside it: the pane comes first, then the list.
    expect(content(screen).contains(nav)).toBe(false)
    expect(nav.compareDocumentPosition(content(screen)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // One "folders" region in the module, and it holds no other region.
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    // The one region inside it is the module strip at its foot (#354).
    expect([...nav.querySelectorAll<HTMLElement>('[data-region]')].map((region) => region.dataset.region)).toEqual([
      'modules',
    ])
    expect(nav.querySelector('[data-region="modules"]')?.getAttribute('aria-label')).toBe('Modules')
    // The old filter row is not drawn in the list's header as well.
    expect(screen.queryByLabelText('Show group')).toBeNull()
    expect(within(content(screen)).queryByRole('button', { name: 'New group' })).toBeNull()
  })

  it('lists all contacts and each group with how many it holds, and chooses one', () => {
    const screen = render(<PeopleView />)
    const nav = within(pane(screen))
    const all = nav.getByRole('button', { name: 'All contacts' })
    const group = nav.getByRole('button', { name: 'Climbing (2)' })
    expect(all.getAttribute('aria-current')).toBe('true')
    expect(group.getAttribute('aria-current')).toBeNull()
    // A name that can end in "…" is whole in its tooltip, with its count.
    expect(group.getAttribute('title')).toBe('Climbing (2)')
    const long = nav.getByTitle(`${shared.name} (1)`)
    expect(long.textContent).toContain(shared.name)
    expect(rows(screen)).toEqual(['Bob Young', 'Zoe Adams'])

    fireEvent.click(group)
    expect(people$.groupFilter.peek()).toBe(climbing.id)
    expect(group.getAttribute('aria-current')).toBe('true')
    expect(all.getAttribute('aria-current')).toBeNull()

    fireEvent.click(long)
    expect(rows(screen)).toEqual(['Zoe Adams'])
    fireEvent.click(all)
    expect(rows(screen)).toEqual(['Bob Young', 'Zoe Adams'])
  })

  it('says when there are no groups', () => {
    people$.groups.set([])
    const screen = render(<PeopleView />)
    expect(within(pane(screen)).getByText('No groups yet')).toBeTruthy()
    expect(within(pane(screen)).getByRole('button', { name: 'All contacts' })).toBeTruthy()
    expect(within(pane(screen)).getByRole('button', { name: 'New group' })).toBeTruthy()
  })

  it('creates, renames, writes to and deletes a group from the pane, as the row did', async () => {
    const screen = render(<PeopleView />)
    const nav = within(pane(screen))
    // With none on show, only "New group".
    expect(nav.queryByRole('button', { name: /^(Rename|Delete) / })).toBeNull()
    expect(nav.queryByRole('button', { name: /^Write to everyone/ })).toBeNull()

    fireEvent.click(nav.getByRole('button', { name: 'New group' }))
    expect(people$.groupEditing.peek()).toEqual({ name: '', book: '', members: [] })
    // The dialog is the module's, and it saves as before.
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: ' Book club ' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(calls.some((call) => call.command === 'people.groupSave')).toBe(true))
    expect(calls.find((call) => call.command === 'people.groupSave')!.payload).toEqual({
      name: 'Book club',
      members: [],
    })
    await waitFor(() => expect(people$.groupEditing.peek()).toBeNull())

    fireEvent.click(nav.getByRole('button', { name: 'Climbing (2)' }))
    // Each action says which group it acts on, as its name and its tooltip.
    const rename = nav.getByRole('button', { name: 'Rename Climbing' })
    expect(rename.getAttribute('title')).toBe('Rename Climbing')
    fireEvent.click(rename)
    expect(people$.groupEditing.peek()).toEqual({
      id: climbing.id,
      version: '4',
      name: 'Climbing',
      book: 'local',
      members: [bob.id, zoe.id],
    })
    people$.groupEditing.set(null)

    // Write to everyone in it: a compose tab from the account that can send.
    const write = nav.getByRole('button', { name: 'Write to everyone in Climbing' })
    expect((write as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(write)
    expect(ui$.module.peek()).toBe('mail')

    const remove = nav.getByRole('button', { name: 'Delete Climbing' })
    expect(remove.getAttribute('title')).toBe('Delete Climbing')
    fireEvent.click(remove)
    await waitFor(() => expect(ui$.confirm.peek()).not.toBeNull())
    expect(ui$.confirm.peek()!.message).toBe('The group Climbing will be deleted. The people in it stay.')
    settleConfirm(false)
    await waitFor(() => expect(ui$.confirm.peek()).toBeNull())
    expect(calls.some((call) => call.command === 'people.groupDelete')).toBe(false)
  })

  it('deletes an Exchange group from the pane once confirmed, saying it goes from the server', async () => {
    const distribution: ContactGroup = {
      ...climbing,
      id: 'group:exchange::ews-a:dl1',
      source: 'exchange',
      account: 'acct',
      book: 'ews-a',
      name: 'Team list',
      version: 'ck1',
    }
    people$.groups.set([climbing, distribution])
    const screen = render(<PeopleView />)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByRole('button', { name: 'Team list (2)' }))
    fireEvent.click(nav.getByRole('button', { name: 'Delete Team list' }))
    await waitFor(() => expect(ui$.confirm.peek()).not.toBeNull())
    expect(ui$.confirm.peek()!.message).toBe(
      'The group Team list will be deleted from the address book on its server. The people in it stay.',
    )
    expect(calls.some((call) => call.command === 'people.groupDelete')).toBe(false)
    settleConfirm(true)
    await waitFor(() => expect(calls.some((call) => call.command === 'people.groupDelete')).toBe(true))
    expect(calls.find((call) => call.command === 'people.groupDelete')!.payload).toEqual({
      id: distribution.id,
      version: 'ck1',
    })
  })

  it('offers no rename or delete for a group it cannot write', () => {
    const screen = render(<PeopleView />)
    const nav = within(pane(screen))
    fireEvent.click(nav.getByTitle(`${shared.name} (1)`))
    expect(nav.queryByRole('button', { name: /^(Rename|Delete) / })).toBeNull()
    expect(nav.getByRole('button', { name: `Write to everyone in ${shared.name}` })).toBeTruthy()
  })

  it('shows the list and a person beside the pane, as before', () => {
    people$.selectedId.set(bob.id)
    const screen = render(<PeopleView />)
    expect(rows(screen)).toEqual(['Bob Young', 'Zoe Adams'])
    expect(screen.getByRole('heading', { level: 2, name: 'Bob Young' })).toBeTruthy()
    // The list's header keeps the title and the actions; the search is in the
    // top band (#344).
    const column = content(screen)
    expect(within(column).getByRole('heading', { level: 1, name: 'People' })).toBeTruthy()
    expect(within(column).getByRole('button', { name: 'New contact' })).toBeTruthy()
    expect(within(column).getByRole('button', { name: 'Import contacts' })).toBeTruthy()
    expect(within(column).queryByRole('textbox', { name: 'Search people' })).toBeNull()
    // The list and the person at the reader's 360 px, as the content's basis,
    // which the app's sidebar never takes (owner decision D3 on #360): the
    // list's 288 px from PEOPLE_LIST_PX. Not a hard minimum: too short a row
    // (the system's 200 % zoom) shrinks it rather than scroll sideways.
    expect(column.style.flex).toBe('1 1 648px')
    expect(column.style.minWidth).toBe('')
    expect(screen.getByRole('listbox').closest('section')!.style.width).toBe('288px')
  })

  it('shares one width with mail: resized here, it is the width mail draws, and the reverse', () => {
    const screen = render(<PeopleView />)
    const handle = within(pane(screen)).getByRole('separator', { name: 'Resize folder pane' })
    expect(pane(screen).style.width).toBe('260px')
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(pane(screen).style.width).toBe('400px')
    expect(written('folder_pane_width')).toEqual([400])
    cleanup()

    const mail = render(
      <FolderPane title="Accounts and folders">
        <button type="button">Inbox</button>
      </FolderPane>,
    )
    expect(mail.getByRole('navigation', { name: 'Accounts and folders' }).style.width).toBe('400px')
    fireEvent.keyDown(mail.getByRole('separator', { name: 'Resize folder pane' }), { key: 'Home' })
    expect(written('folder_pane_width')).toEqual([400, 200])
    cleanup()

    const again = render(<PeopleView />)
    expect(pane(again).style.width).toBe('200px')
    expect(within(pane(again)).getByRole('separator').getAttribute('aria-valuenow')).toBe('200')
  })
})

describe('the name of People\'s "folders" region (ADR-0068 §1, #326)', () => {
  it('is never the name of <main> or of the card\'s "Groups", in any language', () => {
    // A screen reader reads two names that differ only in case or spacing the
    // same, so compare them as it would hear them.
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog['people.contactGroups']
      if (!name?.trim()) return [`${language}: missing`]
      return [
        ...(heard(name) === heard(catalog['people.title']) ? [`${language}: same as <main>, "${name}"`] : []),
        ...(heard(name) === heard(catalog['people.groups']) ? [`${language}: same as "Groups", "${name}"`] : []),
      ]
    })
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes).toEqual([])
  })
})

describe('People at 1024 px and below (#326)', () => {
  it("keeps the groups as a filter under the list's header, as before", () => {
    setWidth(1024)
    const screen = render(<PeopleView />)
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize folder pane' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Contact groups' })).toBeNull()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(content(screen).contains(column)).toBe(true)
    const filter = within(column).getByLabelText('Show group') as HTMLSelectElement
    expect(within(column).getByText('Climbing (2)')).toBeTruthy()
    fireEvent.change(filter, { target: { value: climbing.id } })
    expect(rows(screen)).toEqual(['Bob Young', 'Zoe Adams'])
    expect(within(column).getByRole('button', { name: 'New group' })).toBeTruthy()
    expect(within(column).getByRole('button', { name: 'Rename group' })).toBeTruthy()
    expect(within(column).getByRole('button', { name: 'Delete group' })).toBeTruthy()
    expect(within(column).getByRole('button', { name: 'Write to everyone in Climbing' })).toBeTruthy()
  })

  it('follows the window across 1025 px, one place at a time, keeping the chosen group', async () => {
    setWidth(1024)
    const screen = render(<PeopleView />)
    people$.groupFilter.set(shared.id)
    expect(screen.getAllByLabelText('Show group')).toHaveLength(1)
    await act(async () => setWidth(1025))
    expect(pane(screen).hasAttribute('data-folder-pane')).toBe(true)
    expect(screen.queryByLabelText('Show group')).toBeNull()
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(within(pane(screen)).getByTitle(`${shared.name} (1)`).getAttribute('aria-current')).toBe('true')
    expect(rows(screen)).toEqual(['Zoe Adams'])
    await act(async () => setWidth(1024))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect((screen.getByLabelText('Show group') as HTMLSelectElement).value).toBe(shared.id)
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
  })
})

// #341: the focus follows the control across 1025 px.
// happy-dom tells a media query's listeners about a change only once the query
// has matched, so a window that starts wide is resized wide once (1500 px)
// before it narrows to 1024 px, as a browser's would have been.
const narrowWindow = async () => {
  await act(async () => setWidth(1500))
  await act(async () => setWidth(1024))
}

describe('People keep the focus across 1025 px (#341)', () => {
  it('moves it from the group on show to the group select, and back to its row', () => {
    return (async () => {
      const screen = render(<PeopleView />)
      fireEvent.click(within(pane(screen)).getByRole('button', { name: 'Climbing (2)' }))
      const row = within(pane(screen)).getByRole('button', { name: 'Climbing (2)' })
      row.focus()
      await narrowWindow()
      const select = screen.getByLabelText('Show group')
      expect(document.activeElement).toBe(select)
      expect((select as HTMLSelectElement).value).toBe(climbing.id)
      await act(async () => setWidth(1025))
      expect(document.activeElement).toBe(within(pane(screen)).getByRole('button', { name: 'Climbing (2)' }))
    })()
  })

  it('moves "New group" the same way, and "All contacts" to the select', async () => {
    const screen = render(<PeopleView />)
    within(pane(screen)).getByRole('button', { name: 'New group' }).focus()
    await narrowWindow()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New group' }))
    await act(async () => setWidth(1025))
    within(pane(screen)).getByRole('button', { name: 'All contacts' }).focus()
    await narrowWindow()
    expect(document.activeElement).toBe(screen.getByLabelText('Show group'))
  })

  it('falls back to the group select when the row is not the group on show', async () => {
    const screen = render(<PeopleView />)
    // A row the arrows reached without choosing it, or one the pointer has not pressed yet.
    within(pane(screen)).getByRole('button', { name: 'Climbing (2)' }).focus()
    await narrowWindow()
    expect(document.activeElement).toBe(screen.getByLabelText('Show group'))
  })

  it('leaves the focus alone when it was on the list, and does nothing on the first render', async () => {
    const screen = render(<PeopleView />)
    expect(document.activeElement).toBe(document.body)
    // The list header's «New contact», which stays in place across 1025 px, as
    // the search did before it moved to the top band (#344).
    const newContact = screen.getByRole('button', { name: 'New contact' })
    newContact.focus()
    await narrowWindow()
    expect(document.activeElement).toBe(newContact)
  })
})
