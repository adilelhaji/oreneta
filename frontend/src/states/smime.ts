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
