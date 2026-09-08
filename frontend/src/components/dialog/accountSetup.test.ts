import { expect, test } from 'bun:test'
import { accountSetupAddress, newAccountForm, suggestedAccountMode } from './accountSetup'

test('accepts ordinary, plus-tagged, mixed-case and international addresses', () => {
  for (const email of [
    'user@example.org',
    'first.last+tag@example.co.uk',
    'USER@GMAIL.COM',
    'persona@ejemplo.es',
    '用户@例子.中国',
  ]) {
    expect(accountSetupAddress(` ${email} `)).toBe(email)
  }
})

test('rejects incomplete or ambiguous addresses before discovery', () => {
  for (const email of [
    '',
    'user',
    '@gmail.com',
    'user@',
    'user@@gmail.com',
    'user @gmail.com',
    'user@gmail..com',
    'user@.com',
    'user@gmail.com.',
    'user@localhost',
    'a'.repeat(250) + '@mail.com',
  ]) {
    expect(accountSetupAddress(email)).toBeNull()
  }
})

test('provider suggestions match exact domains, never corporate guesses or substrings', () => {
  for (const domain of ['gmail.com', 'googlemail.com']) expect(suggestedAccountMode(`user@${domain}`)).toBe('gmail')
  for (const domain of ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'])
    expect(suggestedAccountMode(`user@${domain}`)).toBe('outlook')
  expect(suggestedAccountMode(' USER@GMAIL.COM ')).toBe('gmail')
  for (const domain of ['company.com', 'gmail.com.evil.test', 'notgmail.com', 'outlook.example.org', 'outlook.es']) {
    expect(suggestedAccountMode(`user@${domain}`)).toBe('custom')
  }
})

test('a new connection starts with no credentials, pins or inherited servers', () => {
  const previous = newAccountForm('first@example.org')
  previous.password = 'synthetic secret'
  previous.imap_host = 'old.example.org'
  const next = newAccountForm('second@example.org')
  expect(next.email).toBe('second@example.org')
  expect(next.password).toBe('')
  expect(next.auth_code).toBe('')
  expect(next.imap_host).toBe('')
  expect(next.smtp_host).toBe('')
  expect(next.imap_security).toBe('tls')
  expect(next.smtp_security).toBe('tls')
})
