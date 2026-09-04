//! OpenPGP: reading certificates and checking signatures.
//!
//! Two jobs, and only two for now. Turning an armoured certificate somebody
//! imported into the facts the app needs about it, and deciding whether a
//! detached signature over some bytes was really made by a key the reader
//! holds.
//!
//! The verdicts are the important part of this file. There are four possible
//! answers and they are genuinely different: the signature checked out, the
//! signature did not check out, there is no key here to check it with, and the
//! thing was not a signature at all. Collapsing "unknown" into either "good"
//! or "bad" is the mistake that makes this feature worse than not having it —
//! one hides a forgery, the other cries wolf until nobody reads the warning.

use std::io::Cursor;

use anyhow::{anyhow, Context, Result};
use sequoia_openpgp::cert::prelude::*;
use sequoia_openpgp::parse::stream::*;
use sequoia_openpgp::parse::Parse;
use sequoia_openpgp::policy::StandardPolicy;
use sequoia_openpgp::Cert;
use serde::Serialize;

/// What the app knows about an imported certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// Upper-case hex, no spaces. The certificate's identity.
    pub fingerprint: String,
    /// The user IDs as written, for showing to a person.
    pub user_ids: Vec<String>,
    /// Just the addresses out of those, lower-cased, for matching a sender.
    pub addresses: Vec<String>,
}

/// Read one armoured certificate.
///
/// A file holding several is refused rather than half-imported: "I imported
/// your key" when three arrived and one was kept is a lie about what the
/// reader now trusts.
pub fn read_cert(armoured: &str) -> Result<(Cert, CertInfo)> {
    let cert = Cert::from_reader(Cursor::new(armoured.as_bytes()))
        .context("that does not look like an OpenPGP certificate")?;
    let info = describe(&cert);
    Ok((cert, info))
}

/// The facts the app keeps about a certificate.
pub fn describe(cert: &Cert) -> CertInfo {
    let mut user_ids = Vec::new();
    let mut addresses = Vec::new();
    for uid in cert.userids() {
        let text = String::from_utf8_lossy(uid.userid().value()).to_string();
        if !text.trim().is_empty() {
            user_ids.push(text);
        }
        if let Ok(Some(addr)) = uid.userid().email_normalized() {
            let addr = addr.to_lowercase();
            if !addresses.contains(&addr) {
                addresses.push(addr);
            }
        }
    }
    CertInfo {
        fingerprint: cert.fingerprint().to_hex(),
        user_ids,
        addresses,
    }
}

/// What checking a signature concluded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "verdict")]
pub enum SignatureVerdict {
    /// It checked out against a certificate the reader holds.
    Good {
        /// The certificate that made it.
        fingerprint: String,
        /// The addresses that certificate speaks for.
        addresses: Vec<String>,
    },
    /// A certificate the reader holds was used, and it did not check out.
    /// Either the message was altered or it was not signed by that key.
    Bad,
    /// Nothing here can check it. Not a verdict on the message: a statement
    /// about what this app has.
    NoKey,
    /// It was not a signature, or not one this can read.
    Malformed,
}

/// Collects what the verification told us, since Sequoia reports it through a
/// callback rather than a return value.
struct Helper<'a> {
    certs: &'a [Cert],
    outcome: Option<SignatureVerdict>,
}

impl VerificationHelper for &mut Helper<'_> {
    fn get_certs(&mut self, _ids: &[sequoia_openpgp::KeyHandle]) -> Result<Vec<Cert>> {
        // Everything the reader holds. Narrowing by key id first would be an
        // optimisation, and the sets involved are small.
        Ok(self.certs.to_vec())
    }

    fn check(&mut self, structure: MessageStructure) -> Result<()> {
        for layer in structure.into_iter() {
            let MessageLayer::SignatureGroup { results } = layer else {
                continue;
            };
            // The first conclusive answer wins. A message signed twice, once
            // by a key we hold and once by one we do not, is signed by the one
            // we could check.
            for result in results {
                match result {
                    Ok(good) => {
                        let info = describe(good.ka.cert());
                        self.outcome = Some(SignatureVerdict::Good {
                            fingerprint: info.fingerprint,
                            addresses: info.addresses,
                        });
                        return Ok(());
                    }
                    Err(VerificationError::MissingKey { .. })
                    | Err(VerificationError::UnboundKey { .. }) => {
                        // Nothing here can check it; keep looking in case
                        // another signature can be.
                        self.outcome.get_or_insert(SignatureVerdict::NoKey);
                    }
                    Err(_) => {
                        // A key we hold was used and the check failed. That is
                        // the alarming case and it outranks "unknown".
                        self.outcome = Some(SignatureVerdict::Bad);
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }
}

/// Check a detached signature over exactly these bytes.
///
/// The bytes matter: a signature is over what was sent, byte for byte, which
/// for a MIME message means the part as it stood on the wire and not a
/// re-serialisation of a parse tree.
pub fn verify_detached(signature: &[u8], signed: &[u8], certs: &[Cert]) -> SignatureVerdict {
    if certs.is_empty() {
        // Said without trying: with nothing to check against, "bad" would be
        // a lie and "good" would be worse.
        return SignatureVerdict::NoKey;
    }
    let policy = StandardPolicy::new();
    let mut helper = Helper {
        certs,
        outcome: None,
    };
    let verifier = DetachedVerifierBuilder::from_bytes(signature)
        .and_then(|builder| builder.with_policy(&policy, None, &mut helper));
    match verifier {
        Ok(mut verifier) => {
            if verifier.verify_bytes(signed).is_err() && helper.outcome.is_none() {
                return SignatureVerdict::Malformed;
            }
        }
        Err(_) => return SignatureVerdict::Malformed,
    }
    helper.outcome.unwrap_or(SignatureVerdict::Malformed)
}

/// Parse the certificates the reader holds, skipping any that no longer read.
///
/// A stored certificate that this version cannot parse is left out rather than
/// failing the whole check: one unreadable key must not stop the others from
/// answering.
pub fn certs_from_armoured(stored: &[String]) -> Vec<Cert> {
    stored
        .iter()
        .filter_map(|armoured| Cert::from_reader(Cursor::new(armoured.as_bytes())).ok())
        .collect()
}

/// Whether a verified signer speaks for the address a message claims to be from.
///
/// A good signature from the wrong person is the attack this catches: the
/// cryptography is impeccable and the message is still not from who it says.
pub fn signer_matches_sender(verdict: &SignatureVerdict, from_addr: &str) -> Result<bool> {
    let SignatureVerdict::Good { addresses, .. } = verdict else {
        return Err(anyhow!("no verified signer"));
    };
    let from = from_addr.trim().to_lowercase();
    Ok(addresses.iter().any(|addr| *addr == from))
}

/// What a whole message's signature came to, with who it says it is from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSignature {
    #[serde(flatten)]
    pub verdict: SignatureVerdict,
    /// Whether the verified signer speaks for the address the message claims
    /// to be from. `None` when there is no verified signer to ask about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_sender: Option<bool>,
}

/// Check the signature on a whole RFC 3156 message.
///
/// The signed bytes are the first part exactly as it stood on the wire —
/// headers, blank line, body — because that is what was signed. Taking the
/// parsed body and re-serialising it would produce something that is usually
/// the same and occasionally not, and "occasionally not" in a signature check
/// means telling somebody their mail was tampered with when it was not.
///
/// `None` when the message carries no PGP signature to check.
pub fn verify_message(raw: &[u8], certs: &[Cert]) -> Option<MessageSignature> {
    let mail = mailparse::parse_mail(raw).ok()?;
    let signed_part = find_signed_part(&mail)?;
    let (content, signature) = super::detect::signed_parts(signed_part)?;

    let signature_bytes = signature.get_body_raw().ok()?;
    let verdict = verify_detached(&signature_bytes, content.raw_bytes, certs);

    let from = {
        use mailparse::MailHeaderMap as _;
        mail.headers.get_first_value("From").unwrap_or_default()
    };
    let (_, from_addr) = crate::parse::split_address(&from);
    Some(MessageSignature {
        matches_sender: signer_matches_sender(&verdict, &from_addr).ok(),
        verdict,
    })
}

/// The `multipart/signed` part of a message, wherever it sits.
fn find_signed_part<'a>(
    part: &'a mailparse::ParsedMail<'a>,
) -> Option<&'a mailparse::ParsedMail<'a>> {
    if super::detect::protection_of(part) == super::detect::Protection::PgpSigned
        && part.ctype.mimetype.eq_ignore_ascii_case("multipart/signed")
    {
        return Some(part);
    }
    part.subparts.iter().find_map(find_signed_part)
}
