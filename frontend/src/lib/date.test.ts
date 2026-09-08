import { afterEach, beforeEach, describe, expect, it, type Mock, setSystemTime, spyOn } from 'bun:test'
import { formatThreadDate } from './date'

// Fixed reference: Wednesday 2026-06-10 15:30 local time.
const NOW = new Date(2026, 5, 10, 15, 30, 0)

// Epoch seconds for a local Date.
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

beforeEach(() => {
  setSystemTime(NOW)
})

afterEach(() => {
  setSystemTime()
})

describe('formatThreadDate', () => {
  let dateFormat: Mock<Date['toLocaleDateString']>
  let timeFormat: Mock<Date['toLocaleTimeString']>

  beforeEach(() => {
    dateFormat = spyOn(Date.prototype, 'toLocaleDateString')
    timeFormat = spyOn(Date.prototype, 'toLocaleTimeString')
  })

  afterEach(() => {
    dateFormat.mockRestore()
    timeFormat.mockRestore()
  })

  it('returns empty for unknown (0)', () => {
    expect(formatThreadDate(0)).toBe('')
    expect(dateFormat).not.toHaveBeenCalled()
    expect(timeFormat).not.toHaveBeenCalled()
  })

  it.each([0, 9, 23])('formats same-day hour %i using the host locale and 24-hour time', (hour) => {
    const date = new Date(2026, 5, 10, hour, 5)
    const options = { hour: '2-digit', minute: '2-digit', hour12: false } as const
    const expected = date.toLocaleTimeString([], options)
    timeFormat.mockClear()
    expect(formatThreadDate(sec(date))).toBe(expected)
    expect(timeFormat.mock.calls).toEqual([[[], options]])
    expect(dateFormat).not.toHaveBeenCalled()
  })

  it.each([
    ['yesterday', new Date(2026, 5, 9, 9), false],
    ['earlier this week', new Date(2026, 5, 8, 9), false],
    ['older this year', new Date(2026, 4, 1, 9), false],
    ['later this year', new Date(2026, 11, 31, 9), false],
    ['prior year', new Date(2025, 11, 31, 9), true],
    ['next year', new Date(2027, 0, 1, 9), true],
  ] as const)('formats %s with the appropriate date fields in the host locale', (_name, date, includeYear) => {
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    if (includeYear) options.year = 'numeric'
    const expected = date.toLocaleDateString([], options)
    dateFormat.mockClear()
    expect(formatThreadDate(sec(date))).toBe(expected)
    expect(dateFormat.mock.calls).toEqual([[[], options]])
    expect(timeFormat).not.toHaveBeenCalled()
  })
})
