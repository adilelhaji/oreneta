import { describe, expect, it } from 'bun:test'
import { AUTO_TABLE_MIN_WIDTH, isWideList, resolveListView } from './listView'
import { THREAD_LIST_DEFAULT_WIDTH, THREAD_LIST_WIDTH } from '../../lib/paneResize'
import type { ListView } from '../../states/settings'

describe('which renderer the thread list uses (#283)', () => {
  it('has room for the table from 520 px', () => {
    expect(isWideList(THREAD_LIST_WIDTH.min)).toBe(false)
    expect(isWideList(THREAD_LIST_DEFAULT_WIDTH)).toBe(false)
    expect(isWideList(AUTO_TABLE_MIN_WIDTH - 0.5)).toBe(false)
    expect(isWideList(AUTO_TABLE_MIN_WIDTH)).toBe(true)
    expect(isWideList(THREAD_LIST_WIDTH.max)).toBe(true)
  })

  it('draws rows in a narrow list and the table in a wide one', () => {
    expect(resolveListView('auto', isWideList(THREAD_LIST_DEFAULT_WIDTH), THREAD_LIST_DEFAULT_WIDTH)).toBe('cards')
    expect(resolveListView('auto', isWideList(THREAD_LIST_WIDTH.max), THREAD_LIST_DEFAULT_WIDTH)).toBe('table')
  })

  it('follows the drawn width over the remembered one', () => {
    // A remembered 560 px list squeezed by a narrow window to 300 px.
    expect(resolveListView('auto', isWideList(300), THREAD_LIST_WIDTH.max)).toBe('cards')
    // The whole window on a phone-sized layout.
    expect(resolveListView('auto', isWideList(760), THREAD_LIST_WIDTH.min)).toBe('table')
  })

  it('uses the remembered width until the list is measured', () => {
    expect(resolveListView('auto', null, THREAD_LIST_DEFAULT_WIDTH)).toBe('cards')
    expect(resolveListView('auto', null, THREAD_LIST_WIDTH.max)).toBe('table')
  })

  it('keeps an explicit choice whatever the width', () => {
    for (const wide of [null, false, true]) {
      for (const stored of [THREAD_LIST_WIDTH.min, THREAD_LIST_WIDTH.max]) {
        expect(resolveListView('cards', wide, stored)).toBe('cards')
        expect(resolveListView('table', wide, stored)).toBe('table')
      }
    }
  })

  it('fails loudly on a view it does not know', () => {
    // Hydration only lets known views through, so this is a programming error.
    expect(() => resolveListView('mosaic' as ListView, false, 400)).toThrow('Unknown list view')
  })

  it('switches inside the range the list can be resized to', () => {
    expect(AUTO_TABLE_MIN_WIDTH).toBeGreaterThan(THREAD_LIST_DEFAULT_WIDTH)
    expect(AUTO_TABLE_MIN_WIDTH).toBeLessThanOrEqual(THREAD_LIST_WIDTH.max)
  })
})
