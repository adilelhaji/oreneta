import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import { people$ } from '../../states/people'
import type { Person } from '../../types'

const ana: Person = {
  id: 'carddav::src-1:c1',
  source: 'carddav',
  account: '',
  book: 'src-1',
  name: 'Ana Prat',
  organisation: 'Hospital de Mataró',
  note: 'Met at the congress.',
  photo: '',
  emails: [
    { addr: 'ana@hospital.cat', label: 'work' },
    { addr: 'ana@casa.cat', label: 'home' },
  ],
  phones: [{ number: '+34 600 000 000', label: 'cell' }],
}

const marc: Person = {
  id: 'google::google-acct:people/c2',
  source: 'google',
  account: 'acct',
  book: 'google-acct',
  name: 'Marc Roca',
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr: 'marc@example.com', label: '' }],
  phones: [],
}

beforeEach(() => {
  people$.people.set([ana, marc])
  people$.loaded.set(true)
  people$.loading.set(false)
  people$.query.set('')
  people$.selectedId.set('')
})
afterEach(cleanup)

describe('the address book as a place', () => {
  it('lists everybody with what tells them apart', () => {
    const view = render(<PeopleView />)
    expect(view.container.textContent).toContain('Ana Prat')
    expect(view.container.textContent).toContain('Hospital de Mataró')
    // Marc has no organisation, so his address stands in rather than a blank.
    expect(view.container.textContent).toContain('marc@example.com')
  })

  it('asks the reader to pick somebody before showing a card', () => {
    const view = render(<PeopleView />)
    expect(view.container.textContent).toContain('Pick someone')
  })

  it('shows every address a person has, not just the first', () => {
    people$.selectedId.set(ana.id)
    const view = render(<PeopleView />)
    expect(view.container.textContent).toContain('ana@hospital.cat')
    expect(view.container.textContent).toContain('ana@casa.cat')
    expect(view.container.textContent).toContain('work')
  })

  it('shows the phone number and the note when there are any', () => {
    people$.selectedId.set(ana.id)
    const view = render(<PeopleView />)
    expect(view.container.textContent).toContain('+34 600 000 000')
    expect(view.container.textContent).toContain('Met at the congress.')
  })

  it('leaves out the sections a person has nothing in', () => {
    people$.selectedId.set(marc.id)
    const view = render(<PeopleView />)
    expect(view.container.textContent).not.toContain('Phone')
    expect(view.container.textContent).not.toContain('Notes')
  })

  it('says where each person came from, since two books are two rows', () => {
    people$.selectedId.set(ana.id)
    const carddav = render(<PeopleView />)
    expect(carddav.container.textContent).toContain('CardDAV')
    cleanup()
    people$.selectedId.set(marc.id)
    const google = render(<PeopleView />)
    expect(google.container.textContent).toContain('Google')
  })

  it('offers a way to write to each address', () => {
    people$.selectedId.set(ana.id)
    const view = render(<PeopleView />)
    expect(view.getByLabelText('Write to ana@hospital.cat')).toBeTruthy()
    expect(view.getByLabelText('Write to ana@casa.cat')).toBeTruthy()
  })

  it('selects the person that was clicked', () => {
    const view = render(<PeopleView />)
    fireEvent.click(view.getByText('Marc Roca'))
    expect(people$.selectedId.peek()).toBe(marc.id)
  })

  it('says the book is empty differently from a search that found nobody', () => {
    people$.people.set([])
    const empty = render(<PeopleView />)
    expect(empty.container.textContent).toContain('No people yet')
    cleanup()
    people$.query.set('zzz')
    const noMatch = render(<PeopleView />)
    expect(noMatch.container.textContent).toContain('Nobody by that name')
  })
})
