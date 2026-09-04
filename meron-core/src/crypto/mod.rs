//! Mail that was signed or encrypted.

pub mod detect;
pub mod pgp;

#[cfg(test)]
mod detect_tests;
#[cfg(test)]
mod pgp_tests;
