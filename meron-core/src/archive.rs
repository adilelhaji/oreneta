//! The local mail archive: messages kept on this computer only (ADR-0014).
//!
//! An account like any other to the rest of the core — folders, threads,
//! search, flags, moves — whose "server" is this database. Mail arrives by
//! importing `.eml` and `.mbox` files, or by copying or moving it in from a
//! real account; it never syncs, sends or reaches the network. Each message's
//! original bytes are kept beside its parsed form, so it can be read again,
//! exported or copied back to a server exactly as it came.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::imap::{self, MessageHeader, RawMessageCopy};
use crate::parse;
use crate::store;

/// The archive's account id. There is one archive per profile.
pub const ACCOUNT: &str = "local-archive";
/// The folder imports go to unless another is named.
pub const DEFAULT_FOLDER: &str = "INBOX";
pub const TRASH: &str = "Trash";
/// A single message over this is not mail anyone wants archived whole.
pub const MAX_MESSAGE_BYTES: usize = 100 * 1024 * 1024;
/// An import file over this is refused before it is read: it is read whole.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS archive_messages (
  account TEXT NOT NULL,
  folder  TEXT NOT NULL,
  uid     INTEGER NOT NULL,
  raw     BLOB NOT NULL,
  PRIMARY KEY (account, folder, uid)
);
";

/// Creates the archive account the first time it is needed. It has no
/// password, no host and nothing to sync.
pub fn ensure_account(conn: &Connection, now: i64) -> Result<bool> {
    let exists = conn.prepare("SELECT 1 FROM accounts WHERE id = ?1")?.exists(params![ACCOUNT])?;
    if exists {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO accounts(id, engine, provider, email, display_name, avatar_url, config,
                              created_at, updated_at, sender_name, sort_order)
         VALUES(?1, 'mail', 'local', '', ?2, '', ?3, ?4, ?4, '',
                COALESCE((SELECT MAX(sort_order) + 1 FROM accounts), 0))",
        params![ACCOUNT, "Local archive", r#"{"auth_type":"local_archive","host":"","tls":true}"#, now],
    )?;
    store::upsert_folders(
        conn,
        ACCOUNT,
        &[
            imap::Folder { name: DEFAULT_FOLDER.into(), display_name: DEFAULT_FOLDER.into(), ..Default::default() },
            imap::Folder {
                name: TRASH.into(),
                display_name: TRASH.into(),
                special_use: Some("trash".into()),
                ..Default::default()
            },
        ],
    )?;
    Ok(true)
}

/// Splits an mbox file into messages. Each starts at a `From ` line at the
/// start of a line; `>From ` quoting (mboxrd) is undone in the body.
pub fn split_mbox(file: &[u8]) -> Vec<Vec<u8>> {
    let mut messages: Vec<Vec<u8>> = Vec::new();
    let mut current: Option<Vec<u8>> = None;
    for line in file.split_inclusive(|byte| *byte == b'\n') {
        if line.starts_with(b"From ") {
            if let Some(done) = current.take() {
                messages.push(done);
            }
            current = Some(Vec::new());
            continue;
        }
        let Some(message) = current.as_mut() else {
            // Text before the first separator is not a message.
            continue;
        };
        // mboxrd: one level of `>` before `From ` was added on export.
        let unquoted = if line.starts_with(b">") && line.iter().skip_while(|b| **b == b'>').take(5).eq(b"From ".iter()) {
            &line[1..]
        } else {
            line
        };
        message.extend_from_slice(unquoted);
    }
    if let Some(done) = current {
        messages.push(done);
    }
    messages
        .into_iter()
        .map(|mut message| {
            // The blank line that separates messages belongs to neither.
            while message.ends_with(b"\n") && (message.ends_with(b"\n\n") || message.ends_with(b"\r\n\r\n")) {
                message.pop();
                if message.ends_with(b"\r") {
                    message.pop();
                }
            }
            message
        })
        .filter(|message| !message.is_empty())
        .collect()
}

/// Whether bytes look like one mail message: a header block with at least one
/// of the fields every message has.
pub fn looks_like_message(raw: &[u8]) -> bool {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n"));
    let header = &raw[..end.unwrap_or(raw.len().min(64 * 1024))];
    let text = String::from_utf8_lossy(header).to_ascii_lowercase();
    ["\nfrom:", "\ndate:", "\nsubject:", "\nmessage-id:"]
        .iter()
        .any(|field| text.contains(field) || text.starts_with(&field[1..]))
}

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ImportSummary {
    pub imported: usize,
    /// Already in the folder (same Message-ID): not added twice.
    pub duplicates: usize,
    /// Not a message, or over the size limit.
    pub skipped: usize,
}

fn header_block(raw: &[u8]) -> &[u8] {
    match raw.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(end) => &raw[..end + 4],
        None => match raw.windows(2).position(|w| w == b"\n\n") {
            Some(end) => &raw[..end + 2],
            None => raw,
        },
    }
}

fn next_uid(conn: &Connection, account: &str, folder: &str) -> Result<u32> {
    Ok(conn.query_row(
        "SELECT MAX(COALESCE((SELECT MAX(uid) FROM messages WHERE account = ?1 AND folder = ?2), 0),
                    COALESCE((SELECT MAX(uid) FROM archive_messages WHERE account = ?1 AND folder = ?2), 0)) + 1",
        params![account, folder],
        |row| row.get::<_, i64>(0),
    )? as u32)
}

/// Stores one message in a folder of the archive, as a synced message would
/// be stored, with its original bytes. Returns its uid.
pub fn store_message(
    conn: &Connection,
    account: &str,
    folder: &str,
    raw: &[u8],
    seen: bool,
    starred: bool,
    media_root: &std::path::Path,
) -> Result<u32> {
    let uid = next_uid(conn, account, folder)?;
    let fields = imap::header_fields(header_block(raw));
    let thread_key = imap::thread_key(None, &fields.message_id, &fields.in_reply_to, &fields.references_root, uid);
    let media = parse::MediaCtx {
        root: media_root.to_path_buf(),
        account: account.to_string(),
        folder: folder.to_string(),
        uid,
    };
    let message = parse::parse_message(raw, Some(&media));
    let header = MessageHeader {
        uid,
        folder: folder.to_string(),
        subject: fields.subject,
        from_name: fields.from_name,
        from_addr: fields.from_addr,
        date: fields.date,
        seen,
        starred,
        thread_key,
        message_id: fields.message_id,
        in_reply_to: fields.in_reply_to,
        has_attachments: Some(!message.attachments.is_empty()),
        to: fields.to,
        cc: fields.cc,
        ..Default::default()
    };
    let tx = conn.unchecked_transaction()?;
    store::ensure_folder(&tx, account, folder)?;
    tx.execute(
        "INSERT OR REPLACE INTO archive_messages(account, folder, uid, raw) VALUES(?1, ?2, ?3, ?4)",
        params![account, folder, uid, raw],
    )?;
    store::upsert_messages_in_transaction(&tx, account, folder, &[header])?;
    store::save_cached_message(&tx, account, folder, uid, &message)?;
    tx.commit()?;
    Ok(uid)
}

/// Imports messages into a folder: duplicates by Message-ID are skipped, as
/// is anything that is not a message or is too large. Imported mail is
/// marked read; it is old mail being filed, not new mail arriving.
pub fn import(
    conn: &Connection,
    folder: &str,
    messages: Vec<Vec<u8>>,
    media_root: &std::path::Path,
) -> Result<ImportSummary> {
    let folder = folder.trim();
    if folder.is_empty() {
        bail!("a folder is needed to import into");
    }
    let mut summary = ImportSummary::default();
    let mut known: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT lower(json_extract(json, '$.message_id')) FROM messages
              WHERE account = ?1 AND folder = ?2 AND json_extract(json, '$.message_id') IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![ACCOUNT, folder], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for raw in messages {
        if raw.len() > MAX_MESSAGE_BYTES || !looks_like_message(&raw) {
            summary.skipped += 1;
            continue;
        }
        let id = imap::header_fields(header_block(&raw)).message_id.to_lowercase();
        if !id.is_empty() && !known.insert(id) {
            summary.duplicates += 1;
            continue;
        }
        store_message(conn, ACCOUNT, folder, &raw, true, false, media_root)?;
        summary.imported += 1;
    }
    Ok(summary)
}

/// The messages in one file: an `.mbox` holds many, anything else is one.
/// Decided by content as well as name, since exports are often misnamed.
pub fn read_file(path: &std::path::Path) -> Result<Vec<Vec<u8>>> {
    let size = std::fs::metadata(path).with_context(|| format!("read {}", path.display()))?.len();
    if size > MAX_FILE_BYTES {
        bail!("{} is larger than 1 GB; split it and import the parts", path.display());
    }
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let named_mbox = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mbox") || e.eq_ignore_ascii_case("mbx"));
    if named_mbox || bytes.starts_with(b"From ") {
        Ok(split_mbox(&bytes))
    } else {
        Ok(vec![bytes])
    }
}

/// What importing these files into `folder` would do, before anything is
/// stored.
pub fn preview(conn: &Connection, folder: &str, files: &[Vec<Vec<u8>>]) -> Result<ImportSummary> {
    let mut known: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT lower(json_extract(json, '$.message_id')) FROM messages
              WHERE account = ?1 AND folder = ?2 AND json_extract(json, '$.message_id') IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![ACCOUNT, folder], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut summary = ImportSummary::default();
    for raw in files.iter().flatten() {
        if raw.len() > MAX_MESSAGE_BYTES || !looks_like_message(raw) {
            summary.skipped += 1;
            continue;
        }
        let id = imap::header_fields(header_block(raw)).message_id.to_lowercase();
        if !id.is_empty() && !known.insert(id) {
            summary.duplicates += 1;
        } else {
            summary.imported += 1;
        }
    }
    Ok(summary)
}

/// The original bytes of a message in the archive.
pub fn raw(conn: &Connection, account: &str, folder: &str, uid: u32) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT raw FROM archive_messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, uid],
            |row| row.get(0),
        )
        .optional()?)
}

/// The archive as a mail session: every operation answered from this database.
pub struct LocalSession {
    db: Arc<Mutex<Connection>>,
    account: String,
    /// The folder later folder-less calls (`fetch_full_message`) address,
    /// as IMAP's SELECT would set it.
    selected: String,
}

impl LocalSession {
    pub fn new(db: Arc<Mutex<Connection>>, account: &str) -> Self {
        Self { db, account: account.to_string(), selected: DEFAULT_FOLDER.into() }
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap()
    }

    pub fn list_folders(&self) -> Result<Vec<imap::Folder>> {
        store::get_folders(&self.conn(), &self.account)
    }

    pub fn create_folder(&self, name: &str) -> Result<()> {
        store::ensure_folder(&self.conn(), &self.account, name.trim())
    }

    pub fn delete_folders(&self, names: &[String]) -> Result<Vec<String>> {
        let conn = self.conn();
        for name in names {
            conn.execute(
                "DELETE FROM archive_messages WHERE account = ?1 AND folder = ?2",
                params![self.account, name],
            )?;
        }
        Ok(names.to_vec())
    }

    pub fn fetch_recent(&mut self, folder: &str, limit: u32) -> Result<imap::RecentBatch> {
        self.selected = folder.to_string();
        let messages = store::recent_headers(&self.conn(), &self.account, folder, limit as i64)?;
        let uid_next = next_uid(&self.conn(), &self.account, folder)?;
        Ok(imap::RecentBatch { uidvalidity: 1, uid_next, messages })
    }

    pub fn list_all_uids(&self, folder: &str) -> Result<HashSet<u32>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT uid FROM archive_messages WHERE account = ?1 AND folder = ?2")?;
        let rows = stmt.query_map(params![self.account, folder], |row| row.get::<_, u32>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn select(&mut self, folder: &str) {
        self.selected = folder.to_string();
    }

    fn parse(&self, folder: &str, uid: u32, media: Option<&parse::MediaCtx>) -> Result<parse::Message> {
        let raw = raw(&self.conn(), &self.account, folder, uid)?
            .with_context(|| format!("message {uid} is not in the archive's {folder}"))?;
        Ok(parse::parse_message(&raw, media))
    }

    pub fn read_message(&mut self, folder: &str, uid: u32, media: &parse::MediaCtx) -> Result<parse::Message> {
        self.selected = folder.to_string();
        self.parse(folder, uid, Some(media))
    }

    pub fn fetch_full_message(&self, uid: u32, media: &parse::MediaCtx) -> Result<Option<parse::Message>> {
        match raw(&self.conn(), &self.account, &self.selected, uid)? {
            Some(raw) => Ok(Some(parse::parse_message(&raw, Some(media)))),
            None => Ok(None),
        }
    }

    pub fn fetch_bodies(
        &self,
        folder: &str,
        uids: &[u32],
        media_root: &std::path::Path,
    ) -> Result<Vec<(u32, parse::Message)>> {
        let mut out = Vec::new();
        for uid in uids {
            let media = parse::MediaCtx {
                root: media_root.to_path_buf(),
                account: self.account.clone(),
                folder: folder.to_string(),
                uid: *uid,
            };
            if let Ok(message) = self.parse(folder, *uid, Some(&media)) {
                out.push((*uid, message));
            }
        }
        Ok(out)
    }

    pub fn raw_for_copy(&self, folder: &str, uids: &[u32]) -> Result<Vec<RawMessageCopy>> {
        let conn = self.conn();
        let mut out = Vec::new();
        for uid in uids {
            let flags: Option<(bool, bool)> = conn
                .query_row(
                    "SELECT seen, starred FROM messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                    params![self.account, folder, uid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some(raw) = raw(&conn, &self.account, folder, *uid)? {
                let (seen, starred) = flags.unwrap_or((true, false));
                out.push(RawMessageCopy { raw, seen, starred });
            }
        }
        Ok(out)
    }

    /// A message copied in from another account (or another archive folder).
    pub fn append(&self, folder: &str, message: &RawMessageCopy) -> Result<()> {
        store_message(&self.conn(), &self.account, folder, &message.raw, message.seen, message.starred, &parse::media_root())?;
        Ok(())
    }

    /// Copies within the archive: the target gets complete messages; the
    /// caller refreshes its list from here afterwards.
    pub fn copy_within(&self, from: &str, to: &str, uids: &[u32]) -> Result<usize> {
        let copies = self.raw_for_copy(from, uids)?;
        for copy in &copies {
            self.append(to, copy)?;
        }
        Ok(copies.len())
    }

    /// A move is a copy and then the source's originals go; the caller drops
    /// the source rows from the message list, as it does for a server move.
    pub fn move_to_folder(&self, from: &str, to: &str, uids: &[u32]) -> Result<()> {
        self.copy_within(from, to, uids)?;
        self.expunge(from, uids)
    }

    pub fn expunge(&self, folder: &str, uids: &[u32]) -> Result<()> {
        let conn = self.conn();
        for uid in uids {
            conn.execute(
                "DELETE FROM archive_messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![self.account, folder, uid],
            )?;
        }
        store::delete_messages_by_uid(&conn, &self.account, folder, uids)?;
        Ok(())
    }

    pub fn empty_folder(&self, folder: &str) -> Result<u32> {
        let uids: Vec<u32> = self.list_all_uids(folder)?.into_iter().collect();
        self.expunge(folder, &uids)?;
        Ok(uids.len() as u32)
    }
}

/// What the archive cannot do: it has no server to send through or to keep
/// calendars on.
pub fn unsupported<T>(operation: &str) -> Result<T> {
    Err(anyhow::anyhow!("the local archive cannot {operation}: it is kept only on this computer"))
}

#[cfg(test)]
mod tests;
