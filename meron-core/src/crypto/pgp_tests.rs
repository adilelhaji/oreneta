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

/// The same, but keeping the secret parts.
fn armour_secret(cert: &Cert) -> String {
    use sequoia_openpgp::serialize::SerializeInto;
    String::from_utf8(cert.as_tsk().armored().to_vec().unwrap()).unwrap()
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

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

use sequoia_openpgp::serialize::stream::{Encryptor, LiteralWriter, Recipient};

/// A certificate that can receive encrypted mail, optionally passphrase-protected.
fn make_encryption_cert(uid: &str, passphrase: Option<&str>) -> Cert {
    let mut builder = CertBuilder::new()
        .add_userid(uid)
        .add_signing_subkey()
        .add_transport_encryption_subkey();
    if let Some(passphrase) = passphrase {
        builder = builder.set_password(Some(passphrase.into()));
    }
    builder.generate().unwrap().0
}

/// An OpenPGP message encrypted to `cert`.
fn encrypt_to(cert: &Cert, plaintext: &[u8]) -> Vec<u8> {
    let policy = StandardPolicy::new();
    let recipients: Vec<Recipient> = cert
        .keys()
        .with_policy(&policy, None)
        .supported()
        .for_transport_encryption()
        .map(Recipient::from)
        .collect();

    let mut sink = Vec::new();
    {
        let message = Message::new(&mut sink);
        let message = Armorer::new(message).build().unwrap();
        let message = Encryptor::for_recipients(message, recipients).build().unwrap();
        let mut writer = LiteralWriter::new(message).build().unwrap();
        writer.write_all(plaintext).unwrap();
        writer.finalize().unwrap();
    }
    sink
}

#[test]
fn an_unprotected_secret_key_is_read_and_reported_as_unprotected() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let (_, info) = read_secret_key(&armour_secret(&cert)).unwrap();
    assert_eq!(info.addresses, vec!["ana@example.com"]);
    assert!(!info.protected);
}

#[test]
fn a_passphrase_protected_key_is_reported_as_protected() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", Some("hunter2"));
    let (_, info) = read_secret_key(&armour_secret(&cert)).unwrap();
    assert!(info.protected);
}

#[test]
fn importing_a_public_certificate_where_a_secret_key_was_meant_is_refused() {
    // Otherwise the reader believes they can decrypt and finds out from a
    // message that will not open.
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let error = read_secret_key(&armour(&cert)).unwrap_err().to_string();
    assert!(error.contains("public certificate"), "{error}");
}

#[test]
fn a_message_encrypted_to_our_key_opens() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let ciphertext = encrypt_to(&cert, b"The figures are 12 and 34.");
    let opened = decrypt(&ciphertext, &[cert], None).unwrap();
    assert_eq!(opened.content, b"The figures are 12 and 34.");
    assert_eq!(opened.signature, None);
}

#[test]
fn a_protected_key_opens_with_its_passphrase() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", Some("hunter2"));
    let ciphertext = encrypt_to(&cert, b"Secret");
    assert_eq!(decrypt(&ciphertext, &[cert], Some("hunter2")).unwrap().content, b"Secret");
}

#[test]
fn a_wrong_passphrase_says_so_rather_than_saying_the_message_is_not_ours() {
    // The two send the reader in opposite directions: one to type again, the
    // other to go hunting for a key they already have.
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", Some("hunter2"));
    let ciphertext = encrypt_to(&cert, b"Secret");
    assert_eq!(
        decrypt(&ciphertext, &[cert.clone()], Some("wrong")).unwrap_err(),
        DecryptionFailure::NeedsPassphrase
    );
    // And no passphrase at all is the same situation, not a different one.
    assert_eq!(
        decrypt(&ciphertext, &[cert], None).unwrap_err(),
        DecryptionFailure::NeedsPassphrase
    );
}

#[test]
fn a_message_for_somebody_else_says_there_is_no_key_for_it() {
    let theirs = make_encryption_cert("Marc Roca <marc@example.com>", None);
    let ours = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let ciphertext = encrypt_to(&theirs, b"Not for Ana");
    assert_eq!(decrypt(&ciphertext, &[ours], None).unwrap_err(), DecryptionFailure::NoKey);
}

#[test]
fn with_no_keys_at_all_there_is_no_key_for_it() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let ciphertext = encrypt_to(&cert, b"Secret");
    assert_eq!(decrypt(&ciphertext, &[], None).unwrap_err(), DecryptionFailure::NoKey);
}

#[test]
fn rubbish_where_an_encrypted_message_should_be_is_not_reported_as_a_missing_key() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let failure = decrypt(b"not an encrypted message", &[cert], None).unwrap_err();
    assert_eq!(failure, DecryptionFailure::Malformed);
}

/// A complete RFC 3156 encrypted message.
fn encrypted_message(cert: &Cert, inner_part: &str) -> Vec<u8> {
    let ciphertext = encrypt_to(cert, inner_part.as_bytes());
    let mut out = Vec::new();
    out.extend_from_slice(
        b"From: ana@example.com\r\nSubject: Figures\r\nContent-Type: multipart/encrypted; \
          protocol=\"application/pgp-encrypted\"; boundary=bnd\r\n\r\n--bnd\r\n\
          Content-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--bnd\r\n\
          Content-Type: application/octet-stream\r\n\r\n",
    );
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(b"\r\n--bnd--\r\n");
    out
}

#[test]
fn an_encrypted_message_opens_and_its_inner_part_is_read() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let raw = encrypted_message(
        &cert,
        "Content-Type: text/plain; charset=utf-8\r\n\r\nThe figures are 12 and 34.\r\n",
    );
    let opened = decrypt_message(&raw, &[cert], None).unwrap();
    assert!(opened.body.contains("The figures are 12 and 34."));
    assert_eq!(opened.body_html, None);
}

#[test]
fn the_html_inside_an_encrypted_message_comes_through_as_html() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let raw = encrypted_message(
        &cert,
        "Content-Type: text/html; charset=utf-8\r\n\r\n<p>The <b>figures</b>.</p>\r\n",
    );
    let opened = decrypt_message(&raw, &[cert], None).unwrap();
    assert!(opened.body_html.unwrap().contains("<b>figures</b>"));
}

#[test]
fn an_armoured_block_in_a_plain_body_opens_too() {
    // Mail was armoured this way before there was a MIME type for it, and
    // plenty of it still is.
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let ciphertext = String::from_utf8(encrypt_to(&cert, b"Inline and secret.")).unwrap();
    let raw = format!(
        "From: ana@example.com\r\nContent-Type: text/plain\r\n\r\nHere it is:\r\n\r\n{ciphertext}\r\n\r\nRegards,\r\nAna\r\n"
    );
    let opened = decrypt_message(raw.as_bytes(), &[cert], None).unwrap();
    assert!(opened.body.contains("Inline and secret."));
}

#[test]
fn an_encrypted_message_we_have_no_key_for_says_so_rather_than_looking_broken() {
    let theirs = make_encryption_cert("Marc Roca <marc@example.com>", None);
    let raw = encrypted_message(&theirs, "Content-Type: text/plain\r\n\r\nNot for Ana\r\n");
    let ours = make_encryption_cert("Ana Prat <ana@example.com>", None);
    assert_eq!(
        decrypt_message(&raw, &[ours], None).unwrap_err(),
        DecryptionFailure::NoKey
    );
}

#[test]
fn an_ordinary_message_is_not_something_to_decrypt() {
    let cert = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let raw = b"From: ana@example.com\r\nContent-Type: text/plain\r\n\r\nLunch?\r\n";
    assert_eq!(
        decrypt_message(raw, &[cert], None).unwrap_err(),
        DecryptionFailure::Malformed
    );
}

// ---------------------------------------------------------------------------
// Protecting what is sent
// ---------------------------------------------------------------------------

const OUTGOING: &[u8] = b"From: Ana <ana@example.com>\r\n\
To: Marc <marc@example.com>\r\n\
Subject: Figures\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
The figures are 12 and 34.\r\n";

fn sign_only() -> Protect {
    Protect { sign: true, encrypt: false }
}

fn encrypt_only() -> Protect {
    Protect { sign: false, encrypt: true }
}

#[test]
fn a_signed_message_verifies_at_the_other_end() {
    // The real test of signing is that the receiving code accepts it.
    let ana = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let sent = protect_message(OUTGOING, sign_only(), Some(&ana), None, &[], &[]).unwrap();
    let checked = verify_message(&sent, &[ana]).expect("signed");
    assert!(matches!(checked.verdict, SignatureVerdict::Good { .. }));
    assert_eq!(checked.matches_sender, Some(true));
}

#[test]
fn an_encrypted_message_opens_at_the_other_end() {
    let marc = make_encryption_cert("Marc Roca <marc@example.com>", None);
    let sent = protect_message(
        OUTGOING,
        encrypt_only(),
        None,
        None,
        &[marc.clone()],
        &["marc@example.com".into()],
    )
    .unwrap();
    let opened = decrypt_message(&sent, &[marc], None).unwrap();
    assert!(opened.body.contains("The figures are 12 and 34."));
}

#[test]
fn signing_and_encrypting_puts_the_signature_inside_where_it_cannot_be_swapped() {
    // A signature outside the encryption can be stripped and replaced by
    // anyone able to re-send the ciphertext. The one that survives is inside.
    let ana = make_encryption_cert("Ana Prat <ana@example.com>", None);
    let marc = make_encryption_cert("Marc Roca <marc@example.com>", None);
    let sent = protect_message(
        OUTGOING,
        Protect { sign: true, encrypt: true },
        Some(&ana),
        None,
        &[marc.clone()],
        &["marc@example.com".into()],
    )
    .unwrap();

    // From the outside it is only encrypted; nothing claims a signature.
    let parsed = mailparse::parse_mail(&sent).unwrap();
    assert_eq!(
        super::detect::protection_of(&parsed),
        super::detect::Protection::PgpEncrypted
    );
    // And opening it finds the signature that was inside.
    let opened = decrypt_message(&sent, &[marc, ana.clone()], None).unwrap();
    assert!(matches!(opened.signature, Some(SignatureVerdict::Good { .. })));
}

#[test]
fn the_subject_and_the_recipients_still_travel_in_the_clear() {
    // That is what this format does, and pretending otherwise would be worse
    // than the limitation: the message could not be delivered at all.
    let marc = make_encryption_cert("Marc Roca <marc@example.com>", None);
    let sent = protect_message(
        OUTGOING,
        encrypt_only(),
        None,
        None,
        &[marc],
        &["marc@example.com".into()],
    )
    .unwrap();
    let text = String::from_utf8_lossy(&sent);
    assert!(text.contains("Subject: Figures"));
    assert!(text.contains("To: Marc"));
    assert!(!text.contains("The figures are 12 and 34."));
}

#[test]
fn a_recipient_with_no_key_stops_the_send_and_names_them() {
    // Falling back to sending in the clear is the worst thing this code could
    // do — worse than not sending — so it does not.
    let marc = make_encryption_cert("Marc Roca <marc@example.com>", None);
    let failure = protect_message(
        OUTGOING,
        encrypt_only(),
        None,
        None,
        &[marc],
        &["marc@example.com".into(), "stranger@example.com".into()],
    )
    .unwrap_err();
    assert_eq!(
        failure,
        ProtectFailure::NoRecipientKey {
            missing: vec!["stranger@example.com".into()]
        }
    );
}

#[test]
fn signing_with_no_key_stops_the_send() {
    assert_eq!(
        protect_message(OUTGOING, sign_only(), None, None, &[], &[]).unwrap_err(),
        ProtectFailure::NoSigningKey
    );
}

#[test]
fn a_locked_signing_key_asks_for_its_passphrase_rather_than_sending_unsigned() {
    let ana = make_encryption_cert("Ana Prat <ana@example.com>", Some("hunter2"));
    assert_eq!(
        protect_message(OUTGOING, sign_only(), Some(&ana), None, &[], &[]).unwrap_err(),
        ProtectFailure::NeedsPassphrase
    );
    assert_eq!(
        protect_message(OUTGOING, sign_only(), Some(&ana), Some("wrong"), &[], &[]).unwrap_err(),
        ProtectFailure::NeedsPassphrase
    );
    // And with the right one it goes.
    assert!(protect_message(OUTGOING, sign_only(), Some(&ana), Some("hunter2"), &[], &[]).is_ok());
}

#[test]
fn asking_for_nothing_leaves_the_message_exactly_as_it_was() {
    let sent = protect_message(
        OUTGOING,
        Protect { sign: false, encrypt: false },
        None,
        None,
        &[],
        &[],
    )
    .unwrap();
    assert_eq!(sent, OUTGOING);
}

#[test]
fn an_address_is_matched_however_it_was_capitalised() {
    let marc = make_encryption_cert("Marc Roca <marc@example.com>", None);
    assert!(protect_message(
        OUTGOING,
        encrypt_only(),
        None,
        None,
        &[marc],
        &["Marc@Example.COM".into()],
    )
    .is_ok());
}

// ---------------------------------------------------------------------------
// A real interoperability gap, found by crossing GnuPG-generated keys through
// this module rather than only Sequoia's own.
// ---------------------------------------------------------------------------

/// A passphrase-protected Ed25519/Curve25519 key pair, as GnuPG 2.4.8 exports
/// it — GnuPG's default algorithm choice since 2.3, and so the shape a great
/// many real keys are in. Passphrase: "hunter2".
const GNUPG_PROTECTED_ED25519: &str = "-----BEGIN PGP PRIVATE KEY BLOCK-----

lIYEapp/SBYJKwYBBAHaRw8BAQdAxa2nV8v+dXra5iuvSqJ92f18aK44yQIIW6F+
KnkFZkj+BwMC61ykXDqYYAv/dawDNCsRSUWMDS03L8LccfsphBDtvWzoz2CQuFUq
pMFw3u7QFwkqfSVIpjjI9YV2rYcAzdT11l2JHCuehq1YY+W5WLhr+7QcTWFyYyBS
b2NhIDxtYXJjQGV4YW1wbGUuY29tPoiQBBMWCgA4FiEEei3HzGRAWUksu5QFh5tp
kTHEoPoFAmqaf0gCGwMFCwkIBwIGFQoJCAsCBBYCAwECHgECF4AACgkQh5tpkTHE
oPq+nQEArsDMF/yoClHcMWCUQ2qRnIAnLL7MxNZxN0HAtwwlP3MA/A6C7zkXybZH
jgKb1f+baHTFCBNhhiwh2M0CDmb+1dQDnIsEapp/ahIKKwYBBAGXVQEFAQEHQKs+
58gSk2pTB7C/uNMHyRl/nu0ciC93GyiBsK3GQRI9AwEIB/4HAwLxi4N3Iti8Hf/h
i//Jf2Z+NRwuyMTHxi0mKmenEb51Jj01Lm0VsyKMTYp46r15TGJh0NcWbQtTxRX0
fLLN9GGXZABDhKh6lx1BdGy45YrtiHgEGBYKACAWIQR6LcfMZEBZSSy7lAWHm2mR
McSg+gUCapp/agIbDAAKCRCHm2mRMcSg+rEYAP9YWKQOaR6lTnJHAgaFNWxDifx7
ySEZ3R656+6p/XRyVAEA+MPTpPO9fRY/XLr7UMFs6Uz1rT4qT88Oalv1peytmA4=
=cgh4
-----END PGP PRIVATE KEY BLOCK-----";

/// A known, cited limitation, not a silent one.
///
/// This module's own OpenPGP messages round-trip perfectly with a
/// passphrase-protected key — the tests above prove it. But every one of
/// those keys was generated by Sequoia itself, and generating and reading a
/// key with the same library proves the library agrees with itself, not that
/// it reads what other people's software writes.
///
/// A real GnuPG-exported key, crossed through this module by hand while this
/// feature was being verified, found what that check could not: a
/// passphrase-protected Ed25519 or Curve25519 secret key exported by GnuPG
/// 2.4 — the algorithm suite GnuPG has defaulted to since 2.3, and so the
/// shape a great many real keys are in — cannot be unlocked here. It fails
/// with "Malformed MPI" while parsing the protected material, in
/// `sequoia-openpgp` 2.4.1's `crypto-rust` backend specifically. An RSA key
/// with the same passphrase protection unlocks correctly, and an *unprotected*
/// Curve25519 key from GnuPG decrypts a real message correctly — so the gap is
/// narrow: protected secret material for these two algorithms, from GnuPG,
/// through this backend.
///
/// Nothing in this codebase can fix a parsing bug inside a dependency. What
/// this test does instead is make the gap impossible to lose track of: it
/// fails loudly the day this starts working, which is the signal to delete it
/// and to tell every reader who protected a modern GnuPG key with a
/// passphrase that decryption now actually works for them.
#[test]
fn known_limitation_gnupg_protected_curve25519_secrets_do_not_unlock_here() {
    let (cert, info) = read_secret_key(GNUPG_PROTECTED_ED25519).expect("the key itself parses");
    assert!(info.protected);

    let policy = StandardPolicy::new();
    let mut failed = 0;
    for ka in cert.keys().secret().with_policy(&policy, None) {
        let mut key = ka.key().clone();
        let outcome = key.decrypt_secret(&sequoia_openpgp::crypto::Password::from("hunter2"));
        if outcome.is_err() {
            failed += 1;
        }
    }
    // If this ever reaches 0, the gap has closed: delete this test, and tell
    // whoever asks that a passphrase-protected modern GnuPG key now decrypts.
    assert_eq!(failed, 2, "expected both the primary and the subkey to still fail to unlock");
}
