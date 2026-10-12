import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ThemeEditorDialog } from './ThemeEditorDialog'
import type { CustomTheme } from '../../lib/themes'
import { deriveThemeTokens, type CustomThemeInput } from '../../lib/themes'

afterEach(cleanup)

const themeFrom = (source: CustomThemeInput): CustomTheme => ({
  id: 'custom-test',
  name: 'Test',
  appearance: source.appearance,
  tokens: deriveThemeTokens(source),
  source,
})

describe('ThemeEditorDialog', () => {
  it('says nothing about contrast for the default palette', () => {
    const view = render(<ThemeEditorDialog appearance="light" initial={null} onClose={() => {}} />)
    expect(view.queryByText(/hard to read/)).toBeNull()
  })

  it('names unreadable text and accent, with the ratio, without blocking save', () => {
    const view = render(
      <ThemeEditorDialog
        appearance="dark"
        initial={themeFrom({
          appearance: 'dark',
          bgApp: '#101b2e',
          surface: '#152137',
          sideNav: '#0b162b',
          accent: '#3b5bdb',
          text: '#6b7280',
        })}
        onClose={() => {}}
      />,
    )
    expect(view.getByText(/The text is hard to read on these backgrounds \(\d\.\d:1/)).toBeTruthy()
    expect(view.getByText(/The accent is hard to read as text/)).toBeTruthy()
    expect((view.getByRole('button', { name: 'Save theme' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
