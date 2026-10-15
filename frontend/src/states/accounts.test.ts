import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { accounts$, refreshAccountPictures, setAccountAvatar, setAccountSignature } from './accounts'
import type { Account } from '../types'

const account = (id: string): Account => ({
  id,
  email: `${id}@example.com`,
  display_name: id,
  provider: 'custom',
  auth_type: 'password',
  imap_host: 'imap.example.com',
  imap_port: 993,
  smtp_host: 'smtp.example.com',
  smtp_port: 465,
  tls: true,
})

describe('setAccountSignature', () => {
  let completed: string[] = []
  let gate: (() => void) | null = null
  // Which call should fail, decided per test: (payload, callIndex) => boolean.
  let failWhen: (payload: any, call: number) => boolean = () => false

  beforeEach(() => {
    completed = []
    gate = null
    failWhen = () => false
    accounts$.set([account('a'), account('b')])
    let calls = 0
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            if (command !== 'account.setSignature') return {}
            calls += 1
            const first = calls === 1
            if (first && gate) {
              await new Promise<void>((resolve) => {
                gate = resolve
              })
            }
            if (failWhen(payload, calls)) throw new Error('write failed')
            completed.push(payload.signature?.mode ?? 'cleared')
            return {}
          },
        },
      },
    }
  })

  it('lands writes for one account in the order they were made', async () => {
    // The settings card fires two in a row: the mode the user picked, then the
    // text its editor had pending. Unordered, the older content wins the race.
    gate = () => {}
    const slow = setAccountSignature('a', { mode: 'none', html: '<p>Mine</p>' })
    const fast = setAccountSignature('a', { mode: 'custom', html: '<p>Mine, edited</p>' })

    gate?.()
    gate = null
    await Promise.all([slow, fast])

    expect(completed).toEqual(['none', 'custom'])
    expect(accounts$.peek()[0].signature).toEqual({ mode: 'custom', html: '<p>Mine, edited</p>' })
  })

  it('does not roll a failed write back over a newer one that succeeded', async () => {
    gate = () => {}
    // Only the first (slow) write fails; the second one lands and must stand.
    failWhen = (_payload, call) => call === 1
    const failing = setAccountSignature('a', { mode: 'none', html: '<p>Mine</p>' })
    const succeeding = setAccountSignature('a', { mode: 'custom', html: '<p>Mine, edited</p>' })

    gate?.()
    gate = null
    await Promise.all([failing, succeeding])

    expect(accounts$.peek()[0].signature).toEqual({ mode: 'custom', html: '<p>Mine, edited</p>' })
  })

  it('falls back to what the store holds, not to a value that never reached it', async () => {
    // Old -> None (fails) -> Custom (fails). Rolling back to "what was on
    // screen when I started" would leave the UI on None, which was never saved.
    accounts$.set([{ ...account('a'), signature: { mode: 'custom', html: '<p>Old</p>' } }, account('b')])
    failWhen = () => true

    // Queued together, as the settings card does: the second must not treat the
    // first one's optimistic value as the baseline to fall back to.
    const first = setAccountSignature('a', { mode: 'none', html: '<p>Old</p>' })
    const second = setAccountSignature('a', { mode: 'custom', html: '<p>Newer</p>' })
    await Promise.all([first, second])

    expect(accounts$.peek()[0].signature).toEqual({ mode: 'custom', html: '<p>Old</p>' })
  })

  it('leaves other accounts untouched when a write fails', async () => {
    await setAccountSignature('b', { mode: 'custom', html: '<p>B</p>' })
    failWhen = (payload) => payload.id === 'a'
    await setAccountSignature('a', { mode: 'custom', html: '<p>A</p>' })

    expect(accounts$.peek()[1].signature).toEqual({ mode: 'custom', html: '<p>B</p>' })
  })
})

// An account picture is only ever a copy kept on this computer (#194).
describe('account pictures', () => {
  const bridge = (answer: (command: string, payload: any) => unknown) => {
    const calls: { command: string; payload: any }[] = []
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), answer(command, payload)),
        },
      },
    }
    return calls
  }
  afterEach(() => {
    delete (window as any).go
  })

  it('does not show a remote address while the core fetches it', async () => {
    accounts$.set([{ ...account('a'), avatar_url: '/media/avatars/a/old.png' }])
    bridge(() => ({ ok: true, pending: true }))

    expect(await setAccountAvatar('a', 'https://img.example/me.png')).toBe(true)

    expect(accounts$.peek()[0].avatar_url).toBe('/media/avatars/a/old.png')
  })

  it('shows the copy a remote picture became as soon as it is fetched', async () => {
    accounts$.set([{ ...account('a'), avatar_url: '/media/avatars/a/old.png' }, account('b')])
    bridge(() => ({ ok: true, pending: false, avatar_url: '/media/avatars/a/fetched.png' }))

    expect(await setAccountAvatar('a', 'https://img.example/me.png')).toBe(true)

    expect(accounts$.peek()[0].avatar_url).toBe('/media/avatars/a/fetched.png')
    expect(accounts$.peek()[1].avatar_url).toBe(account('b').avatar_url)
  })

  it('never shows an address the core hands back that is not a local copy', async () => {
    accounts$.set([{ ...account('a'), avatar_url: '/media/avatars/a/old.png' }])
    bridge(() => ({ ok: true, pending: false, avatar_url: 'https://img.example/me.png' }))

    await setAccountAvatar('a', 'https://img.example/me.png')

    expect(accounts$.peek()[0].avatar_url).toBe('/media/avatars/a/old.png')
  })

  it('shows a local copy at once, and the initials when it is cleared', async () => {
    accounts$.set([{ ...account('a'), avatar_url: '' }])
    bridge(() => ({ ok: true }))

    await setAccountAvatar('a', '/media/avatars/a/new.png')
    expect(accounts$.peek()[0].avatar_url).toBe('/media/avatars/a/new.png')
    await setAccountAvatar('a', '')
    expect(accounts$.peek()[0].avatar_url).toBe('')
  })

  it('takes only the pictures from the core after a retry stored a copy', async () => {
    accounts$.set([{ ...account('a'), avatar_url: '', display_name: 'Edited name' }, account('b')])
    bridge(() => ({
      accounts: [
        { ...account('a'), display_name: 'Name on disk', avatar_url: '/media/avatars/a/fetched.png' },
        account('b'),
      ],
    }))

    await refreshAccountPictures()

    expect(accounts$.peek()[0].avatar_url).toBe('/media/avatars/a/fetched.png')
    expect(accounts$.peek()[0].display_name).toBe('Edited name')
  })
})
