import { describe, expect, it } from 'bun:test'
import { AUTO_TABLE_MIN_WIDTH, resolveListView } from './listView'
import { THREAD_LIST_DEFAULT_WIDTH, THREAD_LIST_WIDTH } from '../../lib/paneResize'
import type { ListView } from '../../states/settings'

describe('which renderer the thread list uses (#283)', () => {
  it('draws rows in a narrow list and the table in a wide one', () => {
    expect(resolveListView('auto', THREAD_LIST_WIDTH.min, THREAD_LIST_DEFAULT_WIDTH)).toBe('cards')
    expect(resolveListView('auto', THREAD_LIST_DEFAULT_WIDTH, THREAD_LIST_DEFAULT_WIDTH)).toBe('cards')
    expect(resolveListView('auto', AUTO_TABLE_MIN_WIDTH - 0.5, THREAD_LIST_DEFAULT_WIDTH)).toBe('cards')
    expect(resolveListView('auto', AUTO_TABLE_MIN_WIDTH, THREAD_LIST_DEFAULT_WIDTH)).toBe('table')
    expect(resolveListView('auto', THREAD_LIST_WIDTH.max, THREAD_LIST_DEFAULT_WIDTH)).toBe('table')
  })

  it('follows the drawn width over the remembered one', () => {
    // A remembered 560 px list squeezed by a narrow window to 300 px.
    expect(resolveListView('auto', 300, THREAD_LIST_WIDTH.max)).toBe('cards')
    // The whole window on a phone-sized layout.
    expect(resolveListView('auto', 760, THREAD_LIST_WIDTH.min)).toBe('table')
  })

  it('uses the remembered width until the list is measured', () => {
    expect(resolveListView('auto', 0, THREAD_LIST_DEFAULT_WIDTH)).toBe('cards')
    expect(resolveListView('auto', 0, THREAD_LIST_WIDTH.max)).toBe('table')
  })

  it('keeps an explicit choice whatever the width', () => {
    for (const width of [0, THREAD_LIST_WIDTH.min, AUTO_TABLE_MIN_WIDTH, THREAD_LIST_WIDTH.max]) {
      expect(resolveListView('cards', width, width)).toBe('cards')
      expect(resolveListView('table', width, width)).toBe('table')
    }
  })

  it('fails loudly on a view it does not know', () => {
    // Hydration only lets known views through, so this is a programming error.
    expect(() => resolveListView('mosaic' as ListView, 400, 400)).toThrow('Unknown list view')
  })

  it('switches inside the range the list can be resized to', () => {
    expect(AUTO_TABLE_MIN_WIDTH).toBeGreaterThan(THREAD_LIST_DEFAULT_WIDTH)
    expect(AUTO_TABLE_MIN_WIDTH).toBeLessThanOrEqual(THREAD_LIST_WIDTH.max)
  })
})
