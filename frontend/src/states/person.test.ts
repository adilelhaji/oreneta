import { afterEach, describe, expect, it } from 'bun:test'
import type { Account, Person } from '../types'
import {
  chooseForContact,
  historyAccounts,
  person$,
  resolvePersonPanel,
  showParticipantHistory,
  type PersonPanelInput,
} from './person'
import { ui$ } from './ui'

// Who the sidebar's Persona panel is about (ADR-0069 §4, #363): the open
// conversation's person in mail, the selected contact in Persones, nobody
// elsewhere; always one account, and nothing chosen by itself.

const work = { id: 'work', email: 'me@work.test', display_name: 'Work' } as Account
const home = { id: 'home', email: 'me@home.test', display_name: 'Home' } as Account
const feeds = { id: 'rss:feeds', email: '', display_name: 'Feeds', provider: 'rss', auth_type: 'rss' } as Account
const accounts = [work, home, feeds]

const me = { name: 'me@work.test', email: 'me@work.test', isSelf: true }
const ana = { name: 'Ana', email: 'ana@x.test', isSelf: false }
const bea = { name: 'Bea', email: 'bea@x.test', isSelf: false }

const contact = (patch: Partial<Person>): Person => ({
  id: 'carddav::src-1:c1',
  source: 'carddav',
  account: '',
  book: 'src-1',
  name: 'Ana Prat',
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr: 'ana@x.test', label: '' }],
  phones: [],
  ...patch,
})

const mail = (participants: (typeof ana)[], patch: Partial<PersonPanelInput> = {}): PersonPanelInput => ({
  module: 'mail',
  conversation: { thread: 'work#INBOX#t1', account: 'work', loading: false, participants },
  participant: null,
  contact: null,
  choice: null,
  accounts,
  ...patch,
})

const people = (selected: Person | null, patch: Partial<PersonPanelInput> = {}): PersonPanelInput => ({
  module: 'people',
  conversation: null,
  participant: null,
  contact: selected,
  choice: null,
  accounts,
  ...patch,
})

afterEach(() => {
  person$.set({ participant: null, contact: null })
  ui$.sidebarSection.set('overview')
  ui$.sidebarSection.set('agenda')
})

describe('in mail', () => {
  it("is the conversation's one other person, in the conversation's account", () => {
    expect(resolvePersonPanel(mail([ana, me]))).toEqual({
      kind: 'history',
      thread: 'work#INBOX#t1',
      account: 'work',
      address: 'ana@x.test',
      name: 'Ana',
      back: false,
    })
  })

  it('lists the people who are not one of your accounts when there are several, and picks nobody', () => {
    expect(resolvePersonPanel(mail([ana, bea, me]))).toEqual({
      kind: 'participants',
      thread: 'work#INBOX#t1',
      account: 'work',
      participants: [ana, bea],
    })
  })

  it('shows the one picked in this conversation and account, with the way back to the list', () => {
    const pick = { thread: 'work#INBOX#t1', account: 'work', address: 'BEA@x.test ', name: 'Bea' }
    expect(resolvePersonPanel(mail([ana, bea, me], { participant: pick }))).toMatchObject({
      kind: 'history',
      account: 'work',
      address: 'bea@x.test',
      back: true,
    })
    // A pick made in another conversation, or in the same thread of another
    // account, is not this one's.
    for (const other of [
      { ...pick, thread: 'work#INBOX#t2' },
      { ...pick, account: 'home' },
    ]) {
      expect(resolvePersonPanel(mail([ana, bea, me], { participant: other })).kind).toBe('participants')
    }
    // Nor is someone who is not in the conversation at all.
    const stranger = { ...pick, address: 'zoe@x.test' }
    expect(resolvePersonPanel(mail([ana, bea, me], { participant: stranger })).kind).toBe('participants')
  })

  it('says when nobody else is in the conversation, and waits while its messages are still another one', () => {
    expect(resolvePersonPanel(mail([me]))).toEqual({ kind: 'nobody' })
    const loading = mail([ana, me])
    loading.conversation = { ...loading.conversation!, loading: true }
    expect(resolvePersonPanel(loading)).toEqual({ kind: 'loading' })
  })

  it('asks for a conversation when none is open', () => {
    expect(resolvePersonPanel(mail([], { conversation: null }))).toEqual({ kind: 'empty', where: 'mail' })
  })
})

describe('in Persones', () => {
  it("reads the history in the account of the contact's address book", () => {
    expect(resolvePersonPanel(people(contact({ account: 'home', source: 'google' })))).toMatchObject({
      kind: 'contact',
      addresses: ['ana@x.test'],
      address: 'ana@x.test',
      accounts: null,
      account: 'home',
    })
  })

  it('asks for an account when the book is nobody’s, and never picks one by itself', () => {
    const local = contact({ account: '', source: 'local', book: 'local' })
    // Even with one account to choose from, and feeds left out.
    for (const offered of [accounts, [work]]) {
      expect(resolvePersonPanel(people(local, { accounts: offered }))).toMatchObject({
        kind: 'contact',
        accounts: historyAccounts(offered),
        account: '',
      })
    }
    expect(historyAccounts(accounts)).toEqual([work, home])
    // An account no longer here is nobody's too.
    expect(resolvePersonPanel(people(contact({ account: 'gone' })))).toMatchObject({
      accounts: [work, home],
      account: '',
    })
    // Once chosen, for this contact only.
    const chosen = { contact: local.id, account: 'home' }
    expect(resolvePersonPanel(people(local, { choice: chosen }))).toMatchObject({ account: 'home' })
    expect(resolvePersonPanel(people({ ...local, id: 'other' }, { choice: chosen }))).toMatchObject({ account: '' })
  })

  it('asks which address when the contact has several, and says when it has none', () => {
    const several = contact({
      account: 'work',
      emails: [
        { addr: 'ana@x.test', label: 'work' },
        { addr: 'ANA@x.test', label: '' },
        { addr: 'ana@casa.test', label: 'home' },
      ],
    })
    expect(resolvePersonPanel(people(several))).toMatchObject({
      addresses: ['ana@x.test', 'ana@casa.test'],
      address: '',
      account: 'work',
    })
    expect(
      resolvePersonPanel(people(several, { choice: { contact: several.id, address: 'ana@casa.test' } })),
    ).toMatchObject({
      address: 'ana@casa.test',
    })
    const none = contact({ emails: [] })
    expect(resolvePersonPanel(people(none))).toEqual({ kind: 'noAddress', contact: none })
  })

  it('asks for a contact when none is selected', () => {
    expect(resolvePersonPanel(people(null))).toEqual({ kind: 'empty', where: 'people' })
  })
})

describe('elsewhere', () => {
  it('is nobody in the other modules, whatever mail or Persones had', () => {
    for (const module of ['calendar', 'tasks', 'notes', 'chat', 'attachments'] as const) {
      expect(resolvePersonPanel({ ...mail([ana, me]), module, contact: contact({}) })).toEqual({
        kind: 'empty',
        where: 'elsewhere',
      })
    }
  })
})

describe('what is held', () => {
  it('keeps a choice per contact, the address and the account together', () => {
    chooseForContact('c1', { address: 'ana@x.test' })
    chooseForContact('c1', { account: 'home' })
    expect(person$.contact.get()).toEqual({ contact: 'c1', address: 'ana@x.test', account: 'home' })
    // Another contact starts with nothing chosen.
    chooseForContact('c2', { account: 'work' })
    expect(person$.contact.get()).toEqual({ contact: 'c2', account: 'work' })
  })

  it('opens the Persona panel on a participant, remembering the panel, not the person', () => {
    showParticipantHistory({ thread: 't1', account: 'work', address: 'ana@x.test', name: 'Ana' })
    expect(person$.participant.get()).toEqual({ thread: 't1', account: 'work', address: 'ana@x.test', name: 'Ana' })
    expect(ui$.sidebarSection.get()).toBe('person')
  })
})
