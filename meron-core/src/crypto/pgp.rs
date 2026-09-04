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

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

use sequoia_openpgp::crypto::Password;

/// What the reader's own key is, as far as the app needs to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeyInfo {
    pub fingerprint: String,
    pub user_ids: Vec<String>,
    pub addresses: Vec<String>,
    /// Whether the key material is protected by a passphrase.
    ///
    /// Stored rather than rediscovered, and shown, because a reader whose
    /// exported key turned out to be unprotected should be told rather than
    /// quietly accommodated.
    pub protected: bool,
}

/// Read an armoured secret key.
///
/// Refuses a certificate that carries no secret part: importing a public key
/// where a secret one was meant would leave the reader believing they can
/// decrypt, and finding out from a message that will not open.
pub fn read_secret_key(armoured: &str) -> Result<(Cert, SecretKeyInfo)> {
    let cert = Cert::from_reader(Cursor::new(armoured.as_bytes()))
        .context("that does not look like an OpenPGP key")?;
    if !cert.is_tsk() {
        return Err(anyhow!(
            "that is a public certificate, not a secret key — it can check signatures but not decrypt"
        ));
    }
    let info = describe(&cert);
    // Protected if any secret key in it is encrypted. A key where some parts
    // are protected and some are not is protected: the reader will be asked.
    let protected = cert
        .keys()
        .secret()
        .any(|key| !key.key().has_unencrypted_secret());
    Ok((
        cert,
        SecretKeyInfo {
            fingerprint: info.fingerprint,
            user_ids: info.user_ids,
            addresses: info.addresses,
            protected,
        },
    ))
}

/// Why a message could not be decrypted, in words the reader can act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub enum DecryptionFailure {
    /// None of the reader's keys can open it. It was encrypted to somebody
    /// else, or to a key of theirs they have not imported.
    NoKey,
    /// A key that could open it is here, and the passphrase was wrong or absent.
    NeedsPassphrase,
    /// It was not readable as an encrypted message at all.
    Malformed,
}

struct DecryptHelper<'a> {
    keys: &'a [Cert],
    password: Option<Password>,
    policy: &'a StandardPolicy<'a>,
    /// Set when a key that could have opened it was found, so a failure can
    /// tell "wrong passphrase" from "not for you".
    saw_own_key: bool,
    /// Set when the thing turned out to be an encrypted message at all.
    ///
    /// This is what tells "no key for this" from "that was not encrypted
    /// mail" — a fact about the input rather than a guess from the wording of
    /// an error, which changes between library versions.
    saw_ciphertext: bool,
    signature: Option<SignatureVerdict>,
}

impl VerificationHelper for &mut DecryptHelper<'_> {
    fn get_certs(&mut self, _ids: &[sequoia_openpgp::KeyHandle]) -> Result<Vec<Cert>> {
        Ok(self.keys.to_vec())
    }

    fn check(&mut self, structure: MessageStructure) -> Result<()> {
        for layer in structure.into_iter() {
            if let MessageLayer::SignatureGroup { results } = layer {
                for result in results {
                    match result {
                        Ok(good) => {
                            let info = describe(good.ka.cert());
                            self.signature = Some(SignatureVerdict::Good {
                                fingerprint: info.fingerprint,
                                addresses: info.addresses,
                            });
                            return Ok(());
                        }
                        Err(VerificationError::MissingKey { .. })
                        | Err(VerificationError::UnboundKey { .. }) => {
                            self.signature.get_or_insert(SignatureVerdict::NoKey);
                        }
                        Err(_) => {
                            self.signature = Some(SignatureVerdict::Bad);
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

impl DecryptionHelper for &mut DecryptHelper<'_> {
    fn decrypt(
        &mut self,
        pkesks: &[sequoia_openpgp::packet::PKESK],
        skesks: &[sequoia_openpgp::packet::SKESK],
        sym_algo: Option<sequoia_openpgp::types::SymmetricAlgorithm>,
        decrypt: &mut dyn FnMut(
            Option<sequoia_openpgp::types::SymmetricAlgorithm>,
            &sequoia_openpgp::crypto::SessionKey,
        ) -> bool,
    ) -> Result<Option<Cert>> {
        self.saw_ciphertext = !pkesks.is_empty() || !skesks.is_empty();
        for pkesk in pkesks {
            for cert in self.keys {
                for ka in cert
                    .keys()
                    .secret()
                    .with_policy(self.policy, None)
                    .for_transport_encryption()
                    .for_storage_encryption()
                {
                    if Some(&ka.key().keyid()) != pkesk.recipient().map(|id| id.into()).as_ref()
                        && pkesk.recipient().is_some()
                    {
                        continue;
                    }
                    // A key of the reader's that this message was encrypted to.
                    // Noted before trying, so a wrong passphrase is told apart
                    // from a message that was never for them.
                    self.saw_own_key = true;
                    let mut key = ka.key().clone();
                    if !key.has_unencrypted_secret() {
                        let Some(password) = &self.password else {
                            continue;
                        };
                        key = match key.decrypt_secret(password) {
                            Ok(key) => key,
                            Err(_) => continue,
                        };
                    }
                    let Ok(mut pair) = key.into_keypair() else {
                        continue;
                    };
                    if pkesk
                        .decrypt(&mut pair, sym_algo)
                        .map(|(algo, session_key)| decrypt(algo, &session_key))
                        .unwrap_or(false)
                    {
                        return Ok(Some(cert.clone()));
                    }
                }
            }
        }
        Err(anyhow!("no key could open this message"))
    }
}

/// What decrypting a message produced.
#[derive(Debug, Clone)]
pub struct Decrypted {
    /// The plaintext, which for RFC 3156 is a whole MIME part.
    pub content: Vec<u8>,
    /// The signature inside the encrypted part, when there was one. Mail is
    /// commonly signed *and* encrypted, and the signature inside is the one
    /// that means anything — an attacker can strip an outer one.
    pub signature: Option<SignatureVerdict>,
}

/// Decrypt an OpenPGP message with the reader's keys.
pub fn decrypt(
    ciphertext: &[u8],
    keys: &[Cert],
    passphrase: Option<&str>,
) -> std::result::Result<Decrypted, DecryptionFailure> {
    let policy = StandardPolicy::new();
    let mut helper = DecryptHelper {
        keys,
        password: passphrase.map(Password::from),
        policy: &policy,
        saw_own_key: false,
        saw_ciphertext: false,
        signature: None,
    };

    let mut content = Vec::new();
    let outcome = DecryptorBuilder::from_bytes(ciphertext)
        .and_then(|builder| builder.with_policy(&policy, None, &mut helper))
        .and_then(|mut decryptor| {
            std::io::copy(&mut decryptor, &mut content)?;
            Ok(())
        });

    match outcome {
        Ok(()) => Ok(Decrypted {
            content,
            signature: helper.signature,
        }),
        // A key of ours was there and still nothing opened: the passphrase is
        // wrong or missing.
        Err(_) if helper.saw_own_key => Err(DecryptionFailure::NeedsPassphrase),
        // It was an encrypted message; just not one for any key here.
        Err(_) if helper.saw_ciphertext => Err(DecryptionFailure::NoKey),
        // It never got as far as being an encrypted message. Said as such, so
        // the reader is not sent hunting for a key they were never missing.
        Err(_) => Err(DecryptionFailure::Malformed),
    }
}

/// An encrypted message, opened.
#[derive(Debug, Clone)]
pub struct OpenedMessage {
    /// The plain-text body, ready to read.
    pub body: String,
    /// Its HTML, when the message inside had any.
    pub body_html: Option<String>,
    /// The signature that was *inside* the encryption, when there was one.
    ///
    /// The inner one is the one that means anything: an outer signature can be
    /// stripped and replaced by anyone who can re-send the ciphertext, while
    /// one inside was made by whoever could also read the plaintext.
    pub signature: Option<SignatureVerdict>,
}

/// Open one encrypted mail message and read the MIME part inside it.
///
/// Handles both shapes real mail uses: the RFC 3156 `multipart/encrypted`, and
/// an armoured block sitting in a plain-text body.
pub fn decrypt_message(
    raw: &[u8],
    keys: &[Cert],
    passphrase: Option<&str>,
) -> std::result::Result<OpenedMessage, DecryptionFailure> {
    let mail = mailparse::parse_mail(raw).map_err(|_| DecryptionFailure::Malformed)?;
    let (ciphertext, shape) = find_ciphertext(&mail).ok_or(DecryptionFailure::Malformed)?;
    let opened = decrypt(&ciphertext, keys, passphrase)?;

    // The two shapes produce different things and must not be read the same
    // way. RFC 3156 encrypts a whole MIME part, headers and all. An inline
    // block encrypts text — and parsing text as MIME reads the first lines as
    // headers and leaves the body empty, which is how a decrypted message
    // comes out blank.
    match shape {
        Shape::Mime => {
            let inner = crate::parse::parse_message(&opened.content, None);
            Ok(OpenedMessage {
                body: inner.body,
                body_html: inner.body_html,
                signature: opened.signature,
            })
        }
        Shape::Text => Ok(OpenedMessage {
            body: String::from_utf8_lossy(&opened.content).to_string(),
            body_html: None,
            signature: opened.signature,
        }),
    }
}

/// What the plaintext will be once it is out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// A whole MIME part, as RFC 3156 encrypts.
    Mime,
    /// Text, as an armoured block in a body encrypts.
    Text,
}

/// The bytes to decrypt, wherever in the message they are, and what they will
/// turn out to be.
fn find_ciphertext(part: &mailparse::ParsedMail) -> Option<(Vec<u8>, Shape)> {
    match super::detect::protection_of(part) {
        super::detect::Protection::PgpEncrypted => {
            let encrypted = find_encrypted_part(part)?;
            let bytes = super::detect::pgp_encrypted_parts(encrypted)?.get_body_raw().ok()?;
            Some((bytes, Shape::Mime))
        }
        super::detect::Protection::PgpInline => {
            let body = find_inline_block(part)?;
            Some((body.into_bytes(), Shape::Text))
        }
        _ => None,
    }
}

fn find_encrypted_part<'a>(
    part: &'a mailparse::ParsedMail<'a>,
) -> Option<&'a mailparse::ParsedMail<'a>> {
    if part.ctype.mimetype.eq_ignore_ascii_case("multipart/encrypted") {
        return Some(part);
    }
    part.subparts.iter().find_map(find_encrypted_part)
}

/// The armoured block out of a plain-text body, without the words around it.
fn find_inline_block(part: &mailparse::ParsedMail) -> Option<String> {
    if part.subparts.is_empty() {
        let body = part.get_body().ok()?;
        if let Some(start) = body.find("-----BEGIN PGP MESSAGE-----") {
            let end = body[start..].find("-----END PGP MESSAGE-----")?;
            let stop = start + end + "-----END PGP MESSAGE-----".len();
            return Some(body[start..stop].to_string());
        }
        return None;
    }
    part.subparts.iter().find_map(find_inline_block)
}
