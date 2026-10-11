//! The local address book: people kept only on this computer (ADR-0012).
//!
//! Every write names the version it was made from. A different version means
//! the person was changed elsewhere (another window, or later a server) since
//! it was read; nothing is written and the current copy is returned, so the
//! person can choose between the two instead of one silently replacing the
//! other.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::{BookOrigin, StoredPerson};
use crate::contacts::person::Person;

/// Where local people live: no account, one book.
pub fn origin() -> BookOrigin {
    BookOrigin {
        source: "local".into(),
        account: String::new(),
        book: "local".into(),
    }
}

/// The result of a write to the local book.
#[derive(Debug, PartialEq, Eq)]
pub enum Write {
    /// Written; the person's id and the version it now has.
    Saved { id: String, version: String },
    /// Changed elsewhere since it was read: nothing was written. `current` is
    /// the copy that is there now, or `None` if it was deleted meanwhile.
    Conflict { current: Option<Box<StoredPerson>> },
}

/// One local person with the version it is at.
pub fn get(conn: &Connection, id: &str) -> Result<Option<(StoredPerson, String)>> {
    let row = conn
        .query_row(
            "SELECT uid, name, organisation, note, photo, version FROM people
              WHERE id = ?1 AND source = 'local'",
            params![id],
            |row| {
                Ok((
                    Person {
                        uid: row.get(0)?,
                        name: row.get(1)?,
                        organisation: row.get(2)?,
                        note: row.get(3)?,
                        emails: Vec::new(),
                        phones: Vec::new(),
                        photo: None,
                    },
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((mut person, photo_key, version)) = row else {
        return Ok(None);
    };
    let (emails, phones) = super::attachments_for(conn, &[id.to_string()])?;
    person.emails = emails.get(id).cloned().unwrap_or_default();
    person.phones = phones.get(id).cloned().unwrap_or_default();
    Ok(Some((
        StoredPerson {
            id: id.to_string(),
            origin: origin(),
            person,
            photo_key,
            version: version.clone(),
        },
        version,
    )))
}

/// Creates a person (`id` absent) or edits one, from the version it was read at.
pub fn save(
    conn: &Connection,
    id: Option<&str>,
    read_at: Option<&str>,
    person: &Person,
    now: i64,
) -> Result<Write> {
    let person = tidy(person);
    if !person.is_useful() {
        bail!("a contact needs a name or an email address");
    }
    let tx = conn.unchecked_transaction()?;
    let (id, uid, version) = match id {
        None => {
            let uid = uuid::Uuid::new_v4().to_string();
            (origin().person_id(&uid), uid, 1u64)
        }
        Some(id) => {
            let Some((stored, current)) = get(&tx, id)? else {
                return Ok(Write::Conflict { current: None });
            };
            if read_at != Some(current.as_str()) {
                return Ok(Write::Conflict {
                    current: Some(Box::new(stored)),
                });
            }
            (id.to_string(), stored.person.uid, current.parse::<u64>().unwrap_or(0) + 1)
        }
    };
    let origin = origin();
    tx.execute(
        "INSERT INTO people(id, source, account, book, uid, name, organisation, note, photo, updated, version)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, organisation = excluded.organisation, note = excluded.note,
           updated = excluded.updated, version = excluded.version",
        params![
            id,
            origin.source,
            origin.account,
            origin.book,
            uid,
            person.name,
            person.organisation,
            person.note,
            now,
            version.to_string()
        ],
    )?;
    tx.execute("DELETE FROM person_emails WHERE person_id = ?1", params![id])?;
    tx.execute("DELETE FROM person_phones WHERE person_id = ?1", params![id])?;
    for (position, email) in person.emails.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO person_emails(person_id, addr, label, position) VALUES(?1, ?2, ?3, ?4)",
            params![id, email.addr, email.label, position as i64],
        )?;
    }
    for (position, phone) in person.phones.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO person_phones(person_id, number, label, position) VALUES(?1, ?2, ?3, ?4)",
            params![id, phone.number, phone.label, position as i64],
        )?;
    }
    tx.commit()?;
    Ok(Write::Saved {
        id,
        version: version.to_string(),
    })
}

/// Deletes a local person, if it is still at the version it was read at.
pub fn delete(conn: &Connection, id: &str, read_at: &str) -> Result<Write> {
    let tx = conn.unchecked_transaction()?;
    let Some((stored, current)) = get(&tx, id)? else {
        // Already gone is what was asked for.
        return Ok(Write::Saved {
            id: id.to_string(),
            version: String::new(),
        });
    };
    if current != read_at {
        return Ok(Write::Conflict {
            current: Some(Box::new(stored)),
        });
    }
    tx.execute("DELETE FROM person_emails WHERE person_id = ?1", params![id])?;
    tx.execute("DELETE FROM person_phones WHERE person_id = ?1", params![id])?;
    tx.execute("DELETE FROM people WHERE id = ?1", params![id])?;
    tx.commit()?;
    super::person_links::unlink(conn, id)?;
    Ok(Write::Saved {
        id: id.to_string(),
        version: String::new(),
    })
}

/// Trims every field and drops blank addresses and numbers, so an empty row
/// left in the form is not stored as a contact detail.
fn tidy(person: &Person) -> Person {
    let mut tidy = person.clone();
    tidy.name = tidy.name.trim().to_string();
    tidy.organisation = tidy.organisation.trim().to_string();
    tidy.note = tidy.note.trim().to_string();
    tidy.emails.retain(|email| !email.addr.trim().is_empty());
    for email in &mut tidy.emails {
        email.addr = email.addr.trim().to_lowercase();
        email.label = email.label.trim().to_string();
    }
    tidy.phones.retain(|phone| !phone.number.trim().is_empty());
    for phone in &mut tidy.phones {
        phone.number = phone.number.trim().to_string();
        phone.label = phone.label.trim().to_string();
    }
    tidy
}

#[cfg(test)]
mod tests;
