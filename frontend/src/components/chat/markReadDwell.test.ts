import { describe, expect, it } from 'bun:test'
import { dwellUpdate } from './markReadDwell'

describe('how long a message has been looked at', () => {
  it('does not count a message the moment it appears', () => {
    const since = new Map<string, number>()
    const first = dwellUpdate({ onScreen: ['m1'], since, now: 1_000, delayMs: 3_000 })

    expect(first.ready).toEqual([])
    // And says when to look again, because a reader holding still produces no
    // scroll and no resize to wake this up.
    expect(first.recheckIn).toBe(3_000)
  })

  it('counts it once it has stayed', () => {
    const since = new Map<string, number>()
    dwellUpdate({ onScreen: ['m1'], since, now: 1_000, delayMs: 3_000 })

    expect(dwellUpdate({ onScreen: ['m1'], since, now: 3_500, delayMs: 3_000 }).ready).toEqual([])
    const done = dwellUpdate({ onScreen: ['m1'], since, now: 4_000, delayMs: 3_000 })
    expect(done.ready).toEqual(['m1'])
    expect(done.recheckIn).toBeNull()
  })

  it('makes a message that scrolled away start its wait again', () => {
    const since = new Map<string, number>()
    dwellUpdate({ onScreen: ['m1'], since, now: 1_000, delayMs: 3_000 })
    // Gone before its time: what it had waited does not carry over.
    dwellUpdate({ onScreen: [], since, now: 2_000, delayMs: 3_000 })

    const back = dwellUpdate({ onScreen: ['m1'], since, now: 3_000, delayMs: 3_000 })
    expect(back.ready).toEqual([])
    expect(back.recheckIn).toBe(3_000)
    expect(dwellUpdate({ onScreen: ['m1'], since, now: 6_000, delayMs: 3_000 }).ready).toEqual(['m1'])
  })

  it('asks to be woken for whichever message comes due first', () => {
    const since = new Map<string, number>()
    dwellUpdate({ onScreen: ['m1'], since, now: 0, delayMs: 3_000 })
    const both = dwellUpdate({ onScreen: ['m1', 'm2'], since, now: 2_000, delayMs: 3_000 })

    expect(both.ready).toEqual([])
    // m1 has a second left, m2 has three: the wake-up belongs to m1.
    expect(both.recheckIn).toBe(1_000)
  })

  it('reports each message as it comes due, not the whole screen at once', () => {
    const since = new Map<string, number>()
    dwellUpdate({ onScreen: ['m1'], since, now: 0, delayMs: 3_000 })
    dwellUpdate({ onScreen: ['m1', 'm2'], since, now: 2_000, delayMs: 3_000 })

    const partial = dwellUpdate({ onScreen: ['m1', 'm2'], since, now: 3_000, delayMs: 3_000 })
    expect(partial.ready).toEqual(['m1'])
    expect(partial.recheckIn).toBe(2_000)
  })

  it('counts a message at once when no wait is asked for', () => {
    const since = new Map<string, number>()
    const now = dwellUpdate({ onScreen: ['m1'], since, now: 1_000, delayMs: 0 })

    expect(now.ready).toEqual(['m1'])
    expect(now.recheckIn).toBeNull()
  })

  it('treats a nonsensical negative wait as no wait', () => {
    const since = new Map<string, number>()
    expect(dwellUpdate({ onScreen: ['m1'], since, now: 1_000, delayMs: -5_000 }).ready).toEqual(['m1'])
  })
})
