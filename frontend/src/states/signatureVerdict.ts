// What checking a message's signature concluded — shared between OpenPGP and
// S/MIME, since the reader-facing question is the same one either way: is
// this signed, by whom, and does that match who it says it's from.
//
// OpenPGP only ever produces four of these; S/MIME can produce a fifth. An
// S/MIME certificate normally travels inside the message it signed, so a
// signature can almost always be checked cryptographically whether or not
// the reader has chosen to trust that certificate — a distinction that does
// not exist for OpenPGP, where nothing can be checked at all without a key
// already held. `validUntrusted` says exactly that: the cryptography holds,
// the trust does not, and those are different facts.
export type SignatureResult =
  | { verdict: 'none' }
  | { verdict: 'good'; fingerprint: string; addresses: string[]; matchesSender?: boolean }
  | { verdict: 'validUntrusted'; fingerprint: string; addresses: string[]; matchesSender?: boolean }
  | { verdict: 'bad'; matchesSender?: boolean }
  | { verdict: 'noKey'; matchesSender?: boolean }
  | { verdict: 'malformed'; matchesSender?: boolean }
