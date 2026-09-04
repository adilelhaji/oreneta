use sequoia_openpgp::cert::prelude::*;
use sequoia_openpgp::policy::StandardPolicy;
use sequoia_openpgp::serialize::stream::{Armorer, Message, Signer};
use std::io::Write;

use super::pgp::*;

/// A certificate with a signing key, for a person at an address.
fn make_cert(uid: &str) -> Cert {
    CertBuilder::new()
        .add_userid(uid)
        .add_signing_subkey()
        .generate()
        .unwrap()
        .0
}

fn armour(cert: &Cert) -> String {
    use sequoia_openpgp::serialize::SerializeInto;
    String::from_utf8(cert.armored().to_vec().unwrap()).unwrap()
}

/// A detached signature over `data`, made by `cert`.
fn sign_detached(cert: &Cert, data: &[u8]) -> Vec<u8> {
    let policy = StandardPolicy::new();
    let keypair = cert
        .keys()
        .with_policy(&policy, None)
        .secret()
        .for_signing()
        .next()
        .unwrap()
        .key()
        .clone()
        .into_keypair()
        .unwrap();

    let mut sink = Vec::new();
    {
        let message = Message::new(&mut sink);
        let message = Armorer::new(message).build().unwrap();
        let mut signer = Signer::new(message, keypair).unwrap().detached().build().unwrap();
        signer.write_all(data).unwrap();
        signer.finalize().unwrap();
    }
    sink
}

#[test]
fn reads_the_facts_an_imported_certificate_carries() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let (_, info) = read_cert(&armour(&cert)).unwrap();
    assert_eq!(info.fingerprint, cert.fingerprint().to_hex());
    assert_eq!(info.user_ids, vec!["Ana Prat <ana@example.com>"]);
    assert_eq!(info.addresses, vec!["ana@example.com"]);
}

#[test]
fn a_certificate_with_several_identities_keeps_all_their_addresses() {
    let cert = CertBuilder::new()
        .add_userid("Ana Prat <ana@example.com>")
        .add_userid("Ana <ana@hospital.cat>")
        .add_signing_subkey()
        .generate()
        .unwrap()
        .0;
    let (_, info) = read_cert(&armour(&cert)).unwrap();
    assert_eq!(info.addresses.len(), 2);
    assert!(info.addresses.contains(&"ana@hospital.cat".to_string()));
}

#[test]
fn something_that_is_not_a_certificate_is_refused_rather_than_half_read() {
    assert!(read_cert("hello, this is not a key").is_err());
    assert!(read_cert("-----BEGIN PGP PUBLIC KEY BLOCK-----\nrubbish\n-----END PGP PUBLIC KEY BLOCK-----").is_err());
}

#[test]
fn a_signature_by_a_key_we_hold_checks_out() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let data = b"The quarterly figures are attached.\r\n";
    let signature = sign_detached(&cert, data);

    match verify_detached(&signature, data, &[cert.clone()]) {
        SignatureVerdict::Good { fingerprint, addresses } => {
            assert_eq!(fingerprint, cert.fingerprint().to_hex());
            assert_eq!(addresses, vec!["ana@example.com"]);
        }
        other => panic!("expected good, got {other:?}"),
    }
}

#[test]
fn a_message_altered_after_signing_does_not_check_out() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let signature = sign_detached(&cert, b"Pay the invoice to account 111.\r\n");
    let tampered = b"Pay the invoice to account 999.\r\n";
    assert_eq!(verify_detached(&signature, tampered, &[cert]), SignatureVerdict::Bad);
}

#[test]
fn a_signature_by_a_key_we_do_not_hold_is_unknown_and_not_bad() {
    // The difference matters: "bad" means somebody tampered, "unknown" means
    // this app has not been given the key. Reporting the first for the second
    // is crying wolf until nobody reads the warning.
    let signer = make_cert("Ana Prat <ana@example.com>");
    let stranger = make_cert("Marc Roca <marc@example.com>");
    let data = b"Hello\r\n";
    let signature = sign_detached(&signer, data);
    assert_eq!(verify_detached(&signature, data, &[stranger]), SignatureVerdict::NoKey);
}

#[test]
fn with_no_keys_at_all_the_answer_is_unknown() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let data = b"Hello\r\n";
    let signature = sign_detached(&cert, data);
    assert_eq!(verify_detached(&signature, data, &[]), SignatureVerdict::NoKey);
}

#[test]
fn rubbish_where_a_signature_should_be_is_malformed() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    assert_eq!(
        verify_detached(b"not a signature at all", b"Hello", &[cert]),
        SignatureVerdict::Malformed
    );
}

#[test]
fn the_signature_is_over_exact_bytes_including_the_line_endings() {
    // A verifier that normalised line endings would accept a message that was
    // not what was signed. Mail is CRLF on the wire and this must not be lax.
    let cert = make_cert("Ana Prat <ana@example.com>");
    let signature = sign_detached(&cert, b"Line one\r\nLine two\r\n");
    assert_eq!(
        verify_detached(&signature, b"Line one\nLine two\n", &[cert]),
        SignatureVerdict::Bad
    );
}

#[test]
fn a_good_signature_from_the_wrong_person_is_caught() {
    // The attack worth catching: the cryptography is impeccable and the
    // message is still not from who it claims to be from.
    let cert = make_cert("Marc Roca <marc@example.com>");
    let data = b"Please wire the money today.\r\n";
    let signature = sign_detached(&cert, data);
    let verdict = verify_detached(&signature, data, &[cert]);
    assert!(matches!(verdict, SignatureVerdict::Good { .. }));
    assert!(!signer_matches_sender(&verdict, "ana@example.com").unwrap());
    assert!(signer_matches_sender(&verdict, "Marc@Example.com").unwrap());
}

#[test]
fn asking_whether_an_unverified_signer_matches_is_a_question_with_no_answer() {
    for verdict in [SignatureVerdict::Bad, SignatureVerdict::NoKey, SignatureVerdict::Malformed] {
        assert!(signer_matches_sender(&verdict, "ana@example.com").is_err());
    }
}

#[test]
fn one_unreadable_stored_certificate_does_not_stop_the_others() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let stored = vec!["not a certificate".to_string(), armour(&cert)];
    let parsed = certs_from_armoured(&stored);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
}

/// A complete RFC 3156 signed message: the part, then a detached signature
/// over its exact bytes.
fn signed_message(cert: &Cert, from: &str, body_part: &str) -> Vec<u8> {
    let signature = sign_detached(cert, body_part.as_bytes());
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "From: {from}\r\nSubject: Figures\r\nContent-Type: multipart/signed; \
             protocol=\"application/pgp-signature\"; micalg=pgp-sha256; boundary=bnd\r\n\r\n--bnd\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(body_part.as_bytes());
    out.extend_from_slice(b"\r\n--bnd\r\nContent-Type: application/pgp-signature\r\n\r\n");
    out.extend_from_slice(&signature);
    out.extend_from_slice(b"\r\n--bnd--\r\n");
    out
}

const PART: &str = "Content-Type: text/plain; charset=utf-8\r\n\r\nThe quarterly figures are attached.\r\n";

#[test]
fn a_signed_message_checks_out_end_to_end() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let raw = signed_message(&cert, "Ana Prat <ana@example.com>", PART);
    let result = verify_message(&raw, &[cert.clone()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn a_body_changed_in_the_post_does_not_check_out() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let raw = signed_message(&cert, "Ana Prat <ana@example.com>", PART);
    let tampered = String::from_utf8_lossy(&raw).replace("attached", "cancelled").into_bytes();
    let result = verify_message(&tampered, &[cert]).expect("signed");
    assert_eq!(result.verdict, SignatureVerdict::Bad);
}

#[test]
fn a_perfect_signature_from_somebody_else_is_flagged() {
    // The whole point: the cryptography passes and the From header is a lie.
    let marc = make_cert("Marc Roca <marc@example.com>");
    let raw = signed_message(&marc, "Ana Prat <ana@example.com>", PART);
    let result = verify_message(&raw, &[marc]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(result.matches_sender, Some(false));
}

#[test]
fn an_unsigned_message_has_nothing_to_report() {
    let raw = b"From: ana@example.com\r\nContent-Type: text/plain\r\n\r\nLunch?\r\n";
    assert!(verify_message(raw, &[]).is_none());
}

#[test]
fn a_signed_message_with_no_key_to_check_it_asks_nothing_about_the_sender() {
    let cert = make_cert("Ana Prat <ana@example.com>");
    let raw = signed_message(&cert, "Ana Prat <ana@example.com>", PART);
    let result = verify_message(&raw, &[]).expect("signed");
    assert_eq!(result.verdict, SignatureVerdict::NoKey);
    // No verified signer means the question "is it the right person" has no
    // answer, and an answer is not invented.
    assert_eq!(result.matches_sender, None);
}
