//! Verified against real OpenSSL output, not just against itself.
//!
//! Every fixture here was produced by the `openssl smime` command line tool —
//! `openssl smime -verify` confirmed each one before it was committed — so
//! what these tests prove is interop with an independent implementation, the
//! same reason the OpenPGP tests are cross-checked against real `gpg`. A
//! verifier that only ever checks its own signatures can be wrong in a way
//! that agrees with itself.

use super::smime::*;

const ANA_DER: &[u8] = include_bytes!("testdata/ana.der");
const ANA_SAN_DER: &[u8] = include_bytes!("testdata/ana_san.der");
const MARC_DER: &[u8] = include_bytes!("testdata/marc.der");

const SIGNED_DETACHED: &[u8] = include_bytes!("testdata/signed_detached.eml");
const SIGNED_DETACHED_TAMPERED: &[u8] = include_bytes!("testdata/signed_detached_tampered.eml");
const SIGNED_OPAQUE: &[u8] = include_bytes!("testdata/signed_opaque.eml");
const SIGNED_OPAQUE_TAMPERED: &[u8] = include_bytes!("testdata/signed_opaque_tampered.eml");
const SIGNED_OPAQUE_SAN: &[u8] = include_bytes!("testdata/signed_opaque_san.eml");
const SIGNED_WRONG_SIGNER: &[u8] = include_bytes!("testdata/signed_wrong_signer.eml");

fn ana() -> x509_cert::Certificate {
    read_cert(ANA_DER).unwrap().0
}

fn ana_san() -> x509_cert::Certificate {
    read_cert(ANA_SAN_DER).unwrap().0
}

fn marc() -> x509_cert::Certificate {
    read_cert(MARC_DER).unwrap().0
}

// ---------------------------------------------------------------------------
// Reading a certificate
// ---------------------------------------------------------------------------

#[test]
fn reads_the_address_from_the_subject_dns_legacy_emailaddress_attribute() {
    let (_, info) = read_cert(ANA_DER).unwrap();
    assert_eq!(info.subject, "Ana Prat");
    assert_eq!(info.addresses, vec!["ana@example.com"]);
}

#[test]
fn reads_every_address_from_the_subject_alternative_name() {
    // The modern, CA-issued shape: several rfc822Name entries, no
    // emailAddress attribute in the Subject DN at all.
    let (_, info) = read_cert(ANA_SAN_DER).unwrap();
    assert_eq!(info.addresses, vec!["ana@example.com", "ana@hospital.cat"]);
}

#[test]
fn something_that_is_not_a_certificate_is_refused() {
    assert!(read_cert(b"hello, this is not a certificate").is_err());
}

#[test]
fn the_fingerprint_is_stable_and_certificates_differ() {
    let (_, ana) = read_cert(ANA_DER).unwrap();
    let (_, ana_again) = read_cert(ANA_DER).unwrap();
    let (_, marc) = read_cert(MARC_DER).unwrap();
    assert_eq!(ana.fingerprint, ana_again.fingerprint);
    assert_ne!(ana.fingerprint, marc.fingerprint);
    assert_eq!(ana.fingerprint.len(), 64, "SHA-256 as hex is 64 characters");
}

// ---------------------------------------------------------------------------
// Verifying a whole message
// ---------------------------------------------------------------------------

#[test]
fn a_detached_signature_from_a_held_certificate_is_good() {
    let result = verify_message(SIGNED_DETACHED, &[ana()]).expect("signed");
    match result.verdict {
        SignatureVerdict::Good { fingerprint, addresses } => {
            assert_eq!(fingerprint, describe(&ana()).fingerprint);
            assert_eq!(addresses, vec!["ana@example.com"]);
        }
        other => panic!("expected Good, got {other:?}"),
    }
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn opaque_signing_outlooks_default_is_read_the_same_way() {
    let result = verify_message(SIGNED_OPAQUE, &[ana()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
}

#[test]
fn a_certificate_the_reader_does_not_hold_is_still_checked_but_not_trusted() {
    // The whole point of the fifth verdict: this is not "no key" (something
    // here really was checked) and not "good" (nobody vouched for it).
    let result = verify_message(SIGNED_OPAQUE, &[]).expect("signed");
    match result.verdict {
        SignatureVerdict::ValidUntrusted { addresses, .. } => {
            assert_eq!(addresses, vec!["ana@example.com"]);
        }
        other => panic!("expected ValidUntrusted, got {other:?}"),
    }
    // The cryptography still answers the sender question; trust is separate.
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn holding_an_unrelated_certificate_does_not_manufacture_trust() {
    let result = verify_message(SIGNED_OPAQUE, &[marc()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::ValidUntrusted { .. }));
}

#[test]
fn a_tampered_opaque_message_does_not_check_out() {
    let result = verify_message(SIGNED_OPAQUE_TAMPERED, &[ana()]).expect("signed");
    assert_eq!(result.verdict, SignatureVerdict::Bad);
}

#[test]
fn a_tampered_detached_message_does_not_check_out_either() {
    let result = verify_message(SIGNED_DETACHED_TAMPERED, &[ana()]).expect("signed");
    assert_eq!(result.verdict, SignatureVerdict::Bad);
}

#[test]
fn several_addresses_on_one_certificate_are_all_offered_for_the_sender_check() {
    let result = verify_message(SIGNED_OPAQUE_SAN, &[ana_san()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn a_perfect_signature_from_the_wrong_person_is_caught() {
    // Marc's own certificate, cryptographically impeccable — signing a
    // message whose From header claims to be Ana. The attack this exists to
    // catch: the cryptography passes and the identity is still a lie.
    let result = verify_message(SIGNED_WRONG_SIGNER, &[marc()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(result.matches_sender, Some(false));
}

#[test]
fn an_unsigned_message_has_nothing_to_report() {
    let raw = b"From: ana@example.com\r\nContent-Type: text/plain\r\n\r\nLunch?\r\n";
    assert!(verify_message(raw, &[]).is_none());
}

#[test]
fn an_encrypted_message_is_not_something_to_verify() {
    // application/pkcs7-mime with smime-type=enveloped-data: nothing here
    // claims a signature, so there is nothing for this to check.
    let raw = include_bytes!("testdata/enveloped.eml");
    assert!(verify_message(raw, &[]).is_none());
}

#[test]
fn asking_whether_an_unchecked_signer_matches_is_a_question_with_no_answer() {
    for verdict in [SignatureVerdict::Bad, SignatureVerdict::NoKey, SignatureVerdict::Malformed] {
        assert_eq!(signer_matches_sender(&verdict, "ana@example.com"), None);
    }
}

// ---------------------------------------------------------------------------
// Decrypting CMS EnvelopedData
// ---------------------------------------------------------------------------

const ENVELOPED: &[u8] = include_bytes!("testdata/enveloped.eml");
const ANA_MODERN_P12: &[u8] = include_bytes!("testdata/pkcs12/ana_modern.p12");
const ANA_LEGACY_P12: &[u8] = include_bytes!("testdata/pkcs12/ana_legacy.p12");
const MARC_MODERN_P12: &[u8] = include_bytes!("testdata/pkcs12/marc_modern.p12");

fn ana_identity() -> super::pkcs12::Identity {
    super::pkcs12::read_pkcs12(ANA_MODERN_P12, "hunter2").unwrap()
}

#[test]
fn a_message_encrypted_to_the_readers_own_certificate_opens() {
    // Independently confirmed with `openssl smime -decrypt`: the plaintext
    // really is this, not just whatever this code's own round trip agrees
    // with itself on.
    let opened = decrypt_message(ENVELOPED, &ana_identity()).expect("should decrypt");
    assert!(opened.body.contains("The quarterly figures are attached."));
}

#[test]
fn the_legacy_and_modern_identity_files_decrypt_the_same_message() {
    let legacy = super::pkcs12::read_pkcs12(ANA_LEGACY_P12, "hunter2").unwrap();
    let opened = decrypt_message(ENVELOPED, &legacy).expect("should decrypt");
    assert!(opened.body.contains("The quarterly figures are attached."));
}

#[test]
fn a_message_encrypted_to_somebody_else_does_not_open_with_the_wrong_identity() {
    let marc = super::pkcs12::read_pkcs12(MARC_MODERN_P12, "hunter2").unwrap();
    assert!(matches!(decrypt_message(ENVELOPED, &marc), Err(DecryptionFailure::NoKey)));
}

#[test]
fn a_signed_not_encrypted_message_is_not_something_to_decrypt() {
    let raw = include_bytes!("testdata/signed_detached.eml");
    assert!(matches!(decrypt_message(raw, &ana_identity()), Err(DecryptionFailure::Malformed)));
}

#[test]
fn junk_is_reported_as_malformed_not_as_no_key() {
    let raw = b"From: ana@example.com\r\nContent-Type: text/plain\r\n\r\nLunch?\r\n";
    assert!(matches!(decrypt_message(raw, &ana_identity()), Err(DecryptionFailure::Malformed)));
}
