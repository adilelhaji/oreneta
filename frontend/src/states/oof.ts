// Out-of-office / Automatic Replies. What shape the settings take depends
// entirely on the account's protocol — see meron-core's oof.get/oof.set for
// why: an Exchange account's settings live on the server (reliable even
// when Oreneta is closed); a plain IMAP/SMTP account has no server-side
// equivalent, so this app keeps its own preference and can only send the
// auto-reply itself, while it is running.

import { invoke } from '../lib/bridge'

/** A plain IMAP/SMTP account's own out-of-office preference. */
export type ImapOofSettings = {
  enabled: boolean
  /** Unix seconds; 0 means "no start date", i.e. active immediately. */
  startAt: number
  /** Unix seconds; 0 means "no end date", i.e. stays on until turned off. */
  endAt: number
  subject: string
  body: string
}

/** An Exchange account's real, server-side Automatic Replies. */
export type EwsOofSettings = {
  state: 'disabled' | 'enabled' | 'scheduled'
  externalAudience: 'none' | 'known' | 'all'
  /** Unix seconds; meaningful only when `state` is `'scheduled'`. */
  startAt: number
  endAt: number
  internalReply: string
  externalReply: string
}

export type OofResult = { kind: 'imap'; settings: ImapOofSettings } | { kind: 'ews'; settings: EwsOofSettings }

export function getOof(account: string): Promise<OofResult> {
  return invoke<OofResult>('oof.get', { account })
}

export async function setImapOof(account: string, settings: ImapOofSettings): Promise<void> {
  await invoke('oof.set', { account, settings })
}

export async function setEwsOof(account: string, settings: EwsOofSettings): Promise<void> {
  await invoke('oof.set', { account, settings })
}
