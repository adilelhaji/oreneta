//! Files attached to notes (#104, ADR-0042).
//!
//! Kept inside the store, beside the note, so a full-profile backup carries
//! them and nothing outside the profile has to be found again. A file is read
//! whole before anything is stored, and refused if it is larger than
//! `MAX_FILE_BYTES`; saving one writes beside the destination and renames it
//! into place, so a failure never leaves a cut file under the chosen name.
//! They go with their note when it is deleted for good, and stay while it is
//! only in the trash.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_PER_NOTE: usize = 50;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS note_attachments (
    id         TEXT PRIMARY KEY,
    note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    size       INTEGER NOT NULL,
    data       BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_attachments_note ON note_attachments(note_id);
";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attachment {
    pub id: String,
    pub note_id: String,
    pub filename: String,
    pub size: i64,
    pub created_at: i64,
}

/// A file name that is a name, not a path: no folders, no control characters.
fn clean_name(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim();
    if name.is_empty() { "file".to_string() } else { name.to_string() }
}

pub fn list(conn: &Connection, note_id: &str) -> Result<Vec<Attachment>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, filename, size, created_at FROM note_attachments
          WHERE note_id = ?1 ORDER BY created_at, filename",
    )?;
    let rows = stmt.query_map(params![note_id], |r| {
        Ok(Attachment { id: r.get(0)?, note_id: r.get(1)?, filename: r.get(2)?, size: r.get(3)?, created_at: r.get(4)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Attaches a copy of the file at `path` to a note that is not in the trash.
pub fn attach(conn: &Connection, note_id: &str, path: &Path, now: i64) -> Result<Attachment> {
    let live: Option<Option<i64>> = conn
        .query_row("SELECT deleted_at FROM notes WHERE id = ?1", params![note_id], |r| r.get(0))
        .optional()?;
    match live {
        None => bail!("that note is no longer there"),
        Some(Some(_)) => bail!("restore the note from the trash before attaching files to it"),
        Some(None) => {}
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM note_attachments WHERE note_id = ?1", params![note_id], |r| r.get(0))?;
    if count as usize >= MAX_PER_NOTE {
        bail!("a note can hold {MAX_PER_NOTE} files at most");
    }
    let meta = std::fs::metadata(path).with_context(|| format!("read {}", path.display()))?;
    if !meta.is_file() {
        bail!("{} is not a file", path.display());
    }
    if meta.len() > MAX_FILE_BYTES {
        bail!("{} is larger than 25 MB; attach a link to it instead", clean_name(path));
    }
    let data = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if data.len() as u64 > MAX_FILE_BYTES {
        bail!("{} is larger than 25 MB; attach a link to it instead", clean_name(path));
    }
    let attachment = Attachment {
        id: format!("na:{}", uuid::Uuid::new_v4()),
        note_id: note_id.to_string(),
        filename: clean_name(path),
        size: data.len() as i64,
        created_at: now,
    };
    conn.execute(
        "INSERT INTO note_attachments(id, note_id, filename, size, data, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![attachment.id, attachment.note_id, attachment.filename, attachment.size, data, now],
    )?;
    Ok(attachment)
}

pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM note_attachments WHERE id = ?1", params![id])? == 0 {
        bail!("that file is no longer attached");
    }
    Ok(())
}

/// The attachment's name, for the save dialog.
pub fn filename(conn: &Connection, id: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT filename FROM note_attachments WHERE id = ?1", params![id], |r| r.get(0)).optional()?)
}

/// Writes the attachment to `dest`, beside it first and renamed when whole.
pub fn save(conn: &Connection, id: &str, dest: &Path) -> Result<u64> {
    let data: Vec<u8> = conn
        .query_row("SELECT data FROM note_attachments WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?
        .context("that file is no longer attached")?;
    let partial = dest.with_extension(match dest.extension() {
        Some(ext) => format!("{}.part", ext.to_string_lossy()),
        None => "part".to_string(),
    });
    let written = (|| -> Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&partial).with_context(|| format!("create {}", partial.display()))?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&partial, dest).with_context(|| format!("finish {}", dest.display()))?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    written.map(|_| data.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::notes;

    fn setup() -> (Connection, String, std::path::PathBuf) {
        let conn = crate::store::open_in_memory_for_test().unwrap();
        let note = notes::create(&conn, &notes::NoteFields { title: "Trip".into(), ..Default::default() }, 1).unwrap();
        let dir = std::env::temp_dir().join(format!("oreneta-note-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (conn, note.id, dir)
    }

    #[test]
    fn a_file_is_kept_whole_with_its_name_and_saved_back_the_same() {
        let (conn, note, dir) = setup();
        let source = dir.join("ticket.pdf");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        std::fs::write(&source, &bytes).unwrap();
        let attached = attach(&conn, &note, &source, 5).unwrap();
        assert_eq!((attached.filename.as_str(), attached.size), ("ticket.pdf", 70_000));
        // The copy is the note's own: changing the original changes nothing.
        std::fs::write(&source, b"changed").unwrap();
        let out = dir.join("copy.pdf");
        assert_eq!(save(&conn, &attached.id, &out).unwrap(), 70_000);
        assert_eq!(std::fs::read(&out).unwrap(), bytes);
        assert!(!dir.join("copy.pdf.part").exists());
        assert_eq!(list(&conn, &note).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn too_large_missing_or_a_folder_is_refused_and_nothing_is_stored() {
        let (conn, note, dir) = setup();
        let big = dir.join("big.bin");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(attach(&conn, &note, &big, 1).unwrap_err().to_string().contains("25 MB"));
        assert!(attach(&conn, &note, &dir.join("nowhere"), 1).is_err());
        assert!(attach(&conn, &note, &dir, 1).is_err());
        assert!(attach(&conn, "no-such-note", &big, 1).is_err());
        assert!(list(&conn, &note).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_stay_while_the_note_is_in_the_trash_and_go_with_it_for_good() {
        let (conn, note, dir) = setup();
        let source = dir.join("a.txt");
        std::fs::write(&source, b"a").unwrap();
        attach(&conn, &note, &source, 1).unwrap();
        notes::trash(&conn, &note, 2).unwrap();
        assert!(attach(&conn, &note, &source, 3).unwrap_err().to_string().contains("trash"));
        assert_eq!(list(&conn, &note).unwrap().len(), 1, "kept in the trash");
        notes::restore(&conn, &note).unwrap();
        assert_eq!(list(&conn, &note).unwrap().len(), 1);
        notes::trash(&conn, &note, 4).unwrap();
        notes::purge(&conn, &note).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM note_attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "gone with the note");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_save_leaves_no_partial_file_and_removing_is_once() {
        let (conn, note, dir) = setup();
        let source = dir.join("a.txt");
        std::fs::write(&source, b"a").unwrap();
        let attached = attach(&conn, &note, &source, 1).unwrap();
        assert!(save(&conn, &attached.id, &dir.join("missing/dir/a.txt")).is_err());
        assert!(!dir.join("missing").exists());
        remove(&conn, &attached.id).unwrap();
        assert!(remove(&conn, &attached.id).is_err());
        assert!(save(&conn, &attached.id, &dir.join("b.txt")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
