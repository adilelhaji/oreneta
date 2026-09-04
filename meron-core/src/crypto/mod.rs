//! Mail that was signed or encrypted.

pub mod detect;
pub mod mime;
pub mod pgp;

#[cfg(test)]
mod detect_tests;
#[cfg(test)]
mod mime_tests;
#[cfg(test)]
mod pgp_tests;
