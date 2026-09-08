import type { MailSecurity } from './accountSecurity'

// A UI recommendation, not MX discovery or proof that a domain uses OAuth.
const googleDomains = new Set(['gmail.com', 'googlemail.com'])
const microsoftDomains = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com'])

export function accountSetupAddress(value: string): string | null {
  const email = value.trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return null
  return email
}

export function suggestedAccountMode(email: string): 'gmail' | 'outlook' | 'custom' {
  const domain = accountSetupAddress(email)?.split('@')[1].toLowerCase()
  if (domain && googleDomains.has(domain)) return 'gmail'
  if (domain && microsoftDomains.has(domain)) return 'outlook'
  return 'custom'
}

export function newAccountForm(email = '') {
  return {
    email,
    display_name: '',
    sender_name: '',
    imap_host: '',
    imap_host_touched: false,
    imap_port: '993',
    imap_port_touched: false,
    imap_security: 'tls' as MailSecurity,
    imap_security_touched: false,
    smtp_host: '',
    smtp_host_touched: false,
    smtp_port: '465',
    smtp_port_touched: false,
    smtp_security: 'tls' as MailSecurity,
    smtp_security_touched: false,
    username: '',
    username_touched: false,
    password: '',
    auth_code: '',
    feed_url: '',
    ews_url: '',
  }
}
