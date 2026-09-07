//! Recognising a signed or encrypted message from its structure alone.
//!
//! Before anything is decrypted, the app has to know that there is something
//! to decrypt. That is a question about MIME, not about cryptography, and
//! keeping it separate means the reader can be told "this is encrypted, and
//! here is why it cannot be read" even when no key is present — instead of
//! being shown an attachment called `encrypted.asc` and left to work it out.
//!
//! Structure only. Nothing here says a signature is *good*: that needs keys
//! and is decided elsewhere. What this answers is what kind of thing arrived.

use der::Decode;
use mailparse::ParsedMail;

/// What protection a message carries, as its structure declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protection {
    /// Nothing: an ordinary message.
    None,
    /// RFC 3156: `multipart/encrypted` with an OpenPGP protocol parameter.
    PgpEncrypted,
    /// RFC 3156: `multipart/signed` with an OpenPGP signature part.
    PgpSigned,
    /// An OpenPGP block sitting in the text itself, the way mail was armoured
    /// before there was a MIME type for it. Still common, still readable.
    PgpInline,
    /// S/MIME: `application/pkcs7-mime; smime-type=enveloped-data` (or
    /// `authEnveloped-data`). Encrypted; needs decrypting, not verifying.
    SmimeEnveloped,
    /// S/MIME: `multipart/signed` with a PKCS#7 signature part — the content
    /// sits in the clear beside a detached signature over it.
    SmimeSigned,
    /// S/MIME: `application/pkcs7-mime; smime-type=signed-data` — "opaque"
    /// signing. The message *is* the CMS structure; the content is inside it,
    /// not beside it. Outlook signs this way by default, so this shape is not
    /// the rare one. Needs verifying, not decrypting: nothing here is secret.
    SmimeOpaqueSigned,
}

impl Protection {
    /// Whether the body is unreadable until something decrypts it.
    pub fn is_encrypted(self) -> bool {
        matches!(
            self,
            Protection::PgpEncrypted | Protection::PgpInline | Protection::SmimeEnveloped
        )
    }

    /// Whether it needs verifying rather than decrypting — the two S/MIME
    /// shapes that carry a plaintext, one beside the signature and one wrapped
    /// with it, plus everything OpenPGP already put under `claims_signature`.

    /// Whether the message claims to be signed.
    ///
    /// A claim, not a verdict. Whether the signature is any good is a
    /// different question with a different answer.
    pub fn claims_signature(self) -> bool {
        matches!(
            self,
            Protection::PgpSigned
                | Protection::SmimeSigned
                | Protection::SmimeOpaqueSigned
                | Protection::PgpInline
        )
    }

    /// The word the wire and the interface use for this.
    pub fn as_str(self) -> &'static str {
        match self {
            Protection::None => "none",
            Protection::PgpEncrypted => "pgpEncrypted",
            Protection::PgpSigned => "pgpSigned",
            Protection::PgpInline => "pgpInline",
            Protection::SmimeEnveloped => "smimeEnveloped",
            Protection::SmimeSigned => "smimeSigned",
            Protection::SmimeOpaqueSigned => "smimeOpaqueSigned",
        }
    }
}

/// The `protocol` parameter of a multipart, lower-cased.
fn protocol_of(part: &ParsedMail) -> String {
    param_of(part, "protocol")
}

/// The `smime-type` parameter of a part, lower-cased. Absent on plenty of real
/// mail — RFC 8551 says it SHOULD be present, not that it always is.
fn smime_type_of(part: &ParsedMail) -> String {
    param_of(part, "smime-type")
}

fn param_of(part: &ParsedMail, name: &str) -> String {
    part.ctype
        .params
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().trim_matches('"').to_ascii_lowercase())
        .unwrap_or_default()
}

/// The CMS `ContentType` OID inside a `pkcs7-mime` part's body, for the rare
/// message that omits `smime-type`. Cheap on purpose: this reads only the
/// outer `SEQUENCE`'s content-type field, not the (possibly large) payload
/// inside it, so a message this does not even apply to costs almost nothing.
///
/// `"1.2.840.113549.1.7.2"` is signed-data, `"...1.7.3"` is enveloped-data,
/// `"...1.7.23"` is authenticated-enveloped-data. Anything else, or a body
/// this cannot even parse as CMS, comes back empty rather than guessed at.
fn cms_content_type_oid(part: &ParsedMail) -> String {
    let Ok(body) = part.get_body_raw() else {
        return String::new();
    };
    // The body is base64 inside the message; mailparse already decoded the
    // transfer encoding via get_body_raw for a base64 part, but a part with no
    // declared encoding hands back raw bytes verbatim, which parses the same.
    let Ok(content_info) = cms::content_info::ContentInfo::from_der(&body) else {
        return String::new();
    };
    content_info.content_type.to_string()
}

/// Whether a part's own type is one of the given, ignoring case.
fn is_type(part: &ParsedMail, wanted: &[&str]) -> bool {
    let mime = part.ctype.mimetype.to_ascii_lowercase();
    wanted.iter().any(|candidate| mime == *candidate)
}

/// The armoured OpenPGP blocks that can stand in a plain-text body.
const INLINE_MARKERS: [&str; 2] = ["-----BEGIN PGP MESSAGE-----", "-----BEGIN PGP SIGNED MESSAGE-----"];

/// What protection this part declares, looking at it and its children.
///
/// The first thing found wins, outermost first: a signed message wrapped
/// around an encrypted one is encrypted as far as the reader is concerned,
/// because that is what stands between them and the words.
pub fn protection_of(part: &ParsedMail) -> Protection {
    let mime = part.ctype.mimetype.to_ascii_lowercase();
    let protocol = protocol_of(part);

    if mime == "multipart/encrypted" && protocol.contains("pgp-encrypted") {
        return Protection::PgpEncrypted;
    }
    if mime == "multipart/signed" {
        if protocol.contains("pgp-signature") {
            return Protection::PgpSigned;
        }
        if protocol.contains("pkcs7-signature") || protocol.contains("x-pkcs7-signature") {
            return Protection::SmimeSigned;
        }
        // A `multipart/signed` with no protocol parameter is still signed by
        // something; the part types say by what.
        if part.subparts.iter().any(|sub| {
            is_type(sub, &["application/pgp-signature"])
        }) {
            return Protection::PgpSigned;
        }
        if part.subparts.iter().any(|sub| {
            is_type(sub, &["application/pkcs7-signature", "application/x-pkcs7-signature"])
        }) {
            return Protection::SmimeSigned;
        }
    }
    if is_type(part, &["application/pkcs7-mime", "application/x-pkcs7-mime"]) {
        match smime_type_of(part).as_str() {
            "signed-data" => return Protection::SmimeOpaqueSigned,
            "enveloped-data" | "authenveloped-data" => return Protection::SmimeEnveloped,
            // No hint in the MIME parameters; ask the CMS structure itself
            // rather than assume the more common shape.
            _ => match cms_content_type_oid(part).as_str() {
                "1.2.840.113549.1.7.2" => return Protection::SmimeOpaqueSigned,
                "1.2.840.113549.1.7.3" | "1.2.840.113549.1.9.16.1.23" => {
                    return Protection::SmimeEnveloped
                }
                _ => {}
            },
        }
    }

    // A body armoured in the text itself, with no MIME to announce it.
    if part.subparts.is_empty() && mime.starts_with("text/") {
        if let Ok(body) = part.get_body() {
            if INLINE_MARKERS.iter().any(|marker| body.contains(marker)) {
                return Protection::PgpInline;
            }
        }
    }

    for sub in &part.subparts {
        let found = protection_of(sub);
        if found != Protection::None {
            return found;
        }
    }
    Protection::None
}

/// Whether a `multipart/encrypted` is shaped the way RFC 3156 requires.
///
/// Two parts: a control part that says the version, and the ciphertext. A
/// message claiming the protocol without them is malformed, and saying so is
/// better than handing a decryptor something that is not there.
pub fn pgp_encrypted_parts<'a>(part: &'a ParsedMail<'a>) -> Option<&'a ParsedMail<'a>> {
    if part.subparts.len() < 2 {
        return None;
    }
    if !is_type(&part.subparts[0], &["application/pgp-encrypted"]) {
        return None;
    }
    Some(&part.subparts[1])
}

/// The signed content and the detached signature of a `multipart/signed`.
///
/// The content is the first part *as it stood on the wire*: a signature is
/// over exact bytes, and a part re-serialised from a parse tree is not
/// necessarily the same bytes. Callers that verify need the raw span, which is
/// why this hands back the parsed parts and the caller slices the original.
pub fn signed_parts<'a>(part: &'a ParsedMail<'a>) -> Option<(&'a ParsedMail<'a>, &'a ParsedMail<'a>)> {
    if part.subparts.len() < 2 {
        return None;
    }
    Some((&part.subparts[0], &part.subparts[1]))
}
