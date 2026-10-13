//! Saving a contact to a CardDAV book (ADR-0012).
//!
//! Every write is conditional on the version the person was read at. The
//! server's current card is read first: if its ETag is not the one the editor
//! opened, nothing is written and the server's copy is returned for the reader
//! to choose. The edit itself starts from that card, so fields this app does
//! not show are kept (see `contacts::vcard_write`).

use anyhow::Result;

use super::client::{delete_card, get_card, put_card, Transport, Written};
use crate::contacts::person::{people_from_vcards, Person};
use crate::contacts::vcard_write::{new_card, patch_card};

/// What became of a save or a delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Written. The card's URL, its new version (empty if the server would
    /// not say) and the person as now stored there.
    Saved { href: String, version: String, person: Person },
    /// Deleted (or already gone).
    Deleted,
    /// Changed or deleted on the server since it was read: nothing was
    /// written. The server's copy and its version, if it is still there.
    Conflict { current: Option<(Person, String)> },
}

/// Edits the card at `href` from the version `read_at`.
pub fn save_existing(
    transport: &dyn Transport,
    book_url: &str,
    href: &str,
    read_at: &str,
    uid: &str,
    person: &Person,
    now: i64,
) -> Result<Outcome> {
    let Some((card, etag)) = get_card(transport, book_url, href)? else {
        return Ok(Outcome::Conflict { current: None });
    };
    if etag.is_empty() || etag != read_at {
        return Ok(Outcome::Conflict { current: current_of(&card, &etag) });
    }
    let patched = patch_card(&card, person, now)?;
    match put_card(transport, book_url, href, &patched, Some(&etag))? {
        Written::Conflict => {
            // Changed between the read and the write.
            let current = get_card(transport, book_url, href)?.and_then(|(card, etag)| current_of(&card, &etag));
            Ok(Outcome::Conflict { current })
        }
        Written::Saved { etag } => finish(transport, book_url, href, etag, uid, &patched),
    }
}

/// Adds a new card to the book.
pub fn save_new(transport: &dyn Transport, book_url: &str, person: &Person) -> Result<Outcome> {
    let uid = uuid::Uuid::new_v4().to_string();
    let base = if book_url.ends_with('/') { book_url.to_string() } else { format!("{book_url}/") };
    let href = format!("{base}{uid}.vcf");
    let card = new_card(person, &uid);
    match put_card(transport, book_url, &href, &card, None)? {
        // A fresh UUID already taken would be a server bug; nothing was lost.
        Written::Conflict => anyhow::bail!("the server already has a card at that address; nothing was saved"),
        Written::Saved { etag } => finish(transport, book_url, &href, etag, &uid, &card),
    }
}

/// Deletes the card at `href` if it is still at `read_at`.
pub fn delete_existing(transport: &dyn Transport, book_url: &str, href: &str, read_at: &str) -> Result<Outcome> {
    match delete_card(transport, book_url, href, read_at)? {
        Written::Saved { .. } => Ok(Outcome::Deleted),
        Written::Conflict => {
            let current = get_card(transport, book_url, href)?.and_then(|(card, etag)| current_of(&card, &etag));
            Ok(Outcome::Conflict { current })
        }
    }
}

/// After a write: the version the server now holds. A server that sends no
/// ETag on PUT (RFC 6352 allows it when it altered the card) is asked again.
fn finish(
    transport: &dyn Transport,
    book_url: &str,
    href: &str,
    etag: Option<String>,
    uid: &str,
    written: &str,
) -> Result<Outcome> {
    let (card, version) = match etag {
        Some(etag) if !etag.is_empty() => (written.to_string(), etag),
        _ => get_card(transport, book_url, href)?.unwrap_or_else(|| (written.to_string(), String::new())),
    };
    let mut person = people_from_vcards(card.as_bytes()).into_iter().next().unwrap_or_default();
    // The id in the local copy is built from the uid the card was stored
    // under; a server that rewrote it must not split the person in two.
    person.uid = uid.to_string();
    Ok(Outcome::Saved { href: href.to_string(), version, person })
}

fn current_of(card: &str, etag: &str) -> Option<(Person, String)> {
    people_from_vcards(card.as_bytes()).into_iter().next().map(|person| (person, etag.to_string()))
}

// ---- Groups (ADR-0052) ------------------------------------------------------

use crate::contacts::groups::{group_from_properties, new_group_card, patch_group_card, GroupCard, GroupStyle};

/// What became of a write to a group card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupOutcome {
    /// Written: the card's URL, its new version and the group as now stored.
    Saved { href: String, version: String, group: GroupCard },
    Deleted,
    /// Changed or deleted on the server since it was read: nothing was
    /// written. The server's copy and its version, if it is still there.
    Conflict { current: Option<(GroupCard, String)> },
}

fn group_of(card: &str) -> Option<GroupCard> {
    crate::contacts::vcard::split_cards(card.as_bytes()).iter().find_map(|properties| group_from_properties(properties))
}

fn current_group(card: &str, etag: &str) -> Option<(GroupCard, String)> {
    group_of(card).map(|group| (group, etag.to_string()))
}

/// Renames the group card at `href` and adds and removes members, from the
/// version `read_at`. The edit starts from the server's copy, so members and
/// fields this app does not know are kept.
#[allow(clippy::too_many_arguments)]
pub fn save_group_existing(
    transport: &dyn Transport,
    book_url: &str,
    href: &str,
    read_at: &str,
    name: &str,
    add: &[String],
    remove: &[String],
    now: i64,
) -> Result<GroupOutcome> {
    let Some((card, etag)) = get_card(transport, book_url, href)? else {
        return Ok(GroupOutcome::Conflict { current: None });
    };
    if etag.is_empty() || etag != read_at {
        return Ok(GroupOutcome::Conflict { current: current_group(&card, &etag) });
    }
    let patched = patch_group_card(&card, name, add, remove, now)?;
    match put_card(transport, book_url, href, &patched, Some(&etag))? {
        Written::Conflict => {
            let current = get_card(transport, book_url, href)?.and_then(|(card, etag)| current_group(&card, &etag));
            Ok(GroupOutcome::Conflict { current })
        }
        Written::Saved { etag } => finish_group(transport, book_url, href, etag, &patched),
    }
}

/// Adds a new group card to the book, written in `style`.
pub fn save_group_new(
    transport: &dyn Transport,
    book_url: &str,
    name: &str,
    members: &[String],
    style: GroupStyle,
) -> Result<GroupOutcome> {
    let uid = uuid::Uuid::new_v4().to_string();
    let base = if book_url.ends_with('/') { book_url.to_string() } else { format!("{book_url}/") };
    let href = format!("{base}{uid}.vcf");
    let card = new_group_card(name, &uid, members, style);
    match put_card(transport, book_url, &href, &card, None)? {
        Written::Conflict => anyhow::bail!("the server already has a card at that address; nothing was saved"),
        Written::Saved { etag } => finish_group(transport, book_url, &href, etag, &card),
    }
}

/// Deletes the group card at `href` if it is still at `read_at`. Its members'
/// cards are not touched.
pub fn delete_group(transport: &dyn Transport, book_url: &str, href: &str, read_at: &str) -> Result<GroupOutcome> {
    match delete_card(transport, book_url, href, read_at)? {
        Written::Saved { .. } => Ok(GroupOutcome::Deleted),
        Written::Conflict => {
            let current = get_card(transport, book_url, href)?.and_then(|(card, etag)| current_group(&card, &etag));
            Ok(GroupOutcome::Conflict { current })
        }
    }
}

fn finish_group(
    transport: &dyn Transport,
    book_url: &str,
    href: &str,
    etag: Option<String>,
    written: &str,
) -> Result<GroupOutcome> {
    let (card, version) = match etag {
        Some(etag) if !etag.is_empty() => (written.to_string(), etag),
        _ => get_card(transport, book_url, href)?.unwrap_or_else(|| (written.to_string(), String::new())),
    };
    let group = group_of(&card)
        .or_else(|| group_of(written))
        .ok_or_else(|| anyhow::anyhow!("the server did not keep the card as a group"))?;
    Ok(GroupOutcome::Saved { href: href.to_string(), version, group })
}
