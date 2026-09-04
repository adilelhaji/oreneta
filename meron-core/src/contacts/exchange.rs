//! Turning what Exchange's directory answers into people.
//!
//! The directory is not a book to copy: an organisation's address list runs
//! to tens of thousands of entries and changes under the reader's feet. It is
//! asked, by name, when the reader is typing one. The asking already exists —
//! the calendar uses it to find attendees — so this only shapes the answer,
//! which the rest of the app should see as people and not as attendees.

use crate::calendar::Participant;

use super::person::{EmailAddress, Person};

/// The people a directory lookup names.
///
/// An entry with no address is nobody the composer can use; the same address
/// under two spellings is one person. Nothing else is invented: the directory
/// gave a name and an address, and that is what a person made from it has.
pub fn people_from_participants(found: Vec<Participant>) -> Vec<Person> {
    let mut people = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in found {
        let addr = entry.addr.trim().to_lowercase();
        if addr.is_empty() || !addr.contains('@') || seen.contains(&addr) {
            continue;
        }
        seen.push(addr.clone());
        let name = entry.name.trim();
        people.push(Person {
            uid: addr.clone(),
            name: if name.is_empty() { addr.clone() } else { name.to_string() },
            organisation: String::new(),
            note: String::new(),
            emails: vec![EmailAddress {
                addr,
                label: String::new(),
            }],
            phones: Vec::new(),
            photo: None,
        });
    }
    people
}
