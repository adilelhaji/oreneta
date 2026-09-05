//! Reading the reader's own S/MIME identity out of a PKCS#12 (`.p12`/`.pfx`)
//! file: the certificate-plus-private-key bundle a CA or another mail client
//! hands out, protected by a password. This is what [`super::smime`]'s
//! decryption and signing-on-send need and cannot get any other way — a
//! private key never travels inside a received message the way a signing
//! certificate does.
//!
//! The file format (RFC 7292) is a shell — an outer `PFX` holding an
//! `AuthenticatedSafe`, itself a sequence of `ContentInfo`s each either
//! plaintext or password-encrypted — around a handful of `SafeBag`s, each
//! either a certificate or a key. What actually protects the private key
//! varies by *when* the file was made: OpenSSL 3.x defaults to PBES2 with
//! PBKDF2 and AES-CBC; anything made against the classic RFC 7292 Appendix B
//! KDF (still what most non-OpenSSL-3 tooling, and years of already-issued
//! certificates, wrote) uses SHA-1-based key stretching with RC2-40-CBC or
//! 3DES-CBC. Both are read here, verified against real `openssl pkcs12
//! -export` output for each — see `pkcs12_tests.rs`.
//!
//! The file's own MAC (RFC 7292 §4, when present) is checked before anything
//! is decrypted, and a mismatch is reported as a wrong password rather than
//! surfacing as a padding error two steps further in — the honest way to
//! distinguish "that password is wrong" from "this file is corrupt".

use aes::cipher::array::Array;
use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, InnerIvInit, KeyInit};
use cms::content_info::ContentInfo as CmsContentInfo;
use cms::encrypted_data::EncryptedData;
use der::asn1::{AnyRef, OctetString};
use der::Decode;
use pbkdf2::hmac::{Hmac, Mac};
use pkcs12::kdf::{derive_key_utf8, Pkcs12KeyType};
use pkcs12::pbe_params::{EncryptedPrivateKeyInfo, Pbes2Params, Pbkdf2Params, Pkcs12PbeParams};
use pkcs12::pfx::Pfx;
use pkcs12::safe_bag::SafeBag;
use pkcs12::{
    CertBag, MacData, PKCS_12_CERT_BAG_OID, PKCS_12_PBEWITH_SHAAND40_BIT_RC2_CBC,
    PKCS_12_PBE_WITH_SHAAND128_BIT_RC2_CBC, PKCS_12_PBE_WITH_SHAAND3_KEY_TRIPLE_DES_CBC,
    PKCS_12_PKCS8_KEY_BAG_OID,
};
use pkcs8::DecodePrivateKey;
use rc2::Rc2;
use rsa::RsaPrivateKey;
use sha1::Sha1;
use sha2::Sha256;
use x509_cert::spki::AlgorithmIdentifierOwned;
use x509_cert::Certificate;

use super::smime::{describe, CertInfo};

/// The reader's own certificate and private key, imported from a PKCS#12
/// file. Same trust shape as everywhere else in this module family: this is
/// what the file says, not a claim verified against a root CA.
pub struct Identity {
    pub certificate: Certificate,
    pub private_key: RsaPrivateKey,
    pub info: CertInfo,
}

/// Why a PKCS#12 file could not be opened. Kept apart from a single error
/// string for the one case the caller needs to react to differently: asking
/// the reader to try the password again only makes sense for
/// [`WrongPassword`](OpenFailure::WrongPassword), not for a corrupt file or
/// one this code cannot read yet.
#[derive(Debug)]
pub enum OpenFailure {
    /// The MAC did not verify, or every decrypt attempt failed padding —
    /// both are what a wrong password looks like from here.
    WrongPassword,
    /// Structurally not a readable PKCS#12 file.
    Malformed(String),
    /// Readable, but protected with something this does not implement yet
    /// (RC4, 2-key 3DES, a non-RSA key) — said as such rather than guessed.
    Unsupported(String),
}

impl std::fmt::Display for OpenFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenFailure::WrongPassword => write!(f, "wrong password"),
            OpenFailure::Malformed(msg) => write!(f, "malformed PKCS#12 file: {msg}"),
            OpenFailure::Unsupported(msg) => write!(f, "unsupported PKCS#12 file: {msg}"),
        }
    }
}

impl std::error::Error for OpenFailure {}

fn malformed(context: &str) -> impl Fn(der::Error) -> OpenFailure + '_ {
    move |error| OpenFailure::Malformed(format!("{context}: {error}"))
}

/// A `SafeBag`'s `bagValue` is stored, tag and all, as `[0] EXPLICIT
/// BAG-TYPE.&Type` — this crate's hand-rolled `SafeBag` decoder captures that
/// whole wrapper rather than unwrapping it (its own `encode_value` re-wraps
/// the same way), so every bag's actual content — a `CertBag`, an
/// `EncryptedPrivateKeyInfo` — needs this one layer of EXPLICIT tagging
/// peeled off before it can be decoded as its real type.
fn unwrap_explicit(bag_value: &[u8]) -> Result<&[u8], OpenFailure> {
    let any = AnyRef::from_der(bag_value)
        .map_err(malformed("SafeBag value is not a valid EXPLICIT wrapper"))?;
    Ok(any.value())
}

/// `1.2.840.113549.1.7.1`: `id-data`, plaintext content.
const OID_DATA: &str = "1.2.840.113549.1.7.1";
/// `1.2.840.113549.1.7.6`: `id-encryptedData`, password-encrypted content.
const OID_ENCRYPTED_DATA: &str = "1.2.840.113549.1.7.6";
/// `1.2.840.113549.1.5.13`: `id-PBES2`.
const OID_PBES2: &str = "1.2.840.113549.1.5.13";
/// `1.2.840.113549.1.5.12`: `id-PBKDF2`.
const OID_PBKDF2: &str = "1.2.840.113549.1.5.12";
/// `1.3.14.3.2.26`: SHA-1, used both as a MAC/PBE digest and a PBKDF2 PRF.
const OID_SHA1: &str = "1.3.14.3.2.26";
/// `2.16.840.1.101.3.4.2.1`: SHA-256.
const OID_SHA256: &str = "2.16.840.1.101.3.4.2.1";
/// `hmacWithSHA1` / `hmacWithSHA256` — the PBKDF2 PRF OIDs OpenSSL writes.
const OID_HMAC_SHA1: &str = "1.2.840.113549.2.7";
const OID_HMAC_SHA256: &str = "1.2.840.113549.2.9";
/// AES-CBC content-encryption OIDs PBES2 names as its `encryptionScheme`.
const OID_AES128_CBC: &str = "2.16.840.1.101.3.4.1.2";
const OID_AES192_CBC: &str = "2.16.840.1.101.3.4.1.22";
const OID_AES256_CBC: &str = "2.16.840.1.101.3.4.1.42";

/// Read and unlock a PKCS#12 identity file.
pub fn read_pkcs12(bytes: &[u8], password: &str) -> Result<Identity, OpenFailure> {
    let pfx = Pfx::from_der(bytes).map_err(malformed("not a PKCS#12 (PFX) structure"))?;
    if pfx.auth_safe.content_type.to_string() != OID_DATA {
        return Err(OpenFailure::Unsupported(
            "the authenticated safe is not plain data — publicly-encrypted PKCS#12 is not supported".into(),
        ));
    }
    let auth_safe_octets: OctetString = pfx
        .auth_safe
        .content
        .decode_as()
        .map_err(malformed("authenticated safe is not an OCTET STRING"))?;
    let auth_safe_der = auth_safe_octets.as_bytes();

    if let Some(mac_data) = &pfx.mac_data {
        verify_mac(mac_data, auth_safe_der, password)?;
    }

    let content_infos: Vec<CmsContentInfo> =
        Vec::from_der(auth_safe_der).map_err(malformed("authenticated safe is not a SEQUENCE OF ContentInfo"))?;

    let mut bags: Vec<SafeBag> = Vec::new();
    for content_info in &content_infos {
        let content_type = content_info.content_type.to_string();
        let safe_contents_der = if content_type == OID_DATA {
            let octets: OctetString = content_info
                .content
                .decode_as()
                .map_err(malformed("content-safe is not an OCTET STRING"))?;
            octets.as_bytes().to_vec()
        } else if content_type == OID_ENCRYPTED_DATA {
            let encrypted: EncryptedData = content_info
                .content
                .decode_as()
                .map_err(malformed("not a valid EncryptedData"))?;
            let cipher_text = encrypted
                .enc_content_info
                .encrypted_content
                .as_ref()
                .ok_or_else(|| OpenFailure::Malformed("EncryptedData with no ciphertext".into()))?;
            decrypt_pbe(&encrypted.enc_content_info.content_enc_alg, password, cipher_text.as_bytes())?
        } else {
            return Err(OpenFailure::Unsupported(format!(
                "content-safe type {content_type} is not supported"
            )));
        };
        let mut contents: Vec<SafeBag> =
            Vec::from_der(&safe_contents_der).map_err(malformed("content-safe is not a SEQUENCE OF SafeBag"))?;
        bags.append(&mut contents);
    }

    let mut certificate: Option<Certificate> = None;
    let mut private_key: Option<RsaPrivateKey> = None;

    for bag in &bags {
        let bag_value = unwrap_explicit(&bag.bag_value)?;
        if bag.bag_id == PKCS_12_CERT_BAG_OID {
            let cert_bag = CertBag::from_der(bag_value).map_err(malformed("not a valid CertBag"))?;
            let cert = Certificate::from_der(cert_bag.cert_value.as_bytes())
                .map_err(malformed("certificate bag does not hold a valid X.509 certificate"))?;
            certificate = Some(cert);
        } else if bag.bag_id == PKCS_12_PKCS8_KEY_BAG_OID {
            let shrouded = EncryptedPrivateKeyInfo::from_der(bag_value)
                .map_err(malformed("not a valid shrouded key bag"))?;
            let plain = decrypt_pbe(&shrouded.encryption_algorithm, password, shrouded.encrypted_data.as_bytes())?;
            let key = RsaPrivateKey::from_pkcs8_der(&plain)
                .map_err(|_| OpenFailure::Unsupported("the private key is not RSA, or not PKCS#8".into()))?;
            private_key = Some(key);
        }
        // A plain (unshrouded) key bag or a CRL/secret bag is skipped: none
        // of the identity files this reads should carry one, and guessing at
        // a shape nothing here tests against is worse than not reading it.
    }

    let certificate = certificate
        .ok_or_else(|| OpenFailure::Malformed("no certificate bag found in the file".into()))?;
    let private_key =
        private_key.ok_or_else(|| OpenFailure::Malformed("no private key bag found in the file".into()))?;
    let info = describe(&certificate);
    Ok(Identity { certificate, private_key, info })
}

fn verify_mac(mac_data: &MacData, auth_safe_der: &[u8], password: &str) -> Result<(), OpenFailure> {
    let oid = mac_data.mac.algorithm.oid.to_string();
    let salt = mac_data.mac_salt.as_bytes();
    let iterations = mac_data.iterations;
    let expected = mac_data.mac.digest.as_bytes();

    let ok = match oid.as_str() {
        OID_SHA1 => mac_matches_sha1(password, salt, iterations, auth_safe_der, expected),
        OID_SHA256 => mac_matches_sha256(password, salt, iterations, auth_safe_der, expected),
        other => return Err(OpenFailure::Unsupported(format!("MAC digest {other} is not supported"))),
    };
    if ok {
        Ok(())
    } else {
        Err(OpenFailure::WrongPassword)
    }
}

fn mac_matches_sha1(password: &str, salt: &[u8], iterations: i32, data: &[u8], expected: &[u8]) -> bool {
    let Ok(key) = derive_key_utf8::<Sha1>(password, salt, Pkcs12KeyType::Mac, iterations, 20) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&key) else {
        return false;
    };
    mac.update(data);
    mac.verify_slice(expected).is_ok()
}

fn mac_matches_sha256(password: &str, salt: &[u8], iterations: i32, data: &[u8], expected: &[u8]) -> bool {
    let Ok(key) = derive_key_utf8::<Sha256>(password, salt, Pkcs12KeyType::Mac, iterations, 32) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&key) else {
        return false;
    };
    mac.update(data);
    mac.verify_slice(expected).is_ok()
}

/// Decrypt one PBE-protected blob (a content-safe, or an individual shrouded
/// key bag's `EncryptedPrivateKeyInfo`) — dispatching on the algorithm OID to
/// either the legacy RFC 7292 Appendix B KDF or modern PBES2/PBKDF2.
fn decrypt_pbe(alg: &AlgorithmIdentifierOwned, password: &str, ciphertext: &[u8]) -> Result<Vec<u8>, OpenFailure> {
    if alg.oid == PKCS_12_PBE_WITH_SHAAND3_KEY_TRIPLE_DES_CBC {
        return decrypt_legacy_tdes(alg, password, ciphertext);
    }
    if alg.oid == PKCS_12_PBE_WITH_SHAAND128_BIT_RC2_CBC {
        return decrypt_legacy_rc2(alg, password, ciphertext, 16);
    }
    if alg.oid == PKCS_12_PBEWITH_SHAAND40_BIT_RC2_CBC {
        return decrypt_legacy_rc2(alg, password, ciphertext, 5);
    }
    if alg.oid.to_string() == OID_PBES2 {
        return decrypt_pbes2(alg, password, ciphertext);
    }
    Err(OpenFailure::Unsupported(format!("encryption algorithm {} is not supported", alg.oid)))
}

fn legacy_pbe_params(alg: &AlgorithmIdentifierOwned) -> Result<Pkcs12PbeParams, OpenFailure> {
    alg.parameters
        .clone()
        .ok_or_else(|| OpenFailure::Malformed("PBE algorithm with no parameters".into()))?
        .decode_as()
        .map_err(|error: der::Error| OpenFailure::Malformed(format!("bad PBE parameters: {error}")))
}

fn decrypt_legacy_tdes(alg: &AlgorithmIdentifierOwned, password: &str, ciphertext: &[u8]) -> Result<Vec<u8>, OpenFailure> {
    let params = legacy_pbe_params(alg)?;
    let salt = params.salt.as_bytes();
    let key = derive_key_utf8::<Sha1>(password, salt, Pkcs12KeyType::EncryptionKey, params.iterations, 24)
        .map_err(malformed("deriving the 3DES key"))?;
    let iv = derive_key_utf8::<Sha1>(password, salt, Pkcs12KeyType::Iv, params.iterations, 8)
        .map_err(malformed("deriving the 3DES IV"))?;
    super::block_cipher::tdes_cbc_decrypt(&key, &iv, ciphertext).map_err(|_| OpenFailure::WrongPassword)
}

fn decrypt_legacy_rc2(
    alg: &AlgorithmIdentifierOwned,
    password: &str,
    ciphertext: &[u8],
    key_len: usize,
) -> Result<Vec<u8>, OpenFailure> {
    let params = legacy_pbe_params(alg)?;
    let salt = params.salt.as_bytes();
    let key = derive_key_utf8::<Sha1>(password, salt, Pkcs12KeyType::EncryptionKey, params.iterations, key_len)
        .map_err(malformed("deriving the RC2 key"))?;
    let iv = derive_key_utf8::<Sha1>(password, salt, Pkcs12KeyType::Iv, params.iterations, 8)
        .map_err(malformed("deriving the RC2 IV"))?;
    let rc2 = Rc2::new_with_eff_key_len(&key, key_len * 8);
    let iv_array: Array<u8, aes::cipher::consts::U8> =
        Array::try_from(iv.as_slice()).map_err(|_| OpenFailure::Malformed("bad RC2 IV length".into()))?;
    let decryptor = cbc::Decryptor::<Rc2>::inner_iv_init(rc2, &iv_array);
    let mut buf = ciphertext.to_vec();
    decryptor
        .decrypt_padded::<Pkcs7>(&mut buf)
        .map(<[u8]>::to_vec)
        .map_err(|_| OpenFailure::WrongPassword)
}

fn decrypt_pbes2(alg: &AlgorithmIdentifierOwned, password: &str, ciphertext: &[u8]) -> Result<Vec<u8>, OpenFailure> {
    let params: Pbes2Params = alg
        .parameters
        .clone()
        .ok_or_else(|| OpenFailure::Malformed("PBES2 with no parameters".into()))?
        .decode_as()
        .map_err(|error: der::Error| OpenFailure::Malformed(format!("bad PBES2 parameters: {error}")))?;

    if params.kdf.oid.to_string() != OID_PBKDF2 {
        return Err(OpenFailure::Unsupported(format!("PBES2 KDF {} is not supported", params.kdf.oid)));
    }
    let kdf_params: Pbkdf2Params = params
        .kdf
        .parameters
        .clone()
        .ok_or_else(|| OpenFailure::Malformed("PBKDF2 with no parameters".into()))?
        .decode_as()
        .map_err(|error: der::Error| OpenFailure::Malformed(format!("bad PBKDF2 parameters: {error}")))?;
    let salt = kdf_params.salt.as_bytes();
    let iterations = kdf_params.iteration_count;
    let prf_oid = kdf_params.prf.oid.to_string();

    let key_len = match params.encryption.oid.to_string().as_str() {
        OID_AES128_CBC => 16,
        OID_AES192_CBC => 24,
        OID_AES256_CBC => 32,
        other => return Err(OpenFailure::Unsupported(format!("PBES2 encryption scheme {other} is not supported"))),
    };

    let mut key = vec![0u8; key_len];
    match prf_oid.as_str() {
        OID_HMAC_SHA1 => pbkdf2::pbkdf2_hmac::<Sha1>(password.as_bytes(), salt, iterations, &mut key),
        OID_HMAC_SHA256 => pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key),
        other => return Err(OpenFailure::Unsupported(format!("PBKDF2 PRF {other} is not supported"))),
    }

    let iv_octets: OctetString = params
        .encryption
        .parameters
        .clone()
        .ok_or_else(|| OpenFailure::Malformed("AES-CBC with no IV parameter".into()))?
        .decode_as()
        .map_err(|error: der::Error| OpenFailure::Malformed(format!("bad AES-CBC IV: {error}")))?;
    let iv = iv_octets.as_bytes();

    super::block_cipher::aes_cbc_decrypt(&key, iv, ciphertext).map_err(|_| OpenFailure::WrongPassword)
}
