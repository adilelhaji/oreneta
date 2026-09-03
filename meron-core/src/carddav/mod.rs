//! Reading an address book off a CardDAV server.

pub mod client;
pub mod http;
pub mod xml;

#[cfg(test)]
mod client_tests;
#[cfg(test)]
mod xml_tests;
