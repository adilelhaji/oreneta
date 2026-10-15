import { describe, expect, it } from 'bun:test'
import { connectivityAccountLabel } from './connectivityBannerHelpers'

const accounts = [
  { id: 'one', display_name: 'Ping Chen', email: 'ping.one@example.com' },
  { id: 'two', display_name: 'Ping Chen', email: 'ping.two@example.com' },
  { id: 'three', display_name: 'Ada', email: 'ada@example.com' },
]

describe('connectivityAccountLabel', () => {
  it('adds the email address when display names collide', () => {
    expect(connectivityAccountLabel('one', accounts)).toBe('Ping Chen (ping.one@example.com)')
    expect(connectivityAccountLabel('two', accounts)).toBe('Ping Chen (ping.two@example.com)')
  })

  it('keeps a unique display name concise and falls back safely', () => {
    expect(connectivityAccountLabel('three', accounts)).toBe('Ada')
    expect(connectivityAccountLabel('missing', accounts)).toBe('missing')
    expect(connectivityAccountLabel(null, accounts)).toBeNull()
  })
})
