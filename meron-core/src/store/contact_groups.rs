//! Contact groups (ADR-0052): the local book's own, and copies of a CardDAV
//! book's group cards and a Google account's labels.
//!
//! A group belongs to one book, like a person. Its members are kept by person
//! id: for a synced book that is the id of the card the group names by UID in
//! the same book, so a re-sync that rewrites the people keeps the groups
//! pointing at them. A local group may hold anybody in any book — it is the
//! reader's own list, and nothing outside this computer reads it.
//!
//! Writes to the local book follow ADR-0012: each names the version it was
//! read at, and a different version saves nothing and answers with the copy
//! that is there now.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::BookOrigin;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS contact_groups (
  id      TEXT PRIMARY KEY,
  source  TEXT NOT NULL,
  account TEXT NOT NULL,
  book    TEXT NOT NULL,
  uid     TEXT NOT NULL,
  name    TEXT NOT NULL,
  href    TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  style   TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_groups_origin ON contact_groups(source, account, book, uid);
CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id  TEXT NOT NULL,
  person_id TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, person_id)
);
CREATE INDEX IF NOT EXISTS contact_group_members_person ON contact_group_members(person_id);
";

/// The schema step: the groups, a person's given and family names, and how a
/// CardDAV book writes its groups. Columns are checked first so a database
/// whose recorded version was set back does not fail on one it has.
pub fn migrate(conn: &Connection) -> Result<()> {
    let has = |table: &str, column: &str| -> rusqlite::Result<bool> {
        conn.prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}'"))?
            .exists([])
    };
    if !has("people", "given")? {
        conn.execute_batch("ALTER TABLE people ADD COLUMN given TEXT NOT NULL DEFAULT '';")?;
    }
    if !has("people", "family")? {
        conn.execute_batch("ALTER TABLE people ADD COLUMN family TEXT NOT NULL DEFAULT '';")?;
    }
    if !has("contact_sources", "group_style")? {
        conn.execute_batch("ALTER TABLE contact_sources ADD COLUMN group_style TEXT NOT NULL DEFAULT '';")?;
    }
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// Schema 64 (ADR-0058): a member who is no card of the book can carry the
/// name and address the book's server gave for them — an Exchange
/// distribution list's addresses typed in and directory entries. Without
/// them such a list would show and expand to nobody.
pub fn migrate_member_addresses(conn: &Connection) -> Result<()> {
    for column in ["name", "addr"] {
        let has = conn
            .prepare(&format!("SELECT 1 FROM pragma_table_info('contact_group_members') WHERE name = '{column}'"))?
            .exists([])?;
        if !has {
            conn.execute_batch(&format!(
                "ALTER TABLE contact_group_members ADD COLUMN {column} TEXT NOT NULL DEFAULT '';"
            ))?;
        }
    }
    Ok(())
}

/// Gives members who are no card of the book the name and address their
/// server gave, as `(person id, name, address)`. A member a card stands for
/// is shown from the card and needs none.
pub fn label_members(conn: &Connection, group_id: &str, labels: &[(String, String, String)]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    label_in(&tx, group_id, labels)?;
    tx.commit()?;
    Ok(())
}

fn label_in(conn: &Connection, group_id: &str, labels: &[(String, String, String)]) -> Result<()> {
    for (person, name, addr) in labels {
        conn.execute(
            "UPDATE contact_group_members SET name = ?3, addr = ?4 WHERE group_id = ?1 AND person_id = ?2",
            params![group_id, person, name, addr],
        )?;
    }
    Ok(())
}

/// The labels of each group's members who are no card of the book, by the
/// group's UID: see [`label_members`].
pub type GroupLabels = [(String, Vec<(String, String, String)>)];

/// The id a group is kept under: apart from people's, so the two can never
/// be confused.
pub fn group_id(origin: &BookOrigin, uid: &str) -> String {
    format!("group:{}", origin.person_id(uid))
}

/// A group as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredGroup {
    pub id: String,
    pub origin: BookOrigin,
    pub uid: String,
    pub name: String,
    /// The group card's URL, for a CardDAV group.
    pub href: String,
    /// The version it was read at: an ETag, or the local revision.
    pub version: String,
    /// "vcard4" or "apple" for a CardDAV group; empty otherwise.
    pub style: String,
    /// Person ids, in the group's order.
    pub members: Vec<String>,
}

/// A group as a sync read it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GroupRow {
    pub uid: String,
    pub name: String,
    /// The members' UIDs in the same book.
    pub members: Vec<String>,
    pub href: String,
    pub version: String,
    pub style: String,
}

fn members_of(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT person_id FROM contact_group_members WHERE group_id = ?1 ORDER BY position, person_id")?;
    let rows = stmt.query_map(params![id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

const COLUMNS: &str = "id, source, account, book, uid, name, href, version, style";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<StoredGroup> {
    Ok(StoredGroup {
        id: row.get(0)?,
        origin: BookOrigin { source: row.get(1)?, account: row.get(2)?, book: row.get(3)? },
        uid: row.get(4)?,
        name: row.get(5)?,
        href: row.get(6)?,
        version: row.get(7)?,
        style: row.get(8)?,
        members: Vec::new(),
    })
}

/// Every group, by name.
pub fn list(conn: &Connection) -> Result<Vec<StoredGroup>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM contact_groups ORDER BY name COLLATE NOCASE, id"))?;
    let mut groups: Vec<StoredGroup> = stmt.query_map([], from_row)?.collect::<rusqlite::Result<_>>()?;
    for group in &mut groups {
        group.members = members_of(conn, &group.id)?;
    }
    Ok(groups)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<StoredGroup>> {
    let found = conn
        .query_row(&format!("SELECT {COLUMNS} FROM contact_groups WHERE id = ?1"), params![id], from_row)
        .optional()?;
    let Some(mut group) = found else { return Ok(None) };
    group.members = members_of(conn, id)?;
    Ok(Some(group))
}

fn insert(
    conn: &Connection,
    origin: &BookOrigin,
    row: &GroupRow,
    members: &[String],
    now: i64,
) -> Result<String> {
    let id = group_id(origin, row.uid.trim());
    conn.execute(
        "INSERT OR REPLACE INTO contact_groups(id, source, account, book, uid, name, href, version, style, updated)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            origin.source,
            origin.account,
            origin.book,
            row.uid.trim(),
            row.name,
            row.href,
            row.version,
            row.style,
            now
        ],
    )?;
    conn.execute("DELETE FROM contact_group_members WHERE group_id = ?1", params![id])?;
    for (position, person) in members.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO contact_group_members(group_id, person_id, position) VALUES(?1, ?2, ?3)",
            params![id, person, position as i64],
        )?;
    }
    Ok(id)
}

/// Replaces every group of one book with what a sync just read, like
/// [`super::replace_book_rows`] does for its people.
pub fn replace_book_groups(conn: &Connection, origin: &BookOrigin, rows: &[GroupRow], now: i64) -> Result<usize> {
    replace_book_groups_labelled(conn, origin, rows, &[], now)
}

/// [`replace_book_groups`], with the labels of members who are no card of
/// the book written in the same transaction (ADR-0058).
pub fn replace_book_groups_labelled(
    conn: &Connection,
    origin: &BookOrigin,
    rows: &[GroupRow],
    labels: &GroupLabels,
    now: i64,
) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM contact_group_members WHERE group_id IN
           (SELECT id FROM contact_groups WHERE source = ?1 AND account = ?2 AND book = ?3)",
        params![origin.source, origin.account, origin.book],
    )?;
    tx.execute(
        "DELETE FROM contact_groups WHERE source = ?1 AND account = ?2 AND book = ?3",
        params![origin.source, origin.account, origin.book],
    )?;
    let mut written = 0;
    for row in rows {
        if row.uid.trim().is_empty() {
            continue;
        }
        let members: Vec<String> = row.members.iter().map(|uid| origin.person_id(uid.trim())).collect();
        insert(&tx, origin, row, &members, now)?;
        written += 1;
    }
    for (uid, members) in labels {
        label_in(&tx, &group_id(origin, uid.trim()), members)?;
    }
    tx.commit()?;
    Ok(written)
}

/// Records one synced group as the server now holds it, after a write there.
pub fn put_synced_group(conn: &Connection, origin: &BookOrigin, row: &GroupRow, now: i64) -> Result<String> {
    put_synced_group_labelled(conn, origin, row, &[], now)
}

/// [`put_synced_group`], with the labels of members who are no card of the
/// book written in the same transaction (ADR-0058).
pub fn put_synced_group_labelled(
    conn: &Connection,
    origin: &BookOrigin,
    row: &GroupRow,
    labels: &[(String, String, String)],
    now: i64,
) -> Result<String> {
    let tx = conn.unchecked_transaction()?;
    let members: Vec<String> = row.members.iter().map(|uid| origin.person_id(uid.trim())).collect();
    let id = insert(&tx, origin, row, &members, now)?;
    label_in(&tx, &id, labels)?;
    tx.commit()?;
    Ok(id)
}

/// Drops a group from the local copy (after its card was deleted, or for a
/// local group, as the deletion itself).
pub fn forget_group(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM contact_group_members WHERE group_id = ?1", params![id])?;
    conn.execute("DELETE FROM contact_groups WHERE id = ?1", params![id])?;
    Ok(())
}

/// Drops every group of a book (when the book goes).
pub fn forget_book(conn: &Connection, origin: &BookOrigin) -> Result<()> {
    replace_book_groups(conn, origin, &[], 0).map(|_| ())
}

/// The way a CardDAV book writes its groups, as its last sync found ("" when
/// not known).
pub fn book_style(conn: &Connection, book: &str) -> Result<String> {
    Ok(conn
        .query_row("SELECT group_style FROM contact_sources WHERE id = ?1", params![book], |row| row.get(0))
        .optional()?
        .unwrap_or_default())
}

pub fn set_book_style(conn: &Connection, book: &str, style: &str) -> Result<()> {
    conn.execute("UPDATE contact_sources SET group_style = ?2 WHERE id = ?1", params![book, style])?;
    Ok(())
}

/// One member of a group with what a list or the composer shows of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberDetail {
    pub group_id: String,
    pub person_id: String,
    pub name: String,
    pub given: String,
    pub family: String,
    /// Their first address; empty when they have none.
    pub addr: String,
}

/// Every group's members who are still in the address book, in order, and
/// those who are no card of it but have an address their server gave
/// (ADR-0058).
pub fn member_details(conn: &Connection) -> Result<Vec<MemberDetail>> {
    let mut stmt = conn.prepare(
        "SELECT m.group_id, m.person_id,
                CASE WHEN p.id IS NULL THEN CASE WHEN m.name <> '' THEN m.name ELSE m.addr END ELSE p.name END,
                COALESCE(p.given, ''), COALESCE(p.family, ''),
                CASE WHEN p.id IS NULL THEN m.addr
                     ELSE COALESCE((SELECT e.addr FROM person_emails e WHERE e.person_id = p.id
                                     ORDER BY e.position LIMIT 1), '') END
           FROM contact_group_members m LEFT JOIN people p ON p.id = m.person_id
          WHERE p.id IS NOT NULL OR m.addr <> ''
          ORDER BY m.group_id, m.position, COALESCE(p.name, m.name) COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(MemberDetail {
            group_id: row.get(0)?,
            person_id: row.get(1)?,
            name: row.get(2)?,
            given: row.get(3)?,
            family: row.get(4)?,
            addr: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The address book's names for these (lower-cased) addresses, as
/// `(addr, name, given, family)`. The local book's come first, then the
/// others by name, so a caller keeping the first per address is consistent.
pub fn book_names(conn: &Connection, addrs: &[String]) -> Result<Vec<(String, String, String, String)>> {
    let mut out = Vec::new();
    // Bounded per call: a list asks about one screenful of senders.
    for chunk in addrs.chunks(200) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT e.addr, p.name, p.given, p.family FROM person_emails e JOIN people p ON p.id = e.person_id
              WHERE e.addr IN ({placeholders}) AND p.name <> ''
              ORDER BY e.addr, p.source <> 'local', p.name COLLATE NOCASE"
        ))?;
        let bound: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|addr| addr as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(bound.as_slice(), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(out)
}

/// The local book.
pub fn local_origin() -> BookOrigin {
    super::local_people::origin()
}

/// The result of a write to a local group.
#[derive(Debug, PartialEq, Eq)]
pub enum Write {
    Saved { id: String, version: String },
    /// Changed or deleted elsewhere since it was read: nothing was written.
    Conflict { current: Option<Box<StoredGroup>> },
}

/// Creates a local group (`id` absent) or renames one and sets its members,
/// from the version it was read at. Members that are nobody in the address
/// book any more are left out.
pub fn save_local(
    conn: &Connection,
    id: Option<&str>,
    read_at: Option<&str>,
    name: &str,
    members: &[String],
    now: i64,
) -> Result<Write> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a group needs a name");
    }
    let tx = conn.unchecked_transaction()?;
    let origin = local_origin();
    let (uid, version) = match id {
        None => (uuid::Uuid::new_v4().to_string(), 1u64),
        Some(id) => {
            let Some(current) = get(&tx, id)?.filter(|group| group.origin.source == "local") else {
                return Ok(Write::Conflict { current: None });
            };
            if read_at != Some(current.version.as_str()) {
                return Ok(Write::Conflict { current: Some(Box::new(current)) });
            }
            (current.uid.clone(), current.version.parse::<u64>().unwrap_or(0) + 1)
        }
    };
    let mut kept: Vec<String> = Vec::new();
    for member in members {
        let exists = tx.prepare("SELECT 1 FROM people WHERE id = ?1")?.exists(params![member])?;
        if exists && !kept.contains(member) {
            kept.push(member.clone());
        }
    }
    let row = GroupRow {
        uid,
        name: name.to_string(),
        version: version.to_string(),
        ..Default::default()
    };
    let id = insert(&tx, &origin, &row, &kept, now)?;
    tx.commit()?;
    Ok(Write::Saved { id, version: version.to_string() })
}

/// Deletes a local group if it is still at the version it was read at. Its
/// members stay in the address book: a group is a list, not who is on it.
pub fn delete_local(conn: &Connection, id: &str, read_at: &str) -> Result<Write> {
    let tx = conn.unchecked_transaction()?;
    let Some(current) = get(&tx, id)? else {
        return Ok(Write::Saved { id: id.to_string(), version: String::new() });
    };
    if current.origin.source != "local" {
        bail!("this group is not in the local address book");
    }
    if current.version != read_at {
        return Ok(Write::Conflict { current: Some(Box::new(current)) });
    }
    forget_group(&tx, id)?;
    tx.commit()?;
    Ok(Write::Saved { id: id.to_string(), version: String::new() })
}

#[cfg(test)]
mod tests;
