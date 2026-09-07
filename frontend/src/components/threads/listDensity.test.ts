import { describe, expect, it } from 'bun:test'
import { densityStyle } from './listDensity'
import { LIST_DENSITIES, type ListDensity } from '../../states/settings'

describe('how much room a thread-list row is given', () => {
  it('describes every density the settings offer', () => {
    for (const density of LIST_DENSITIES) {
      const style = densityStyle(density)
      expect(style.avatarSize).toBeGreaterThan(0)
      expect(style.rowPadding).not.toBe('')
    }
  })

  it('gets tighter, not looser, as it goes', () => {
    const [compact, cosy, relaxed] = LIST_DENSITIES.map(densityStyle)
    expect(compact.avatarSize).toBeLessThan(cosy.avatarSize)
    expect(cosy.avatarSize).toBeLessThan(relaxed.avatarSize)
  })

  it('puts a thread on one line only when compact', () => {
    expect(densityStyle('compact').singleLine).toBe(true)
    expect(densityStyle('cosy').singleLine).toBe(false)
    expect(densityStyle('relaxed').singleLine).toBe(false)
  })

  it('gives the preview its own line only when relaxed', () => {
    expect(densityStyle('relaxed').previewOnOwnLine).toBe(true)
    expect(densityStyle('cosy').previewOnOwnLine).toBe(false)
    // Compact has one line for everything, so a preview of its own would
    // contradict the whole point of it.
    expect(densityStyle('compact').previewOnOwnLine).toBe(false)
  })

  it('falls back to the default for a density it does not know', () => {
    // A value stored by a later version, or edited by hand: the list still
    // renders rather than collapsing to undefined measures.
    expect(densityStyle('spacious' as ListDensity)).toEqual(densityStyle('cosy'))
  })
})
