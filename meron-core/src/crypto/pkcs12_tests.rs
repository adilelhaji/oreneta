use super::pkcs12::{read_pkcs12, OpenFailure};
use der::Encode as _;
use rsa::RsaPublicKey;

const MODERN: &[u8] = include_bytes!("testdata/pkcs12/ana_modern.p12");
const LEGACY: &[u8] = include_bytes!("testdata/pkcs12/ana_legacy.p12");
const ANA_CERT_DER: &[u8] = include_bytes!("testdata/ana.der");

/// The public key half of `identity`'s certificate, computed the same way
/// [`super::smime::verify_signed_data`] does, so a match here is the same
/// thing that module would accept as "this key signed with this cert".
fn public_key_of(cert: &x509_cert::Certificate) -> RsaPublicKey {
    let der = cert.tbs_certificate().subject_public_key_info().to_der().unwrap();
    let spki = pkcs8::SubjectPublicKeyInfoRef::try_from(der.as_slice()).unwrap();
    RsaPublicKey::try_from(spki).unwrap()
}

#[test]
fn a_modern_pbes2_file_opens_with_the_right_password() {
    let identity = read_pkcs12(MODERN, "hunter2").expect("should unlock");
    assert_eq!(identity.certificate.to_der().unwrap(), ANA_CERT_DER);
    assert_eq!(RsaPublicKey::from(&identity.private_key), public_key_of(&identity.certificate));
    assert!(identity.info.addresses.contains(&"ana@example.com".to_string()));
}

#[test]
fn a_legacy_rc2_and_3des_file_opens_with_the_right_password() {
    let identity = read_pkcs12(LEGACY, "hunter2").expect("should unlock");
    assert_eq!(identity.certificate.to_der().unwrap(), ANA_CERT_DER);
    assert_eq!(RsaPublicKey::from(&identity.private_key), public_key_of(&identity.certificate));
}

#[test]
fn the_two_files_hold_the_same_identity() {
    // Same key pair exported twice, once each way — the point of having both
    // fixtures is that they must land on the same certificate and key.
    let modern = read_pkcs12(MODERN, "hunter2").unwrap();
    let legacy = read_pkcs12(LEGACY, "hunter2").unwrap();
    assert_eq!(modern.certificate.to_der().unwrap(), legacy.certificate.to_der().unwrap());
    assert_eq!(RsaPublicKey::from(&modern.private_key), RsaPublicKey::from(&legacy.private_key));
}

#[test]
fn a_wrong_password_is_reported_as_a_wrong_password_not_a_generic_error() {
    for file in [MODERN, LEGACY] {
        let result = read_pkcs12(file, "not-the-password");
        assert!(result.is_err(), "a wrong password must not unlock the file");
        match result {
            Err(OpenFailure::WrongPassword) => {}
            Err(other) => panic!("expected WrongPassword, got {other}"),
            Ok(_) => unreachable!(),
        }
    }
}

#[test]
fn junk_bytes_are_reported_as_malformed_not_as_a_wrong_password() {
    let result = read_pkcs12(b"not a pkcs12 file at all", "hunter2");
    assert!(result.is_err(), "junk bytes must not unlock");
    match result {
        Err(OpenFailure::Malformed(_)) => {}
        Err(other) => panic!("expected Malformed, got {other}"),
        Ok(_) => unreachable!(),
    }
}
