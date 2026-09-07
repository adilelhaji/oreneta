//! Taking a built message apart and putting a protected one back together.
//!
//! RFC 3156 signs and encrypts a *MIME entity*, not a mail message. The
//! difference is the header block: `Content-Type` and its companions belong to
//! the entity and are covered by the signature; `From`, `To` and `Subject`
//! belong to the message around it and are not.
//!
//! Getting that split wrong is not a cosmetic error. Sign too much and no
//! recipient can verify, because their copy has headers the sender's did not.
//! Sign too little and the signature covers nothing anyone cares about. So the
//! split is a function of its own, with the list of what belongs to the entity
//! written down where it can be read.

/// Header fields that belong to the MIME entity rather than to the message.
///
/// Everything else — the sender, the recipients, the subject, the date, the
/// message id — stays outside, on the message that carries the entity.
const ENTITY_HEADERS: [&str; 5] = [
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
    "content-id",
    "content-description",
];

/// A message split into the part that gets protected and the part that does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitMessage {
    /// `From`, `To`, `Subject` and the rest, as written, ending in CRLF.
    pub message_headers: String,
    /// The MIME entity: its own headers, a blank line, and the body. These are
    /// the bytes a signature covers, exactly as they stand.
    pub entity: Vec<u8>,
}

/// Where the header block ends: the first empty line.
fn header_end(raw: &[u8]) -> Option<usize> {
    // CRLF is what a built message uses; bare LF is tolerated because some
    // builders and every hand-written test fixture produce it.
    for (index, window) in raw.windows(4).enumerate() {
        if window == b"\r\n\r\n" {
            return Some(index + 4);
        }
    }
    raw.windows(2).position(|window| window == b"\n\n").map(|index| index + 2)
}

/// Whether a header line starts a field belonging to the MIME entity.
fn is_entity_header(line: &str) -> bool {
    let name = line.split(':').next().unwrap_or_default().trim().to_ascii_lowercase();
    // MIME-Version belongs to the message: an entity inside one does not
    // restate it, and a recipient's parser reads it from the outside.
    ENTITY_HEADERS.contains(&name.as_str())
}

/// Split a built message into what to protect and what to carry it.
///
/// Folded continuation lines stay with the field they continue, which matters
/// because a long `Content-Type` with parameters is routinely folded and half
/// of it landing on the wrong side would corrupt both.
pub fn split_for_signing(raw: &[u8]) -> Option<SplitMessage> {
    let end = header_end(raw)?;
    let headers = std::str::from_utf8(&raw[..end]).ok()?;
    let body = &raw[end..];

    let mut message_headers = String::new();
    let mut entity_headers = String::new();
    let mut in_entity = false;

    for line in headers.split_inclusive('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let continuation = line.starts_with(' ') || line.starts_with('\t');
        if !continuation {
            in_entity = is_entity_header(line);
        }
        if in_entity {
            entity_headers.push_str(line);
        } else {
            message_headers.push_str(line);
        }
    }

    let mut entity = entity_headers.into_bytes();
    entity.extend_from_slice(b"\r\n");
    entity.extend_from_slice(body);
    Some(SplitMessage {
        message_headers,
        entity,
    })
}

/// Wrap a signed entity and its signature into an RFC 3156 message.
///
/// `micalg` names the digest, which recipients use to check the signature
/// without parsing it first. It is written as the spec requires — lower case,
/// prefixed `pgp-`.
pub fn build_signed(headers: &str, entity: &[u8], signature: &[u8], micalg: &str) -> Vec<u8> {
    let boundary = boundary("signed");
    let mut out = Vec::new();
    out.extend_from_slice(headers.as_bytes());
    out.extend_from_slice(b"MIME-Version: 1.0\r\n");
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/signed; micalg=\"pgp-{micalg}\"; \
             protocol=\"application/pgp-signature\"; boundary=\"{boundary}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    out.extend_from_slice(entity);
    out.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/pgp-signature; name=\"signature.asc\"\r\n\
          Content-Description: OpenPGP digital signature\r\n\r\n",
    );
    out.extend_from_slice(signature);
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

/// Wrap ciphertext into an RFC 3156 encrypted message.
pub fn build_encrypted(headers: &str, ciphertext: &[u8]) -> Vec<u8> {
    let boundary = boundary("encrypted");
    let mut out = Vec::new();
    out.extend_from_slice(headers.as_bytes());
    out.extend_from_slice(b"MIME-Version: 1.0\r\n");
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/encrypted; \
             protocol=\"application/pgp-encrypted\"; boundary=\"{boundary}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    out.extend_from_slice(b"Content-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n");
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\
          Content-Description: OpenPGP encrypted message\r\n\r\n",
    );
    out.extend_from_slice(ciphertext);
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

/// A boundary that cannot appear in the content it delimits.
fn boundary(kind: &str) -> String {
    format!("--=_oreneta_{kind}_{}", uuid::Uuid::new_v4().simple())
}

/// Wrap a signed entity and its detached CMS signature into an RFC 8551
/// `multipart/signed` message.
///
/// `headers` is the message-level header block (`From`, `To`, `Subject`...).
/// Pass an empty string when this is building the *content* of an outer
/// `EnvelopedData` for sign-then-encrypt rather than a standalone message —
/// the result is then a complete MIME entity with its own `MIME-Version`,
/// exactly what an enveloped message's content needs to be.
pub fn build_smime_signed(headers: &str, entity: &[u8], signature: &[u8]) -> Vec<u8> {
    let boundary = boundary("smime_signed");
    let mut out = Vec::new();
    out.extend_from_slice(headers.as_bytes());
    out.extend_from_slice(b"MIME-Version: 1.0\r\n");
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/signed; micalg=\"sha-256\"; \
             protocol=\"application/pkcs7-signature\"; boundary=\"{boundary}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    out.extend_from_slice(entity);
    out.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/pkcs7-signature; name=\"smime.p7s\"\r\n\
          Content-Transfer-Encoding: base64\r\n\
          Content-Disposition: attachment; filename=\"smime.p7s\"\r\n\r\n",
    );
    out.extend_from_slice(base64_wrapped(signature).as_bytes());
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

/// Wrap CMS `EnvelopedData` into an RFC 8551 `application/pkcs7-mime`
/// (`smime-type=enveloped-data`) message — a single part, not a multipart
/// structure, since the ciphertext is the entire body.
pub fn build_smime_enveloped(headers: &str, cms_der: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(headers.as_bytes());
    out.extend_from_slice(b"MIME-Version: 1.0\r\n");
    out.extend_from_slice(
        b"Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=\"smime.p7m\"\r\n\
          Content-Transfer-Encoding: base64\r\n\
          Content-Disposition: attachment; filename=\"smime.p7m\"\r\n\r\n",
    );
    out.extend_from_slice(base64_wrapped(cms_der).as_bytes());
    out.extend_from_slice(b"\r\n");
    out
}

/// Base64, wrapped at 76 columns with CRLF — the line length RFC 2045
/// requires, so a strict MIME parser on the receiving end does not choke on
/// one unbroken line.
fn base64_wrapped(data: &[u8]) -> String {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    encoded
        .as_bytes()
        .chunks(76)
        .map(|chunk| std::str::from_utf8(chunk).unwrap())
        .collect::<Vec<_>>()
        .join("\r\n")
}
