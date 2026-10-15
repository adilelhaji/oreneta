import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { ConnectivityBanner } from './ConnectivityBanner'
import { AccountProxyCard, ProxySettingsSection } from '../dialog/ProxySettingsCard'
import { accounts$ } from '../../states/accounts'
import { connectivity$, setSyncError } from '../../states/connectivity'
import { ui$ } from '../../states/ui'
import i18n from '../../lib/i18n'
import type { Account } from '../../types'

const account = (id: string, proxy?: Account['proxy']) =>
  ({
    id,
    email: `${id}@example.test`,
    display_name: id === 'work' ? 'Work' : 'Home',
    provider: 'imap',
    auth_type: 'password',
    paused: false,
    proxy,
  }) as Account

// The refusals as the core writes them (meron-core/src/proxy.rs, #201).
const appRefusal =
  "sync INBOX: connect: proxy setting unusable (app): the app's proxy is incomplete (server or port missing)"
const accountRefusal =
  "sync INBOX: connect: proxy setting unusable (account): this account's proxy has an unknown type \"ftp\""

beforeEach(() => {
  i18n.changeLanguage('en')
  accounts$.set([account('work'), account('home', { mode: 'socks5', host: 'proxy.home', port: 1080 })])
  connectivity$.set({ byAccount: {}, unattributed: null })
  ui$.settingsOpen.set(false)
  ui$.accountSettingsId.set('')
  ui$.settingsFocus.set({ section: '', request: 0 })
})
afterEach(() => {
  cleanup()
  ui$.settingsOpen.set(false)
})

function openEntry(name: string) {
  const view = render(<ConnectivityBanner />)
  fireEvent.click(view.getByRole('button', { name: 'Account sync' }))
  return within(view.getByRole('listitem', { name }))
}

describe('ConnectivityBanner proxy refusals (#201)', () => {
  it('names the app proxy and opens Settings → Network when the app-wide proxy is incomplete', () => {
    setSyncError('work', appRefusal)
    const entry = openEntry('Work')
    expect(
      entry.getByText('Connections for Work are refused: the app proxy setting is incomplete or cannot be used.'),
    ).toBeTruthy()
    expect(entry.queryByText('Unresolved sync issue — recovery not verified')).toBeNull()
    expect(entry.queryByRole('button', { name: 'Account settings' })).toBeNull()

    fireEvent.click(entry.getByRole('button', { name: 'Network settings' }))
    expect(ui$.settingsOpen.peek()).toBe(true)
    expect(ui$.accountSettingsId.peek()).toBe('')
    expect(ui$.settingsFocus.peek().section).toBe('network')
  })

  it("opens that account's proxy settings when the account's own proxy is incomplete", () => {
    setSyncError('home', accountRefusal)
    const entry = openEntry('Home')
    expect(
      entry.getByText(
        "Connections for Home are refused: the account's own proxy setting is incomplete or cannot be used.",
      ),
    ).toBeTruthy()

    fireEvent.click(entry.getByRole('button', { name: 'Account proxy settings' }))
    expect(ui$.settingsOpen.peek()).toBe(true)
    expect(ui$.accountSettingsId.peek()).toBe('home')
    expect(ui$.settingsFocus.peek().section).toBe('accountNetwork')
  })

  it('reads a Microsoft Graph refusal the same way', () => {
    setSyncError('work', 'folders sync: Microsoft Graph: proxy setting unusable (app)')
    fireEvent.click(openEntry('Work').getByRole('button', { name: 'Network settings' }))
    expect(ui$.settingsFocus.peek().section).toBe('network')
  })

  it('sends a proxy that did not answer to the setting the account uses', () => {
    setSyncError('home', 'sync INBOX: connect to proxy proxy.home:1080: tcp connect: Connection refused')
    setSyncError('work', 'sync INBOX: connect to proxy 10.0.0.1:3128: tcp connect: Connection refused')
    const home = openEntry('Home')
    expect(home.getByText(/Unable to connect to proxy proxy\.home:1080/)).toBeTruthy()
    fireEvent.click(home.getByRole('button', { name: 'Account proxy settings' }))
    expect(ui$.accountSettingsId.peek()).toBe('home')
    cleanup()
    // An account that follows the app proxy is fixed in Settings → Network.
    fireEvent.click(openEntry('Work').getByRole('button', { name: 'Network settings' }))
    expect(ui$.accountSettingsId.peek()).toBe('')
    expect(ui$.settingsFocus.peek().section).toBe('network')
  })

  it('keeps the account settings for any other failure, including one that follows a proxy refusal', () => {
    setSyncError('work', appRefusal)
    setSyncError('work', 'sync INBOX: connect imap.example:993: timed out')
    const entry = openEntry('Work')
    expect(entry.getByText('Unresolved sync issue — recovery not verified')).toBeTruthy()
    expect(entry.queryByRole('button', { name: 'Network settings' })).toBeNull()
    fireEvent.click(entry.getByRole('button', { name: 'Account settings' }))
    expect(ui$.accountSettingsId.peek()).toBe('work')
    expect(ui$.settingsFocus.peek().section).toBe('account')
  })

  it('leaves an account that must sign in again to its account settings', () => {
    accounts$.set([{ ...account('work'), needs_reconnect: true }])
    setSyncError('work', appRefusal)
    const entry = openEntry('Work')
    expect(entry.queryByRole('button', { name: 'Network settings' })).toBeNull()
    expect(entry.getByRole('button', { name: 'Account settings' })).toBeTruthy()
  })
})

describe('proxy settings the banner opens', () => {
  it('are the sections the settings dialog focuses', () => {
    const app = render(<ProxySettingsSection />)
    expect(app.container.querySelector('[data-settings-section="network"]')).toBeTruthy()
    cleanup()
    const own = render(<AccountProxyCard account={account('home', { mode: 'socks5', host: 'proxy.home', port: 1080 })} />)
    expect(own.container.querySelector('[data-settings-section="accountNetwork"]')).toBeTruthy()
  })
})
