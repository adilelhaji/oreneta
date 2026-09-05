//! Mail that was signed or encrypted.

pub mod detect;
pub mod mime;
pub mod pgp;
pub mod pkcs12;
pub mod smime;

#[cfg(test)]
mod detect_tests;
#[cfg(test)]
mod mime_tests;
#[cfg(test)]
mod pgp_tests;
#[cfg(test)]
mod pkcs12_tests;
#[cfg(test)]
mod smime_tests;
