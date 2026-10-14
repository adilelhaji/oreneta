//! Reading an address book off a CardDAV server.

pub mod client;
pub mod http;
pub mod write;
pub mod xml;

#[cfg(test)]
mod client_tests;
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod write_tests;
#[cfg(test)]
mod xml_tests;
