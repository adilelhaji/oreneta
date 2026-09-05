use mailparse::parse_mail;

use super::detect::*;

fn protection(raw: &str) -> Protection {
    protection_of(&parse_mail(raw.as_bytes()).unwrap())
}

const PGP_ENCRYPTED: &str = "From: ana@example.com\r
Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=b\r
\r
--b\r
Content-Type: application/pgp-encrypted\r
\r
Version: 1\r
--b\r
Content-Type: application/octet-stream\r
\r
-----BEGIN PGP MESSAGE-----\r
abcd\r
-----END PGP MESSAGE-----\r
--b--\r
";

const PGP_SIGNED: &str = "From: ana@example.com\r
Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; micalg=pgp-sha256; boundary=b\r
\r
--b\r
Content-Type: text/plain\r
\r
Hello\r
--b\r
Content-Type: application/pgp-signature\r
\r
-----BEGIN PGP SIGNATURE-----\r
abcd\r
-----END PGP SIGNATURE-----\r
--b--\r
";

#[test]
fn recognises_a_pgp_encrypted_message() {
    assert_eq!(protection(PGP_ENCRYPTED), Protection::PgpEncrypted);
    assert!(protection(PGP_ENCRYPTED).is_encrypted());
}

#[test]
fn recognises_a_pgp_signed_message() {
    assert_eq!(protection(PGP_SIGNED), Protection::PgpSigned);
    assert!(!protection(PGP_SIGNED).is_encrypted());
    assert!(protection(PGP_SIGNED).claims_signature());
}

#[test]
fn the_quotes_and_the_case_of_the_protocol_make_no_difference() {
    let unquoted = PGP_ENCRYPTED.replace("\"application/pgp-encrypted\"", "Application/PGP-Encrypted");
    assert_eq!(protection(&unquoted), Protection::PgpEncrypted);
}

#[test]
fn a_multipart_signed_without_a_protocol_is_read_from_its_parts() {
    let bare = PGP_SIGNED.replace("; protocol=\"application/pgp-signature\"", "");
    assert_eq!(protection(&bare), Protection::PgpSigned);
}

const SMIME_OPAQUE_SIGNED_BODY: &str = "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\r
/ttJuoeqzAzL/25A\r\n";

#[test]
fn recognises_smime_enveloped_data() {
    let enveloped = "Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\r\n\r\nMIIB\r\n";
    assert_eq!(protection(enveloped), Protection::SmimeEnveloped);
    assert!(protection(enveloped).is_encrypted());
    assert!(!protection(enveloped).claims_signature());
}

#[test]
fn recognises_smime_detached_signed_data() {
    let signed = "Content-Type: multipart/signed; protocol=\"application/pkcs7-signature\"; boundary=b\r
\r
--b\r
Content-Type: text/plain\r
\r
Hello\r
--b\r
Content-Type: application/pkcs7-signature\r
\r
MIIB\r
--b--\r
";
    assert_eq!(protection(signed), Protection::SmimeSigned);
    assert!(!protection(signed).is_encrypted());
    assert!(protection(signed).claims_signature());
}

/// Outlook's default: the message *is* the CMS structure, content included.
/// Nothing is encrypted here — there is a plaintext, just inside the
/// structure rather than beside it — so this must read as claiming a
/// signature and nothing more, not as something to decrypt.
#[test]
fn recognises_smime_opaque_signed_data_by_its_mime_parameter() {
    let opaque = format!(
        "Content-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n{SMIME_OPAQUE_SIGNED_BODY}"
    );
    assert_eq!(protection(&opaque), Protection::SmimeOpaqueSigned);
    assert!(!protection(&opaque).is_encrypted());
    assert!(protection(&opaque).claims_signature());
}

/// The same real message, but as it plenty of real mail actually arrives:
/// with no `smime-type` parameter at all. Told apart from enveloped-data by
/// peeking at the CMS structure's own ContentType OID rather than guessed at.
#[test]
fn recognises_smime_opaque_signed_data_with_no_mime_hint_at_all() {
    let opaque = format!(
        "Content-Type: application/pkcs7-mime; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n{SMIME_OPAQUE_SIGNED_BODY}"
    );
    assert_eq!(protection(&opaque), Protection::SmimeOpaqueSigned);
}

/// The Microsoft `x-` spelling of the MIME type carries the OID-fallback path
/// too, not just the parameter-present one.
#[test]
fn the_oid_fallback_also_recognises_the_microsoft_spelling() {
    let opaque = format!(
        "Content-Type: application/x-pkcs7-mime; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n{SMIME_OPAQUE_SIGNED_BODY}"
    );
    assert_eq!(protection(&opaque), Protection::SmimeOpaqueSigned);
}

/// A `pkcs7-mime` part whose body is not CMS at all — a stray attachment
/// that happened to be typed that way — must not be forced into either
/// shape. Neither parameter nor OID gives an answer, so there is none.
#[test]
fn a_pkcs7_mime_part_with_an_unreadable_body_claims_no_protection() {
    let junk = "Content-Type: application/pkcs7-mime; name=smime.p7m\r\n\r\nnot base64 CMS at all\r\n";
    assert_eq!(protection(junk), Protection::None);
}

#[test]
fn the_microsoft_spelling_of_the_pkcs7_types_counts_too() {
    let enveloped = "Content-Type: application/x-pkcs7-mime; smime-type=enveloped-data\r\n\r\nMIIB\r\n";
    assert_eq!(protection(enveloped), Protection::SmimeEnveloped);
}

#[test]
fn recognises_an_armoured_block_sitting_in_the_text() {
    let inline = "Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nabcd\r\n-----END PGP MESSAGE-----\r\n";
    assert_eq!(protection(inline), Protection::PgpInline);
    assert!(protection(inline).is_encrypted());
}

#[test]
fn a_clearsigned_body_is_recognised_as_well() {
    let inline = "Content-Type: text/plain\r\n\r\n-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA256\r\n\r\nHello\r\n";
    assert_eq!(protection(inline), Protection::PgpInline);
}

#[test]
fn an_ordinary_message_carries_no_protection() {
    assert_eq!(protection("Content-Type: text/plain\r\n\r\nHello\r\n"), Protection::None);
    let multipart = "Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHi\r\n--b--\r\n";
    assert_eq!(protection(multipart), Protection::None);
}

#[test]
fn talking_about_pgp_is_not_the_same_as_using_it() {
    // A message quoting the marker inside a sentence, which is what a mail
    // about encryption looks like. The marker must be a block, not a mention.
    let talking = "Content-Type: text/plain\r\n\r\nYou start it with -----BEGIN PGP MESSAGE----- and go from there.\r\n";
    // This one is a known limitation and is written down rather than hidden:
    // a body containing the marker anywhere reads as inline PGP. Decryption
    // then fails and the reader is told the body could not be read — which is
    // wrong but visible, rather than wrong and silent.
    assert_eq!(protection(talking), Protection::PgpInline);
}

#[test]
fn something_nested_is_still_found() {
    let nested = "Content-Type: multipart/mixed; boundary=o\r
\r
--o\r
Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; boundary=b\r
\r
--b\r
Content-Type: text/plain\r
\r
Hello\r
--b\r
Content-Type: application/pgp-signature\r
\r
sig\r
--b--\r
--o--\r
";
    assert_eq!(protection(nested), Protection::PgpSigned);
}

#[test]
fn the_ciphertext_part_of_a_well_formed_message_is_found() {
    let mail = parse_mail(PGP_ENCRYPTED.as_bytes()).unwrap();
    let body = pgp_encrypted_parts(&mail).expect("well formed");
    assert!(body.get_body().unwrap().contains("BEGIN PGP MESSAGE"));
}

#[test]
fn a_message_claiming_the_protocol_without_the_parts_is_malformed() {
    let broken = "Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=b\r
\r
--b\r
Content-Type: application/octet-stream\r
\r
nothing\r
--b--\r
";
    let mail = parse_mail(broken.as_bytes()).unwrap();
    // Recognised as encrypted — that is what it says it is — but nothing is
    // handed to a decryptor, because the part it would need is not there.
    assert_eq!(protection_of(&mail), Protection::PgpEncrypted);
    assert!(pgp_encrypted_parts(&mail).is_none());
}

#[test]
fn every_protection_has_a_word_and_they_are_all_different() {
    let all = [
        Protection::None,
        Protection::PgpEncrypted,
        Protection::PgpSigned,
        Protection::PgpInline,
        Protection::SmimeEnveloped,
        Protection::SmimeSigned,
        Protection::SmimeOpaqueSigned,
    ];
    let words: Vec<&str> = all.iter().map(|p| p.as_str()).collect();
    let mut unique = words.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), words.len());
}
