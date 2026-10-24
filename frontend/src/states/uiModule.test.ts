import { afterEach, describe, expect, it } from 'bun:test'
import { APP_MODULES, toggleModule, ui$ } from './ui'

// One value for the module on screen (ADR-0068 §1). That the app starts in
// mail is read in the production entry (startup.e2e.ts, #306): other test files
// share this state.
describe('the module on screen', () => {
  afterEach(() => ui$.module.set('mail'))

  it('names the seven modules of the frame', () => {
    expect([...APP_MODULES]).toEqual(['mail', 'calendar', 'people', 'tasks', 'notes', 'chat', 'attachments'])
  })

  it('opens a module from its button in the module switcher, and the same button goes back to mail', () => {
    ui$.module.set('mail')
    toggleModule('calendar')
    expect(ui$.module.peek()).toBe('calendar')
    toggleModule('calendar')
    expect(ui$.module.peek()).toBe('mail')
  })

  it('moves from one module straight to another: never two at once', () => {
    ui$.module.set('mail')
    toggleModule('people')
    toggleModule('tasks')
    expect(ui$.module.peek()).toBe('tasks')
    toggleModule('people')
    expect(ui$.module.peek()).toBe('people')
  })

  it('leaves mail on screen when its own button is pressed there', () => {
    ui$.module.set('mail')
    toggleModule('mail')
    expect(ui$.module.peek()).toBe('mail')
  })
})
