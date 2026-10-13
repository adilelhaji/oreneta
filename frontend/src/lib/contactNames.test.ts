import { describe, expect, it } from 'bun:test'
import {
  formatName,
  localeNameDefaults,
  resolveDisplay,
  resolveSort,
  sanitizeNameDisplay,
  sanitizeNameSort,
  sortByName,
  sortKey,
} from './contactNames'

const ada = { name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace' }
const wang = { name: '王芳', given: '芳', family: '王' }
const whole = { name: 'María José García López' }

describe('contact name display (ADR-0052)', () => {
  it('writes a name with known parts in each order', () => {
    expect(formatName(ada, 'first_last')).toBe('Ada Lovelace')
    expect(formatName(ada, 'last_comma_first')).toBe('Lovelace, Ada')
    expect(formatName(ada, 'last_first')).toBe('Lovelace Ada')
  })

  it('writes Chinese, Japanese and Korean names family first with no space', () => {
    expect(formatName(wang, 'last_first')).toBe('王芳')
    expect(formatName(wang, 'first_last')).toBe('芳 王')
  })

  it('never splits a name the book keeps whole', () => {
    for (const display of ['first_last', 'last_comma_first', 'last_first'] as const) {
      expect(formatName(whole, display)).toBe('María José García López')
      expect(formatName({ name: 'Cher', given: 'Cher' }, display)).toBe('Cher')
    }
  })

  it('follows the language when left automatic', () => {
    expect(localeNameDefaults('en')).toEqual({ display: 'first_last', sort: 'first' })
    expect(localeNameDefaults('ja')).toEqual({ display: 'last_first', sort: 'last' })
    expect(localeNameDefaults('zh_TW')).toEqual({ display: 'last_first', sort: 'last' })
    expect(localeNameDefaults('hu-HU').display).toBe('last_first')
    expect(resolveDisplay('auto', 'ko')).toBe('last_first')
    expect(resolveDisplay('last_comma_first', 'ko')).toBe('last_comma_first')
    expect(resolveSort('auto', 'es')).toBe('first')
    expect(resolveSort('last', 'es')).toBe('last')
  })

  it('sorts by the chosen part, falling back to the whole name', () => {
    const people = [
      { name: 'Zoe Adams', given: 'Zoe', family: 'Adams' },
      { name: 'Bob Young', given: 'Bob', family: 'Young' },
      { name: 'Mallory' },
    ]
    expect(sortByName(people, 'first', 'en').map((p) => p.name)).toEqual(['Bob Young', 'Mallory', 'Zoe Adams'])
    expect(sortByName(people, 'last', 'en').map((p) => p.name)).toEqual(['Zoe Adams', 'Mallory', 'Bob Young'])
    expect(sortKey(ada, 'last')).toBe('Lovelace Ada')
    expect(sortByName(people, 'first', 'not a language!').length).toBe(3)
  })

  it('keeps only choices it offers', () => {
    expect(sanitizeNameDisplay('last_first')).toBe('last_first')
    expect(sanitizeNameDisplay('surname')).toBeNull()
    expect(sanitizeNameSort('last')).toBe('last')
    expect(sanitizeNameSort(3)).toBeNull()
  })
})
