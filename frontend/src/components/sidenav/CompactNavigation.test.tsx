import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CompactNavigation } from './CompactNavigation'
import { ui$ } from '../../states/ui'

afterEach(() => {
  cleanup()
  ui$.module.set('mail')
})

describe('compact workspace navigation', () => {
  it('switches areas exclusively through the existing app menu', () => {
    ui$.module.set('people')
    const view = render(<CompactNavigation />)
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    fireEvent.click(view.getByRole('button', { name: 'Tasks' }))
    expect(ui$.module.peek()).toBe('tasks')
    expect(view.queryByRole('button', { name: 'Tasks' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Back to Chats' }))
    expect(ui$.module.peek()).toBe('mail')
  })

  it('Escape returns focus to the opener without changing the current area', () => {
    ui$.module.set('calendar')
    const view = render(<CompactNavigation />)
    const opener = view.getByRole('button', { name: 'More' })
    fireEvent.click(opener)
    view.getByRole('button', { name: 'People' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
    expect(ui$.module.peek()).toBe('calendar')
  })
})
