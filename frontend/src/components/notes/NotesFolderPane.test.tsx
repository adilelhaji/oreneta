import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { default: i18n } = await import('../../lib/i18n')
const { settings$ } = await import('../../states/settings')
const { loadNotes, notes$ } = await import('../../states/notes')
const { ui$ } = await import('../../states/ui')
const { AppHotkeys } = await import('../dialog/AppHotkeys')
const { mail$ } = await import('../../states/mail')
const { FolderPane } = await import('../shell/FolderPane')
const { messages, supportedI18nLanguages } = await import('../../generated/locales')
const { NotesView } = await import('./NotesView')

// #335: the notes' tags in the common folder pane (ADR-0068 §4), at the width
// every module shares. At 1024 px and below the pane is not drawn, and the
// tags keep their chips above the list.

const summary = (id: string, title: string, tags: string[], extra: Record<string, unknown> = {}) => ({
  id,
  title,
  preview: `${title} body`,
  tags,
  pinned: false,
  revision: 1,
  updated_at: 1_760_000_000,
  deleted_at: null,
  ...extra,
})
const stored = [
  summary('n1', 'Plan the trip', ['travel', 'ideas']),
  summary('n2', 'Packing list', ['travel']),
  summary('n3', 'Pasta', ['cooking']),
  summary('n4', 'Old receipt', [], { deleted_at: 5 }),
]
// As the core answers: the tags of the live notes, whatever the filter.
const tagCounts = [
  { tag: 'travel', count: 2 },
  { tag: 'cooking', count: 1 },
  { tag: 'a-tag-with-a-name-far-too-long-for-the-pane', count: 1 },
  { tag: 'ideas', count: 1 },
]

let calls: { command: string; payload: any }[] = []

const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })

beforeEach(async () => {
  calls = []
  await i18n.changeLanguage('en')
  settings$.folderPaneWidth.set(260)
  notes$.assign({ items: [], tags: [], loaded: false, search: '', tag: '', trash: false, selected: null })
  ui$.module.set('notes')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'notes.list')
            return {
              notes: stored
                .filter((note) => (note.deleted_at !== null) === !!payload.trash)
                .filter((note) => !payload.tag || note.tags.includes(payload.tag)),
              tags: tagCounts,
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
  notes$.assign({ items: [], tags: [], loaded: false, search: '', tag: '', trash: false, selected: null })
  settings$.folderPaneWidth.set(260)
  ui$.module.set('mail')
  delete (window as any).go
})

const written = (key: string) =>
  calls.filter((call) => call.command === 'app.prefsSet' && call.payload.key === key).map((call) => call.payload.value)
const listed = () => calls.filter((call) => call.command === 'notes.list').map((call) => call.payload)

const pane = (screen: ReturnType<typeof render>) => screen.getByRole('navigation', { name: 'Note tags' })
const content = (screen: ReturnType<typeof render>) =>
  screen.container.querySelector<HTMLElement>('[data-region="content"]')!
const shown = (screen: ReturnType<typeof render>) =>
  [...content(screen).querySelectorAll('ul > li > button .truncate')].map((node) => node.textContent)
const ready = async (screen: ReturnType<typeof render>) => {
  await waitFor(() => expect(screen.container.textContent).toContain('Plan the trip'))
  await waitFor(() => expect(notes$.tags.peek()).toHaveLength(4))
}

describe('Notes in the common folder pane (ADR-0068 §4, #335)', () => {
  it('is the "folders" region beside the whole module, named by its title row', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    const nav = pane(screen)
    expect(nav.dataset.region).toBe('folders')
    expect(nav.hasAttribute('data-folder-pane')).toBe(true)
    expect(within(nav).getByRole('heading', { level: 2, name: 'Note tags' }).getAttribute('title')).toBe('Note tags')
    // Beside the module, not inside it: the pane comes first, then the notes.
    expect(content(screen).contains(nav)).toBe(false)
    expect(nav.compareDocumentPosition(content(screen)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The note list no longer claims the region, and no chips sit above it.
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(content(screen).querySelectorAll('[data-region="folders"]')).toHaveLength(0)
    // The one region inside it is the module strip at its foot (#354).
    expect([...nav.querySelectorAll<HTMLElement>('[data-region]')].map((region) => region.dataset.region)).toEqual([
      'modules',
    ])
    expect(nav.querySelector('[data-region="modules"]')?.getAttribute('aria-label')).toBe('Modules')
    expect(content(screen).querySelector('[aria-label="Tags"]')).toBeNull()
    // Trash and New note stay where they were; the search is in the top band (#344).
    expect(within(content(screen)).queryByRole('textbox', { name: 'Search notes' })).toBeNull()
    expect(within(content(screen)).getByRole('button', { name: 'Trash' })).toBeTruthy()
    expect(within(content(screen)).getByRole('button', { name: 'New note' })).toBeTruthy()
  })

  it('offers "All notes" and each tag with its count, in the core\'s order', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    const rows = [...pane(screen).querySelectorAll<HTMLElement>('[data-tag-row]')]
    expect(rows.map((row) => row.getAttribute('aria-label') ?? row.textContent)).toEqual([
      'All notes',
      '#travel (2)',
      '#cooking (1)',
      '#a-tag-with-a-name-far-too-long-for-the-pane (1)',
      '#ideas (1)',
    ])
    const all = within(pane(screen)).getByTitle('All notes')
    expect(all.getAttribute('aria-current')).toBe('true')
    // A name that can end in "…" is whole in its tooltip, with its count.
    const long = within(pane(screen)).getByTitle('#a-tag-with-a-name-far-too-long-for-the-pane (1)')
    expect(long.textContent).toContain('#a-tag-with-a-name-far-too-long-for-the-pane')
    expect(long.getAttribute('aria-current')).toBeNull()
  })

  it('chooses a tag, marks it with aria-current, clears it on a second press and on "All notes"', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    const nav = within(pane(screen))
    const all = nav.getByTitle('All notes')
    const travel = nav.getByRole('button', { name: '#travel (2)' })
    fireEvent.click(travel)
    expect(notes$.tag.peek()).toBe('travel')
    expect(travel.getAttribute('aria-current')).toBe('true')
    expect(all.getAttribute('aria-current')).toBeNull()
    await waitFor(() => expect(listed().at(-1)).toMatchObject({ tag: 'travel', trash: false }))
    await waitFor(() => expect(shown(screen)).toEqual(['Plan the trip', 'Packing list']))
    // The chosen tag again clears the filter, as the chip did.
    fireEvent.click(travel)
    expect(notes$.tag.peek()).toBe('')
    expect(travel.getAttribute('aria-current')).toBeNull()
    expect(all.getAttribute('aria-current')).toBe('true')
    await waitFor(() => expect(shown(screen)).toHaveLength(3))
    // Another tag, then "All notes".
    fireEvent.click(nav.getByRole('button', { name: '#cooking (1)' }))
    await waitFor(() => expect(shown(screen)).toEqual(['Pasta']))
    fireEvent.click(all)
    expect(notes$.tag.peek()).toBe('')
    await waitFor(() => expect(shown(screen)).toHaveLength(3))
    // "All notes" is not a toggle.
    fireEvent.click(all)
    expect(all.getAttribute('aria-current')).toBe('true')
  })

  it('moves between the rows with Up, Down, Home and End, choosing as it goes', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    const nav = within(pane(screen))
    const all = nav.getByTitle('All notes')
    all.focus()
    fireEvent.keyDown(all, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(nav.getByRole('button', { name: '#travel (2)' }))
    expect(notes$.tag.peek()).toBe('travel')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(notes$.tag.peek()).toBe('ideas')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(notes$.tag.peek()).toBe('a-tag-with-a-name-far-too-long-for-the-pane')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(notes$.tag.peek()).toBe('')
    expect(document.activeElement).toBe(all)
    // Left and Right are not the rows' keys here.
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(notes$.tag.peek()).toBe('')
  })

  it('keeps the chosen tag when an arrow lands on it: only a press clears it', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    const nav = within(pane(screen))
    const ideas = nav.getByRole('button', { name: '#ideas (1)' })
    fireEvent.click(ideas)
    expect(notes$.tag.peek()).toBe('ideas')
    // From "All notes" (where F6 lands) down to the chosen row and on to the end.
    const all = nav.getByTitle('All notes')
    all.focus()
    fireEvent.keyDown(all, { key: 'End' })
    expect(document.activeElement).toBe(ideas)
    expect(notes$.tag.peek()).toBe('ideas')
    fireEvent.keyDown(ideas, { key: 'End' })
    expect(notes$.tag.peek()).toBe('ideas')
    fireEvent.keyDown(ideas, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(ideas)
    expect(notes$.tag.peek()).toBe('ideas')
    expect(ideas.getAttribute('aria-current')).toBe('true')
  })

  it('drops a chosen tag that no note carries any more', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    fireEvent.click(within(pane(screen)).getByRole('button', { name: '#cooking (1)' }))
    await waitFor(() => expect(shown(screen)).toEqual(['Pasta']))
    // Its last note goes to the trash: the core stops listing the tag.
    const gone = tagCounts.findIndex((entry) => entry.tag === 'cooking')
    const [cooking] = tagCounts.splice(gone, 1)
    try {
      await act(() => loadNotes())
      expect(notes$.tag.peek()).toBe('')
      await waitFor(() => expect(shown(screen)).toHaveLength(3))
      expect(within(pane(screen)).getByTitle('All notes').getAttribute('aria-current')).toBe('true')
    } finally {
      tagCounts.splice(gone, 0, cooking)
    }
  })

  it('follows the spelling the core lists for the chosen tag instead of dropping it', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    // Chosen as "Ideas" while another note's "ideas" is the spelling listed.
    notes$.tag.set('Ideas')
    await act(() => loadNotes())
    expect(notes$.tag.peek()).toBe('ideas')
    await waitFor(() =>
      expect(within(pane(screen)).getByRole('button', { name: '#ideas (1)' }).getAttribute('aria-current')).toBe(
        'true',
      ),
    )
  })

  it('fills the list from the latest load only, whatever order the replies come in', async () => {
    const replies: ((value: unknown) => void)[] = []
    ;(window as any).go.main.App.Invoke = (command: string, payload: any) =>
      command === 'notes.list'
        ? new Promise((resolve) =>
            replies.push(() => resolve({ notes: [summary(payload.tag, payload.tag, [])], tags: tagCounts })),
          )
        : Promise.resolve({ ok: true })
    notes$.tag.set('travel')
    const first = loadNotes()
    notes$.tag.set('ideas')
    const second = loadNotes()
    replies[1](undefined)
    await second
    replies[0](undefined)
    await first
    expect(notes$.items.peek().map((note) => note.id)).toEqual(['ideas'])
    expect(notes$.loaded.peek()).toBe(true)
  })

  it('takes the arrow keys: the mail thread list behind does not step with them', async () => {
    const thread = (id: string) => ({ thread_id: id, id }) as never
    mail$.threads.set([thread('t1'), thread('t2')])
    ui$.selectedThread.set('t1')
    try {
      const screen = render(
        <>
          <AppHotkeys />
          <NotesView />
        </>,
      )
      await ready(screen)
      const all = within(pane(screen)).getByTitle('All notes')
      all.focus()
      fireEvent.keyDown(all, { key: 'ArrowDown' })
      expect(notes$.tag.peek()).toBe('travel')
      expect(ui$.selectedThread.peek()).toBe('t1')
    } finally {
      mail$.threads.set([])
      ui$.selectedThread.set('')
    }
  })

  it('hides the tags in the Trash and says it is not filtered by tag, and brings them back', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    fireEvent.click(within(pane(screen)).getByRole('button', { name: '#travel (2)' }))
    await waitFor(() => expect(shown(screen)).toEqual(['Plan the trip', 'Packing list']))
    fireEvent.click(within(content(screen)).getByRole('button', { name: 'Trash' }))
    await waitFor(() => expect(screen.container.textContent).toContain('Old receipt'))
    const nav = pane(screen)
    // Nothing to press in its body; the module strip stays at its foot (#354).
    const body = within(nav).getByRole('heading', { level: 2 }).parentElement!.nextElementSibling as HTMLElement
    expect(within(body).queryByRole('button')).toBeNull()
    expect(within(nav).getByRole('navigation', { name: 'Modules' })).toBeTruthy()
    expect(nav.querySelectorAll('[data-tag-row]')).toHaveLength(0)
    expect(within(nav).getByText('The trash is not filtered by tag.')).toBeTruthy()
    // The pane is still the region, with its title, and the tag chosen before
    // is not applied to the trash, as the line says.
    expect(nav.dataset.region).toBe('folders')
    expect(listed().at(-1)).toMatchObject({ tag: '', trash: true })
    fireEvent.click(within(content(screen)).getByRole('button', { name: 'Trash' }))
    await waitFor(() => expect(shown(screen)).toEqual(['Plan the trip', 'Packing list']))
    expect(within(pane(screen)).queryByText('The trash is not filtered by tag.')).toBeNull()
    // The tag is back, still chosen.
    expect(within(pane(screen)).getByRole('button', { name: '#travel (2)' }).getAttribute('aria-current')).toBe('true')
  })

  it('has the width the other modules have, and shares it with them', async () => {
    settings$.folderPaneWidth.set(320)
    const screen = render(<NotesView />)
    await ready(screen)
    expect(pane(screen).style.width).toBe('320px')
    const handle = within(pane(screen)).getByRole('separator', { name: 'Resize folder pane' })
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(written('folder_pane_width').at(-1)).toBe(200)
    expect(pane(screen).style.width).toBe('200px')
    // The module's column gives way after the pane: it is the flex basis.
    expect(content(screen).className).toContain('flex-[1_1_680px]')
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

describe('the name of Notes\'s "folders" region (ADR-0068 §1, #335)', () => {
  it('is never the name of another region, in any language', () => {
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
      'messaging.title',
      'messaging.conversations',
      'attachmentsView.title',
    ]
    const clashes = supportedI18nLanguages.flatMap((language) => {
      const catalog = messages[language]
      const heard = (s: string | undefined) =>
        (s ?? '').trim().normalize('NFC').toLocaleLowerCase(language.replace('_', '-'))
      const name = catalog['notes.tagsPane']
      if (!name?.trim()) return [`${language}: missing`]
      return others
        .filter((key) => heard(catalog[key]) === heard(name))
        .map((key) => `${language}: same as ${key}, "${name}"`)
    })
    expect(supportedI18nLanguages.length).toBe(20)
    expect(clashes).toEqual([])
  })

  it('has every string of the pane in every catalog', () => {
    const missing = supportedI18nLanguages.flatMap((language) =>
      ['notes.tagsPane', 'notes.allNotes', 'notes.tagOption', 'notes.trashNoTags']
        .filter((key) => !messages[language][key]?.trim())
        .map((key) => `${language}: ${key}`),
    )
    expect(missing).toEqual([])
    expect(messages.ca['notes.tagsPane']).toBe('Etiquetes de notes')
  })
})

describe('Notes at 1024 px and below (#335)', () => {
  it('keeps the tags as chips above the list, as before', async () => {
    setWidth(1024)
    const screen = render(<NotesView />)
    await waitFor(() => expect(notes$.tags.peek()).toHaveLength(4))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize folder pane' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Note tags' })).toBeNull()
    const column = screen.container.querySelector<HTMLElement>('[data-region="folders"]')!
    expect(content(screen).contains(column)).toBe(true)
    const chips = within(column.querySelector<HTMLElement>('[aria-label="Tags"]')!).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      '#travel 2',
      '#cooking 1',
      '#a-tag-with-a-name-far-too-long-for-the-pane 1',
      '#ideas 1',
    ])
    fireEvent.click(chips[0])
    expect(notes$.tag.peek()).toBe('travel')
    expect(chips[0].getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(listed().at(-1)).toMatchObject({ tag: 'travel' }))
    expect(within(column).queryByTitle('All notes')).toBeNull()
  })

  it('follows the window across 1025 px, one place at a time, keeping the chosen tag', async () => {
    setWidth(1024)
    const screen = render(<NotesView />)
    await waitFor(() => expect(notes$.tags.peek()).toHaveLength(4))
    fireEvent.click(screen.getByRole('button', { name: /^#cooking 1$/ }))
    await act(async () => setWidth(1025))
    expect(pane(screen).hasAttribute('data-folder-pane')).toBe(true)
    expect(screen.container.querySelector('[aria-label="Tags"]')).toBeNull()
    expect(screen.container.querySelectorAll('[data-region="folders"]')).toHaveLength(1)
    expect(within(pane(screen)).getByRole('button', { name: '#cooking (1)' }).getAttribute('aria-current')).toBe('true')
    await act(async () => setWidth(1024))
    expect(screen.container.querySelector('[data-folder-pane]')).toBeNull()
    expect(screen.getByRole('button', { name: /^#cooking 1$/ }).getAttribute('aria-pressed')).toBe('true')
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

describe('Notes keep the focus across 1025 px (#341)', () => {
  it("moves it from a tag row to the same tag's chip and back", async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    const row = within(pane(screen)).getByRole('button', { name: '#travel (2)' })
    row.focus()
    await narrowWindow()
    const chip = [...screen.container.querySelectorAll<HTMLElement>('[aria-label="Tags"] button')].find((button) =>
      button.textContent?.startsWith('#travel'),
    )!
    expect(document.activeElement).toBe(chip)
    await act(async () => setWidth(1025))
    expect(document.activeElement).toBe(within(pane(screen)).getByRole('button', { name: '#travel (2)' }))
  })

  it('falls back to the first control of the list column when "All notes" has no chip', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    within(pane(screen)).getByTitle('All notes').focus()
    await narrowWindow()
    // The search that came first is in the top band (#344): the first chip.
    const chips = [...screen.container.querySelectorAll<HTMLElement>('[aria-label="Tags"] button')]
    expect(chips[0].textContent).toMatch(/^#travel/)
    expect(document.activeElement).toBe(chips[0])
  })

  it('falls back to the first note when there is no chip either', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    within(pane(screen)).getByTitle('All notes').focus()
    // No tag left: no chips below 1025 px.
    act(() => notes$.tags.set([]))
    await narrowWindow()
    expect(screen.container.querySelector('[aria-label="Tags"]')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Plan the trip/ }))
  })

  it('leaves the focus alone when it was elsewhere', async () => {
    const screen = render(<NotesView />)
    await ready(screen)
    // The header's «New note», which stays in place across 1025 px, as the
    // search did before it moved to the top band (#344).
    const newNote = screen.getByRole('button', { name: 'New note' })
    newNote.focus()
    await narrowWindow()
    expect(document.activeElement).toBe(newNote)
  })
})
