import { describe, expect, it } from 'bun:test'
import { bubbleMaxWidth, readingMeasure } from './readingWidth'
import { READING_WIDTHS, type ReadingWidth } from '../../states/settings'

describe('how wide a message body may run', () => {
  it('caps every width except the one that means "do not"', () => {
    for (const width of READING_WIDTHS) {
      const measure = readingMeasure(width)
      if (width === 'full') expect(measure).toBeNull()
      else expect(measure).toMatch(/^\d+ch$/)
    }
  })

  it('lets a wide reading run wider than a comfortable one', () => {
    const ch = (value: string | null) => Number((value ?? '0').replace('ch', ''))
    expect(ch(readingMeasure('wide'))).toBeGreaterThan(ch(readingMeasure('comfortable')))
  })

  it('holds a bubble to whichever is narrower, its share or the measure', () => {
    expect(bubbleMaxWidth('comfortable', '70%')).toBe('min(70%, 72ch)')
  })

  it('leaves a bubble its share alone when no measure is asked for', () => {
    expect(bubbleMaxWidth('full', '70%')).toBe('70%')
  })

  it('falls back to a readable measure for a width it does not know', () => {
    expect(readingMeasure('gigantic' as ReadingWidth)).toBe(readingMeasure('comfortable'))
  })
})
