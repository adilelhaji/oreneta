import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CompactNavigation } from './CompactNavigation'
import { ui$ } from '../../states/ui'

afterEach(() => {
  cleanup()
  ui$.peopleOpen.set(false)
  ui$.tasksOpen.set(false)
  ui$.calendarOpen.set(false)
})

describe('compact workspace navigation', () => {
  it('switches areas exclusively through the existing app menu', () => {
    ui$.peopleOpen.set(true)
    const view = render(<CompactNavigation />)
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    fireEvent.click(view.getByRole('button', { name: 'Tasks' }))
    expect(ui$.tasksOpen.peek()).toBe(true)
    expect(ui$.peopleOpen.peek()).toBe(false)
    expect(ui$.calendarOpen.peek()).toBe(false)
    expect(view.queryByRole('button', { name: 'Tasks' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Back to Chats' }))
    expect(ui$.tasksOpen.peek()).toBe(false)
  })

  it('Escape returns focus to the opener without changing the current area', () => {
    ui$.calendarOpen.set(true)
    const view = render(<CompactNavigation />)
    const opener = view.getByRole('button', { name: 'More' })
    fireEvent.click(opener)
    view.getByRole('button', { name: 'People' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
    expect(ui$.calendarOpen.peek()).toBe(true)
  })
})
