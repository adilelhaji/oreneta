import { describe, expect, it } from 'bun:test'
import { FOLDER_COLORS, FOLDER_COLOR_SURFACES, contrastRatio, folderColor, isFolderColorId } from './folderColors'

describe('folder color palette (ADR-0050)', () => {
  it('keeps every shade at 3:1 or more on the navigation surfaces of its theme', () => {
    for (const color of FOLDER_COLORS) {
      for (const surface of FOLDER_COLOR_SURFACES.light) {
        expect(contrastRatio(color.light, surface)).toBeGreaterThanOrEqual(3)
      }
      for (const surface of FOLDER_COLOR_SURFACES.dark) {
        expect(contrastRatio(color.dark, surface)).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('names every color for screen readers and accepts only palette ids', () => {
    const labels = FOLDER_COLORS.map((color) => color.label)
    expect(new Set(labels).size).toBe(FOLDER_COLORS.length)
    for (const color of FOLDER_COLORS) expect(color.labelKey).toBe(`folderColors.${color.id}`)
    expect(isFolderColorId('blue')).toBe(true)
    expect(isFolderColorId('#ff0000')).toBe(false)
    expect(folderColor('teal')?.label).toBe('Teal')
    expect(folderColor(undefined)).toBeUndefined()
  })

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#777777')).toBe(1)
  })
})
