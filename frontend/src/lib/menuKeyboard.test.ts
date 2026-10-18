import { describe, expect, it } from 'bun:test'
import { menuKeyAction, movedIndex, typeaheadIndex, typeaheadLabel } from './menuKeyboard'

const ltr = { direction: 'ltr' as const, submenu: false, typing: false }
const rtl = { direction: 'rtl' as const, submenu: false, typing: false }

describe('what a key does in a menu (#289)', () => {
  it('moves with the vertical arrows, Home and End', () => {
    expect(menuKeyAction({ key: 'ArrowDown' }, ltr)).toEqual({ kind: 'move', to: 'next' })
    expect(menuKeyAction({ key: 'ArrowUp' }, ltr)).toEqual({ kind: 'move', to: 'previous' })
    expect(menuKeyAction({ key: 'Home' }, ltr)).toEqual({ kind: 'move', to: 'first' })
    expect(menuKeyAction({ key: 'End' }, ltr)).toEqual({ kind: 'move', to: 'last' })
  })

  it('opens a submenu with the arrow towards the end of the line, mirrored in right to left', () => {
    expect(menuKeyAction({ key: 'ArrowRight' }, ltr)).toEqual({ kind: 'open-submenu' })
    expect(menuKeyAction({ key: 'ArrowLeft' }, rtl)).toEqual({ kind: 'open-submenu' })
  })

  it('closes a submenu with the arrow towards the start, and only a submenu', () => {
    expect(menuKeyAction({ key: 'ArrowLeft' }, { ...ltr, submenu: true })).toEqual({ kind: 'close-submenu' })
    expect(menuKeyAction({ key: 'ArrowRight' }, { ...rtl, submenu: true })).toEqual({ kind: 'close-submenu' })
    expect(menuKeyAction({ key: 'ArrowLeft' }, ltr)).toEqual({ kind: 'swallow' })
    expect(menuKeyAction({ key: 'ArrowRight' }, rtl)).toEqual({ kind: 'swallow' })
  })

  it('closes on Tab, leaves Enter to the item and Escape to the Escape stack', () => {
    expect(menuKeyAction({ key: 'Tab' }, ltr)).toEqual({ kind: 'close' })
    expect(menuKeyAction({ key: 'Enter' }, ltr)).toEqual({ kind: 'swallow' })
    expect(menuKeyAction({ key: 'Escape' }, ltr)).toBeNull()
  })

  it('searches on printable characters, Space only inside a search under way', () => {
    expect(menuKeyAction({ key: 'a' }, ltr)).toEqual({ kind: 'typeahead', char: 'a' })
    expect(menuKeyAction({ key: 'ب' }, rtl)).toEqual({ kind: 'typeahead', char: 'ب' })
    expect(menuKeyAction({ key: ' ' }, ltr)).toEqual({ kind: 'swallow' })
    expect(menuKeyAction({ key: ' ' }, { ...ltr, typing: true })).toEqual({ kind: 'typeahead', char: ' ' })
  })

  it('leaves chords and other named keys alone', () => {
    expect(menuKeyAction({ key: 'a', ctrlKey: true }, ltr)).toBeNull()
    expect(menuKeyAction({ key: 'ArrowDown', altKey: true }, ltr)).toBeNull()
    expect(menuKeyAction({ key: 'k', metaKey: true }, ltr)).toBeNull()
    expect(menuKeyAction({ key: 'F5' }, ltr)).toBeNull()
  })

  it('moves a horizontal menu with the horizontal arrows in reading order', () => {
    const horizontal = { ...ltr, orientation: 'horizontal' as const }
    expect(menuKeyAction({ key: 'ArrowRight' }, horizontal)).toEqual({ kind: 'move', to: 'next' })
    expect(menuKeyAction({ key: 'ArrowLeft' }, horizontal)).toEqual({ kind: 'move', to: 'previous' })
    expect(menuKeyAction({ key: 'ArrowRight' }, { ...horizontal, direction: 'rtl' })).toEqual({
      kind: 'move',
      to: 'previous',
    })
    expect(menuKeyAction({ key: 'ArrowDown' }, horizontal)).toEqual({ kind: 'swallow' })
    expect(menuKeyAction({ key: 'Home' }, horizontal)).toEqual({ kind: 'move', to: 'first' })
  })
})

describe('moving between items', () => {
  it('wraps at both ends', () => {
    expect(movedIndex('next', 2, 3)).toBe(0)
    expect(movedIndex('previous', 0, 3)).toBe(2)
    expect(movedIndex('next', 0, 3)).toBe(1)
  })

  it('arrives at an end when no item has focus yet', () => {
    expect(movedIndex('next', -1, 3)).toBe(0)
    expect(movedIndex('previous', -1, 3)).toBe(2)
  })

  it('has nowhere to go in an empty menu', () => {
    expect(movedIndex('first', 0, 0)).toBeNull()
  })
})

describe('typeahead', () => {
  const labels = ['archive', 'apply label', 'delete', 'after', 'ب'].map(typeaheadLabel)

  it('goes to the next item starting with the character, wrapping', () => {
    expect(typeaheadIndex(labels, 0, 'd')).toBe(2)
    expect(typeaheadIndex(labels, 2, 'a')).toBe(3)
    expect(typeaheadIndex(labels, 3, 'a')).toBe(0)
  })

  it('cycles through the items when one character is typed again and again', () => {
    expect(typeaheadIndex(labels, 0, 'aa')).toBe(1)
    expect(typeaheadIndex(labels, 1, 'aaa')).toBe(3)
  })

  it('keeps the current item while a longer search still matches it', () => {
    expect(typeaheadIndex(labels, 1, 'ap')).toBe(1)
    expect(typeaheadIndex(labels, 0, 'af')).toBe(3)
  })

  it('finds non-Latin labels and nothing for a miss', () => {
    expect(typeaheadIndex(labels, 0, 'ب')).toBe(4)
    expect(typeaheadIndex(labels, 0, 'z')).toBe(-1)
    expect(typeaheadIndex([], 0, 'a')).toBe(-1)
  })

  it('compares trimmed, lower-cased labels', () => {
    expect(typeaheadLabel('  Archive ')).toBe('archive')
    expect(typeaheadLabel(null)).toBe('')
  })
})
