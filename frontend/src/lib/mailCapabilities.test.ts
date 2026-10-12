import { expect, test } from 'bun:test'
import {
  canChangeMessages,
  canExportMail,
  canSendFrom,
  copyBlocked,
  isReadOnlyMail,
  keepsServerDrafts,
  messageChangesBlocked,
  readOnlyTarget,
  sendBlocked,
} from './mailCapabilities'
import { isSendableAccount } from '../states/accounts'
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

test('Graph sends only with Mail.Send granted and never keeps server drafts (#143)', () => {
  const sender = { id: 's@example.test', auth_type: 'graph_oauth', graph_send: true } as Account
  const reader = { id: 'r@example.test', auth_type: 'graph_oauth', graph_writes: true } as Account
  const imap = { id: 'i@example.test', auth_type: 'password' } as Account
  expect([sender, reader, imap].map(canSendFrom)).toEqual([true, false, true])
  expect(sendBlocked([sender, reader, imap], 'r@example.test#INBOX#1')).toBe(true)
  expect(sendBlocked([sender, reader, imap], 's@example.test#INBOX#1')).toBe(false)
  expect([sender, imap].map(keepsServerDrafts)).toEqual([false, true])
  expect(isSendableAccount(sender)).toBe(true)
  expect(isSendableAccount(reader)).toBe(false)
  expect(isSendableAccount({ ...sender, needs_reconnect: true })).toBe(false)
})

test('folders export as .mbox only where the original messages can be read (#112)', () => {
  expect(canExportMail({ auth_type: 'password' })).toBe(true)
  expect(canExportMail({ auth_type: 'gmail_oauth' })).toBe(true)
  expect(canExportMail({ auth_type: 'local_archive' })).toBe(true)
  expect(canExportMail({ auth_type: 'graph_oauth' })).toBe(false)
  expect(canExportMail({ auth_type: 'outlook_oauth', ews_url: 'https://ex.example.test/EWS/Exchange.asmx' })).toBe(
    false,
  )
  expect(canExportMail({ auth_type: 'rss' })).toBe(false)
  expect(canExportMail(undefined)).toBe(false)
})
