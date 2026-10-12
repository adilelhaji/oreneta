import { describe, expect, it } from 'bun:test'
import { canLoadMoreThreads } from './ui'

describe('loading more of a list (#30, #34)', () => {
  it('a filtered view pages on its cursor like any other', () => {
    for (const filters of [['unread'], ['attachments'], ['unread', 'attachments']] as const) {
      expect(canLoadMoreThreads('conv1:abc', '', [...filters] as any), filters.join(',')).toBe(true)
    }
    expect(canLoadMoreThreads('conv1:abc', '', [])).toBe(true)
  })

  it('stops without a cursor, and on the starred view, which is one page', () => {
    expect(canLoadMoreThreads('', '', [])).toBe(false)
    expect(canLoadMoreThreads('conv1:abc', '', ['starred'] as any)).toBe(false)
    // A search over the starred view is paged like any other search.
    expect(canLoadMoreThreads('conv1:abc', 'invoice', ['starred'] as any)).toBe(true)
  })
})
