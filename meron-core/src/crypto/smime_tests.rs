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

/// The instant the existing fixtures are judged at. `ana.der` is valid from
/// 2026-09-05 to 2027-09-05; checking at the wall clock would turn every
/// test below into a failure the day it expires (#9).
const FIXTURE_NOW: i64 = 1790812800;

fn verify_message_at_fixture(raw: &[u8], held: &[x509_cert::Certificate]) -> Option<MessageSignature> {
    verify_message_at(raw, held, FIXTURE_NOW)
}

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
    let result = verify_message_at_fixture(SIGNED_DETACHED, &[ana()]).expect("signed");
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
    let result = verify_message_at_fixture(SIGNED_OPAQUE, &[ana()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
}

#[test]
fn a_certificate_the_reader_does_not_hold_is_still_checked_but_not_trusted() {
    // The whole point of the fifth verdict: this is not "no key" (something
    // here really was checked) and not "good" (nobody vouched for it).
    let result = verify_message_at_fixture(SIGNED_OPAQUE, &[]).expect("signed");
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
    let result = verify_message_at_fixture(SIGNED_OPAQUE, &[marc()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::ValidUntrusted { .. }));
}

#[test]
fn a_tampered_opaque_message_does_not_check_out() {
    let result = verify_message_at_fixture(SIGNED_OPAQUE_TAMPERED, &[ana()]).expect("signed");
    assert_eq!(result.verdict, SignatureVerdict::Bad);
}

#[test]
fn a_tampered_detached_message_does_not_check_out_either() {
    let result = verify_message_at_fixture(SIGNED_DETACHED_TAMPERED, &[ana()]).expect("signed");
    assert_eq!(result.verdict, SignatureVerdict::Bad);
}

#[test]
fn several_addresses_on_one_certificate_are_all_offered_for_the_sender_check() {
    let result = verify_message_at_fixture(SIGNED_OPAQUE_SAN, &[ana_san()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn a_perfect_signature_from_the_wrong_person_is_caught() {
    // Marc's own certificate, cryptographically impeccable — signing a
    // message whose From header claims to be Ana. The attack this exists to
    // catch: the cryptography passes and the identity is still a lie.
    let result = verify_message_at_fixture(SIGNED_WRONG_SIGNER, &[marc()]).expect("signed");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(result.matches_sender, Some(false));
}

#[test]
fn an_unsigned_message_has_nothing_to_report() {
    let raw = b"From: ana@example.com\r\nContent-Type: text/plain\r\n\r\nLunch?\r\n";
    assert!(verify_message_at_fixture(raw, &[]).is_none());
}

#[test]
fn an_encrypted_message_is_not_something_to_verify() {
    // application/pkcs7-mime with smime-type=enveloped-data: nothing here
    // claims a signature, so there is nothing for this to check.
    let raw = include_bytes!("testdata/enveloped.eml");
    assert!(verify_message_at_fixture(raw, &[]).is_none());
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

// ---------------------------------------------------------------------------
// Signing and encrypting outgoing mail
// ---------------------------------------------------------------------------

const BUILT_MESSAGE: &[u8] =
    b"From: Ana Prat <ana@example.com>\r\nTo: someone@example.com\r\nSubject: Wire the funds\r\n\
      Content-Type: text/plain; charset=utf-8\r\n\r\nPlease wire the funds today.";

#[test]
fn a_signed_outgoing_message_verifies_with_this_codebases_own_reader() {
    let signed = protect_message(BUILT_MESSAGE, Protect { sign: true, encrypt: false }, Some(&ana_identity()), &[], &[])
        .expect("should sign");
    let result = verify_message_at_fixture(&signed, &[ana()]).expect("a signed message has something to check");
    assert_eq!(result.verdict, SignatureVerdict::Good { fingerprint: describe(&ana()).fingerprint, addresses: describe(&ana()).addresses });
    assert_eq!(result.matches_sender, Some(true));
}

#[test]
fn an_encrypted_outgoing_message_decrypts_with_this_codebases_own_reader() {
    let encrypted =
        protect_message(BUILT_MESSAGE, Protect { sign: false, encrypt: true }, None, &[ana()], &["ana@example.com".into()])
            .expect("should encrypt");
    let opened = decrypt_message(&encrypted, &ana_identity()).expect("should decrypt");
    assert!(opened.body.contains("Please wire the funds today."));
}

#[test]
fn a_signed_and_encrypted_message_carries_a_real_signature_inside_the_encryption() {
    let protected = protect_message(
        BUILT_MESSAGE,
        Protect { sign: true, encrypt: true },
        Some(&ana_identity()),
        &[ana()],
        &["ana@example.com".into()],
    )
    .expect("should sign and encrypt");

    // Opening it only decrypts — the inner signature is a second, separate
    // check the caller runs on what came out, per OpenedMessage's own doc.
    let opened = decrypt_message(&protected, &ana_identity()).expect("should decrypt");
    assert!(opened.body.contains("Please wire the funds today."));

    // The decrypted content is itself a whole `multipart/signed` MIME
    // entity — verify_message reads that shape directly from the plaintext
    // CMS produced, without going through the outer envelope again.
    let mail = mailparse::parse_mail(&protected).unwrap();
    fn find_enveloped<'a>(part: &'a mailparse::ParsedMail<'a>) -> &'a mailparse::ParsedMail<'a> {
        if part.ctype.mimetype.eq_ignore_ascii_case("application/pkcs7-mime") {
            return part;
        }
        part.subparts.iter().map(find_enveloped).next().expect("an enveloped part exists")
    }
    let cms_der = find_enveloped(&mail).get_body_raw().unwrap();
    let plaintext = decrypt_enveloped(&cms_der, &ana_identity()).expect("should decrypt");

    let result = verify_message_at_fixture(&plaintext, &[ana()]).expect("the inner content is a signed MIME entity");
    assert!(matches!(result.verdict, SignatureVerdict::Good { .. }));
}

#[test]
fn encrypting_to_a_recipient_with_no_held_certificate_is_refused() {
    let result = protect_message(
        BUILT_MESSAGE,
        Protect { sign: false, encrypt: true },
        None,
        &[],
        &["nobody@example.com".into()],
    );
    assert!(matches!(result, Err(ProtectFailure::NoRecipientKey { .. })));
}

// ---- Certificate validity and the signed contentType (#9) ----------------
//
// Fixtures from OpenSSL, see testdata/validity/README.md.

const VALIDITY_VALID: &[u8] = include_bytes!("testdata/validity/valid.eml");
const VALIDITY_EXPIRED: &[u8] = include_bytes!("testdata/validity/expired.eml");
const VALIDITY_NOT_YET: &[u8] = include_bytes!("testdata/validity/notyet.eml");
const VALIDITY_VALID_DER: &[u8] = include_bytes!("testdata/validity/valid.der");
const VALIDITY_EXPIRED_DER: &[u8] = include_bytes!("testdata/validity/expired.der");

const JAN_2020: i64 = 1577836800;
const JAN_2021: i64 = 1609459200;
const JAN_2026: i64 = 1767225600;
const JAN_2090: i64 = 3786912000;
const MID_2026: i64 = 1780272000;

fn cert(der: &[u8]) -> x509_cert::Certificate {
    read_cert(der).unwrap().0
}

fn verdict_name(verdict: &SignatureVerdict) -> &'static str {
    match verdict {
        SignatureVerdict::Good { .. } => "good",
        SignatureVerdict::ValidUntrusted { .. } => "validUntrusted",
        SignatureVerdict::CertificateNotValid { .. } => "certificateNotValid",
        SignatureVerdict::Bad => "bad",
        SignatureVerdict::NoKey => "noKey",
        SignatureVerdict::Malformed => "malformed",
    }
}

#[test]
fn a_certificate_within_its_validity_signs_as_before() {
    let held = [cert(VALIDITY_VALID_DER)];
    let result = verify_message_at(VALIDITY_VALID, &held, MID_2026).expect("signed");
    assert_eq!(verdict_name(&result.verdict), "good");
    let untrusted = verify_message_at(VALIDITY_VALID, &[], MID_2026).expect("signed");
    assert_eq!(verdict_name(&untrusted.verdict), "validUntrusted");
}

/// Acceptance: an expired certificate never displays a trusted or valid
/// result, even held, even with a cryptographically sound signature.
#[test]
fn an_expired_certificate_is_never_a_valid_signature() {
    for held in [vec![cert(VALIDITY_EXPIRED_DER)], vec![]] {
        let result = verify_message_at(VALIDITY_EXPIRED, &held, MID_2026).expect("signed");
        match &result.verdict {
            SignatureVerdict::CertificateNotValid { reason, not_after, trusted, addresses, .. } => {
                assert_eq!(reason, "expired");
                assert_eq!(*not_after, JAN_2021);
                assert_eq!(*trusted, !held.is_empty(), "trust is reported separately");
                assert_eq!(addresses, &vec!["oriol@example.test".to_string()]);
            }
            other => panic!("expired certificate read as {other:?}"),
        }
        // The sender check still answers: integrity and identity are distinct.
        assert_eq!(result.matches_sender, Some(true));
    }
}

#[test]
fn a_certificate_not_valid_yet_is_never_a_valid_signature() {
    let result = verify_message_at(VALIDITY_NOT_YET, &[], MID_2026).expect("signed");
    match &result.verdict {
        SignatureVerdict::CertificateNotValid { reason, not_before, .. } => {
            assert_eq!(reason, "notYetValid");
            assert_eq!(*not_before, JAN_2090);
        }
        other => panic!("not-yet-valid certificate read as {other:?}"),
    }
}

/// RFC 5280: both ends of the interval are inside it.
#[test]
fn validity_boundaries_are_inclusive() {
    assert_eq!(verdict_name(&verify_message_at(VALIDITY_EXPIRED, &[], JAN_2020).unwrap().verdict), "validUntrusted");
    assert_eq!(verdict_name(&verify_message_at(VALIDITY_EXPIRED, &[], JAN_2021).unwrap().verdict), "validUntrusted");
    assert_eq!(verdict_name(&verify_message_at(VALIDITY_EXPIRED, &[], JAN_2021 + 1).unwrap().verdict), "certificateNotValid");
    assert_eq!(verdict_name(&verify_message_at(VALIDITY_VALID, &[], JAN_2026 - 1).unwrap().verdict), "certificateNotValid");
    assert_eq!(verdict_name(&verify_message_at(VALIDITY_VALID, &[], JAN_2026).unwrap().verdict), "validUntrusted");
}

/// The CMS inside an opaque-signed fixture, and a way to put a changed one back.
fn opaque_cms(raw: &[u8]) -> Vec<u8> {
    let mail = mailparse::parse_mail(raw).unwrap();
    mail.get_body_raw().unwrap()
}

fn rewrap(raw: &[u8], cms: &[u8]) -> Vec<u8> {
    use base64::Engine as _;
    let text = String::from_utf8_lossy(raw);
    let header_end = text.find("\r\n\r\n").map(|i| i + 4).or_else(|| text.find("\n\n").map(|i| i + 2)).unwrap();
    let mut out = text[..header_end].as_bytes().to_vec();
    out.extend_from_slice(base64::engine::general_purpose::STANDARD.encode(cms).as_bytes());
    out.extend_from_slice(b"\r\n");
    out
}

fn mutate_signed_data(raw: &[u8], change: impl FnOnce(&mut cms::signed_data::SignedData)) -> Vec<u8> {
    use der::{Decode, Encode};
    let info = cms::content_info::ContentInfo::from_der(&opaque_cms(raw)).unwrap();
    let mut signed: cms::signed_data::SignedData = info.content.decode_as().unwrap();
    change(&mut signed);
    let rebuilt = cms::content_info::ContentInfo {
        content_type: info.content_type,
        content: der::Any::encode_from(&signed).unwrap(),
    };
    rewrap(raw, &rebuilt.to_der().unwrap())
}

#[test]
fn the_unchanged_rewrapped_fixture_still_verifies() {
    // Guards the two tests below: the rewrapping itself changes nothing.
    let same = mutate_signed_data(VALIDITY_VALID, |_| {});
    assert_eq!(verdict_name(&verify_message_at(&same, &[], MID_2026).unwrap().verdict), "validUntrusted");
}

/// Acceptance: the signed contentType must match the content carried. The
/// content, the digest and the signature are untouched here; only the
/// declared type of the content changes, which without the check verifies.
#[test]
fn a_content_type_that_differs_from_the_signed_one_does_not_check_out() {
    let swapped = mutate_signed_data(VALIDITY_VALID, |signed| {
        // id-ct-TSTInfo instead of id-data.
        signed.encap_content_info.econtent_type = der::asn1::ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.16.1.4");
    });
    let result = verify_message_at(&swapped, &[cert(VALIDITY_VALID_DER)], MID_2026);
    // Either unreadable as a message, or read and refused: never valid.
    if let Some(result) = result {
        assert_eq!(verdict_name(&result.verdict), "bad", "{:?}", result.verdict);
    }
}

#[test]
fn signed_attributes_without_a_content_type_are_never_valid() {
    let stripped = mutate_signed_data(VALIDITY_VALID, |signed| {
        let mut infos: Vec<_> = signed.signer_infos.0.iter().cloned().collect();
        let attrs = infos[0].signed_attrs.as_ref().unwrap();
        let kept: Vec<_> = attrs.iter().filter(|attr| attr.oid.to_string() != "1.2.840.113549.1.9.3").cloned().collect();
        infos[0].signed_attrs = Some(der::asn1::SetOfVec::try_from(kept).unwrap());
        signed.signer_infos = cms::signed_data::SignerInfos(der::asn1::SetOfVec::try_from(infos).unwrap());
    });
    let result = verify_message_at(&stripped, &[cert(VALIDITY_VALID_DER)], MID_2026).expect("still signed");
    assert_eq!(verdict_name(&result.verdict), "malformed", "{:?}", result.verdict);
}
