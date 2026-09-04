//! People: reading them from the places the reader already keeps them.

pub mod exchange;
pub mod google;
pub mod person;
pub mod vcard;

#[cfg(test)]
mod exchange_tests;
#[cfg(test)]
mod google_tests;
#[cfg(test)]
mod person_tests;
#[cfg(test)]
mod vcard_tests;
