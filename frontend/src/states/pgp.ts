// OpenPGP: the certificates the reader holds, and what a signature came to.
//
// Public certificates only for now, which is what checking a signature needs.
// Nothing here decides anything: the core does the cryptography and this
// carries the question and the answer.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type PgpCert = {
  fingerprint: string
  userIds: string[]
  addresses: string[]
  addedAt: number
}

/**
 * What checking a message's signature concluded.
 *
 * Four answers, and they are genuinely different. `good` checked out against a
 * certificate held here. `bad` means a held certificate was used and it did
 * not check out. `noKey` means there is nothing here to check it with — a
 * statement about this app, not about the message. `malformed` means it was
 * not a signature this can read. Collapsing `noKey` into either of the first
 * two is the mistake that makes the feature worse than not having it.
 */
export type SignatureResult =
  | { verdict: 'none' }
  | { verdict: 'good'; fingerprint: string; addresses: string[]; matchesSender?: boolean }
  | { verdict: 'bad'; matchesSender?: boolean }
  | { verdict: 'noKey'; matchesSender?: boolean }
  | { verdict: 'malformed'; matchesSender?: boolean }

export const pgp$ = observable({
  certs: [] as PgpCert[],
  loaded: false,
})

export async function loadCerts() {
  try {
    const res = await invoke<{ certs?: PgpCert[] }>('pgp.certs', {})
    pgp$.certs.set(res?.certs ?? [])
    pgp$.loaded.set(true)
  } catch {
    // Unreadable is not empty: showing none would invite importing again.
  }
}

/** Import one armoured certificate. Returns its fingerprint. */
export async function importCert(armoured: string): Promise<string> {
  const res = await invoke<{ fingerprint: string }>('pgp.import', { armoured })
  await loadCerts()
  return res.fingerprint
}

export async function removeCert(fingerprint: string) {
  await invoke('pgp.remove', { fingerprint })
  await loadCerts()
}

/** Check one message's signature. */
export function verifyMessage(account: string, folder: string, uid: number) {
  return invoke<SignatureResult>('pgp.verify', { account, folder, uid })
}

/** One of the reader's own keys. */
export type PgpSecretKey = {
  fingerprint: string
  userIds: string[]
  addresses: string[]
  /** Whether opening a message with it needs a passphrase. */
  protected: boolean
  addedAt: number
}

/** Why a message could not be opened. */
export type DecryptionFailure = 'noKey' | 'needsPassphrase' | 'malformed'

export type DecryptResult =
  | { ok: true; body: string; bodyHtml?: string | null; signature?: SignatureResult | null }
  | { ok: false; failure: { reason: DecryptionFailure } }

export const secretKeys$ = observable({
  keys: [] as PgpSecretKey[],
  loaded: false,
})

export async function loadSecretKeys() {
  try {
    const res = await invoke<{ keys?: PgpSecretKey[] }>('pgp.secretKeys', {})
    secretKeys$.keys.set(res?.keys ?? [])
    secretKeys$.loaded.set(true)
  } catch {
    // Unreadable is not empty.
  }
}

export async function importSecretKey(armoured: string): Promise<{ fingerprint: string; protected: boolean }> {
  const res = await invoke<{ fingerprint: string; protected: boolean }>('pgp.importSecret', { armoured })
  await loadSecretKeys()
  return res
}

export async function removeSecretKey(fingerprint: string) {
  await invoke('pgp.removeSecret', { fingerprint })
  await loadSecretKeys()
}

/**
 * Open one encrypted message.
 *
 * The passphrase goes with the request and is not kept: it opens this message
 * and is dropped. Holding on to it would be deciding on the reader's behalf
 * that their key may as well not have one.
 */
export function decryptMessage(account: string, folder: string, uid: number, passphrase?: string) {
  return invoke<DecryptResult>('pgp.decrypt', { account, folder, uid, passphrase })
}
