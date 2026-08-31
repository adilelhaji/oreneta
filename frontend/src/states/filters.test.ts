import { describe, expect, it } from 'bun:test'
import { filterKey, nextFilters, parseFilters, type FilterFacet } from './ui'

describe('narrowing the list by more than one thing', () => {
  it('joins a set the same way whatever order it was built in', () => {
    // Sorted, so asking for the same two facets either way round is one view
    // and therefore one cache key, not two.
    expect(filterKey(['unread', 'starred'])).toBe('starred,unread')
    expect(filterKey(['starred', 'unread'])).toBe('starred,unread')
    expect(filterKey([])).toBe('all')
  })

  it('turns a facet on and off again', () => {
    expect(nextFilters([], 'unread')).toEqual(['unread'])
    expect(nextFilters(['unread'], 'unread')).toEqual([])
    expect(nextFilters(['unread'], 'starred')).toEqual(['unread', 'starred'])
  })

  it('keeps what is set aside apart from the rest', () => {
    // They answer different questions: one reads what has been put away, the
    // others narrow what is in front of you. A list claiming to be both would
    // be neither.
    expect(nextFilters(['unread', 'starred'], 'snoozed')).toEqual(['snoozed'])
    expect(nextFilters(['snoozed'], 'unread')).toEqual(['unread'])
    expect(nextFilters(['snoozed'], 'snoozed')).toEqual([])
  })

  it('reads back what an earlier version stored', () => {
    // Earlier versions kept a single name. Nobody's last view is lost to an
    // upgrade.
    expect(parseFilters('unread')).toEqual(['unread'])
    expect(parseFilters('all')).toEqual([])
    expect(parseFilters('')).toEqual([])
  })

  it('reads back a stored set', () => {
    expect(parseFilters(['unread', 'starred'])).toEqual(['unread', 'starred'])
    expect(parseFilters('starred,unread')).toEqual(['starred', 'unread'])
  })

  it('keeps the default rather than honouring a name it does not know', () => {
    // A facet from a later version must not leave the reader with a filter
    // the app cannot apply, nor an empty list nobody asked for.
    expect(parseFilters('nonsense')).toBeUndefined()
    expect(parseFilters(['nonsense' as FilterFacet])).toBeUndefined()
    expect(parseFilters(42)).toBeUndefined()
    // A set that is partly known keeps the part it knows.
    expect(parseFilters('unread,nonsense')).toEqual(['unread'])
  })

  it('narrows to what carries an attachment, alongside anything else', () => {
    expect(parseFilters('attachments')).toEqual(['attachments'])
    expect(nextFilters(['unread'], 'attachments')).toEqual(['unread', 'attachments'])
    expect(filterKey(['attachments', 'unread'])).toBe('attachments,unread')
  })
})
