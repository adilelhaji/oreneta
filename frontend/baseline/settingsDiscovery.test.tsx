import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import i18n from '../src/lib/i18n'
import { settingsDestinations } from '../src/lib/settingsDestinations'
import { t } from '../src/lib/i18n'
import { accounts$ } from '../src/states/accounts'
import { ui$, openCommandPalette, closeCommandPalette } from '../src/states/ui'
import { useCommandList } from '../src/components/palette/useCommandList'
import { CommandPalette } from '../src/components/palette/CommandPalette'
import { SettingsSearch } from '../src/components/dialog/SettingsSearch'
import { compose$ } from '../src/states/compose'
import { matchesCommand } from '../src/components/palette/paletteCommands'
import { createFixture } from './fixtures'

const fixture = createFixture()
beforeEach(() => {
  i18n.changeLanguage('en')
  accounts$.set([fixture.account])
  ui$.selectedAccount.set(fixture.account.id)
  ui$.selectedThread.set('')
  ui$.paletteOpen.set(false)
  ui$.settingsOpen.set(false)
  ui$.accountSettingsId.set('')
  compose$.tabs.set([])
  compose$.activeTab.set('')
})
afterEach(() => {
  cleanup()
  closeCommandPalette()
  ui$.settingsOpen.set(false)
  i18n.changeLanguage('en')
})

describe('settings and palette discovery', () => {
  it('localizes on language changes, finds Spanish and English aliases and preserves fallback', async () => {
    const { result } = renderHook(useCommandList)
    expect(result.current.find((item) => item.id === 'settings.open')?.label).toBe('Open settings')
    await act(async () => {
      await i18n.changeLanguage('es')
    })
    const command = result.current.find((item) => item.id === 'settings.open')!
    expect(command.label).toBe('Abrir ajustes')
    expect(matchesCommand(command, 'configuración')).toBe(true)
    expect(matchesCommand(command, 'open settings')).toBe(true)
    await act(async () => {
      await i18n.changeLanguage('fr')
    })
    expect(result.current.find((item) => item.id === 'settings.open')?.label).toBe('Open settings')
  })
  it('navigates to the exact account without changing mailbox selection and ignores removed accounts', () => {
    const other = { ...fixture.account, id: 'another:account', email: 'other@example.test' }
    accounts$.set([fixture.account, other])
    const { result } = renderHook(useCommandList)
    const destination = result.current.find((item) => item.id === `settings.accountSignature.${other.id}`)!
    act(() => destination.run())
    expect(ui$.accountSettingsId.peek()).toBe(other.id)
    expect(ui$.settingsFocus.peek().section).toBe('accountSignature')
    expect(ui$.selectedAccount.peek()).toBe(fixture.account.id)
    act(() => {
      accounts$.set([fixture.account])
      ui$.settingsOpen.set(false)
    })
    act(() => destination.run())
    expect(ui$.settingsOpen.peek()).toBe(false)
  })
  it('marks Graph write commands unavailable and cannot invoke stale capabilities', () => {
    const { result } = renderHook(useCommandList)
    const previous = result.current.find((item) => item.id === 'compose.new')!
    act(() => accounts$.set([{ ...fixture.account, auth_type: 'graph_oauth' }]))
    expect(result.current.find((item) => item.id === 'compose.new')?.disabled).toBe(true)
    expect(result.current.find((item) => item.id === 'mail.sync')?.disabled).toBe(false)
    act(() => {
      openCommandPalette()
      previous.run()
    })
    expect(ui$.paletteOpen.peek()).toBe(true)
  })
  it('omits account signatures for feeds and includes distinct settings destinations', () => {
    const feed = { ...fixture.account, id: 'feed', provider: 'rss' }
    const entries = settingsDestinations([feed], t)
    expect(entries.some((item) => item.accountId === 'feed' && item.section === 'accountSignature')).toBe(false)
    expect(entries.some((item) => item.accountId === 'feed' && item.section === 'account')).toBe(true)
    expect(entries.filter((item) => !item.accountId)).toHaveLength(7)
    expect(settingsDestinations([feed], t, false).some((item) => item.section === 'updates')).toBe(false)
  })
  it('can compose from another sendable account while viewing Graph, but rejects a stale capability', () => {
    const sendable = { ...fixture.account, id: 'sendable' }
    accounts$.set([{ ...fixture.account, auth_type: 'graph_oauth' }, sendable])
    const { result } = renderHook(useCommandList)
    const command = result.current.find((item) => item.id === 'compose.new')!
    expect(command.disabled).toBe(false)
    act(() => command.run())
    expect(compose$.tabs.peek()[0].compose?.accountId).toBe(sendable.id)
    act(() => {
      compose$.tabs.set([])
      accounts$.set([{ ...fixture.account, auth_type: 'graph_oauth' }])
      command.run()
    })
    expect(compose$.tabs.peek()).toHaveLength(0)
  })
  it('does not activate destinations while an IME composition is being confirmed', () => {
    accounts$.set([{ ...fixture.account, display_name: '日本語' }])
    const palette = render(<CommandPalette />)
    act(() => openCommandPalette())
    const input = palette.getByRole('combobox')
    fireEvent.change(input, { target: { value: '日本語' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(ui$.settingsOpen.peek()).toBe(false)
    expect(ui$.paletteOpen.peek()).toBe(true)
    palette.unmount()
    const search = render(<SettingsSearch />).getByRole('combobox')
    fireEvent.change(search, { target: { value: '日本語' } })
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(ui$.settingsOpen.peek()).toBe(false)
    expect((search as HTMLInputElement).value).toBe('日本語')
    fireEvent.keyDown(search, { key: 'Enter', keyCode: 229 })
    expect(ui$.settingsOpen.peek()).toBe(false)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(ui$.accountSettingsId.peek()).toBe(fixture.account.id)
    expect(ui$.settingsOpen.peek()).toBe(true)
  })
  it('restores focus on Escape, exposes active results and announces an empty query result', async () => {
    const view = render(
      <>
        <button onClick={openCommandPalette}>Open commands</button>
        <CommandPalette />
      </>,
    )
    const opener = view.getByRole('button', { name: 'Open commands' })
    opener.focus()
    fireEvent.click(opener)
    const input = view.getByRole('combobox')
    input.focus()
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    fireEvent.change(input, { target: { value: '日本語' } })
    expect(view.queryAllByRole('option')).toHaveLength(0)
    expect(view.getByRole('status').textContent).toBe('No matching commands.')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(ui$.paletteOpen.peek()).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })
})
