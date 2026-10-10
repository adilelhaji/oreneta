import { expect, test } from 'bun:test'
import {
  canChangeMessages,
  copyBlocked,
  isReadOnlyMail,
  messageChangesBlocked,
  readOnlyTarget,
} from './mailCapabilities'
import type { Account } from '../types'

test('Graph read-only capability is explicit, never guessed from Microsoft provider', () => {
  const graph = { id: 'a@example.test', auth_type: 'graph_oauth' } as Account
  expect(isReadOnlyMail(graph)).toBe(true)
  for (const auth_type of ['password', 'outlook_oauth', 'gmail_oauth', 'rss'] as const)
    expect(isReadOnlyMail({ auth_type })).toBe(false)
  expect(readOnlyTarget([graph], 'a@example.test#INBOX#opaque')).toBe(true)
  expect(readOnlyTarget([graph], 'a@example.test.evil#INBOX#opaque')).toBe(false)
  expect(readOnlyTarget([graph], 'another@example.test')).toBe(false)
})

test('Graph message changes follow the granted permission; managing stays unsupported (#141)', () => {
  const locked = { id: 'a@example.test', auth_type: 'graph_oauth' } as Account
  const granted = { id: 'b@example.test', auth_type: 'graph_oauth', graph_writes: true } as Account
  const imap = { id: 'c@example.test', auth_type: 'password' } as Account
  const accounts = [locked, granted, imap]
  expect(messageChangesBlocked(accounts, 'a@example.test#INBOX#1')).toBe(true)
  expect(messageChangesBlocked(accounts, 'b@example.test#INBOX#1')).toBe(false)
  expect(messageChangesBlocked(accounts, 'c@example.test#INBOX#1')).toBe(false)
  // Granted changes do not make folders, sending or .eml available.
  expect(readOnlyTarget(accounts, 'b@example.test')).toBe(true)
  expect(canChangeMessages(granted)).toBe(true)
  expect(canChangeMessages(locked)).toBe(false)
  // Copy: within the granted account yes; to or from another account no.
  expect(copyBlocked(accounts, 'b@example.test#INBOX#1', 'b@example.test')).toBe(false)
  expect(copyBlocked(accounts, 'b@example.test#INBOX#1', 'c@example.test')).toBe(true)
  expect(copyBlocked(accounts, 'c@example.test#INBOX#1', 'b@example.test')).toBe(true)
  expect(copyBlocked(accounts, 'a@example.test#INBOX#1', 'a@example.test')).toBe(true)
  expect(copyBlocked(accounts, 'c@example.test#INBOX#1', 'c@example.test')).toBe(false)
})
