import { afterEach, expect, it } from 'bun:test'
import { currentProfile, profileKey } from './profile'

afterEach(() => document.querySelectorAll('meta[name="oreneta-profile"]').forEach((meta) => meta.remove()))

function setProfile(value: string) {
  const meta = document.createElement('meta')
  meta.name = 'oreneta-profile'
  meta.content = value
  document.head.appendChild(meta)
}

it('the default profile keeps the storage keys every install already has', () => {
  expect(currentProfile()).toBe('default')
  expect(profileKey('meron-compose-tabs')).toBe('meron-compose-tabs')
})

it('another profile keeps its own keys, so open drafts never cross profiles', () => {
  setProfile('work')
  expect(currentProfile()).toBe('work')
  expect(profileKey('meron-compose-tabs')).toBe('meron-compose-tabs@profile:work')
  expect(profileKey('meron-compose-tabs', 'home')).not.toBe(profileKey('meron-compose-tabs'))
})

it('a malformed profile in the page falls back to the default one', () => {
  setProfile('../x')
  expect(currentProfile()).toBe('default')
})
