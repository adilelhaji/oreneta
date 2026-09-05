//! S/MIME: reading certificates and checking CMS signatures.
//!
//! The trust model is deliberately the same shape as the OpenPGP one in
//! [`super::pgp`]: a certificate is either one the reader has chosen to hold,
//! or it is not, and nothing here builds a chain up to a root CA. That is not
//! an oversight — this codebase already has a manual trust model for
//! certificates (the TLS certificate pinning a mail server's own certificate
//! goes through), and CA-chain validation is a different, much larger feature
//! with its own hard questions (which roots, revocation, name constraints)
//! that a "does this app hold this one certificate" model sidesteps entirely
//! while still being honest: a CA-issued certificate says "some CA vouched
//! for this identity at issuance", which is a weaker claim than "the reader
//! specifically trusts mail signed with this key" — and the weaker of the two
//! is the one this reports.
//!
//! Where this genuinely differs from OpenPGP is that an S/MIME certificate
//! normally travels *inside* the message that was signed with it. A PGP
//! signature the reader holds no key for cannot be checked at all; an S/MIME
//! one almost always can be, cryptographically, whether or not the reader
//! trusts the certificate that did it. Collapsing that into OpenPGP's four
//! verdicts would either call an untrusted-but-genuine signature "good" (a
//! lie about trust) or "bad" (a lie about tampering, which cries wolf until
//! nobody reads the warning) or "no key" (which specifically means "cannot
//! even check", the one thing this case is not). So there are five verdicts
//! here, not four; see [`SignatureVerdict`].

use anyhow::{anyhow, Context, Result};
use cms::cert::CertificateChoices;
use cms::content_info::ContentInfo;
use cms::signed_data::{SignedData, SignerIdentifier, SignerInfo};
use der::asn1::OctetString;
use der::{Decode, Encode};
use rsa::pkcs1v15::Pkcs1v15Sign;
use rsa::RsaPublicKey;
use serde::Serialize;
use sha2::Digest as _;
use x509_cert::ext::pkix::SubjectAltName;
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::name::Name;
use x509_cert::Certificate;

/// What the app knows about an imported certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// Upper-case hex SHA-256 of the DER encoding. The certificate's identity
    /// for matching purposes — not a security property CAs promise, just a
    /// stable name for "this exact certificate" the way a PGP fingerprint is.
    pub fingerprint: String,
    /// The Subject as a person would read it: the Common Name if there is
    /// one, else the whole distinguished name.
    pub subject: String,
    /// Addresses this certificate speaks for, lower-cased: the Subject
    /// Alternative Name's rfc822Name entries (how modern CA-issued S/MIME
    /// certificates carry it) and the Subject DN's legacy emailAddress
    /// attribute (how older and many self-signed ones do). Both are read,
    /// because a certificate that only used the older form is not thereby
    /// not an email certificate.
    pub addresses: Vec<String>,
}

/// Read one certificate, DER or PEM.
pub fn read_cert(bytes: &[u8]) -> Result<(Certificate, CertInfo)> {
    let cert = read_cert_bytes(bytes).context("that does not look like an X.509 certificate")?;
    let info = describe(&cert);
    Ok((cert, info))
}

fn read_cert_bytes(bytes: &[u8]) -> Result<Certificate> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        if text.contains("-----BEGIN CERTIFICATE-----") {
            use der::DecodePem;
            return Certificate::from_pem(text).map_err(|error| anyhow!("{error}"));
        }
    }
    Certificate::from_der(bytes).map_err(|error| anyhow!("{error}"))
}

/// The SHA-256 fingerprint of a certificate's DER encoding, as upper-case hex.
fn fingerprint_of(cert: &Certificate) -> Result<String> {
    let der = cert.to_der().context("re-encode certificate")?;
    let digest = sha2::Sha256::digest(&der);
    Ok(digest.iter().map(|byte| format!("{byte:02X}")).collect())
}

/// The facts the app keeps about a certificate.
pub fn describe(cert: &Certificate) -> CertInfo {
    let tbs = cert.tbs_certificate();
    let mut addresses = Vec::new();

    if let Ok(Some((_critical, san))) = tbs.get_extension::<SubjectAltName>() {
        for name in san.0.iter() {
            if let GeneralName::Rfc822Name(email) = name {
                push_address(&mut addresses, email.as_str());
            }
        }
    }
    // The PKCS#9 emailAddress attribute in the Subject DN — how a
    // self-signed or older certificate carries it when there is no SAN.
    for candidate in email_attributes(tbs.subject()) {
        push_address(&mut addresses, &candidate);
    }

    CertInfo {
        fingerprint: fingerprint_of(cert).unwrap_or_default(),
        subject: subject_display(tbs.subject()),
        addresses,
    }
}

fn push_address(into: &mut Vec<String>, raw: &str) {
    let addr = raw.trim().to_lowercase();
    if !addr.is_empty() && !into.contains(&addr) {
        into.push(addr);
    }
}

/// `1.2.840.113549.1.9.1`: the PKCS#9 `emailAddress` attribute.
const OID_EMAIL_ADDRESS: &str = "1.2.840.113549.1.9.1";
/// `2.5.4.3`: the `commonName` attribute.
const OID_COMMON_NAME: &str = "2.5.4.3";

fn email_attributes(subject: &Name) -> Vec<String> {
    subject
        .iter()
        .filter(|atv| atv.oid.to_string() == OID_EMAIL_ADDRESS)
        .filter_map(|atv| attribute_string(atv))
        .collect()
}

/// Read an attribute's value as text, trying the string forms an X.501
/// attribute is realistically encoded in. Not every choice is tried — an
/// attribute that turns out to be something else entirely reads as absent
/// rather than as mangled bytes.
fn attribute_string(atv: &x509_cert::attr::AttributeTypeAndValue) -> Option<String> {
    if let Ok(value) = atv.value.decode_as::<der::asn1::Utf8StringRef>() {
        return Some(value.as_str().to_string());
    }
    if let Ok(value) = atv.value.decode_as::<der::asn1::PrintableStringRef>() {
        return Some(value.as_str().to_string());
    }
    if let Ok(value) = atv.value.decode_as::<der::asn1::Ia5StringRef>() {
        return Some(value.as_str().to_string());
    }
    None
}

/// The Subject the way a person would want to read it: the Common Name if
/// there is one, else the whole distinguished name in its usual notation.
fn subject_display(subject: &Name) -> String {
    let cn = subject
        .iter()
        .find(|atv| atv.oid.to_string() == OID_COMMON_NAME)
        .and_then(attribute_string);
    cn.unwrap_or_else(|| subject.to_string())
}

/// What checking a signature concluded.
///
/// Five verdicts, not OpenPGP's four — see the module documentation for why.
/// `ValidUntrusted` is the one that is new: the cryptography checked out
/// against the certificate embedded in the message, and that certificate is
/// not one the reader has chosen to hold. It is a real, distinct thing to say
/// — most S/MIME the reader will ever receive lands here, from a colleague
/// or a bank whose certificate was never separately imported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "verdict")]
pub enum SignatureVerdict {
    /// Checked out, and the reader holds this certificate.
    Good {
        fingerprint: String,
        addresses: Vec<String>,
    },
    /// Checked out, cryptographically, against the certificate the message
    /// itself carried. That certificate is not one the reader holds.
    ValidUntrusted {
        fingerprint: String,
        addresses: Vec<String>,
    },
    /// The content does not match the signature over it.
    Bad,
    /// Nothing here can check it: no certificate to check against — missing
    /// from the message and not held — or signed with an algorithm this does
    /// not verify yet (see [`verify_signed_data`]).
    NoKey,
    /// Not readable as CMS signed data.
    Malformed,
}

/// A whole message's signature, and whether the signer speaks for the sender.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSignature {
    #[serde(flatten)]
    pub verdict: SignatureVerdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_sender: Option<bool>,
}

/// `1.2.840.113549.1.7.2`: `id-signedData`.
const OID_SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
/// `1.2.840.113549.1.9.3` / `.1.9.4`: the `contentType` / `messageDigest`
/// signed attributes.
const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
/// `1.2.840.113549.1.1.1`: plain `rsaEncryption`, used as the signature
/// algorithm when the digest is named separately in `digestAlgorithm` — which
/// is what OpenSSL, and plenty of other generators, actually write.
const OID_RSA_ENCRYPTION: &str = "1.2.840.113549.1.1.1";

/// A digest algorithm this can verify, and the bytes computed with it.
enum Hashed {
    Sha1([u8; 20]),
    Sha256([u8; 32]),
    Sha384([u8; 48]),
    Sha512([u8; 64]),
}

impl Hashed {
    fn bytes(&self) -> &[u8] {
        match self {
            Hashed::Sha1(b) => b.as_slice(),
            Hashed::Sha256(b) => b.as_slice(),
            Hashed::Sha384(b) => b.as_slice(),
            Hashed::Sha512(b) => b.as_slice(),
        }
    }

    /// The PKCS#1 v1.5 padding scheme for this digest, DigestInfo prefix and
    /// all — generated by the `rsa`/`sha2`/`sha1` crates' own tested code
    /// rather than as a hand-copied byte constant.
    fn pkcs1v15(&self) -> Pkcs1v15Sign {
        match self {
            Hashed::Sha1(_) => Pkcs1v15Sign::new::<sha1::Sha1>(),
            Hashed::Sha256(_) => Pkcs1v15Sign::new::<sha2::Sha256>(),
            Hashed::Sha384(_) => Pkcs1v15Sign::new::<sha2::Sha384>(),
            Hashed::Sha512(_) => Pkcs1v15Sign::new::<sha2::Sha512>(),
        }
    }
}

/// Digest `data` with the algorithm the OID names, or `None` for one this
/// does not support — treated the same as holding no key for it: a statement
/// about what this app can check, not about the message.
fn hash_with(oid: &str, data: &[u8]) -> Option<Hashed> {
    match oid {
        "1.3.14.3.2.26" => Some(Hashed::Sha1(sha1::Sha1::digest(data).into())),
        "2.16.840.1.101.3.4.2.1" => Some(Hashed::Sha256(sha2::Sha256::digest(data).into())),
        "2.16.840.1.101.3.4.2.2" => Some(Hashed::Sha384(sha2::Sha384::digest(data).into())),
        "2.16.840.1.101.3.4.2.3" => Some(Hashed::Sha512(sha2::Sha512::digest(data).into())),
        _ => None,
    }
}

/// The digest algorithm implied by a combined `shaNNNWithRSAEncryption`
/// signature-algorithm OID, for the generators that write one of those
/// instead of naming `rsaEncryption` and leaving the digest to its own field.
fn digest_oid_from_combined_rsa(oid: &str) -> Option<&'static str> {
    match oid {
        "1.2.840.113549.1.1.5" => Some("1.3.14.3.2.26"),
        "1.2.840.113549.1.1.11" => Some("2.16.840.1.101.3.4.2.1"),
        "1.2.840.113549.1.1.12" => Some("2.16.840.1.101.3.4.2.2"),
        "1.2.840.113549.1.1.13" => Some("2.16.840.1.101.3.4.2.3"),
        _ => None,
    }
}

/// Whether a `SignerIdentifier` names this certificate.
fn identifies(sid: &SignerIdentifier, cert: &Certificate) -> bool {
    match sid {
        SignerIdentifier::IssuerAndSerialNumber(isn) => {
            isn.serial_number == *cert.tbs_certificate().serial_number()
                && isn.issuer == *cert.tbs_certificate().issuer()
        }
        SignerIdentifier::SubjectKeyIdentifier(ski) => {
            matches!(
                cert.tbs_certificate().get_extension::<x509_cert::ext::pkix::SubjectKeyIdentifier>(),
                Ok(Some((_, cert_ski))) if cert_ski == *ski
            )
        }
    }
}

/// Certificates embedded in a `SignedData`, as ordinary X.509 — a
/// `CertificateChoices` this cannot read (an attribute certificate, a raw
/// public key) is skipped rather than failing the whole message over a
/// shape nobody here needs.
fn embedded_certs(signed_data: &SignedData) -> Vec<Certificate> {
    let Some(set) = &signed_data.certificates else {
        return Vec::new();
    };
    set.0
        .iter()
        .filter_map(|choice| match choice {
            CertificateChoices::Certificate(cert) => Some(cert.clone()),
            _ => None,
        })
        .collect()
}

/// Verify one `SignerInfo` against the exact bytes that were signed.
///
/// `content` is the message content — the detached MIME part's raw bytes, or
/// the CMS structure's own `eContent` for opaque signing. What is actually
/// hashed and checked against the signature differs depending on whether
/// signed attributes are present, per RFC 5652 §5.4; both branches are real
/// and both are common (Thunderbird typically omits signed attributes for a
/// detached signature; Outlook's opaque signing includes them).
fn verify_signer_info(
    signer: &SignerInfo,
    content: &[u8],
    embedded: &[Certificate],
    held: &[Certificate],
) -> Result<VerifyOutcome> {
    let Some(found) = find_embedded_and_held(&signer.sid, embedded, held) else {
        return Ok(VerifyOutcome::NoCertificate);
    };
    let (signing_cert, trusted) = found;

    let digest_oid = signer.digest_alg.oid.to_string();
    let Some(content_digest) = hash_with(&digest_oid, content) else {
        return Ok(VerifyOutcome::UnsupportedAlgorithm);
    };

    let (signed_bytes, digest_ok) = match &signer.signed_attrs {
        Some(attrs) => {
            let message_digest_matches = attrs
                .iter()
                .find(|attr| attr.oid.to_string() == OID_MESSAGE_DIGEST)
                .and_then(|attr| attr.values.iter().next())
                .and_then(|value| value.decode_as::<OctetString>().ok())
                .is_some_and(|value| value.as_bytes() == content_digest.bytes());
            let der = attrs.to_der().context("re-encode signed attributes")?;
            (der, message_digest_matches)
        }
        None => (content.to_vec(), true),
    };

    if !digest_ok {
        // The content does not match what the signature covers. Tampered, or
        // corrupted in transit — either way, not what was signed.
        return Ok(VerifyOutcome::Tampered);
    }

    let signature_oid = signer.signature_algorithm.oid.to_string();
    let hashed = if signature_oid == OID_RSA_ENCRYPTION {
        // The digest to use is named separately; when signed attributes are
        // present the RSA signature is over *their* digest, computed with the
        // same algorithm, not over the content digest computed above.
        match &signer.signed_attrs {
            Some(_) => match hash_with(&digest_oid, &signed_bytes) {
                Some(hashed) => hashed,
                None => return Ok(VerifyOutcome::UnsupportedAlgorithm),
            },
            None => content_digest,
        }
    } else if let Some(implied) = digest_oid_from_combined_rsa(&signature_oid) {
        match hash_with(implied, &signed_bytes) {
            Some(hashed) => hashed,
            None => return Ok(VerifyOutcome::UnsupportedAlgorithm),
        }
    } else {
        // Not RSA at all — ECDSA and Ed25519 S/MIME certificates exist but
        // are rare in practice; this cannot check them yet. Said as such
        // rather than guessed at.
        return Ok(VerifyOutcome::UnsupportedAlgorithm);
    };

    let public_key = rsa_public_key_of(signing_cert)?;
    let signature = signer.signature.as_bytes();
    let crypto_ok = public_key
        .verify(hashed.pkcs1v15(), hashed.bytes(), signature)
        .is_ok();

    if !crypto_ok {
        return Ok(VerifyOutcome::Tampered);
    }

    let info = describe(signing_cert);
    Ok(VerifyOutcome::Verified {
        fingerprint: info.fingerprint,
        addresses: info.addresses,
        trusted,
    })
}

enum VerifyOutcome {
    Verified {
        fingerprint: String,
        addresses: Vec<String>,
        trusted: bool,
    },
    Tampered,
    NoCertificate,
    UnsupportedAlgorithm,
}

/// Like [`find_signer`], but also says whether the match came from the
/// reader's own held set — which is exactly the trust question this answers.
fn find_embedded_and_held<'a>(
    sid: &SignerIdentifier,
    embedded: &'a [Certificate],
    held: &'a [Certificate],
) -> Option<(&'a Certificate, bool)> {
    if let Some(held_cert) = held.iter().find(|cert| identifies(sid, cert)) {
        return Some((held_cert, true));
    }
    embedded.iter().find(|cert| identifies(sid, cert)).map(|cert| (cert, false))
}

fn rsa_public_key_of(cert: &Certificate) -> Result<RsaPublicKey> {
    let der = cert.tbs_certificate().subject_public_key_info().to_der()?;
    let spki = pkcs8::SubjectPublicKeyInfoRef::try_from(der.as_slice())
        .context("read the certificate's public key")?;
    RsaPublicKey::try_from(spki).context("that is not an RSA public key")
}

/// Check the signature on a whole message.
///
/// `content` is the exact bytes the signature was made over: the detached
/// part's bytes as they stood on the wire for `multipart/signed`, or the
/// CMS structure's own decoded `eContent` for opaque signing — the caller
/// supplies it because *which* bytes those are depends on the MIME shape,
/// which is a question this module does not answer (see [`super::detect`]).
pub fn verify_signed_data(
    cms_der: &[u8],
    content: Option<&[u8]>,
    held: &[Certificate],
) -> Option<MessageSignature> {
    let content_info = ContentInfo::from_der(cms_der).ok()?;
    if content_info.content_type.to_string() != OID_SIGNED_DATA {
        return None;
    }
    let signed_data: SignedData = content_info.content.decode_as().ok()?;

    // Opaque signing carries its own content; detached signing needs the
    // caller's copy. A message that claims one shape and supplies the wrong
    // kind of content cannot be checked, and says so rather than guessing.
    let embedded_content = signed_data
        .encap_content_info
        .econtent
        .as_ref()
        .and_then(|any| any.decode_as::<OctetString>().ok())
        .map(|octets| octets.into_bytes());
    let content_bytes = match (content, embedded_content) {
        (Some(bytes), _) => bytes.to_vec(),
        (None, Some(bytes)) => bytes.into_vec(),
        (None, None) => {
            return Some(MessageSignature {
                verdict: SignatureVerdict::Malformed,
                matches_sender: None,
            })
        }
    };

    let embedded = embedded_certs(&signed_data);
    let signer_infos = signed_data.signer_infos.0.as_slice();
    let Some(signer) = signer_infos.first() else {
        return Some(MessageSignature {
            verdict: SignatureVerdict::Malformed,
            matches_sender: None,
        });
    };

    let outcome = match verify_signer_info(signer, &content_bytes, &embedded, held) {
        Ok(outcome) => outcome,
        Err(_) => return Some(MessageSignature { verdict: SignatureVerdict::Malformed, matches_sender: None }),
    };

    let verdict = match outcome {
        VerifyOutcome::Verified { fingerprint, addresses, trusted: true } => {
            SignatureVerdict::Good { fingerprint, addresses }
        }
        VerifyOutcome::Verified { fingerprint, addresses, trusted: false } => {
            SignatureVerdict::ValidUntrusted { fingerprint, addresses }
        }
        VerifyOutcome::Tampered => SignatureVerdict::Bad,
        VerifyOutcome::NoCertificate | VerifyOutcome::UnsupportedAlgorithm => SignatureVerdict::NoKey,
    };
    Some(MessageSignature { matches_sender: None, verdict })
}

/// Whether the verified signer speaks for the address a message claims to be
/// from. `None` when there is no verified signer to ask about.
pub fn signer_matches_sender(verdict: &SignatureVerdict, from_addr: &str) -> Option<bool> {
    let addresses = match verdict {
        SignatureVerdict::Good { addresses, .. } | SignatureVerdict::ValidUntrusted { addresses, .. } => addresses,
        SignatureVerdict::Bad | SignatureVerdict::NoKey | SignatureVerdict::Malformed => return None,
    };
    let from = from_addr.trim().to_lowercase();
    Some(addresses.iter().any(|addr| *addr == from))
}

/// Check the signature on a whole RFC 8551 message, in whichever of the two
/// shapes it arrived in.
pub fn verify_message(raw: &[u8], held: &[Certificate]) -> Option<MessageSignature> {
    let mail = mailparse::parse_mail(raw).ok()?;
    let protection = super::detect::protection_of(&mail);

    let mut result = match protection {
        super::detect::Protection::SmimeSigned => {
            let part = find_smime_signed_part(&mail)?;
            let (content_part, signature_part) = super::detect::signed_parts(part)?;
            let signature_der = signature_part.get_body_raw().ok()?;
            verify_signed_data(&signature_der, Some(content_part.raw_bytes), held)
        }
        super::detect::Protection::SmimeOpaqueSigned => {
            let part = find_opaque_signed_part(&mail)?;
            let body = part.get_body_raw().ok()?;
            verify_signed_data(&body, None, held)
        }
        _ => None,
    }?;

    let from = {
        use mailparse::MailHeaderMap as _;
        mail.headers.get_first_value("From").unwrap_or_default()
    };
    let (_, from_addr) = crate::parse::split_address(&from);
    result.matches_sender = signer_matches_sender(&result.verdict, &from_addr);
    Some(result)
}

fn find_smime_signed_part<'a>(part: &'a mailparse::ParsedMail<'a>) -> Option<&'a mailparse::ParsedMail<'a>> {
    if super::detect::protection_of(part) == super::detect::Protection::SmimeSigned
        && part.ctype.mimetype.eq_ignore_ascii_case("multipart/signed")
    {
        return Some(part);
    }
    part.subparts.iter().find_map(find_smime_signed_part)
}

fn find_opaque_signed_part<'a>(part: &'a mailparse::ParsedMail<'a>) -> Option<&'a mailparse::ParsedMail<'a>> {
    let mime = part.ctype.mimetype.to_ascii_lowercase();
    if (mime == "application/pkcs7-mime" || mime == "application/x-pkcs7-mime")
        && super::detect::protection_of(part) == super::detect::Protection::SmimeOpaqueSigned
    {
        return Some(part);
    }
    part.subparts.iter().find_map(find_opaque_signed_part)
}

/// Parse the certificates the reader holds, skipping any this version cannot
/// read — the same reasoning as OpenPGP's `certs_from_armoured`: one
/// unreadable stored certificate must not silence every other check.
pub fn certs_from_der(stored: &[Vec<u8>]) -> Vec<Certificate> {
    stored.iter().filter_map(|der| Certificate::from_der(der).ok()).collect()
}
