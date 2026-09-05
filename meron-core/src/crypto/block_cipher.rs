//! Shared AES-CBC / 3DES-CBC decryption, PKCS#7-padded — the two content
//! ciphers actually used by both [`super::pkcs12`] (unshrouding a stored
//! identity file's own bags) and CMS `EnvelopedData` in [`super::smime`]
//! (opening a received message), whichever way the two arrived at the
//! content-encryption key: a password-based KDF for one, RSA key transport
//! for the other. The cipher itself does not care which.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, KeyIvInit};

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
