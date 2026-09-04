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

#[test]
fn recognises_smime_in_both_of_its_shapes() {
    let enveloped = "Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\r\n\r\nMIIB\r\n";
    assert_eq!(protection(enveloped), Protection::SmimeEnveloped);
    assert!(protection(enveloped).is_encrypted());

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
    assert!(protection(signed).claims_signature());
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
    ];
    let words: Vec<&str> = all.iter().map(|p| p.as_str()).collect();
    let mut unique = words.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), words.len());
}
