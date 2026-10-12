//! Every attachment of the mail kept on this computer, in one list (#93).
//!
//! Read from the attachment lists stored with each downloaded message: no
//! second index, nothing that can drift. Which messages that covers is said
//! with every answer: a message whose body was never downloaded has
//! attachments nobody here knows about, and a list that does not say so would
//! read as "there are none". File contents are not searched (ADR-0020).

use anyhow::Result;
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Query {
    /// Empty means every mail account.
    pub account: String,
    /// Words that must appear in the file name.
    pub name: String,
    /// Part of the sender's name or address.
    pub sender: String,
    /// "image", "pdf", "document", "spreadsheet", "presentation", "archive",
    /// "audio", "video", "calendar", "other", or empty for all.
    pub kind: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub account: String,
    pub folder: String,
    pub uid: i64,
    pub thread_key: String,
    /// The conversation to open for this file, as the interface names it.
    /// Filled in by the caller, which knows how thread ids are spelled.
    pub thread_id: String,
    pub subject: String,
    pub from_name: String,
    pub from_addr: String,
    pub date: i64,
    /// Position among the message's attachments: with the message, what
    /// identifies the file.
    pub index: i64,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    /// Where the bytes are on disk, when they are.
    pub key: Option<String>,
    pub kind: String,
    /// Why the bytes cannot be had, when the provider will not hand them over.
    pub unavailable: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Coverage {
    /// Messages kept here, in the accounts asked about.
    pub messages: i64,
    /// Of those, the ones whose body (and so attachment list) is downloaded.
    pub downloaded: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Page {
    pub items: Vec<Item>,
    pub total: i64,
    pub coverage: Coverage,
}

pub const MAX_LIMIT: u32 = 500;

const KINDS: &[(&str, &[&str], &[&str])] = &[
    ("image", &["image/"], &["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg", "tif", "tiff"]),
    ("pdf", &["application/pdf"], &["pdf"]),
    ("spreadsheet", &["spreadsheet", "excel", "text/csv"], &["xls", "xlsx", "ods", "csv", "numbers"]),
    ("presentation", &["presentation", "powerpoint"], &["ppt", "pptx", "odp", "key"]),
    ("document", &["msword", "wordprocessing", "opendocument.text", "text/plain", "rtf"], &["doc", "docx", "odt", "txt", "rtf", "pages", "md"]),
    ("archive", &["zip", "x-7z", "x-rar", "x-tar", "gzip"], &["zip", "7z", "rar", "tar", "gz", "tgz"]),
    ("audio", &["audio/"], &["mp3", "m4a", "wav", "ogg", "flac"]),
    ("video", &["video/"], &["mp4", "mov", "webm", "mkv", "avi"]),
    ("calendar", &["text/calendar", "application/ics"], &["ics"]),
];

/// What sort of file this is, from its type or else its extension.
pub fn kind_of(mime: &str, filename: &str) -> &'static str {
    let mime = mime.to_ascii_lowercase();
    let ext = filename.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    for (kind, mimes, _) in KINDS {
        if mimes.iter().any(|m| mime.contains(m)) {
            return kind;
        }
    }
    for (kind, _, exts) in KINDS {
        if exts.contains(&ext.as_str()) {
            return kind;
        }
    }
    "other"
}

fn like(text: &str) -> String {
    format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

pub fn list(conn: &Connection, query: &Query) -> Result<Page> {
    let mut filters = vec!["m.json LIKE '%\"attachments\":[{%'".to_string()];
    let mut args: Vec<Value> = Vec::new();
    // Mail only: feed items keep their enclosures elsewhere and are not mail.
    filters.push("m.uid > 0".into());
    if !query.account.is_empty() {
        args.push(Value::Text(query.account.clone()));
        filters.push(format!("m.account = ?{}", args.len()));
    }
    if !query.sender.trim().is_empty() {
        args.push(Value::Text(like(query.sender.trim())));
        let n = args.len();
        filters.push(format!("(m.from_name LIKE ?{n} ESCAPE '\\' OR m.from_addr LIKE ?{n} ESCAPE '\\')"));
    }
    for word in query.name.split_whitespace() {
        args.push(Value::Text(like(word)));
        filters.push(format!("json_extract(a.value, '$.filename') LIKE ?{} ESCAPE '\\'", args.len()));
    }
    if let Some(from) = query.from {
        args.push(Value::Integer(from));
        filters.push(format!("m.date >= ?{}", args.len()));
    }
    if let Some(to) = query.to {
        args.push(Value::Integer(to));
        filters.push(format!("m.date < ?{}", args.len()));
    }
    if let Some(min) = query.min_size {
        args.push(Value::Integer(min));
        filters.push(format!("json_extract(a.value, '$.size') >= ?{}", args.len()));
    }
    if let Some(max) = query.max_size {
        args.push(Value::Integer(max));
        filters.push(format!("json_extract(a.value, '$.size') <= ?{}", args.len()));
    }
    // Inline images that are part of the text (logos, signatures) are not
    // files anyone sent: they are left out, as the reader leaves them out.
    let sql = format!(
        "SELECT m.account, m.folder, m.uid, COALESCE(m.thread_key, ''), COALESCE(m.subject, ''),
                COALESCE(m.from_name, ''), COALESCE(m.from_addr, ''), m.date, a.key,
                COALESCE(json_extract(a.value, '$.filename'), ''), COALESCE(json_extract(a.value, '$.mime'), ''),
                COALESCE(json_extract(a.value, '$.size'), 0), json_extract(a.value, '$.key'),
                COALESCE(json_extract(a.value, '$.unavailable'), '')
           FROM messages m, json_each(m.json, '$.attachments') a
          WHERE {}
          ORDER BY m.date DESC, m.account, m.folder, m.uid, a.key",
        filters.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |row| {
        let filename: String = row.get(9)?;
        let mime: String = row.get(10)?;
        Ok(Item {
            account: row.get(0)?,
            folder: row.get(1)?,
            uid: row.get(2)?,
            thread_key: row.get(3)?,
            thread_id: String::new(),
            subject: row.get(4)?,
            from_name: row.get(5)?,
            from_addr: row.get(6)?,
            date: row.get(7)?,
            index: row.get(8)?,
            kind: kind_of(&mime, &filename).to_string(),
            filename,
            mime,
            size: row.get(11)?,
            key: row.get(12)?,
            unavailable: row.get(13)?,
        })
    })?;
    let wanted_kind = query.kind.trim();
    let mut matching: Vec<Item> = Vec::new();
    for row in rows {
        let item = row?;
        if item.filename.is_empty() && item.mime.to_ascii_lowercase().starts_with("image/") {
            continue;
        }
        if wanted_kind.is_empty() || item.kind == wanted_kind {
            matching.push(item);
        }
    }
    let total = matching.len() as i64;
    let limit = query.limit.unwrap_or(200).clamp(1, MAX_LIMIT) as usize;
    let offset = query.offset.unwrap_or(0) as usize;
    let items = matching.into_iter().skip(offset).take(limit).collect();
    Ok(Page { items, total, coverage: coverage(conn, &query.account)? })
}

pub fn coverage(conn: &Connection, account: &str) -> Result<Coverage> {
    let (messages, downloaded) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(body IS NOT NULL), 0) FROM messages WHERE uid > 0 AND (?1 = '' OR account = ?1)",
        [account],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(Coverage { messages, downloaded })
}

#[cfg(test)]
mod tests;
