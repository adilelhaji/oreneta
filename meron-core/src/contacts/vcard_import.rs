//! Bringing people in from a `.vcf` file (ADR-0012).
//!
//! Read first, written second: the reader sees how many cards can be taken
//! and how many cannot before anything is stored, and nothing is imported
//! from a file larger than [`MAX_BYTES`].

use super::person::{people_from_vcards, Person};
use super::vcard::split_cards;

/// Twenty megabytes: far beyond any address book of text, small enough that a
/// mistaken pick (a video renamed `.vcf`) is refused rather than parsed.
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    /// The people that can be imported, in file order.
    pub people: Vec<Person>,
    /// Cards with neither a name nor an address: nothing to keep.
    pub skipped: usize,
}

pub fn preview(file: &[u8]) -> anyhow::Result<Preview> {
    if file.len() > MAX_BYTES {
        anyhow::bail!("the file is larger than 20 MB, which is not an address book");
    }
    let cards = split_cards(file).len();
    if cards == 0 {
        anyhow::bail!("the file has no contacts in it (it is not a vCard file)");
    }
    let people = people_from_vcards(file);
    Ok(Preview { skipped: cards - people.len(), people })
}

/// Whether `person` is already in a book as the same name with the same first
/// address: importing a file twice must not double the book.
pub fn already_there(person: &Person, existing: &[Person]) -> bool {
    let first = |p: &Person| p.emails.first().map(|e| e.addr.trim().to_lowercase()).unwrap_or_default();
    existing
        .iter()
        .any(|other| other.name.trim().eq_ignore_ascii_case(person.name.trim()) && first(other) == first(person))
}
