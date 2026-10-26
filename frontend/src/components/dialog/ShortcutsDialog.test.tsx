import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, within } from '@testing-library/react'
import i18n, { supportedI18nLanguages, t } from '../../lib/i18n'
import { messages } from '../../generated/locales'
import { SHORTCUT_GROUPS, SHORTCUT_IDS, SHORTCUT_LABELS, shortcutLabel } from '../../lib/shortcuts'
import { ui$ } from '../../states/ui'
import { ShortcutsDialog } from './ShortcutsDialog'

beforeEach(() => {
  ui$.shortcutsOpen.set(true)
})

afterEach(async () => {
  cleanup()
  ui$.shortcutsOpen.set(false)
  await i18n.changeLanguage('en')
})

describe('shortcut names', () => {
  it('has a label key and a group key for every shortcut in every catalog', () => {
    const keys = [...new Set(Object.values(SHORTCUT_LABELS)), ...SHORTCUT_GROUPS.map((g) => g.titleKey)]
    expect(Object.keys(SHORTCUT_LABELS).sort()).toEqual([...SHORTCUT_IDS].sort())
    for (const language of supportedI18nLanguages) {
      for (const key of keys) expect((messages as any)[language][key]).toBeTruthy()
    }
  })

  it('resolves in the interface language, at call time', async () => {
    await i18n.changeLanguage('en')
    expect(shortcutLabel(t, 'thread.archive')).toBe('Archive thread')
    expect(shortcutLabel(t, 'view.rail3')).toBe('Go to item 3 of “Accounts and folders”')
    await i18n.changeLanguage('ca')
    expect(shortcutLabel(t, 'thread.archive')).toBe('Arxiva la conversa')
    expect(shortcutLabel(t, 'view.rail3')).toBe("Ves a l'element 3 de «Comptes i carpetes»")
    expect(t('shortcuts.group.rail')).toBe('Comptes i carpetes')
  })

  it('does not copy English into the other catalogs', () => {
    const english = (messages as any).en
    for (const language of ['ca', 'es', 'fr', 'de', 'ja']) {
      expect((messages as any)[language]['shortcuts.label.pane.next']).not.toBe(english['shortcuts.label.pane.next'])
    }
  })
})

describe('ShortcutsDialog', () => {
  it('shows group titles and labels in English and in Catalan', async () => {
    await i18n.changeLanguage('en')
    const english = render(<ShortcutsDialog />)
    expect(english.getByRole('heading', { name: 'Accounts and folders' })).toBeTruthy()
    expect(english.getByText('Archive thread')).toBeTruthy()
    expect(english.getByText('Go to item 1 of “Accounts and folders”')).toBeTruthy()
    cleanup()

    await i18n.changeLanguage('ca')
    const catalan = render(<ShortcutsDialog />)
    const headings = catalan.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['General', 'Converses', 'Correu', 'Visualització', 'Comptes i carpetes'])
    expect(catalan.getByText('Arxiva la conversa')).toBeTruthy()
    expect(catalan.queryByText('Archive thread')).toBeNull()
    expect(within(document.body).queryByText('Accounts and folders')).toBeNull()
  })

  it('follows a language change while open', async () => {
    await i18n.changeLanguage('en')
    const screen = render(<ShortcutsDialog />)
    expect(screen.getByText('Next region')).toBeTruthy()
    await act(async () => {
      await i18n.changeLanguage('ca')
    })
    expect(screen.getByText('Regió següent')).toBeTruthy()
  })
})
