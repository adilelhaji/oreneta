//! Shared AES-CBC / 3DES-CBC decryption, PKCS#7-padded — the two content
//! ciphers actually used by both [`super::pkcs12`] (unshrouding a stored
//! identity file's own bags) and CMS `EnvelopedData` in [`super::smime`]
//! (opening a received message), whichever way the two arrived at the
//! content-encryption key: a password-based KDF for one, RSA key transport
//! for the other. The cipher itself does not care which.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use rand::Rng as _;

/// The key or IV did not fit the ciphertext — in practice, indistinguishable
/// from "that key is wrong", since a correct key almost never fails to
/// unpad.
pub(crate) struct BadKeyOrPadding;

pub(crate) fn aes_cbc_decrypt(key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, BadKeyOrPadding> {
    let mut buf = ciphertext.to_vec();
    let plain = match key.len() {
        16 => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv)
            .map_err(|_| BadKeyOrPadding)?
            .decrypt_padded::<Pkcs7>(&mut buf),
        24 => cbc::Decryptor::<aes::Aes192>::new_from_slices(key, iv)
            .map_err(|_| BadKeyOrPadding)?
            .decrypt_padded::<Pkcs7>(&mut buf),
        32 => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv)
            .map_err(|_| BadKeyOrPadding)?
            .decrypt_padded::<Pkcs7>(&mut buf),
        _ => return Err(BadKeyOrPadding),
    };
    plain.map(<[u8]>::to_vec).map_err(|_| BadKeyOrPadding)
}

pub(crate) fn tdes_cbc_decrypt(key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, BadKeyOrPadding> {
    let decryptor = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).map_err(|_| BadKeyOrPadding)?;
    let mut buf = ciphertext.to_vec();
    decryptor.decrypt_padded::<Pkcs7>(&mut buf).map(<[u8]>::to_vec).map_err(|_| BadKeyOrPadding)
}

/// Generate a fresh random AES-256 key and IV and PKCS#7-encrypt `plaintext`
/// under them — the content-encryption step of building a new CMS
/// `EnvelopedData`. Returns `(key, iv, ciphertext)`; the key then gets
/// wrapped separately (RSA key transport) to each recipient.
pub(crate) fn aes256_cbc_encrypt_random(plaintext: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut rng = rand::rng();
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    rng.fill_bytes(&mut key);
    rng.fill_bytes(&mut iv);

    let mut buf = plaintext.to_vec();
    buf.extend_from_slice(&[0u8; 16]); // headroom for PKCS#7 padding, up to one block
    let encryptor = cbc::Encryptor::<aes::Aes256>::new_from_slices(&key, &iv)
        .expect("a freshly generated 32-byte key and 16-byte IV always fit AES-256-CBC");
    let ciphertext = encryptor
        .encrypt_padded::<Pkcs7>(&mut buf, plaintext.len())
        .expect("buf has one block of headroom reserved above")
        .to_vec();
    (key.to_vec(), iv.to_vec(), ciphertext)
}
