// S/MIME: the certificates the reader holds, and what a signature came to.
//
// The trust model is the same shape as OpenPGP's in states/pgp.ts: a
// certificate is either held here or it is not, and nothing chains to a root
// CA. See meron-core's crypto::smime module for why. Nothing here decides
// anything — the core does the cryptography, this carries the question and
// the answer.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type { SignatureResult } from './signatureVerdict'
import type { SignatureResult } from './signatureVerdict'

export type SmimeCert = {
  fingerprint: string
  subject: string
  addresses: string[]
  addedAt: number
}

export const smime$ = observable({
  certs: [] as SmimeCert[],
  loaded: false,
})

export async function loadSmimeCerts() {
  try {
    const res = await invoke<{ certs?: SmimeCert[] }>('smime.certs', {})
    smime$.certs.set(res?.certs ?? [])
    smime$.loaded.set(true)
  } catch {
    // Unreadable is not empty: showing none would invite importing again.
  }
}

/**
 * Import one certificate. `der` is the certificate's raw bytes — a `.cer`,
 * `.crt` or `.p7b` a reader was sent, or one saved out of another mail
 * client — base64-encoded for the trip over the bridge, which carries JSON
 * and has no byte-string type of its own. Returns the fingerprint.
 */
export async function importSmimeCert(der: string): Promise<string> {
  const res = await invoke<{ fingerprint: string }>('smime.import', { der })
  await loadSmimeCerts()
  return res.fingerprint
}

export async function removeSmimeCert(fingerprint: string) {
  await invoke('smime.remove', { fingerprint })
  await loadSmimeCerts()
}

/** Check one message's S/MIME signature. */
export function verifySmimeMessage(account: string, folder: string, uid: number) {
  return invoke<SignatureResult>('smime.verify', { account, folder, uid })
}

/**
 * The reader's own S/MIME identity — a certificate plus the private key it
 * needs to sign and to decrypt. Unlike a held certificate (for checking
 * someone else's signature or encrypting to them), this is what the reader
 * signs and decrypts *with*, imported once from a `.p12`/`.pfx` file.
 */
export type SmimeIdentity = {
  fingerprint: string
  subject: string
  addresses: string[]
  addedAt: number
}

export const smimeIdentities$ = observable({
  identities: [] as SmimeIdentity[],
  loaded: false,
})

export async function loadSmimeIdentities() {
  try {
    const res = await invoke<{ identities?: SmimeIdentity[] }>('smime.identities', {})
    smimeIdentities$.identities.set(res?.identities ?? [])
    smimeIdentities$.loaded.set(true)
  } catch {
    // Unreadable is not empty: showing none would invite importing again.
  }
}

/**
 * Import a PKCS#12 (`.p12`/`.pfx`) identity file. `p12` is the file's raw
 * bytes, base64-encoded for the trip over the bridge; `password` unlocks it
 * once, here — it is not kept, the way OpenPGP's passphrase is not kept
 * beyond opening the one message it was given for. Returns the fingerprint.
 */
export async function importSmimeIdentity(p12: string, password: string): Promise<string> {
  const res = await invoke<{ fingerprint: string }>('smime.importIdentity', { p12, password })
  await loadSmimeIdentities()
  return res.fingerprint
}

export async function removeSmimeIdentity(fingerprint: string) {
  await invoke('smime.removeIdentity', { fingerprint })
  await loadSmimeIdentities()
}

export type SmimeDecryptResult =
  | { ok: true; body: string; bodyHtml?: string | null }
  | { ok: false; failure: { reason: 'noKey' | 'malformed' } }

/**
 * Open one S/MIME-encrypted message. No passphrase parameter, unlike
 * OpenPGP's `decryptMessage`: the identity's private key was unlocked once,
 * at import, and lives ready-to-use in the OS keyring from then on.
 */
export function decryptSmimeMessage(account: string, folder: string, uid: number) {
  return invoke<SmimeDecryptResult>('smime.decrypt', { account, folder, uid })
}
