//! People: reading them from the places the reader already keeps them.

pub mod exchange;
pub mod google;
pub mod groups;
pub mod person;
pub mod vcard;
pub mod vcard_import;
pub mod vcard_write;

#[cfg(test)]
mod exchange_tests;
#[cfg(test)]
mod google_tests;
#[cfg(test)]
mod groups_tests;
#[cfg(test)]
mod person_tests;
#[cfg(test)]
mod vcard_tests;
#[cfg(test)]
mod vcard_write_tests;
