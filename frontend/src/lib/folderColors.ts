// Folder colors (ADR-0050): a small fixed palette, each with a name a screen
// reader can say and a shade per theme. Every shade keeps at least 3:1 against
// the navigation surfaces it sits on (resting, hover and current row), the
// WCAG 1.4.11 bar for a non-text mark; folderColors.test.ts checks it.

export type FolderColorId = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray'

export type FolderColor = {
  id: FolderColorId
  /** i18n key and English name. */
  labelKey: string
  label: string
  light: string
  dark: string
}

export const FOLDER_COLORS: readonly FolderColor[] = [
  { id: 'red', labelKey: 'folderColors.red', label: 'Red', light: '#c62828', dark: '#ff8a80' },
  { id: 'orange', labelKey: 'folderColors.orange', label: 'Orange', light: '#b45309', dark: '#ffb366' },
  { id: 'yellow', labelKey: 'folderColors.yellow', label: 'Yellow', light: '#8a6a00', dark: '#ffd54f' },
  { id: 'green', labelKey: 'folderColors.green', label: 'Green', light: '#2e7d32', dark: '#81c784' },
  { id: 'teal', labelKey: 'folderColors.teal', label: 'Teal', light: '#00796b', dark: '#4dd0c4' },
  { id: 'blue', labelKey: 'folderColors.blue', label: 'Blue', light: '#1d5fd1', dark: '#8ab4ff' },
  { id: 'purple', labelKey: 'folderColors.purple', label: 'Purple', light: '#7b3fbf', dark: '#c9a2ff' },
  { id: 'pink', labelKey: 'folderColors.pink', label: 'Pink', light: '#b8306f', dark: '#ff8cc6' },
  { id: 'gray', labelKey: 'folderColors.gray', label: 'Gray', light: '#5f6b7a', dark: '#b0bccb' },
]

/** The navigation surfaces a dot is drawn on, per theme (index.css tokens). */
export const FOLDER_COLOR_SURFACES = {
  light: ['#fbfcfe', '#edf2fa', '#e7eefb'],
  dark: ['#152137', '#22314c', '#253a5c'],
} as const

export function isFolderColorId(value: unknown): value is FolderColorId {
  return typeof value === 'string' && FOLDER_COLORS.some((color) => color.id === value)
}

export function folderColor(id: FolderColorId | null | undefined): FolderColor | undefined {
  return id ? FOLDER_COLORS.find((color) => color.id === id) : undefined
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const raw = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(raw.slice(at, at + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
