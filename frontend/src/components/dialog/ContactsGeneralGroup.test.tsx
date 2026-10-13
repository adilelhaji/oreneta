import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ContactsGeneralGroup } from './ContactsGeneralGroup'
import { settings$ } from '../../states/settings'

afterEach(() => {
  cleanup()
  settings$.contactNameDisplay.set('auto')
  settings$.contactNameSort.set('auto')
})

describe('Contacts → General (SET-19, ADR-0052)', () => {
  it('offers each name order by example and stores the choice', () => {
    const view = render(<ContactsGeneralGroup />)
    const display = view.getByLabelText('Display names as') as HTMLSelectElement
    const labels = Array.from(display.options).map((option) => option.textContent)
    expect(labels).toEqual(['As the language does (Ada Lovelace)', 'Ada Lovelace', 'Lovelace, Ada', 'Lovelace Ada'])
    fireEvent.change(display, { target: { value: 'last_comma_first' } })
    expect(settings$.contactNameDisplay.get()).toBe('last_comma_first')
    fireEvent.change(view.getByLabelText('Sort contacts by'), { target: { value: 'last' } })
    expect(settings$.contactNameSort.get()).toBe('last')
  })
})
