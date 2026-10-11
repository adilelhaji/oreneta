//! Notes that stand on their own (#104, ADR-0015).
//!
//! A note lives on this computer only: no account owns it, so removing an
//! account never touches it. Its body is rich text, cleaned when stored so
//! nothing that could run is ever kept; pictures travel inside it as
//! `data:image/…`. A plain-text copy is kept beside it for search.
//!
//! Writes name the revision they were made from (ADR-0012): a note changed in
//! another window meanwhile is not overwritten, and both versions are shown.
//! Deleting moves a note to the trash, where it can be restored; the trash
//! forgets notes after `TRASH_DAYS`.

use std::borrow::Cow;

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

/// A note's body, pictures included. Larger ones are refused, not cut.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TAGS: usize = 20;
pub const TRASH_DAYS: i64 = 30;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
           id         TEXT PRIMARY KEY,
           title      TEXT NOT NULL DEFAULT '',
           html       TEXT NOT NULL DEFAULT '',
           text       TEXT NOT NULL DEFAULT '',
           pinned     INTEGER NOT NULL DEFAULT 0,
           revision   INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           deleted_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS note_tags (
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           tag     TEXT NOT NULL COLLATE NOCASE,
           PRIMARY KEY (note_id, tag)
         );
         CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);",
    )?;
    Ok(())
}

/// Keeps the formatting a note editor produces and nothing that could run or
/// reach the network: links only to web, mail and phone addresses, pictures
/// only inline.
pub fn clean_html(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .url_schemes(["http", "https", "mailto", "tel", "data"].into_iter().collect())
        .url_relative(ammonia::UrlRelative::Deny)
        .attribute_filter(|element, attribute, value| {
            let lower = value.trim_start().to_ascii_lowercase();
            if element == "img" && attribute == "src" {
                // A picture from the web would be fetched on display.
                return lower.starts_with("data:image/").then_some(Cow::Borrowed(value));
            }
            if lower.starts_with("data:") {
                return None;
            }
            Some(Cow::Borrowed(value))
        });
    builder.clean(html).to_string()
}

/// The words of a note body, for search and previews.
pub fn plain_text(html: &str) -> String {
    let spaced = html.replace('<', " <");
    let bare = ammonia::Builder::empty().clean(&spaced).to_string();
    let unescaped = bare
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    unescaped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_tags(tags: &[String]) -> Result<Vec<String>> {
    let mut seen: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').trim();
        if tag.is_empty() || seen.iter().any(|known| known.eq_ignore_ascii_case(tag)) {
            continue;
        }
        if tag.chars().count() > 40 {
            bail!("a tag is at most 40 characters");
        }
        seen.push(tag.to_string());
    }
    if seen.len() > MAX_TAGS {
        bail!("a note has at most {MAX_TAGS} tags");
    }
    Ok(seen)
}

/// What the editor writes.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct NoteFields {
    pub title: String,
    pub html: String,
    pub tags: Vec<String>,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub html: String,
    pub text: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// A list row: the body is left out, a short preview stands in.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub revision: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Write {
    Saved { note: Note },
    /// Changed elsewhere since `revision`: nothing was written.
    Conflict { stored: Note },
    /// Deleted for good elsewhere: nothing was written.
    Gone,
}

fn prepared(fields: &NoteFields) -> Result<(String, String, String, Vec<String>)> {
    if fields.html.len() > MAX_BODY_BYTES {
        bail!("this note is too large to keep (pictures included, at most 8 MB)");
    }
    let html = clean_html(&fields.html);
    let text = plain_text(&html);
    let title = fields.title.trim().to_string();
    if title.is_empty() && text.is_empty() && !html.contains("<img") {
        bail!("an empty note is not kept");
    }
    Ok((title, html, text, clean_tags(&fields.tags)?))
}

fn tags_of(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag COLLATE NOCASE")?;
    let rows = stmt.query_map(params![id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn set_tags(conn: &Connection, id: &str, tags: &[String]) -> Result<()> {
    conn.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
    for tag in tags {
        conn.execute("INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES(?1, ?2)", params![id, tag])?;
    }
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Note>> {
    let note = conn
        .query_row(
            "SELECT id, title, html, text, pinned, revision, created_at, updated_at, deleted_at
               FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(Note {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    html: row.get(2)?,
                    text: row.get(3)?,
                    tags: Vec::new(),
                    pinned: row.get::<_, i64>(4)? != 0,
                    revision: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    deleted_at: row.get(8)?,
                })
            },
        )
        .optional()?;
    match note {
        Some(mut note) => {
            note.tags = tags_of(conn, &note.id)?;
            Ok(Some(note))
        }
        None => Ok(None),
    }
}

pub fn create(conn: &Connection, fields: &NoteFields, now: i64) -> Result<Note> {
    let (title, html, text, tags) = prepared(fields)?;
    let id = format!("note:{}", uuid::Uuid::new_v4());
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO notes(id, title, html, text, pinned, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, title, html, text, fields.pinned as i64, now],
    )?;
    set_tags(&tx, &id, &tags)?;
    tx.commit()?;
    Ok(get(conn, &id)?.expect("just stored"))
}

/// Saves an edit made from `revision`. A note in the trash is restored by
/// `restore`, not by editing it.
pub fn update(conn: &Connection, id: &str, revision: i64, fields: &NoteFields, now: i64) -> Result<Write> {
    let (title, html, text, tags) = prepared(fields)?;
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET title = ?3, html = ?4, text = ?5, pinned = ?6, updated_at = ?7, revision = revision + 1
          WHERE id = ?1 AND revision = ?2 AND deleted_at IS NULL",
        params![id, revision, title, html, text, fields.pinned as i64, now],
    )?;
    if changed == 0 {
        drop(tx);
        return Ok(match get(conn, id)? {
            Some(stored) => Write::Conflict { stored },
            None => Write::Gone,
        });
    }
    set_tags(&tx, id, &tags)?;
    tx.commit()?;
    Ok(Write::Saved { note: get(conn, id)?.expect("just stored") })
}

/// Pins or unpins without touching the text; it still counts as a change.
pub fn set_pinned(conn: &Connection, id: &str, pinned: bool, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE notes SET pinned = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
        params![id, pinned as i64, now],
    )?;
    Ok(())
}

/// Moves a note to the trash.
pub fn trash(conn: &Connection, id: &str, now: i64) -> Result<()> {
    if conn.execute(
        "UPDATE notes SET deleted_at = ?2, revision = revision + 1 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )? == 0
    {
        bail!("that note is no longer there");
    }
    Ok(())
}

pub fn restore(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute(
        "UPDATE notes SET deleted_at = NULL, revision = revision + 1 WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )? == 0
    {
        bail!("that note is not in the trash");
    }
    Ok(())
}

/// Deletes a note in the trash for good.
pub fn purge(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL", params![id])? == 0 {
        bail!("only a note in the trash can be deleted for good");
    }
    Ok(())
}

/// Forgets notes that have been in the trash longer than `TRASH_DAYS`.
pub fn tidy_trash(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        params![now - TRASH_DAYS * 86_400],
    )?)
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct Query {
    pub search: String,
    pub tag: String,
    pub trash: bool,
}

fn like(text: &str) -> String {
    let escaped = text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// Pinned first, then most recently changed. Every word searched for must
/// appear in the title, the text or a tag.
pub fn list(conn: &Connection, query: &Query) -> Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, substr(text, 1, 200), pinned, revision, updated_at, deleted_at
           FROM notes
          WHERE (deleted_at IS NOT NULL) = ?1
            AND (?2 = '' OR EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = notes.id AND t.tag = ?2))
          ORDER BY pinned DESC, updated_at DESC, id",
    )?;
    let rows = stmt.query_map(params![query.trash, query.tag.trim()], |row| {
        Ok(NoteSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            preview: row.get(2)?,
            tags: Vec::new(),
            pinned: row.get::<_, i64>(3)? != 0,
            revision: row.get(4)?,
            updated_at: row.get(5)?,
            deleted_at: row.get(6)?,
        })
    })?;
    let words: Vec<String> = query.search.split_whitespace().map(like).collect();
    let mut matches = conn.prepare(
        "SELECT 1 FROM notes n WHERE n.id = ?1 AND (n.title LIKE ?2 ESCAPE '\\' OR n.text LIKE ?2 ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag LIKE ?2 ESCAPE '\\'))",
    )?;
    let mut out = Vec::new();
    for row in rows {
        let mut note = row?;
        let mut keep = true;
        for word in &words {
            if !matches.exists(params![note.id, word])? {
                keep = false;
                break;
            }
        }
        if keep {
            note.tags = tags_of(conn, &note.id)?;
            out.push(note);
        }
    }
    Ok(out)
}

/// Every tag in use outside the trash, with how many notes carry it.
pub fn tags(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT t.tag, COUNT(*) FROM note_tags t JOIN notes n ON n.id = t.note_id
          WHERE n.deleted_at IS NULL GROUP BY t.tag COLLATE NOCASE ORDER BY t.tag COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
