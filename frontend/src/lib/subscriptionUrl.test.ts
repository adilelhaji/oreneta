import { expect, test } from 'bun:test'
import { isSubscriptionUrl } from './subscriptionUrl'

test('accepts the forms calendar links are published in', () => {
  for (const url of [
    'https://example.org/a.ics',
    'http://example.org/a.ics',
    'webcal://example.org/a.ics',
    'WEBCALS://example.org/a.ics',
    '  webcal://example.org/a.ics ',
  ])
    expect(isSubscriptionUrl(url)).toBe(true)
})

test('refuses what the core would refuse', () => {
  for (const url of ['', 'example.org/a.ics', 'file:///etc/passwd', 'ftp://example.org/a.ics', 'webcal://'])
    expect(isSubscriptionUrl(url)).toBe(false)
})
