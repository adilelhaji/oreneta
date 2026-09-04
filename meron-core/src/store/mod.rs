//! Local SQLite store (rusqlite, bundled) — the single source of truth.
//!
//! `meron.db` (renamed from the old `cache.sqlite`) holds *all* accounts (mail and
//! RSS), fetched folders/messages, per-folder UID sync state, and RSS
//! subscriptions, so the UI renders instantly from disk and history persists
//! across runs. The desktop bridge sets `MERON_CORE_DB` to the active app
//! profile (`meron` or `meron-dev`); standalone runs default under
//! `~/.config/meron`.
//!
//! Accounts and messages share one table each, with a catch-all JSON column
//! absorbing per-engine fields so new account kinds don't force schema
//! migrations (accounts: `config` for mail connection metadata, plus `prefs` for
//! user preferences; messages: `json` for rss item fields). Mail's hot-path
//! columns (integer `uid`, `seen`, `thread_key`) stay typed; JSON carries the
//! divergent tail.

mod db;

pub use db::{app_dir, now_unix, open};

#[allow(dead_code)]
pub fn open_at(path: impl AsRef<std::path::Path>) -> Result<Connection> {
    db::open_at(path)
}

#[allow(dead_code)]
pub fn open_at_keyed(path: impl AsRef<std::path::Path>, key: &str) -> Result<Connection> {
    db::open_at_keyed(path, key)
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn run_migrations(conn: &Connection) -> Result<()> {
    db::run_migrations(conn)
}

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::imap::{Folder, MessageHeader};
use crate::parse::{Attachment, Message};

pub const DEFAULT_RSS_SYNC_INTERVAL_MINUTES: u64 = 60;

mod accounts;
mod settings;

pub use accounts::*;
pub use settings::*;

// ---- Folders (mail) ---------------------------------------------------------

pub fn upsert_folders(conn: &Connection, account: &str, folders: &[Folder]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in folders {
        tx.execute(
            "INSERT INTO folders(account, name, delimiter, special_use) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(account, name) DO UPDATE SET
               delimiter = excluded.delimiter,
               special_use = excluded.special_use",
            params![account, folder.name, folder.delimiter, folder.special_use],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Guarantee a folder row exists for a folder we have messages in, without
/// touching its delimiter. The full folder LIST sync (`upsert_folders`) only
/// runs when an account is opened directly, so in the unified view a freshly
/// added account never gets folder rows — and `get_folders` (which JOINs the
/// folders table) would then report zero unread even with unseen mail in the
/// store, leaving the tray dot and unread badges dark. Calling this on every
/// message sync keeps the count honest and self-heals existing accounts.
pub fn ensure_folder(conn: &Connection, account: &str, name: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO folders(account, name, delimiter) VALUES(?1, ?2, NULL)",
        params![account, name],
    )?;
    Ok(())
}

pub fn folder_exists(conn: &Connection, account: &str, name: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM folders WHERE account = ?1 AND name = ?2)",
        params![account, name],
        |row| row.get(0),
    )?)
}

/// Forget a folder that no longer exists on the server: its row, its cached
/// messages, its sync state and any cached search hits pointing into it. Pairs
/// with `imap::delete_folder`. Returns the number of cached messages dropped.
pub fn delete_folder(conn: &Connection, account: &str, name: &str) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let deleted = tx.execute(
        "DELETE FROM messages WHERE account = ?1 AND folder = ?2",
        params![account, name],
    )?;
    tx.execute(
        "DELETE FROM mail_search_hits WHERE account = ?1 AND folder = ?2",
        params![account, name],
    )?;
    tx.execute(
        "DELETE FROM folder_state WHERE account = ?1 AND folder = ?2",
        params![account, name],
    )?;
    tx.execute(
        "DELETE FROM ews_item_ids WHERE account = ?1 AND folder = ?2",
        params![account, name],
    )?;
    tx.execute(
        "DELETE FROM folders WHERE account = ?1 AND name = ?2",
        params![account, name],
    )?;
    tx.commit()?;
    Ok(deleted)
}

/// Names of the folders nested under `name`, using the target folder's
/// server-reported delimiter. A NULL/empty delimiter means the server exposed
/// no hierarchy for this mailbox; punctuation in another mailbox's name must
/// not turn it into a destructive delete target.
pub fn child_folders(conn: &Connection, account: &str, name: &str) -> Result<Vec<String>> {
    let delimiter: Option<String> = conn
        .query_row(
            "SELECT delimiter FROM folders WHERE account = ?1 AND name = ?2",
            params![account, name],
            |row| row.get(0),
        )
        .optional()?
        .flatten()
        .filter(|delimiter: &String| !delimiter.is_empty());
    let Some(delimiter) = delimiter else {
        return Ok(Vec::new());
    };

    let mut stmt =
        conn.prepare("SELECT name FROM folders WHERE account = ?1 AND name <> ?2 ORDER BY name")?;
    let rows = stmt.query_map(params![account, name], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let child = row?;
        if child.starts_with(&format!("{name}{delimiter}")) {
            out.push(child);
        }
    }
    Ok(out)
}

pub fn get_folders(conn: &Connection, account: &str) -> Result<Vec<Folder>> {
    let mut stmt = conn.prepare(
        "SELECT f.name, f.delimiter, f.special_use,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.account = f.account AND m.folder = f.name AND m.seen = 0) AS unread
           FROM folders f WHERE f.account = ?1 ORDER BY f.name",
    )?;
    let rows = stmt.query_map(params![account], |row| {
        let name = row.get::<_, String>(0)?;
        let special_use = row.get::<_, Option<String>>(2)?;
        Ok(Folder {
            role: classify_folder_role(&name, special_use.as_deref()).to_string(),
            display_name: crate::utf7::decode(&name),
            name,
            delimiter: row.get(1)?,
            special_use,
            unread: row.get::<_, i64>(3)? as u32,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Authoritative unread-message total for one folder. Thread-list responses
/// carry this alongside their cards so clients do not have to join a separately
/// cached folder-list response to the freshly loaded page.
pub fn get_folder_unread(conn: &Connection, account: &str, folder: &str) -> Result<u32> {
    let unread = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE account = ?1 AND folder = ?2 AND seen = 0",
        params![account, folder],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(unread as u32)
}

pub fn classify_folder_role(name: &str, special_use: Option<&str>) -> &'static str {
    match special_use.unwrap_or_default() {
        "inbox" => "inbox",
        "sent" => "sent",
        "drafts" => "drafts",
        "trash" => "trash",
        "junk" => "junk",
        "archive" | "all" => "archive",
        _ if name.eq_ignore_ascii_case("INBOX") => "inbox",
        _ if crate::imap::looks_like_sent(name) => "sent",
        _ if crate::imap::looks_like_drafts(name) => "drafts",
        _ if crate::imap::looks_like_trash(name) => "trash",
        _ if crate::imap::looks_like_junk(name) => "junk",
        _ if crate::imap::looks_like_archive(name) => "archive",
        _ => "folder",
    }
}

/// The account's folder for a special-use role, or `None` when it has none.
///
/// Backs the unified view's folder switcher: "Sent" there means each account's
/// own Sent, and an account whose server has no Archive or Junk is simply left
/// out of that view rather than reported as a failure.
pub fn folder_for_role(conn: &Connection, account: &str, role: &str) -> Result<Option<String>> {
    // Every account has an Inbox, and RSS accounts have no folder rows at all —
    // resolving it from the table would drop them out of the unified inbox.
    if role.eq_ignore_ascii_case("inbox") {
        return Ok(Some("INBOX".to_string()));
    }
    Ok(get_folders(conn, account)?
        .into_iter()
        .find(|folder| classify_folder_role(&folder.name, folder.special_use.as_deref()) == role)
        .map(|folder| folder.name))
}

// ---- Messages (mail) --------------------------------------------------------

pub fn upsert_messages(
    conn: &Connection,
    account: &str,
    folder: &str,
    messages: &[MessageHeader],
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    // The Message-IDs this batch cached: the only ids whose arrival can hand a
    // canonical thread key down to rows already in the cache.
    let mut upserted_ids: HashSet<String> = HashSet::new();
    // Read once for the batch rather than per message: both are small queries,
    // but a fifty-message sync should not make a hundred of them.
    let mine = crate::store::self_addrs(&tx, account);
    // Anyone this account writes to is someone it corresponds with. Noted from
    // the Sent folder, which is the only place that fact is recorded.
    let is_sent = folder_role(&tx, account, folder)
        .map(|role| role == "sent")
        .unwrap_or(false);
    if is_sent {
        let written_to: Vec<String> = messages
            .iter()
            .flat_map(|m| m.to.iter().chain(m.cc.iter()))
            .map(|recipient| recipient.addr.clone())
            .collect();
        note_correspondents(&tx, account, &written_to)?;
    }
    for m in messages {
        // Store recipient lists as JSON. Skip empty lists so a later flag-only
        // resync (which carries no envelope) can't clobber recipients we already
        // cached with NULLs.
        let mut extra = serde_json::Map::new();
        if !m.to.is_empty() {
            extra.insert("to".to_string(), json!(m.to));
        }
        if !m.cc.is_empty() {
            extra.insert("cc".to_string(), json!(m.cc));
        }
        if !m.message_id.is_empty() {
            extra.insert("message_id".to_string(), json!(m.message_id));
        }
        if let Some(gmail_msg_id) = m.gmail_msg_id {
            extra.insert("gmail_msg_id".to_string(), json!(gmail_msg_id));
        }
        if !m.in_reply_to.is_empty() {
            extra.insert("in_reply_to".to_string(), json!(m.in_reply_to));
        }
        let extra_json = Value::Object(extra).to_string();
        let thread_key = resolve_message_thread_key(&tx, account, &m.thread_key)?;
        let message_id = m.message_id.trim().to_lowercase();
        if !message_id.is_empty() {
            upserted_ids.insert(message_id);
        }
        tx.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, starred, thread_key, json, recipients, has_attachments, priority)
             VALUES(?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(account, folder, msg_id) DO UPDATE SET
               subject    = excluded.subject,
               from_name  = excluded.from_name,
               from_addr  = excluded.from_addr,
               date       = excluded.date,
               seen       = excluded.seen,
               starred    = excluded.starred,
               thread_key = excluded.thread_key,
               json       = json_patch(messages.json, excluded.json),
               -- Same rule as the recipient lists in `json`: a flag-only resync
               -- carries no envelope, so it must not blank what we already indexed.
               recipients = COALESCE(excluded.recipients, messages.recipients),
               -- And the same again: a resync that carried no structure must
               -- not turn a known answer back into an unknown one.
               has_attachments = COALESCE(excluded.has_attachments, messages.has_attachments),
               -- Re-judged on every write, unlike the two above: the signals
               -- can change under a message (a reply sent to its sender, a
               -- decision recorded) and a stale verdict is one nobody asked
               -- for and nobody can see.
               priority = excluded.priority",
            params![
                account,
                folder,
                m.uid,
                m.subject,
                m.from_name,
                m.from_addr,
                m.date,
                m.seen as i64,
                m.starred as i64,
                thread_key,
                extra_json,
                recipients_index_text(&m.to, &m.cc),
                m.has_attachments,
                // Judged as it lands, by the same rule that explains it later.
                // One implementation, so the filter and the reason a reader is
                // shown cannot disagree about the same message.
                crate::priority::verdict(priority_signals(
                    &tx, account, &m.from_addr, &m.to, &m.cc, &mine
                ))
                .priority as i64
            ],
        )?;
    }
    reconcile_thread_keys_from(&tx, account, upserted_ids)?;
    tx.commit()?;
    Ok(())
}

fn resolve_message_thread_key(
    conn: &rusqlite::Transaction<'_>,
    account: &str,
    thread_key: &str,
) -> Result<String> {
    let key = thread_key.trim();
    if key.is_empty() || key.starts_with("uid:") || key.starts_with("gmthrid:") {
        return Ok(thread_key.to_string());
    }

    // References chooses a Message-ID as the raw thread key. That message may
    // itself already have inherited an older canonical root. Following the
    // key through its cached Message-ID keeps later replies in that same root,
    // even when their immediate In-Reply-To names a different message. Proton
    // Bridge exposes exactly this shape after a reply round trip.
    Ok(cached_thread_key_of(conn, account, &key.to_lowercase())?
        .unwrap_or_else(|| thread_key.to_string()))
}

/// The thread key of the cached message with this (lowercased) Message-ID, or
/// `None` when we haven't cached it. Duplicate copies of one message — the same
/// id in several folders — resolve to the oldest row, so the answer doesn't
/// depend on which folder synced last.
fn cached_thread_key_of(
    conn: &rusqlite::Transaction<'_>,
    account: &str,
    message_id: &str,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT thread_key FROM messages
             WHERE account = ?1
               AND lower(COALESCE(json_extract(json, '$.message_id'), '')) = ?2
               AND COALESCE(thread_key, '') <> ''
             ORDER BY date ASC, uid ASC
             LIMIT 1",
            params![account, message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

/// Hand the canonical thread key down to rows that named a message we only just
/// cached.
///
/// A fresh folder sync may upsert a reply before the referenced row whose
/// Message-ID reveals the root key, so `resolve_message_thread_key` alone can't
/// settle those. Walking out from the ids this batch wrote — rather than
/// re-scanning the account cache — keeps the work proportional to the batch:
/// each newly cached id fixes the rows that name it, and each row so fixed
/// becomes the next id to walk out from, since its own children inherited
/// through it. `seen` stops the walk from revisiting an id, so a reference cycle
/// (two messages naming each other) terminates instead of flip-flopping.
fn reconcile_thread_keys_from(
    conn: &rusqlite::Transaction<'_>,
    account: &str,
    seeds: HashSet<String>,
) -> Result<()> {
    let mut seen = seeds;
    let mut pending: Vec<String> = seen.iter().cloned().collect();

    while !pending.is_empty() {
        let mut next: Vec<String> = Vec::new();
        for parent_id in pending.drain(..) {
            let Some(canonical) = cached_thread_key_of(conn, account, &parent_id)? else {
                continue;
            };
            let mut stmt = conn.prepare_cached(
                "SELECT id, lower(COALESCE(json_extract(json, '$.message_id'), ''))
                   FROM messages
                  WHERE account = ?1
                    AND uid <> 0
                    AND lower(COALESCE(thread_key, '')) = ?2
                    AND thread_key <> ?3
                    AND thread_key NOT LIKE 'uid:%'
                    AND thread_key NOT LIKE 'gmthrid:%'",
            )?;
            let children = stmt
                .query_map(params![account, parent_id, canonical], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, child_message_id) in children {
                conn.execute(
                    "UPDATE messages SET thread_key = ?1 WHERE id = ?2",
                    params![canonical, id],
                )?;
                if !child_message_id.is_empty() && seen.insert(child_message_id.clone()) {
                    next.push(child_message_id);
                }
            }
        }
        pending = next;
    }
    Ok(())
}

/// Which messages a recent page is narrowed to.
///
/// A set rather than a mode: a reader looking for what is both unread and
/// starred is asking one question, and answering it by filtering a page of
/// fifty after the fact would hand back three rows and call it a page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecentFilter {
    pub unread_only: bool,
    pub starred_only: bool,
    /// Only conversations carrying this label, when set.
    pub label_id: Option<String>,
    /// Only messages known to carry an attachment.
    pub with_attachments: bool,
    /// Only what is worth interrupting for.
    pub priority_only: bool,
}

impl RecentFilter {
    pub fn unread() -> Self {
        Self { unread_only: true, ..Default::default() }
    }
}

pub fn get_recent_page(
    conn: &Connection,
    account: &str,
    folder: &str,
    limit: u32,
    before_cursor: Option<crate::thread_list::PageCursor>,
    filter: RecentFilter,
) -> Result<(Vec<MessageHeader>, Option<String>)> {
    get_recent_page_sorted(
        conn,
        account,
        folder,
        limit,
        before_cursor,
        filter,
        crate::thread_list::Sort::default(),
    )
}

/// A page of a folder in a chosen order.
///
/// The ordering is in the query and so is the position it resumes from, which
/// is what makes sorting real: ordering the fifty rows that came back would
/// put them in order among themselves and in no order at all with respect to
/// the mailbox — it looks like sorting and is not.
pub fn get_recent_page_sorted(
    conn: &Connection,
    account: &str,
    folder: &str,
    limit: u32,
    before_cursor: Option<crate::thread_list::PageCursor>,
    filter: RecentFilter,
    sort: crate::thread_list::Sort,
) -> Result<(Vec<MessageHeader>, Option<String>)> {
    let probe = limit.saturating_add(1);
    // The ordering column and its direction are the query's, and so is the
    // position it resumes from. `uid` is the keyset tiebreaker throughout,
    // because no sort key is unique — two messages can share a second, a
    // sender or a subject — and without it a page would repeat or skip rows at
    // every boundary.
    let key = sort.column();
    let dir = sort.sql_dir();
    let op = sort.cursor_op();
    let sql = format!(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.to') FROM messages
         WHERE account = ?1 AND folder = ?2
           AND (?6 = 0 OR seen = 0)
           AND (?7 = 0 OR starred = 1)
           -- `= 1`, never `IS NOT 0`: a message nobody has looked at is not a
           -- message without an attachment, and offering it here would make
           -- the filter mean nothing.
           AND (?9 = 0 OR has_attachments = 1)
           -- Same reading as the attachment above: a message nobody has
           -- judged is not a message judged unimportant. The backfill is what
           -- keeps this from hiding anything, and it needs no server.
           AND (?10 = 0 OR priority = 1)
           -- A label is on the conversation, so the row is matched by the key
           -- it shares with the rest of its thread, not by its own uid.
           AND (?8 IS NULL OR EXISTS (
                 SELECT 1 FROM thread_labels tl
                  WHERE tl.account = messages.account
                    AND tl.label_id = ?8
                    AND tl.thread_key = COALESCE(NULLIF(messages.thread_key, ''), 'uid:' || messages.uid)))
           AND (?11 = 0
                OR {key} {op} ?3
                OR ({key} = ?3 AND uid {op} ?4))
         ORDER BY {key} {dir}, uid {dir} LIMIT ?5"
    );
    let mut stmt = conn.prepare(&sql)?;
    // Bound as one value whatever the key: SQLite compares an integer column
    // against an integer binding and a text column against a text one, and the
    // cursor carries whichever the ordering minted.
    let cursor_key: Option<Box<dyn rusqlite::ToSql>> = before_cursor.as_ref().map(|cursor| {
        match sort.key {
            crate::thread_list::SortKey::Date => {
                Box::new(cursor.date) as Box<dyn rusqlite::ToSql>
            }
            _ => Box::new(cursor.text.clone()) as Box<dyn rusqlite::ToSql>,
        }
    });
    let cursor_uid = before_cursor.as_ref().map(|cursor| cursor.uid as i64).unwrap_or(0);
    let has_cursor = before_cursor.is_some() as i64;
    let rows = stmt.query_map(
        params![
            account,
            folder,
            cursor_key.as_ref().map(|value| value.as_ref()),
            cursor_uid,
            probe as i64,
            filter.unread_only as i64,
            filter.starred_only as i64,
            filter.label_id.as_deref(),
            filter.with_attachments as i64,
            filter.priority_only as i64,
            has_cursor
        ],
        |row| {
            let uid = row.get(0)?;
            Ok(MessageHeader {
                uid,
                subject: row.get(1)?,
                from_name: row.get(2)?,
                from_addr: row.get(3)?,
                date: row.get(4)?,
                seen: row.get::<_, i64>(5)? != 0,
                starred: row.get::<_, i64>(6)? != 0,
                thread_key: row
                    .get::<_, Option<String>>(7)?
                    .filter(|key| !key.is_empty())
                    .unwrap_or_else(|| format!("uid:{}", uid)),
                to: parse_recipients_json(row.get::<_, Option<String>>(8)?),
                folder: String::new(),
                ..Default::default()
            })
        },
    )?;
    let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = out.len() > limit as usize;
    if has_more {
        out.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        out.last().map(|header| {
            let text_key = match sort.key {
                crate::thread_list::SortKey::Date => String::new(),
                crate::thread_list::SortKey::Sender => {
                    let name = header.from_name.trim();
                    if name.is_empty() { header.from_addr.to_lowercase() } else { name.to_lowercase() }
                }
                crate::thread_list::SortKey::Subject => header.subject.to_lowercase(),
            };
            crate::thread_list::format_page_cursor(sort, &text_key, header.date, header.uid)
        })
    } else {
        None
    };
    Ok((out, next_cursor))
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn mail_identity_from_parts(
    folder: &str,
    uid: u32,
    gmail_msg_id: Option<u64>,
    message_id: &str,
) -> String {
    if let Some(gmail_msg_id) = gmail_msg_id {
        return format!("gmail:{gmail_msg_id}");
    }
    let message_id = message_id.trim();
    if !message_id.is_empty() {
        return format!("message-id:{}", message_id.to_lowercase());
    }
    format!("uid:{}:{uid}", folder.to_lowercase())
}

fn message_identity(header: &MessageHeader, folder: &str) -> String {
    mail_identity_from_parts(folder, header.uid, header.gmail_msg_id, &header.message_id)
}

fn gmail_msg_id_from_json(value: Option<String>) -> Option<u64> {
    value.and_then(|value| value.parse::<u64>().ok())
}

pub fn backfill_observed_mail_identities(conn: &Connection, account: &str) -> Result<()> {
    let now = now_epoch_seconds();
    conn.execute(
        "INSERT OR IGNORE INTO observed_mail_identities(account, identity, first_seen_at)
         SELECT account,
                CASE
                  WHEN json_extract(json, '$.gmail_msg_id') IS NOT NULL
                    THEN 'gmail:' || json_extract(json, '$.gmail_msg_id')
                  WHEN COALESCE(json_extract(json, '$.message_id'), '') <> ''
                    THEN 'message-id:' || lower(json_extract(json, '$.message_id'))
                  ELSE 'uid:' || lower(folder) || ':' || uid
                END,
                ?2
         FROM messages
         WHERE account = ?1 AND uid <> 0",
        params![account, now],
    )?;
    Ok(())
}

/// Record message identities and return the subset that had not been observed
/// before this call.
fn record_observed_mail_identities(
    conn: &Connection,
    account: &str,
    folder: &str,
    messages: &[MessageHeader],
) -> Result<std::collections::HashSet<String>> {
    let now = now_epoch_seconds();
    let tx = conn.unchecked_transaction()?;
    let mut new_identities = std::collections::HashSet::new();
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO observed_mail_identities(account, identity, first_seen_at)
             VALUES(?1, ?2, ?3)",
        )?;
        for message in messages {
            let identity = message_identity(message, folder);
            let inserted = stmt.execute(params![account, &identity, now])?;
            if inserted > 0 {
                new_identities.insert(identity);
            }
        }
    }
    tx.commit()?;
    Ok(new_identities)
}

/// Unread INBOX messages in the UID range that appeared during the last sync,
/// newest first. Returns the whole batch rather than just its latest message so
/// notifications can post one entry per arrival; `None` when nothing new and
/// unread landed.
pub fn new_unread_inbox_messages(
    conn: &Connection,
    account: &str,
    uid_next_before: u32,
    uid_next_after: u32,
    synced_messages: &[MessageHeader],
) -> Result<Option<Vec<MessageHeader>>> {
    if uid_next_before == 0 || uid_next_after <= uid_next_before {
        return Ok(None);
    }
    let newly_observed = record_observed_mail_identities(conn, account, "INBOX", synced_messages)?;
    if newly_observed.is_empty() {
        return Ok(None);
    }

    let mut stmt = conn.prepare(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.to'),
                CAST(json_extract(json, '$.gmail_msg_id') AS TEXT),
                json_extract(json, '$.message_id') FROM messages
         WHERE account = ?1 AND folder = 'INBOX'
           AND uid >= ?2 AND uid < ?3 AND seen = 0
         ORDER BY uid DESC",
    )?;
    let rows = stmt.query_map(
        params![account, uid_next_before as i64, uid_next_after as i64],
        |row| {
            let mut header = message_header_from_row(row)?;
            header.gmail_msg_id = gmail_msg_id_from_json(row.get::<_, Option<String>>(9)?);
            header.message_id = row.get::<_, Option<String>>(10)?.unwrap_or_default();
            Ok(header)
        },
    )?;
    let headers = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|header| newly_observed.contains(&message_identity(header, "INBOX")))
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return Ok(None);
    }
    Ok(Some(headers))
}

/// One-line body snippet for a cached message, or `None` when the body hasn't
/// been fetched yet. Notifications use it to show the mail itself rather than
/// the subject alone; a miss degrades to a subject-only notification.
pub fn cached_body_preview(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Option<String> {
    let message = get_cached_message(conn, account, folder, uid).ok()??;
    let preview = crate::parse::preview_of(&message.body);
    (!preview.trim().is_empty()).then_some(preview)
}

/// Flatten `To`/`Cc` into the plain text `messages.recipients` indexes. The
/// recipient lists themselves live in the `json` catch-all, which FTS can't
/// reach, so this mirror is what makes "find the mail I sent to Ann" work
/// against the cache. `None` for a message with no addressees, which the write
/// path treats as "leave whatever is already indexed alone".
pub(super) fn recipients_index_text(
    to: &[crate::imap::Recipient],
    cc: &[crate::imap::Recipient],
) -> Option<String> {
    let text = to
        .iter()
        .chain(cc.iter())
        .map(|recipient| {
            format!("{} {}", recipient.name, recipient.addr)
                .trim()
                .to_string()
        })
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    (!text.is_empty()).then_some(text)
}

/// Substring search over one folder's cached messages, newest first.
///
/// `before_cursor` is the `(date, uid, folder)` of the last row of the previous
/// page. The folder tie-breaker is required because UIDs are mailbox-scoped.
/// One clause of a search, with the values it binds.
///
/// Built up rather than written out because a search has an open number of
/// parts: two senders and a date is a different statement from a subject and a
/// label, and spelling out every combination is how a query builder becomes a
/// place bugs live.
#[derive(Default)]
struct Clauses {
    sql: Vec<String>,
    params: Vec<Box<dyn rusqlite::ToSql>>,
}

impl Clauses {
    fn push(&mut self, sql: impl Into<String>) {
        self.sql.push(sql.into());
    }

    fn bind(&mut self, value: impl rusqlite::ToSql + 'static) {
        self.params.push(Box::new(value));
    }

    /// A term must appear somewhere in one of these columns.
    ///
    /// Several terms for one field are joined with OR: someone who names two
    /// senders means either, and reading it as "both" would answer nothing.
    fn any_term_in(&mut self, terms: &[String], columns: &[&str]) {
        if terms.is_empty() {
            return;
        }
        let mut alternatives = Vec::with_capacity(terms.len());
        for term in terms {
            let matches: Vec<String> = columns
                .iter()
                .map(|column| format!("lower(COALESCE({column}, '')) LIKE ? ESCAPE '\\'"))
                .collect();
            alternatives.push(format!("({})", matches.join(" OR ")));
            for _ in columns {
                self.bind(format!("%{}%", escape_like(term.to_lowercase())));
            }
        }
        self.push(format!("({})", alternatives.join(" OR ")));
    }
}

/// The parts of a search that are not free text, as SQL.
///
/// `m` is the alias the caller gave the messages table.
fn structured_clauses(query: &crate::search::Query) -> Clauses {
    use crate::search::Flag;
    let mut clauses = Clauses::default();

    // The sender is name and address together: someone searching for "amazon"
    // does not know or care which half of it carries the word.
    clauses.any_term_in(&query.from, &["m.from_name", "m.from_addr"]);
    clauses.any_term_in(&query.to, &["m.recipients"]);
    clauses.any_term_in(&query.subject, &["m.subject"]);

    for flag in &query.flags {
        match flag {
            Flag::Unread => clauses.push("m.seen = 0"),
            Flag::Read => clauses.push("m.seen = 1"),
            Flag::Starred => clauses.push("m.starred = 1"),
            // `= 1`, never `IS NOT 0`: a message nobody has looked at is not a
            // message without an attachment, and offering it here would make
            // the operator mean nothing.
            Flag::HasAttachment => clauses.push("m.has_attachments = 1"),
        }
    }

    if let Some(after) = query.after {
        clauses.push("m.date >= ?");
        clauses.bind(after);
    }
    if let Some(before) = query.before {
        clauses.push("m.date < ?");
        clauses.bind(before);
    }

    if let Some(label) = &query.label {
        // By name, because a name is what was typed. The label is on the
        // conversation, so the row matches by the key it shares with the rest
        // of its thread.
        clauses.push(
            "EXISTS (SELECT 1 FROM thread_labels tl
                       JOIN labels l ON l.id = tl.label_id
                      WHERE tl.account = m.account
                        AND lower(l.name) = ?
                        AND tl.thread_key = COALESCE(NULLIF(m.thread_key, ''), 'uid:' || m.uid))",
        );
        clauses.bind(label.to_lowercase());
    }

    clauses
}

/// Everything in one folder matching a parsed search.
///
/// Free text still goes through the trigram index (or a scoped scan when it is
/// too short for one); the named parts are ordinary predicates beside it. Both
/// halves are the same statement, so a search with an operator pages exactly
/// like a search without one — narrowing a page after the fact would hand back
/// three rows and call it a page.
pub fn search_messages_parsed(
    conn: &Connection,
    account: &str,
    folder: &str,
    query: &crate::search::Query,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> Result<Vec<MessageHeader>> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut clauses = structured_clauses(query);
    let text = query.text.trim();
    if !text.is_empty() {
        if text.chars().count() >= 3 {
            // Whole text as one quoted FTS phrase -> trigram substring match
            // (doubling any `"` so user input can't change the query). Both
            // indexes answer the same phrase: the body/subject/sender one and
            // the recipients one.
            clauses.push(
                "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
                          UNION
                          SELECT rowid FROM messages_recipients_fts WHERE messages_recipients_fts MATCH ?)",
            );
            let phrase = format!("\"{}\"", text.replace('"', "\"\""));
            clauses.bind(phrase.clone());
            clauses.bind(phrase);
        } else {
            // The trigram index needs >= 3 codepoints; shorter queries (common
            // for CJK, where words are often 2 characters) get the scoped scan.
            clauses.any_term_in(
                &[text.to_string()],
                &["m.subject", "m.from_name", "m.from_addr", "m.recipients", "m.body"],
            );
        }
    }

    let mut sql = String::from(
        "SELECT m.uid, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.starred,
                m.thread_key, json_extract(m.json, '$.to')
         FROM messages m
         WHERE m.account = ? AND m.folder = ? AND m.uid <> 0",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(account.to_string()), Box::new(folder.to_string())];

    for clause in &clauses.sql {
        sql.push_str("\n           AND ");
        sql.push_str(clause);
    }
    params.extend(clauses.params);

    sql.push_str(
        "\n           AND (? IS NULL
                OR m.date < ?
                OR (m.date = ? AND m.uid < ?)
                OR (m.date = ? AND m.uid = ? AND m.folder < ?))
         ORDER BY m.date DESC, m.uid DESC LIMIT ?",
    );
    let cursor_date = before_cursor.map(|cursor| cursor.date);
    let cursor_uid = before_cursor.map(|cursor| cursor.uid as i64).unwrap_or(0);
    let cursor_folder = before_cursor
        .map(|cursor| cursor.folder.clone())
        .unwrap_or_default();
    for _ in 0..3 {
        params.push(Box::new(cursor_date));
    }
    params.push(Box::new(cursor_uid));
    params.push(Box::new(cursor_date));
    params.push(Box::new(cursor_uid));
    params.push(Box::new(cursor_folder));
    params.push(Box::new(limit));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(params.iter().map(|param| param.as_ref())),
        message_header_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Everything in one folder matching a search as it was typed.
pub fn search_messages(
    conn: &Connection,
    account: &str,
    folder: &str,
    query: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> Result<Vec<MessageHeader>> {
    search_messages_parsed(
        conn,
        account,
        folder,
        &crate::search::parse(query),
        limit,
        before_cursor,
    )
}

/// Search several folders (typically the open mailbox plus Sent) as one
/// newest-first result set. UIDs are folder-scoped, so each header carries the
/// folder it came from and ordering is by date — the only key comparable across
/// mailboxes. Used both for the cached half of a live search and, on mobile, as
/// the whole answer when the server can't be reached.
pub fn search_messages_in_folders(
    conn: &Connection,
    account: &str,
    folders: &[String],
    query: &str,
    limit: u32,
    before_cursor: Option<&crate::thread_list::SearchCursor>,
) -> Result<Vec<MessageHeader>> {
    let mut messages = Vec::new();
    for folder in folders {
        for mut message in search_messages(conn, account, folder, query, limit, before_cursor)? {
            message.folder = folder.clone();
            messages.push(message);
        }
    }
    sort_search_hits(&mut messages, limit);
    Ok(messages)
}

/// Newest first by epoch send time, capped at `limit`; unknown dates (0) sort
/// last. Shared by every path that merges search hits from more than one source
/// so cached-only and cached+live results are ordered identically.
pub fn sort_search_hits(messages: &mut Vec<MessageHeader>, limit: u32) {
    sort_search_hits_all(messages);
    messages.truncate(limit as usize);
}

pub fn sort_search_hits_all(messages: &mut [MessageHeader]) {
    messages.sort_unstable_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| b.uid.cmp(&a.uid))
            .then_with(|| b.folder.cmp(&a.folder))
    });
}

/// The search cursor for the page after `messages`, or `None` when
/// this page was short (a short page means the result set is exhausted).
pub fn search_next_cursor(messages: &[MessageHeader], limit: u32, scanned: u32) -> Option<String> {
    if messages.len() < limit as usize {
        return None;
    }
    messages.last().map(|header| {
        crate::thread_list::format_search_cursor(&crate::thread_list::SearchCursor {
            date: header.date,
            uid: header.uid,
            folder: header.folder.clone(),
            scanned,
            snapshot: None,
            offset: 0,
        })
    })
}

pub struct SearchSnapshotPage {
    pub messages: Vec<MessageHeader>,
    pub next_offset: u32,
    pub has_more: bool,
}

/// Persist the resolved order of one live IMAP search. Only identities and
/// positions are stored; headers remain in `messages`, where the live fetch
/// already upserted them.
pub fn save_search_snapshot(
    conn: &Connection,
    account: &str,
    query: &str,
    folders: &[String],
    messages: &[MessageHeader],
) -> Result<String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let scope = serde_json::to_string(folders)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let tx = conn.unchecked_transaction()?;
    for (position, message) in messages.iter().enumerate() {
        tx.execute(
            "INSERT INTO mail_search_hits(
               token, account, query, scope, position, folder, uid, created_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                token,
                account,
                query,
                scope,
                position as i64,
                message.folder,
                message.uid,
                created_at
            ],
        )?;
    }
    // Search snapshots are disposable cache state. A one-day lease is long
    // enough for suspended mobile views to resume without letting abandoned
    // queries grow the database indefinitely.
    tx.execute(
        "DELETE FROM mail_search_hits
         WHERE account = ?1 AND created_at < ?2",
        params![account, created_at.saturating_sub(86_400)],
    )?;
    tx.commit()?;
    Ok(token)
}

/// Read a stable live-search page. `None` means the cursor is stale or belongs
/// to a different query/scope, in which case callers can resume keyset paging
/// through ordinary cached search results.
pub fn get_search_snapshot_page(
    conn: &Connection,
    account: &str,
    query: &str,
    folders: &[String],
    token: &str,
    offset: u32,
    limit: u32,
) -> Result<Option<SearchSnapshotPage>> {
    let scope = serde_json::to_string(folders)?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM mail_search_hits
             WHERE token = ?1 AND account = ?2 AND query = ?3 AND scope = ?4
             LIMIT 1",
            params![token, account, query, scope],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }

    let fetch_limit = limit.saturating_add(1);
    let mut stmt = conn.prepare(
        "SELECT m.uid, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.starred,
                m.thread_key, json_extract(m.json, '$.to'), h.folder, h.position
         FROM mail_search_hits h
         JOIN messages m
           ON m.account = h.account AND m.folder = h.folder AND m.uid = h.uid
         WHERE h.token = ?1 AND h.account = ?2 AND h.query = ?3 AND h.scope = ?4
           AND h.position >= ?5
         ORDER BY h.position
         LIMIT ?6",
    )?;
    let rows = stmt.query_map(
        params![token, account, query, scope, offset, fetch_limit],
        |row| {
            let mut message = message_header_from_row(row)?;
            message.folder = row.get(9)?;
            Ok((message, row.get::<_, u32>(10)?))
        },
    )?;
    let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit as usize;
    if has_more {
        rows.pop();
    }
    let next_offset = rows
        .last()
        .map(|(_, position)| position.saturating_add(1))
        .unwrap_or(offset);
    Ok(Some(SearchSnapshotPage {
        messages: rows.into_iter().map(|(message, _)| message).collect(),
        next_offset,
        has_more,
    }))
}

/// A correspondent surfaced for recipient autocomplete.
#[derive(serde::Serialize)]
pub struct Contact {
    pub name: String,
    pub addr: String,
    /// True when this came out of an address book rather than out of mail.
    ///
    /// The two are different claims. "Ana Prat" from a book is somebody the
    /// reader keeps; the same address seen in a header is somebody they have
    /// corresponded with, which they may not recognise at all. The interface
    /// is allowed to show them differently, so it is told which is which.
    #[serde(default)]
    pub known: bool,
    /// Where they work, when a book said so.
    #[serde(default)]
    pub organisation: String,
}

/// Address-book matches for recipient autocomplete.
///
/// One row per address rather than per person: the writer is choosing where to
/// send, and somebody with a work address and a home one is two choices. The
/// name comes along so both read as that person.
pub fn suggest_from_book(conn: &Connection, query: &str, limit: u32) -> Result<Vec<Contact>> {
    let needle = query.trim().to_lowercase();
    let like = format!("%{}%", escape_like(needle.clone()));
    let mut stmt = conn.prepare(
        "SELECT p.name, e.addr, p.organisation
           FROM person_emails e JOIN people p ON p.id = e.person_id
          WHERE ?1 = ''
             OR lower(p.name) LIKE ?2 ESCAPE '\\'
             OR e.addr LIKE ?2 ESCAPE '\\'
             OR lower(p.organisation) LIKE ?2 ESCAPE '\\'
          ORDER BY p.name COLLATE NOCASE, e.position
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![needle, like, limit as i64], |row| {
        Ok(Contact {
            name: row.get(0)?,
            addr: row.get(1)?,
            known: true,
            organisation: row.get(2)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

/// Suggest contacts for recipient autocomplete, drawn from both the senders and
/// the To/Cc recipients of cached messages. Results are distinct by address and
/// ranked by how often the address appears. An empty `query` returns the top
/// correspondents; otherwise we match the substring against address and display
/// name. When `account` is empty we search across all accounts (unified compose).
///
/// Recipient lists are stored as JSON, so aggregation happens in Rust rather than
/// SQL: we pull the candidate rows (coarsely pre-filtered by LIKE) and fold them
/// into a per-address tally.
pub fn suggest_contacts(
    conn: &Connection,
    account: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<Contact>> {
    use std::collections::HashMap;

    let q = query.trim().to_lowercase();
    let like = format!("%{}%", escape_like(q.clone()));
    let account_filter = if account.is_empty() {
        "?1 = ''"
    } else {
        "account = ?1"
    };
    // Pre-filter: keep rows where the query appears anywhere in the sender or the
    // (JSON) recipient lists. With an empty query every row qualifies.
    let sql = format!(
        "SELECT from_name, from_addr, json_extract(json, '$.to'), json_extract(json, '$.cc')
         FROM messages
         WHERE {account_filter}
           AND uid <> 0
           AND (?2 = ''
                OR lower(COALESCE(from_addr, '')) LIKE ?3 ESCAPE '\\'
                OR lower(COALESCE(from_name, '')) LIKE ?3 ESCAPE '\\'
                OR lower(COALESCE(json_extract(json, '$.to'), '')) LIKE ?3 ESCAPE '\\'
                OR lower(COALESCE(json_extract(json, '$.cc'), '')) LIKE ?3 ESCAPE '\\')"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account, q, like], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;

    // Tally per lowercased address: first display name seen wins (falling back to
    // a later non-empty one), plus an occurrence count for ranking.
    struct Tally {
        name: String,
        addr: String,
        count: u32,
    }
    let mut tallies: HashMap<String, Tally> = HashMap::new();
    let mut bump = |name: String, addr: String| {
        let addr = addr.trim();
        if addr.is_empty() {
            return;
        }
        let entry = tallies.entry(addr.to_lowercase()).or_insert_with(|| Tally {
            name: String::new(),
            addr: addr.to_string(),
            count: 0,
        });
        entry.count += 1;
        if entry.name.is_empty() && !name.trim().is_empty() {
            entry.name = name.trim().to_string();
        }
    };

    for row in rows {
        let (from_name, from_addr, to_json, cc_json) = row?;
        bump(from_name, from_addr);
        for json in [to_json, cc_json].into_iter().flatten() {
            if let Ok(list) = serde_json::from_str::<Vec<crate::imap::Recipient>>(&json) {
                for r in list {
                    bump(r.name, r.addr);
                }
            }
        }
    }

    // Keep only the addresses that actually match the query (the SQL pre-filter
    // admits whole rows, so a sender match can drag in non-matching recipients).
    let mut out: Vec<Tally> = tallies
        .into_values()
        .filter(|t| {
            q.is_empty() || t.addr.to_lowercase().contains(&q) || t.name.to_lowercase().contains(&q)
        })
        .collect();
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.addr.to_lowercase().cmp(&b.addr.to_lowercase()))
    });
    // People the reader keeps come first, and what is left of the limit is
    // filled from mail they have seen. The two are different claims — one is
    // somebody's address book, the other is an address that went past — and
    // putting the book first means a colleague is not outranked by a
    // no-reply that happens to have written more often.
    let book = suggest_from_book(conn, query, limit)?;
    let mut taken: std::collections::HashSet<String> =
        book.iter().map(|c| c.addr.to_lowercase()).collect();

    let mut merged = book;
    for tally in out {
        if merged.len() >= limit as usize {
            break;
        }
        if !taken.insert(tally.addr.to_lowercase()) {
            continue;
        }
        merged.push(Contact {
            name: tally.name,
            addr: tally.addr,
            known: false,
            organisation: String::new(),
        });
    }
    merged.truncate(limit as usize);
    Ok(merged)
}

pub fn get_starred(
    conn: &Connection,
    account: &str,
    folder: &str,
    limit: u32,
) -> Result<Vec<MessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.to') FROM messages
         WHERE account = ?1 AND folder = ?2 AND starred <> 0 AND uid <> 0
         ORDER BY date DESC, uid DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![account, folder, limit], message_header_from_row)?;
    let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for header in &mut out {
        header.folder = folder.to_string();
    }
    Ok(out)
}

/// What makes two cached rows the same starred conversation.
///
/// A Message-ID or `gmthrid:` thread key names the conversation itself and
/// holds wherever the server files it, so those dedupe across folders. `uid:`
/// is the reserved key [`crate::store::card_thread_key`] mints for a message
/// that arrived with no threading headers at all, and an IMAP UID means nothing
/// outside its own mailbox — `uid:1` in Inbox and `uid:1` in Archive are
/// ordinarily two unrelated messages, so those stay scoped to their folder.
///
/// Both the query budget below and the card-level dedupe in
/// `mail_model::starred_thread_cards` key on this, so a row that survives the
/// budget as its own conversation cannot then be swallowed as a copy of
/// another, or vice versa.
pub fn starred_thread_identity(folder: &str, thread_key: &str) -> String {
    if thread_key.starts_with("uid:") {
        format!("{folder}\u{0}{thread_key}")
    } else {
        thread_key.to_string()
    }
}

/// Every starred mail message across all accounts and folders, newest first,
/// for the newest `max_threads` distinct conversations.
///
/// The budget counts conversations rather than rows because the caller renders
/// one card per conversation: an account whose server files each message under
/// several folders (Gmail's All Mail beside the Inbox copy, plus every label)
/// would otherwise spend the whole budget on copies of the same few threads and
/// silently drop older ones off the end of the list.
///
/// A conversation past the budget is skipped rather than ending the scan, since
/// its rows carry no signal about where the remaining copies of the admitted
/// ones are: two folders' copies of one message can hold different cached dates,
/// which puts them arbitrarily far apart in this ordering. Stopping at the first
/// over-budget row would drop those stragglers, and the caller picks which
/// folder's copy to show from exactly this set — losing the Inbox copy would put
/// the thread under All Mail instead.
///
/// RSS rows carry `uid = 0` and are excluded; `rss::starred_items` covers them.
pub fn get_starred_all_accounts(
    conn: &Connection,
    max_threads: u32,
) -> Result<Vec<(String, MessageHeader)>> {
    let mut stmt = conn.prepare(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.to'), account, folder FROM messages
         WHERE starred <> 0 AND uid <> 0
         ORDER BY date DESC, uid DESC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    let mut threads: HashSet<(String, String)> = HashSet::new();
    while let Some(row) = rows.next()? {
        let mut header = message_header_from_row(row)?;
        header.folder = row.get(10)?;
        let account: String = row.get(9)?;
        // The branch-aware key, not the stored root: one root split by subject
        // becomes one card per branch, and a budget counting the root would let
        // a heavily branched conversation return far more cards than it allows.
        let thread = (
            account,
            starred_thread_identity(&header.folder, &card_thread_key(&header)),
        );
        if !threads.contains(&thread) {
            if threads.len() as u32 >= max_threads {
                continue;
            }
            threads.insert(thread.clone());
        }
        out.push((thread.0, header));
    }
    Ok(out)
}

pub fn get_thread_headers(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
) -> Result<Vec<MessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.in_reply_to') FROM messages
         WHERE account = ?1 AND folder = ?2 AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3
         ORDER BY date ASC, uid ASC",
    )?;
    let rows = stmt.query_map(params![account, folder, thread_key], |row| {
        let uid = row.get(0)?;
        Ok(MessageHeader {
            uid,
            subject: row.get(1)?,
            from_name: row.get(2)?,
            from_addr: row.get(3)?,
            date: row.get(4)?,
            seen: row.get::<_, i64>(5)? != 0,
            starred: row.get::<_, i64>(6)? != 0,
            thread_key: row
                .get::<_, Option<String>>(7)?
                .filter(|key| !key.is_empty())
                .unwrap_or_else(|| format!("uid:{}", uid)),
            in_reply_to: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            folder: String::new(),
            ..Default::default()
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The newest message of a thread (or of one subject branch of it), as a
/// single-element uid list — empty when the thread has no cached messages.
///
/// Marking a whole thread unread uses this: the gesture means "bring this back
/// to me", not "I read none of these", so only the newest message carries the
/// flag. The thread then shows one unread message and opening it lands on that
/// message, instead of reopening at the oldest one and shedding the count again
/// as the reader scrolls down.
pub fn newest_thread_uids(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
    subject_filter: Option<&str>,
) -> Result<Vec<u32>> {
    // get_thread_headers orders by date ascending, so the newest is last.
    let newest = get_thread_headers(conn, account, folder, thread_key)?
        .into_iter()
        .filter(|header| match subject_filter {
            Some(filter) => thread_grouping_subject(&header.subject) == filter,
            None => true,
        })
        .next_back();
    Ok(newest.map(|header| header.uid).into_iter().collect())
}

/// The newest message of each thread put aside, soonest to return first.
///
/// Read from wherever the thread was when it was set aside, so the list can
/// show what it actually is rather than a bare subject line.
pub fn get_snoozed_headers(conn: &Connection, account: &str) -> Result<Vec<MessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT m.uid, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.starred,
                m.thread_key, json_extract(m.json, '$.to')
           FROM snoozed_threads s
           JOIN messages m
             ON m.account = s.account
            AND m.folder = s.folder
            AND COALESCE(NULLIF(m.thread_key, ''), 'uid:' || m.uid) = s.thread_key
          WHERE s.account = ?1 AND m.uid <> 0
            AND m.date = (
                  SELECT MAX(m2.date) FROM messages m2
                   WHERE m2.account = m.account AND m2.folder = m.folder
                     AND COALESCE(NULLIF(m2.thread_key, ''), 'uid:' || m2.uid) = s.thread_key)
          ORDER BY s.until",
    )?;
    let rows = stmt.query_map(params![account], message_header_from_row)?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Puts a thread aside until an instant.
///
/// The folder it was in travels with it: coming back means coming back where
/// it was, and a thread cannot be returned to a folder nobody recorded.
pub fn snooze_thread(
    conn: &Connection,
    account: &str,
    thread_key: &str,
    folder: &str,
    until: i64,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO snoozed_threads(account, thread_key, folder, until)
         VALUES(?1, ?2, ?3, ?4)",
        params![account, thread_key, folder, until],
    )?;
    Ok(())
}

/// Brings a thread back now, whatever it was waiting for.
pub fn unsnooze_thread(conn: &Connection, account: &str, thread_key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM snoozed_threads WHERE account = ?1 AND thread_key = ?2",
        params![account, thread_key],
    )?;
    Ok(())
}

/// The threads still put aside at `now`, for the list to leave out.
pub fn snoozed_thread_keys(
    conn: &Connection,
    account: &str,
    now: i64,
) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT thread_key FROM snoozed_threads WHERE account = ?1 AND until > ?2",
    )?;
    let rows = stmt.query_map(params![account, now], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Every thread put aside, whether or not its time has come, so a reader can
/// find what they set aside — a thread that vanishes with no way to look it up
/// is a thread lost, not postponed.
pub fn snoozed_threads(conn: &Connection, account: &str) -> Result<Vec<(String, String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT thread_key, folder, until FROM snoozed_threads
          WHERE account = ?1 ORDER BY until",
    )?;
    let rows = stmt.query_map(params![account], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Threads whose time has come, with the account and folder to return them to.
pub fn due_snoozes(conn: &Connection, now: i64) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT account, thread_key, folder FROM snoozed_threads WHERE until <= ?1",
    )?;
    let rows = stmt.query_map(params![now], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// The most recent messages of one folder, for trying rules against.
///
/// Cc comes along with To: a rule can match on either, and a dry run that
/// looked at less than the real run would be a dry run that lies.
pub fn recent_headers(
    conn: &Connection,
    account: &str,
    folder: &str,
    limit: i64,
) -> Result<Vec<MessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT uid, subject, from_name, from_addr, date, seen, starred, thread_key,
                json_extract(json, '$.to'), json_extract(json, '$.cc')
           FROM messages
          WHERE account = ?1 AND folder = ?2 AND uid <> 0
          ORDER BY date DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![account, folder, limit.max(0)], |row| {
        let mut header = message_header_from_row(row)?;
        header.cc = parse_recipients_json(row.get::<_, Option<String>>(9)?);
        header.folder = folder.to_string();
        Ok(header)
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// The conversation a message belongs to.
///
/// Falls back to `uid:<n>` exactly as the rest of the store does for a message
/// the server gave no thread of its own, so a label put on it lands on the same
/// key every other query would look it up by.
pub fn thread_key_for_uid(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<String> {
    let key: Option<String> = conn
        .query_row(
            "SELECT COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) FROM messages
              WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, uid],
            |row| row.get(0),
        )
        .optional()?;
    Ok(key.unwrap_or_else(|| format!("uid:{uid}")))
}

/// Which of these conversations are known to carry an attachment.
///
/// By conversation, because that is what a row is: a thread whose third
/// message has the invoice has an invoice in it, and a paperclip on the row is
/// the honest way to say so.
///
/// Absent from the set means either no attachment or nobody has looked, and
/// the two are deliberately not told apart here — a row shows a paperclip when
/// there is something to show one for, and nothing otherwise.
pub fn threads_with_attachments(
    conn: &Connection,
    account: &str,
    thread_keys: &[String],
) -> Result<HashSet<String>> {
    let mut found = HashSet::new();
    if thread_keys.is_empty() {
        return Ok(found);
    }
    let mut stmt = conn.prepare(
        "SELECT DISTINCT COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) FROM messages
          WHERE account = ?1 AND has_attachments = 1",
    )?;
    let wanted: HashSet<&String> = thread_keys.iter().collect();
    let rows = stmt.query_map(params![account], |row| row.get::<_, String>(0))?;
    for key in rows.filter_map(Result::ok) {
        if wanted.contains(&key) {
            found.insert(key);
        }
    }
    Ok(found)
}

/// The messages of a folder whose structure nobody has fetched yet.
///
/// What makes the attachment filter honest rather than approximate: instead of
/// guessing about them, the caller asks the server, and the answer becomes
/// known. Capped, because a mailbox of fifty thousand should not turn one
/// filter click into one enormous FETCH.
pub fn uids_without_structure(
    conn: &Connection,
    account: &str,
    folder: &str,
    limit: i64,
) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid FROM messages
          WHERE account = ?1 AND folder = ?2 AND uid <> 0 AND has_attachments IS NULL
          ORDER BY date DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![account, folder, limit.max(0)], |row| {
        row.get::<_, i64>(0).map(|uid| uid as u32)
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Records what the server said about a message's structure.
pub fn set_has_attachments(
    conn: &Connection,
    account: &str,
    folder: &str,
    answers: &[(u32, bool)],
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE messages SET has_attachments = ?4
              WHERE account = ?1 AND folder = ?2 AND uid = ?3",
        )?;
        for (uid, has) in answers {
            stmt.execute(params![account, folder, uid, *has as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The verdict on each of these conversations, where one has been reached.
///
/// A conversation counts as worth interrupting for if any message in it does:
/// a thread whose latest reply is from someone you correspond with is a thread
/// you want, whatever the first message in it was.
///
/// Absent from the map means nobody has judged any of its messages — which is
/// not the same as judged unimportant, and the interface is told the
/// difference.
pub fn priority_for_threads(
    conn: &Connection,
    account: &str,
    thread_keys: &[String],
) -> Result<HashMap<String, bool>> {
    let mut out: HashMap<String, bool> = HashMap::new();
    if thread_keys.is_empty() {
        return Ok(out);
    }
    let mut stmt = conn.prepare(
        "SELECT COALESCE(NULLIF(thread_key, ''), 'uid:' || uid), MAX(priority)
           FROM messages
          WHERE account = ?1 AND uid <> 0 AND priority IS NOT NULL
          GROUP BY COALESCE(NULLIF(thread_key, ''), 'uid:' || uid)",
    )?;
    let wanted: HashSet<&String> = thread_keys.iter().collect();
    let rows = stmt.query_map(params![account], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for (key, priority) in rows.filter_map(Result::ok) {
        if wanted.contains(&key) {
            out.insert(key, priority != 0);
        }
    }
    Ok(out)
}

/// Records that this account has written to these addresses.
///
/// Called with the recipients of anything the account sent. Cheap and
/// idempotent, so it can be run over a Sent folder on every sync without
/// keeping track of what was already noted.
/// Opens no transaction of its own: it is called from inside the one that
/// writes the messages these addresses came from, and the two belong together
/// — either the Sent batch landed and its correspondents are known, or
/// neither happened.
pub fn note_correspondents(conn: &Connection, account: &str, addrs: &[String]) -> Result<()> {
    if addrs.is_empty() {
        return Ok(());
    }
    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO correspondents(account, addr) VALUES(?1, ?2)")?;
    for addr in addrs {
        let addr = addr.trim().to_lowercase();
        if !addr.is_empty() {
            stmt.execute(params![account, addr])?;
        }
    }
    Ok(())
}

/// Whether this account has written to an address.
pub fn has_written_to(conn: &Connection, account: &str, addr: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM correspondents WHERE account = ?1 AND addr = ?2",
        params![account, addr.trim().to_lowercase()],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// What the reader decided about a sender, if anything.
pub fn sender_priority(conn: &Connection, account: &str, addr: &str) -> Option<bool> {
    conn.query_row(
        "SELECT priority FROM sender_priority WHERE account = ?1 AND addr = ?2",
        params![account, addr.trim().to_lowercase()],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(|value| value != 0)
}

/// Records what the reader decided about a sender, or forgets it.
pub fn set_sender_priority(
    conn: &Connection,
    account: &str,
    addr: &str,
    priority: Option<bool>,
) -> Result<()> {
    let addr = addr.trim().to_lowercase();
    match priority {
        Some(value) => conn.execute(
            "INSERT OR REPLACE INTO sender_priority(account, addr, priority) VALUES(?1, ?2, ?3)",
            params![account, addr, value as i64],
        )?,
        // Forgetting is its own answer: back to whatever the signals say,
        // rather than stuck at whichever way it was last pushed.
        None => conn.execute(
            "DELETE FROM sender_priority WHERE account = ?1 AND addr = ?2",
            params![account, addr],
        )?,
    };
    Ok(())
}

/// The signals for one message, gathered from the store.
///
/// Everything here is local. Nothing is asked of a server and nothing about
/// the reader's mail leaves the machine to answer it.
pub fn priority_signals(
    conn: &Connection,
    account: &str,
    from_addr: &str,
    to: &[crate::imap::Recipient],
    cc: &[crate::imap::Recipient],
    mine: &HashSet<String>,
) -> crate::priority::Signals {
    let addressed = |list: &[crate::imap::Recipient]| {
        list.iter()
            .any(|recipient| mine.contains(&recipient.addr.trim().to_lowercase()))
    };
    crate::priority::Signals {
        written_to_sender: has_written_to(conn, account, from_addr),
        addressed_directly: addressed(to),
        copied_in: addressed(cc),
        automated_sender: crate::priority::looks_automated(from_addr),
        sender_override: sender_priority(conn, account, from_addr),
    }
}

/// One message a sweep would move.
#[derive(Debug, Clone, PartialEq)]
pub struct SweepCandidate {
    pub uid: u32,
    pub subject: String,
    pub date: i64,
}

/// What a sweep would move, without moving any of it.
///
/// Outlook calls this Sweep: a sender whose mail is fine to keep arriving but
/// whose older copies are not worth keeping. The one thing it must never be is
/// a surprise, so this answers the question first and the caller shows it —
/// the same shape the rules already use, and for the same reason.
///
/// `keep_newest` is how many of the sender's most recent messages survive.
/// Zero sweeps all of them, which is a thing someone may mean and so is
/// allowed, but it is the caller's job to make sure they meant it.
pub fn sweep_candidates(
    conn: &Connection,
    account: &str,
    folder: &str,
    from_addr: &str,
    keep_newest: u32,
) -> Result<Vec<SweepCandidate>> {
    let mut stmt = conn.prepare(
        "SELECT uid, COALESCE(subject, ''), date FROM messages
          WHERE account = ?1 AND folder = ?2 AND uid <> 0
            AND lower(COALESCE(from_addr, '')) = ?3
          ORDER BY date DESC, uid DESC",
    )?;
    let rows = stmt.query_map(
        params![account, folder, from_addr.trim().to_lowercase()],
        |row| {
            Ok(SweepCandidate {
                uid: row.get(0)?,
                subject: row.get(1)?,
                date: row.get(2)?,
            })
        },
    )?;
    // Newest first from the query, so what survives is simply the front of it.
    Ok(rows
        .filter_map(Result::ok)
        .skip(keep_newest as usize)
        .collect())
}

/// The signals for the newest message of one conversation.
///
/// Its own query rather than a reader of `get_thread_headers`, which does not
/// carry recipients — asking it would have produced an explanation that was
/// quietly the wrong one, and a wrong explanation is worse here than none:
/// the whole point of this feature is that the reason can be trusted.
pub fn thread_priority_signals(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
) -> Result<Option<(String, crate::priority::Signals)>> {
    let row: Option<(String, Vec<crate::imap::Recipient>, Vec<crate::imap::Recipient>)> = conn
        .query_row(
            "SELECT from_addr, json_extract(json, '$.to'), json_extract(json, '$.cc')
               FROM messages
              WHERE account = ?1 AND folder = ?2
                AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3
              ORDER BY date DESC, uid DESC LIMIT 1",
            params![account, folder, thread_key],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    parse_recipients_json(row.get::<_, Option<String>>(1)?),
                    parse_recipients_json(row.get::<_, Option<String>>(2)?),
                ))
            },
        )
        .optional()?;

    let Some((from_addr, to, cc)) = row else {
        return Ok(None);
    };
    let mine = crate::store::self_addrs(conn, account);
    let signals = priority_signals(conn, account, &from_addr, &to, &cc, &mine);
    Ok(Some((from_addr, signals)))
}

/// Judges every message of an account that has not been judged yet.
///
/// The gap this closes is one no server can help with, so it is closed here:
/// a mailbox cached before priority existed gets a verdict in one pass rather
/// than being quietly treated as "not priority", which would hide mail behind
/// a filter for no stated reason.
pub fn rejudge_priority(conn: &Connection, account: &str, only_unjudged: bool) -> Result<usize> {
    let mine = crate::store::self_addrs(conn, account);
    let where_clause = if only_unjudged { "AND priority IS NULL" } else { "" };
    let rows: Vec<(i64, String, Vec<crate::imap::Recipient>, Vec<crate::imap::Recipient>)> = {
        let sql = format!(
            "SELECT id, from_addr, json_extract(json, '$.to'), json_extract(json, '$.cc')
               FROM messages WHERE account = ?1 AND uid <> 0 {where_clause}"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mapped = stmt.query_map(params![account], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                parse_recipients_json(row.get::<_, Option<String>>(2)?),
                parse_recipients_json(row.get::<_, Option<String>>(3)?),
            ))
        })?;
        mapped.filter_map(Result::ok).collect()
    };

    let tx = conn.unchecked_transaction()?;
    let mut judged = 0;
    {
        let mut stmt = tx.prepare("UPDATE messages SET priority = ?2 WHERE id = ?1")?;
        for (id, from_addr, to, cc) in rows {
            let signals = priority_signals(&tx, account, &from_addr, &to, &cc, &mine);
            let verdict = crate::priority::verdict(signals);
            stmt.execute(params![id, verdict.priority as i64])?;
            judged += 1;
        }
    }
    tx.commit()?;
    Ok(judged)
}

/// Every kept template, in the order they were arranged.
pub fn templates(conn: &Connection) -> Result<Vec<crate::templates::Template>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, subject, body_html, body_text FROM templates ORDER BY position",
    )?;
    let rows = stmt.query_map([], |row| {
        let kind: String = row.get(1)?;
        Ok(crate::templates::Template {
            id: row.get(0)?,
            kind: crate::templates::Kind::parse(&kind),
            name: row.get(2)?,
            subject: row.get(3)?,
            body_html: row.get(4)?,
            body_text: row.get(5)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Replaces the whole set of templates, in the order given.
///
/// Stated whole rather than one at a time, the same way labels are: the
/// arrangement is part of what is being saved, and applying a reorder as a
/// sequence of single writes would leave moments where the list was in an
/// order nobody asked for.
pub fn replace_templates(
    conn: &Connection,
    templates: &[crate::templates::Template],
    now: i64,
) -> Result<()> {
    conn.execute("DELETE FROM templates", [])?;
    let mut stmt = conn.prepare(
        "INSERT INTO templates(id, kind, name, subject, body_html, body_text, position, updated)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for (position, template) in templates.iter().enumerate() {
        stmt.execute(params![
            template.id,
            template.kind.as_str(),
            template.name,
            template.subject,
            template.body_html,
            template.body_text,
            position as i64,
            now,
        ])?;
    }
    Ok(())
}

/// Where a book of people came from.
///
/// The three together, plus the book's own id for a person, say who a row is
/// *there* — which is what lets a re-sync update in place instead of adding
/// everybody again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookOrigin {
    /// "carddav", "google", "exchange", "local".
    pub source: String,
    /// The account it belongs to; empty for a book that is not an account's.
    pub account: String,
    /// Which book within that source, when the source has more than one.
    pub book: String,
}

impl BookOrigin {
    fn person_id(&self, uid: &str) -> String {
        format!("{}:{}:{}:{}", self.source, self.account, self.book, uid)
    }
}

/// A person as the store returns them, with where they came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPerson {
    pub id: String,
    pub origin: BookOrigin,
    pub person: crate::contacts::person::Person,
    /// Media key of the cached picture, empty when there is none.
    pub photo_key: String,
}

/// Replace everything in one book with what a sync just read.
///
/// Whole rather than incremental, and deliberately: a sync reads the book as
/// it now is, and reconciling that against what was here by guessing which
/// rows correspond would be a way to keep somebody the server deleted. What it
/// costs is that a book briefly has no rows mid-write, which the transaction
/// hides from every reader.
///
/// Only this book is touched. The same person in two books stays two rows —
/// merging them by name would be a guess, and an address book that quietly
/// fuses two people is worse than one that shows both.
pub fn replace_book(
    conn: &Connection,
    origin: &BookOrigin,
    people: &[(crate::contacts::person::Person, String)],
    now: i64,
) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM person_emails WHERE person_id IN
           (SELECT id FROM people WHERE source = ?1 AND account = ?2 AND book = ?3)",
        params![origin.source, origin.account, origin.book],
    )?;
    tx.execute(
        "DELETE FROM person_phones WHERE person_id IN
           (SELECT id FROM people WHERE source = ?1 AND account = ?2 AND book = ?3)",
        params![origin.source, origin.account, origin.book],
    )?;
    tx.execute(
        "DELETE FROM people WHERE source = ?1 AND account = ?2 AND book = ?3",
        params![origin.source, origin.account, origin.book],
    )?;

    let mut written = 0usize;
    {
        let mut person_stmt = tx.prepare(
            "INSERT OR REPLACE INTO people
               (id, source, account, book, uid, name, organisation, note, photo, updated)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let mut email_stmt = tx.prepare(
            "INSERT OR REPLACE INTO person_emails(person_id, addr, label, position)
             VALUES(?1, ?2, ?3, ?4)",
        )?;
        let mut phone_stmt = tx.prepare(
            "INSERT OR REPLACE INTO person_phones(person_id, number, label, position)
             VALUES(?1, ?2, ?3, ?4)",
        )?;

        for (index, (person, photo_key)) in people.iter().enumerate() {
            // A book that gives nobody a uid — some exports do — still has
            // people in it. Their position stands in, which is stable for as
            // long as the book is, and a re-sync replaces the lot anyway.
            let uid = if person.uid.trim().is_empty() {
                format!("#{index}")
            } else {
                person.uid.trim().to_string()
            };
            let id = origin.person_id(&uid);
            person_stmt.execute(params![
                id,
                origin.source,
                origin.account,
                origin.book,
                uid,
                person.name,
                person.organisation,
                person.note,
                photo_key,
                now,
            ])?;
            for (position, email) in person.emails.iter().enumerate() {
                email_stmt.execute(params![id, email.addr, email.label, position as i64])?;
            }
            for (position, phone) in person.phones.iter().enumerate() {
                phone_stmt.execute(params![id, phone.number, phone.label, position as i64])?;
            }
            written += 1;
        }
    }
    tx.commit()?;
    Ok(written)
}

/// Read the addresses and phones belonging to a set of people, in one pass each.
fn attachments_for(
    conn: &Connection,
    ids: &[String],
) -> Result<(
    std::collections::HashMap<String, Vec<crate::contacts::person::EmailAddress>>,
    std::collections::HashMap<String, Vec<crate::contacts::person::PhoneNumber>>,
)> {
    use crate::contacts::person::{EmailAddress, PhoneNumber};
    use std::collections::HashMap;

    let mut emails: HashMap<String, Vec<EmailAddress>> = HashMap::new();
    let mut phones: HashMap<String, Vec<PhoneNumber>> = HashMap::new();
    if ids.is_empty() {
        return Ok((emails, phones));
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let bound: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

    let mut stmt = conn.prepare(&format!(
        "SELECT person_id, addr, label FROM person_emails
          WHERE person_id IN ({placeholders}) ORDER BY person_id, position"
    ))?;
    let rows = stmt.query_map(bound.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            EmailAddress {
                addr: row.get(1)?,
                label: row.get(2)?,
            },
        ))
    })?;
    for (id, email) in rows.flatten() {
        emails.entry(id).or_default().push(email);
    }

    let mut stmt = conn.prepare(&format!(
        "SELECT person_id, number, label FROM person_phones
          WHERE person_id IN ({placeholders}) ORDER BY person_id, position"
    ))?;
    let rows = stmt.query_map(bound.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            PhoneNumber {
                number: row.get(1)?,
                label: row.get(2)?,
            },
        ))
    })?;
    for (id, phone) in rows.flatten() {
        phones.entry(id).or_default().push(phone);
    }

    Ok((emails, phones))
}

/// People whose name, organisation or any address matches, by name.
///
/// An empty query is the whole book, which is what the Personas view opens on.
pub fn find_people(conn: &Connection, query: &str, limit: u32) -> Result<Vec<StoredPerson>> {
    let needle = query.trim().to_lowercase();
    let like = format!("%{}%", escape_like(needle.clone()));
    let mut stmt = conn.prepare(
        "SELECT id, source, account, book, uid, name, organisation, note, photo
           FROM people
          WHERE ?1 = ''
             OR lower(name) LIKE ?2 ESCAPE '\\'
             OR lower(organisation) LIKE ?2 ESCAPE '\\'
             OR id IN (SELECT person_id FROM person_emails WHERE addr LIKE ?2 ESCAPE '\\')
          ORDER BY name COLLATE NOCASE
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![needle, like, limit as i64], |row| {
        Ok(StoredPerson {
            id: row.get(0)?,
            origin: BookOrigin {
                source: row.get(1)?,
                account: row.get(2)?,
                book: row.get(3)?,
            },
            person: crate::contacts::person::Person {
                uid: row.get(4)?,
                name: row.get(5)?,
                organisation: row.get(6)?,
                note: row.get(7)?,
                emails: Vec::new(),
                phones: Vec::new(),
                photo: None,
            },
            photo_key: row.get(8)?,
        })
    })?;
    let mut people: Vec<StoredPerson> = rows.flatten().collect();

    let ids: Vec<String> = people.iter().map(|person| person.id.clone()).collect();
    let (emails, phones) = attachments_for(conn, &ids)?;
    for person in &mut people {
        person.person.emails = emails.get(&person.id).cloned().unwrap_or_default();
        person.person.phones = phones.get(&person.id).cloned().unwrap_or_default();
    }
    Ok(people)
}

/// One place people are fetched from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSource {
    pub id: String,
    /// "carddav" for now; the others get their own word when they arrive.
    pub kind: String,
    pub account: String,
    pub url: String,
    pub username: String,
    pub name: String,
    pub enabled: bool,
    #[serde(skip)]
    pub ctag: String,
    pub last_sync_at: i64,
    pub last_error: String,
}

pub fn contact_sources(conn: &Connection) -> Result<Vec<ContactSource>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, account, url, username, name, enabled, ctag, last_sync_at, last_error
           FROM contact_sources ORDER BY created_at, name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ContactSource {
            id: row.get(0)?,
            kind: row.get(1)?,
            account: row.get(2)?,
            url: row.get(3)?,
            username: row.get(4)?,
            name: row.get(5)?,
            enabled: row.get::<_, i64>(6)? != 0,
            ctag: row.get(7)?,
            last_sync_at: row.get(8)?,
            last_error: row.get(9)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub fn contact_source(conn: &Connection, id: &str) -> Result<Option<ContactSource>> {
    Ok(contact_sources(conn)?.into_iter().find(|source| source.id == id))
}

/// Add or update a source. The password is not part of this: it lives in the
/// keyring, and the caller stores it there.
pub fn upsert_contact_source(conn: &Connection, source: &ContactSource, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO contact_sources(id, kind, account, url, username, name, enabled, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, account = excluded.account, url = excluded.url,
           username = excluded.username, name = excluded.name, enabled = excluded.enabled",
        params![
            source.id,
            source.kind,
            source.account,
            source.url,
            source.username,
            source.name,
            source.enabled as i64,
            now
        ],
    )?;
    Ok(())
}

/// Record how a sync went. An empty error means it went well.
pub fn mark_contact_source_synced(
    conn: &Connection,
    id: &str,
    ctag: &str,
    error: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE contact_sources SET ctag = ?2, last_error = ?3, last_sync_at = ?4 WHERE id = ?1",
        params![id, ctag, error, now],
    )?;
    Ok(())
}

/// Remove a source and every person that came from it.
///
/// The people go too: they were a copy of somebody else's book, and a copy
/// with no origin is one that can never be refreshed or told apart from a
/// contact the reader typed.
pub fn delete_contact_source(conn: &Connection, id: &str) -> Result<()> {
    let Some(source) = contact_source(conn, id)? else {
        return Ok(());
    };
    let origin = BookOrigin {
        source: source.kind.clone(),
        account: source.account.clone(),
        book: source.id.clone(),
    };
    replace_book(conn, &origin, &[], 0)?;
    conn.execute("DELETE FROM contact_sources WHERE id = ?1", params![id])?;
    Ok(())
}

/// A label the reader has made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub id: String,
    pub name: String,
    /// A colour the interface paints it in, as `#rrggbb`.
    pub colour: String,
}

/// Every label, in the order they were arranged.
pub fn labels(conn: &Connection) -> Result<Vec<Label>> {
    let mut stmt = conn.prepare("SELECT id, name, colour FROM labels ORDER BY position")?;
    let rows = stmt.query_map([], |row| {
        Ok(Label {
            id: row.get(0)?,
            name: row.get(1)?,
            colour: row.get(2)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Replaces the whole set of labels, in the order given.
///
/// A label that is gone takes its assignments with it. Leaving them behind
/// would mean conversations carrying a label nobody can see, name or remove —
/// and a filter counting them without being able to show them.
pub fn replace_labels(conn: &Connection, labels: &[Label]) -> Result<()> {
    conn.execute("DELETE FROM labels", [])?;
    {
        let mut stmt =
            conn.prepare("INSERT INTO labels(id, name, colour, position) VALUES(?1, ?2, ?3, ?4)")?;
        for (position, label) in labels.iter().enumerate() {
            stmt.execute(params![label.id, label.name, label.colour, position as i64])?;
        }
    }
    conn.execute(
        "DELETE FROM thread_labels WHERE label_id NOT IN (SELECT id FROM labels)",
        [],
    )?;
    Ok(())
}

/// The labels on one conversation.
pub fn thread_labels(conn: &Connection, account: &str, thread_key: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT l.id FROM thread_labels t
           JOIN labels l ON l.id = t.label_id
          WHERE t.account = ?1 AND t.thread_key = ?2
          ORDER BY l.position",
    )?;
    let rows = stmt.query_map(params![account, thread_key], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Puts exactly this set of labels on a conversation.
///
/// The whole set at once, because "these are its labels" is one statement;
/// adding and removing one at a time would leave moments where a conversation
/// carried a combination nobody asked for.
pub fn set_thread_labels(
    conn: &Connection,
    account: &str,
    thread_key: &str,
    label_ids: &[String],
) -> Result<()> {
    conn.execute(
        "DELETE FROM thread_labels WHERE account = ?1 AND thread_key = ?2",
        params![account, thread_key],
    )?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO thread_labels(account, thread_key, label_id)
         SELECT ?1, ?2, id FROM labels WHERE id = ?3",
    )?;
    for label_id in label_ids {
        stmt.execute(params![account, thread_key, label_id])?;
    }
    Ok(())
}

/// Adds one label to a conversation, leaving its others alone.
///
/// For the rules, which say "also label this" rather than "these are now its
/// labels" — a rule that replaced the set would quietly strip whatever the
/// reader had put there by hand.
pub fn add_thread_label(
    conn: &Connection,
    account: &str,
    thread_key: &str,
    label_id: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO thread_labels(account, thread_key, label_id)
         SELECT ?1, ?2, id FROM labels WHERE id = ?3",
        params![account, thread_key, label_id],
    )?;
    Ok(())
}

/// The labels on each of a set of conversations, so a list can show them
/// without asking once per row.
pub fn labels_for_threads(
    conn: &Connection,
    account: &str,
    thread_keys: &[String],
) -> Result<HashMap<String, Vec<String>>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    if thread_keys.is_empty() {
        return Ok(out);
    }
    let mut stmt = conn.prepare(
        "SELECT t.thread_key, t.label_id FROM thread_labels t
           JOIN labels l ON l.id = t.label_id
          WHERE t.account = ?1
          ORDER BY l.position",
    )?;
    let wanted: HashSet<&String> = thread_keys.iter().collect();
    let rows = stmt.query_map(params![account], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for (thread_key, label_id) in rows.filter_map(Result::ok) {
        if wanted.contains(&thread_key) {
            out.entry(thread_key).or_default().push(label_id);
        }
    }
    Ok(out)
}

/// One entry of the record of what the rules did.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleLogEntry {
    pub at: i64,
    pub account: String,
    pub rule_id: String,
    pub rule_name: String,
    pub folder: String,
    pub uid: u32,
    pub subject: String,
    pub from_addr: String,
    /// What was done, as the interface shows it, e.g. `moveTo:Archive`.
    pub action: String,
    /// `done`, or why it did not happen.
    pub outcome: String,
}

/// How much of the record is kept.
///
/// Enough to answer "what moved my mail last week", bounded so a busy mailbox
/// does not grow a log without end.
pub const RULE_LOG_LIMIT: i64 = 1000;

/// Replaces the whole set of rules, in the order given.
///
/// All at once because the order is part of the meaning: rules run top to
/// bottom and one of them can stop the rest, so saving them one by one would
/// leave moments where the list means something nobody asked for.
pub fn replace_rules(conn: &Connection, rules: &[(String, String, bool, String)]) -> Result<()> {
    conn.execute("DELETE FROM rules", [])?;
    let mut stmt = conn.prepare(
        "INSERT INTO rules(id, account, position, enabled, definition) VALUES(?1, ?2, ?3, ?4, ?5)",
    )?;
    for (position, (id, account, enabled, definition)) in rules.iter().enumerate() {
        stmt.execute(params![id, account, position as i64, *enabled, definition])?;
    }
    Ok(())
}

/// Every rule, in the order they run.
pub fn rules(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT definition FROM rules ORDER BY position")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Records one thing a rule did, and trims the record to its limit.
pub fn log_rule_action(conn: &Connection, entry: &RuleLogEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO rule_log(at, account, rule_id, rule_name, folder, uid, subject,
                              from_addr, action, outcome)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            entry.at,
            entry.account,
            entry.rule_id,
            entry.rule_name,
            entry.folder,
            entry.uid,
            entry.subject,
            entry.from_addr,
            entry.action,
            entry.outcome,
        ],
    )?;
    conn.execute(
        "DELETE FROM rule_log WHERE id NOT IN
           (SELECT id FROM rule_log ORDER BY id DESC LIMIT ?1)",
        params![RULE_LOG_LIMIT],
    )?;
    Ok(())
}

/// What the rules have done, most recent first.
pub fn rule_log(conn: &Connection, limit: i64) -> Result<Vec<RuleLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT at, account, rule_id, rule_name, folder, uid, subject, from_addr, action, outcome
           FROM rule_log ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit.max(0)], |row| {
        Ok(RuleLogEntry {
            at: row.get(0)?,
            account: row.get(1)?,
            rule_id: row.get(2)?,
            rule_name: row.get(3)?,
            folder: row.get(4)?,
            uid: row.get(5)?,
            subject: row.get(6)?,
            from_addr: row.get(7)?,
            action: row.get(8)?,
            outcome: row.get(9)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Forgets the record. The reader's own, so theirs to clear.
pub fn clear_rule_log(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM rule_log", [])?;
    Ok(())
}

/// A message written now and due to go later.
///
/// The whole send travels as `payload` — recipients, body, attachments — so
/// the message that leaves at eight is the message that was written at six,
/// not a reconstruction of it.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledSend {
    pub id: String,
    pub account: String,
    pub due_at: i64,
    pub subject: String,
    pub payload: String,
    /// How many times sending it has been tried and refused.
    pub attempts: i64,
    /// Why the last try failed, empty while none has.
    pub last_error: String,
    /// When it was last tried, zero while it never has been.
    pub last_attempt: i64,
}

/// After this many refusals a scheduled send stops being retried.
///
/// A message that cannot go is usually one that will never go — a bad
/// recipient, a rejected attachment — and retrying it every minute until the
/// reader next opens the app would be a great deal of noise in service of
/// nothing. It stays in the list, with its reason, waiting for a person.
pub const MAX_SEND_ATTEMPTS: i64 = 5;

/// The wait before a refused send is tried again, doubling with each refusal.
pub const RETRY_BACKOFF_SECONDS: i64 = 60;

fn scheduled_send_from_row(row: &rusqlite::Row) -> rusqlite::Result<ScheduledSend> {
    Ok(ScheduledSend {
        id: row.get(0)?,
        account: row.get(1)?,
        due_at: row.get(2)?,
        subject: row.get(3)?,
        payload: row.get(4)?,
        attempts: row.get(5)?,
        last_error: row.get(6)?,
        last_attempt: row.get(7)?,
    })
}

/// Files a message to be sent at `due_at`.
///
/// Replacing any earlier row with the same id: rescheduling a message is
/// changing when one message goes, not adding a second copy of it.
pub fn schedule_send(
    conn: &Connection,
    id: &str,
    account: &str,
    due_at: i64,
    subject: &str,
    payload: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO scheduled_sends(id, account, due_at, subject, payload,
                                                attempts, last_error, last_attempt)
         VALUES(?1, ?2, ?3, ?4, ?5, 0, '', 0)",
        params![id, account, due_at, subject, payload],
    )?;
    Ok(())
}

/// Everything still waiting to go, soonest first.
///
/// Including what has given up trying: a message that failed is exactly the
/// one its writer most needs to see.
pub fn scheduled_sends(conn: &Connection, account: Option<&str>) -> Result<Vec<ScheduledSend>> {
    let mut stmt = conn.prepare(
        "SELECT id, account, due_at, subject, payload, attempts, last_error, last_attempt
           FROM scheduled_sends
          WHERE ?1 IS NULL OR account = ?1
          ORDER BY due_at",
    )?;
    let rows = stmt.query_map(params![account], scheduled_send_from_row)?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// One scheduled send, by id.
pub fn scheduled_send(conn: &Connection, id: &str) -> Result<Option<ScheduledSend>> {
    let mut stmt = conn.prepare(
        "SELECT id, account, due_at, subject, payload, attempts, last_error, last_attempt
           FROM scheduled_sends WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], scheduled_send_from_row)?;
    Ok(rows.next().transpose()?)
}

/// Calls a scheduled send off, handing back what it was.
///
/// The payload comes back so the message can return to the composer it was
/// written in: cancelling a send should give the reader their words, not
/// take them away.
pub fn cancel_scheduled_send(conn: &Connection, id: &str) -> Result<Option<ScheduledSend>> {
    let existing = scheduled_send(conn, id)?;
    if existing.is_some() {
        conn.execute("DELETE FROM scheduled_sends WHERE id = ?1", params![id])?;
    }
    Ok(existing)
}

/// Stops trying a scheduled send outright, recording why.
///
/// For a message no retry could help — one whose stored form can no longer be
/// read. Counting it up one refusal at a time would mean half an hour of
/// pretending there was something left to wait for.
pub fn give_up_on_send(conn: &Connection, id: &str, error: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE scheduled_sends
            SET attempts = ?2, last_error = ?3, last_attempt = ?4
          WHERE id = ?1",
        params![id, MAX_SEND_ATTEMPTS, error, now],
    )?;
    Ok(())
}

/// The messages whose hour has come and which are still worth trying.
///
/// A refused message waits twice as long before each new try — a minute, then
/// two, then four. A submission server that is down for ten minutes should not
/// exhaust a message's tries in ten minutes, and the reader gains nothing from
/// the same failure being attempted sixty times an hour.
pub fn due_scheduled_sends(conn: &Connection, now: i64) -> Result<Vec<ScheduledSend>> {
    let mut stmt = conn.prepare(
        "SELECT id, account, due_at, subject, payload, attempts, last_error, last_attempt
           FROM scheduled_sends
          WHERE due_at <= ?1 AND attempts < ?2
            AND ?1 >= last_attempt + (?3 * (1 << attempts))
          ORDER BY due_at",
    )?;
    let rows = stmt.query_map(
        params![now, MAX_SEND_ATTEMPTS, RETRY_BACKOFF_SECONDS],
        scheduled_send_from_row,
    )?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Records that a scheduled send was refused, and why.
///
/// Returns the new count of attempts, so the caller can tell a try that will
/// come round again from one that has given up.
pub fn record_send_failure(conn: &Connection, id: &str, error: &str, now: i64) -> Result<i64> {
    conn.execute(
        "UPDATE scheduled_sends
            SET attempts = attempts + 1, last_error = ?2, last_attempt = ?3
          WHERE id = ?1",
        params![id, error, now],
    )?;
    Ok(scheduled_send(conn, id)?.map(|row| row.attempts).unwrap_or_default())
}

pub fn draft_thread_keys(conn: &Connection, account: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT COALESCE(NULLIF(m.thread_key, ''), 'uid:' || m.uid), m.folder, f.special_use
           FROM messages m
           LEFT JOIN folders f ON f.account = m.account AND f.name = m.folder
          WHERE m.account = ?1 AND m.uid <> 0",
    )?;
    let rows = stmt.query_map(params![account], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut out = HashSet::new();
    for row in rows {
        let (thread_key, folder, special_use) = row?;
        if classify_folder_role(&folder, special_use.as_deref()) == "drafts" {
            out.insert(thread_key);
        }
    }
    Ok(out)
}

pub fn resolve_message_uids(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
    subject_filter: Option<&str>,
    uid: Option<u32>,
    explicit_uids: &[u32],
) -> Result<Vec<u32>> {
    if !explicit_uids.is_empty() {
        return Ok(explicit_uids.to_vec());
    }
    if thread_key.is_empty() {
        return Ok(uid.into_iter().collect());
    }
    let mut headers = get_thread_headers(conn, account, folder, thread_key)?;
    if let Some(filter) = subject_filter {
        headers.retain(|header| thread_grouping_subject(&header.subject) == filter);
    }
    Ok(headers.into_iter().map(|header| header.uid).collect())
}

#[derive(Clone)]
pub struct ThreadCard {
    pub thread_key: String,
    pub original_thread_key: Option<String>,
    pub header: MessageHeader,
    pub unread_count: u32,
    /// Every message in the card's thread, read or not — the Gmail-style "3"
    /// beside the sender. Counted per card, so a subject-branched thread counts
    /// only its own branch.
    pub message_count: u32,
    pub has_draft: bool,
}

pub fn group_thread_cards(messages: Vec<MessageHeader>, default_folder: &str) -> Vec<ThreadCard> {
    group_thread_cards_with_drafts(messages, default_folder, &HashSet::new())
}

pub fn group_thread_cards_with_drafts(
    messages: Vec<MessageHeader>,
    default_folder: &str,
    draft_thread_keys: &HashSet<String>,
) -> Vec<ThreadCard> {
    use std::collections::HashMap;

    #[derive(Default)]
    struct RootSubject {
        display: String,
        group: String,
        uid: u32,
    }

    let mut roots: HashMap<String, RootSubject> = HashMap::new();
    for message in &messages {
        if message.uid == 0 {
            continue;
        }
        let thread_key = effective_thread_key(message);
        let entry = roots.entry(thread_key).or_default();
        if entry.uid == 0 || message.uid < entry.uid {
            entry.uid = message.uid;
            entry.display = normalize_thread_subject(&message.subject);
            entry.group = thread_grouping_subject(&message.subject);
        }
    }

    let mut groups: HashMap<String, ThreadCard> = HashMap::new();
    let mut order = Vec::new();
    for message in messages {
        if message.uid == 0 {
            continue;
        }
        let base_key = effective_thread_key(&message);
        let branch = should_branch_thread_by_subject(&base_key);
        let group_subject = if branch {
            thread_grouping_subject(&message.subject)
        } else {
            String::new()
        };
        let compound_key = card_thread_key(&message);
        let card = groups.entry(compound_key.clone()).or_insert_with(|| {
            order.push(compound_key.clone());
            let root = roots.get(&base_key);
            let mut header = message.clone();
            if header.folder.is_empty() {
                header.folder = default_folder.to_string();
            }
            header.thread_key = compound_key.clone();
            let title = root.map(|root| root.display.as_str()).unwrap_or_default();
            if !title.is_empty() {
                header.subject = title.to_string();
            }
            let original_thread_key = if branch
                && root
                    .map(|root| root.group.as_str() != group_subject.as_str())
                    .unwrap_or(false)
            {
                root.map(|root| branch_compound_key(&base_key, &root.group))
            } else {
                None
            };
            ThreadCard {
                thread_key: compound_key.clone(),
                original_thread_key,
                header,
                unread_count: 0,
                message_count: 0,
                has_draft: draft_thread_keys.contains(&base_key),
            }
        });
        card.message_count += 1;
        if !message.seen {
            card.unread_count += 1;
            card.header.seen = false;
        }
        if message.starred {
            card.header.starred = true;
        }
    }

    order
        .into_iter()
        .filter_map(|key| groups.remove(&key))
        .collect()
}

/// Total cached messages behind each of `card_keys`, keyed by card key.
///
/// The header page a list request read is not the thread: it is filtered
/// (unread-only, starred-only, search hits) and cursor-paged by *message*, so
/// counting the headers handed to [`group_thread_cards_with_drafts`] would
/// report "1" for a long thread with a single unread message and would split a
/// thread that straddles a page boundary. The cache holds the whole thread, so
/// the count is taken from there and the page tally is only a floor for
/// messages the cache has not seen yet.
///
/// The scope matches what opening the row shows, so the badge never contradicts
/// the reader (see `thread_read`): real threading keys count across every folder
/// in the account, because a received message and the user's own Sent reply
/// belong to one thread; synthetic `uid:N` keys stay inside `folder`, because
/// UIDs are folder-scoped and spanning folders would pull in an unrelated
/// message that happens to share the UID.
///
/// Cross-folder rows are deduplicated by Message-ID exactly as
/// [`get_thread_headers_all_folders`] does, so a self-sent message cached in
/// both Sent and Inbox counts once — the reader renders it as one bubble.
///
/// Counting re-derives each row's card key rather than grouping on the raw
/// thread key, so a subject-branched thread counts only the branch its card
/// stands for — the same split [`card_thread_key`] makes.
pub fn card_message_counts(
    conn: &Connection,
    account: &str,
    folder: &str,
    card_keys: &[String],
) -> Result<std::collections::HashMap<String, u32>> {
    use std::collections::HashMap;

    let mut roots: Vec<String> = card_keys
        .iter()
        .map(|key| split_thread_key(key).0)
        .collect();
    roots.sort();
    roots.dedup();
    let (uid_roots, threaded_roots): (Vec<String>, Vec<String>) =
        roots.into_iter().partition(|root| root.starts_with("uid:"));

    let mut counts: HashMap<String, u32> = HashMap::new();
    count_card_rows(conn, account, Some(folder), &uid_roots, &mut counts)?;
    count_card_rows(conn, account, None, &threaded_roots, &mut counts)?;
    Ok(counts)
}

/// Tally the cached rows of `roots` into `counts`, one card key at a time.
/// `folder` scopes the query to a single mailbox; `None` spans the account.
fn count_card_rows(
    conn: &Connection,
    account: &str,
    folder: Option<&str>,
    roots: &[String],
    counts: &mut std::collections::HashMap<String, u32>,
) -> Result<()> {
    use std::collections::HashSet;

    // Message-ID duplicates are folded in Rust rather than with the correlated
    // NOT EXISTS that reading a single thread uses: with a page of keys and no
    // index on thread_key, that subquery would re-scan the account's messages
    // once per row, where one pass plus a set of seen ids is linear.
    let mut seen_ids: HashSet<(String, String)> = HashSet::new();
    // SQLite caps bound parameters per statement; a page of cards stays well
    // under it, but chunk anyway so an unpaginated caller cannot overrun it.
    for chunk in roots.chunks(100) {
        let first = if folder.is_some() { 3 } else { 2 };
        let placeholders = (first..first + chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let folder_clause = if folder.is_some() {
            "folder = ?2 AND "
        } else {
            ""
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT COALESCE(NULLIF(thread_key, ''), 'uid:' || uid), subject,
                    COALESCE(json_extract(json, '$.message_id'), '') FROM messages
             WHERE account = ?1 AND {folder_clause}uid <> 0
               AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) IN ({placeholders})"
        ))?;
        let mut args: Vec<&str> = vec![account];
        args.extend(folder);
        args.extend(chunk.iter().map(String::as_str));
        let rows = stmt.query_map(params_from_iter(args), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (root, subject, message_id) = row?;
            let key = if should_branch_thread_by_subject(&root) {
                branch_compound_key(&root, &thread_grouping_subject(&subject))
            } else {
                root
            };
            // A row with no Message-ID cannot be matched to a copy, so it counts
            // on its own — same call the thread reader makes.
            if !message_id.is_empty() && !seen_ids.insert((key.clone(), message_id)) {
                continue;
            }
            *counts.entry(key).or_insert(0) += 1;
        }
    }
    Ok(())
}

fn effective_thread_key(message: &MessageHeader) -> String {
    if message.thread_key.is_empty() {
        format!("uid:{}", message.uid)
    } else {
        message.thread_key.clone()
    }
}

/// The branch-aware thread key a list card for `message` carries: the root
/// thread key joined with the message's grouping subject for branchable
/// threads, or the bare root for uid:/gmthrid: keys. Every path that mints a
/// clickable thread id (thread lists, starred items, new-mail notifications)
/// must use this so the id matches the card the grouping produced.
pub fn card_thread_key(message: &MessageHeader) -> String {
    let base = effective_thread_key(message);
    if should_branch_thread_by_subject(&base) {
        branch_compound_key(&base, &thread_grouping_subject(&message.subject))
    } else {
        base
    }
}

/// Split a `thread_key` request parameter into (root key, branch subject
/// filter). Card-minted keys for branchable threads always carry the
/// `#subject` suffix (see [`card_thread_key`]); uid:/gmthrid: keys never do.
pub fn split_thread_key(thread_key: &str) -> (String, Option<String>) {
    if should_branch_thread_by_subject(thread_key) {
        split_branch_compound_key(thread_key)
    } else {
        (thread_key.to_string(), None)
    }
}

pub fn should_branch_thread_by_subject(thread_key: &str) -> bool {
    !thread_key.starts_with("uid:") && !thread_key.starts_with("gmthrid:")
}

/// Join a root thread key and a grouping subject into one branch key. The root
/// is a raw Message-ID, where `#` is legal atext — escape it so
/// [`split_branch_compound_key`] can split at the first literal `#`
/// unambiguously (the subject side stays verbatim; it is only ever compared
/// whole against other grouping subjects).
pub fn branch_compound_key(root: &str, group_subject: &str) -> String {
    let escaped = root.replace('%', "%25").replace('#', "%23");
    format!("{escaped}#{group_subject}")
}

/// Split a branch key built by [`branch_compound_key`] back into
/// (root thread key, grouping subject). Keys without a `#` separator were
/// never escaped (unbranched legacy ids) and come back verbatim with no
/// subject.
pub fn split_branch_compound_key(compound: &str) -> (String, Option<String>) {
    match compound.split_once('#') {
        Some((root, subject)) => (
            root.replace("%23", "#").replace("%25", "%"),
            Some(subject.to_string()),
        ),
        None => (compound.to_string(), None),
    }
}

pub fn normalize_thread_subject(subject: &str) -> String {
    let mut subject = subject.trim();
    while let Some(rest) = strip_reply_prefix(subject) {
        subject = rest.trim();
    }
    subject.to_string()
}

pub fn thread_grouping_subject(subject: &str) -> String {
    let mut subject = subject.trim();
    loop {
        if let Some(rest) = strip_reply_prefix(subject) {
            subject = rest.trim();
            continue;
        }
        if let Some(rest) = strip_leading_bracket_tag(subject) {
            subject = rest.trim();
            continue;
        }
        break;
    }
    subject.to_string()
}

fn strip_reply_prefix(subject: &str) -> Option<&str> {
    let mut probe = subject.trim_start();
    while let Some(rest) = strip_leading_bracket_tag(probe) {
        probe = rest.trim_start();
    }

    const PREFIXES: &[&str] = &[
        "re", "fw", "fwd", "aw", "sv", "vs", "rv", "res", "tr", "antw", "wg", "答复", "回复",
        "转发",
    ];
    // Try every prefix that matches, not just the first: "fw" is a string
    // prefix of "Fwd:" but fails the colon check, and only the "fwd" entry
    // succeeds (mirrors the Go regex alternation, where the engine picks the
    // alternative that lets the trailing colon match).
    for prefix in PREFIXES {
        if !probe.is_char_boundary(prefix.len())
            || !probe[..prefix.len()].eq_ignore_ascii_case(prefix)
        {
            continue;
        }
        let mut rest = &probe[prefix.len()..];
        if let Some(after_count) = strip_reply_count(rest) {
            rest = after_count;
        }
        let mut chars = rest.chars();
        match chars.next() {
            Some(':') | Some('：') => return Some(chars.as_str()),
            _ => continue,
        }
    }
    None
}

fn strip_reply_count(rest: &str) -> Option<&str> {
    let bytes = rest.as_bytes();
    let close = match bytes.first()? {
        b'[' => b']',
        b'(' => b')',
        _ => return None,
    };
    let end = bytes.iter().position(|byte| *byte == close)?;
    if end <= 1 || !bytes[1..end].iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(&rest[end + 1..])
}

fn strip_leading_bracket_tag(subject: &str) -> Option<&str> {
    let trimmed = subject.trim_start();
    if !trimmed.starts_with('[') {
        return None;
    }
    let end = trimmed.find(']')?;
    Some(&trimmed[end + 1..])
}

/// Message-IDs a thread references but hasn't cached locally. Across every
/// cached row of `account` sharing `thread_key`, collect the union of ids they
/// reference (each row's `References` chain) plus the root id (`thread_key`
/// itself), then subtract the ids already present as cached messages. The
/// remainder is the ancestry the thread links to but that lies outside the
/// synced window — the on-demand fetch target. All ids are lowercased here so
/// the set comparison is case-insensitive; stored ids preserve the original
/// header casing.
pub fn get_thread_reference_gaps(
    conn: &Connection,
    account: &str,
    thread_key: &str,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT json FROM messages
         WHERE account = ?1 AND uid <> 0
           AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?2",
    )?;
    let rows = stmt.query_map(params![account, thread_key], |row| {
        row.get::<_, Option<String>>(0)
    })?;
    let mut referenced: std::collections::BTreeSet<String> = Default::default();
    let mut present: std::collections::HashSet<String> = Default::default();
    let normalize = |id: &str| {
        id.trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .trim()
            .to_ascii_lowercase()
    };
    for row in rows {
        let json = row?.unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
        if let Some(mid) = parsed.get("message_id").and_then(|v| v.as_str()) {
            let mid = normalize(mid);
            if !mid.is_empty() {
                present.insert(mid);
            }
        }
        if let Some(refs) = parsed.get("references").and_then(|v| v.as_str()) {
            for id in refs.split_whitespace() {
                let id = normalize(id);
                if !id.is_empty() {
                    referenced.insert(id);
                }
            }
        }
    }
    // The non-synthetic `thread_key` is the thread's root Message-ID.
    if !thread_key.starts_with("uid:") {
        let root = normalize(thread_key);
        if !root.is_empty() {
            referenced.insert(root);
        }
    }
    Ok(referenced
        .into_iter()
        .filter(|id| !present.contains(id))
        .collect())
}

/// Like `get_thread_headers`, but spans any folder of `account` whose row
/// shares the `thread_key`. Used by the cross-folder thread view so a reply
/// stored in Sent appears alongside the inbox messages it threads with.
/// Each header carries its source `folder` so the reader can fetch the body
/// from the right mailbox. Ordered by `date` ASC (UIDs are folder-scoped, so
/// they aren't comparable across folders).
///
/// A self-addressed message is delivered to both Sent and the Inbox, so the
/// same RFC `Message-ID` lands as two rows under one `thread_key` (distinct
/// per-folder UIDs sidestep the `UNIQUE(account, folder, msg_id)` constraint).
/// We collapse those to a single bubble by keeping, per non-empty
/// `Message-ID`, the unread copy if any, otherwise the lowest-`id` row. Rows
/// without a `Message-ID` (e.g. drafts) are never collapsed — a NULL
/// `Message-ID` never equates in SQL.
pub fn get_thread_headers_all_folders(
    conn: &Connection,
    account: &str,
    thread_key: &str,
) -> Result<Vec<MessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT m.uid, m.folder, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.starred, m.thread_key,
                json_extract(m.json, '$.in_reply_to')
         FROM messages m
         WHERE m.account = ?1 AND m.uid <> 0
           AND COALESCE(NULLIF(m.thread_key, ''), 'uid:' || m.uid) = ?2
           AND NOT EXISTS (
             SELECT 1 FROM messages dup
             WHERE dup.account = m.account
               AND COALESCE(NULLIF(dup.thread_key, ''), 'uid:' || dup.uid) = ?2
               AND COALESCE(json_extract(m.json, '$.message_id'), '') <> ''
               AND json_extract(dup.json, '$.message_id') = json_extract(m.json, '$.message_id')
               AND (dup.seen < m.seen OR (dup.seen = m.seen AND dup.id < m.id))
           )
         ORDER BY m.date ASC, m.uid ASC",
    )?;
    let rows = stmt.query_map(params![account, thread_key], |row| {
        let uid: u32 = row.get(0)?;
        Ok(MessageHeader {
            uid,
            folder: row.get(1)?,
            subject: row.get(2)?,
            from_name: row.get(3)?,
            from_addr: row.get(4)?,
            date: row.get(5)?,
            seen: row.get::<_, i64>(6)? != 0,
            starred: row.get::<_, i64>(7)? != 0,
            thread_key: row
                .get::<_, Option<String>>(8)?
                .filter(|key| !key.is_empty())
                .unwrap_or_else(|| format!("uid:{uid}")),
            in_reply_to: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            ..Default::default()
        })
    })?;
    // `date` is now an epoch integer, so the SQL ORDER BY sorts chronologically
    // (it could not when date was an RFC 2822 string). Unknown dates (0) sort first.
    let headers = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(headers)
}

fn message_header_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageHeader> {
    let uid = row.get(0)?;
    Ok(MessageHeader {
        uid,
        subject: row.get(1)?,
        from_name: row.get(2)?,
        from_addr: row.get(3)?,
        date: row.get(4)?,
        seen: row.get::<_, i64>(5)? != 0,
        starred: row.get::<_, i64>(6)? != 0,
        thread_key: row
            .get::<_, Option<String>>(7)?
            .filter(|key| !key.is_empty())
            .unwrap_or_else(|| format!("uid:{}", uid)),
        to: parse_recipients_json(row.get::<_, Option<String>>(8)?),
        folder: String::new(),
        ..Default::default()
    })
}

/// Parse a cached `$.to` JSON array into recipients, tolerating null/garbage.
fn parse_recipients_json(json: Option<String>) -> Vec<crate::imap::Recipient> {
    json.and_then(|s| serde_json::from_str::<Vec<crate::imap::Recipient>>(&s).ok())
        .unwrap_or_default()
}

fn escape_like(value: String) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn get_folder_state(
    conn: &Connection,
    account: &str,
    folder: &str,
) -> Result<Option<(u32, u32)>> {
    let row = conn
        .query_row(
            "SELECT uidvalidity, uid_next FROM folder_state WHERE account = ?1 AND folder = ?2",
            params![account, folder],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .ok();
    Ok(row.map(|(v, n)| (v.unwrap_or(0) as u32, n.unwrap_or(0) as u32)))
}

pub fn set_folder_state(
    conn: &Connection,
    account: &str,
    folder: &str,
    uidvalidity: u32,
    uid_next: u32,
) -> Result<()> {
    conn.execute(
        "INSERT INTO folder_state(account, folder, uidvalidity, uid_next) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(account, folder) DO UPDATE SET
           uidvalidity = excluded.uidvalidity, uid_next = excluded.uid_next",
        params![account, folder, uidvalidity as i64, uid_next as i64],
    )?;
    Ok(())
}

/// Cached uids of unread messages in `folder` newer than `since` (epoch
/// seconds), oldest first.
///
/// Backs body prefetch for backends that cannot ask the server this: EWS
/// exposes no restricted search short of hand-written SOAP, so the answer
/// comes from the cache the sync just refreshed. It therefore covers the
/// messages this account knows about, not everything on the server — which is
/// all a prefetch can act on anyway.
pub fn cached_unseen_uids_since(
    conn: &Connection,
    account: &str,
    folder: &str,
    since: i64,
) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid FROM messages
         WHERE account = ?1 AND folder = ?2 AND seen = 0 AND date >= ?3
         ORDER BY uid",
    )?;
    let uids = stmt
        .query_map(params![account, folder, since], |row| {
            row.get::<_, i64>(0).map(|uid| uid as u32)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(uids)
}

/// The folder's last EWS synchronization state, or `None` before the first
/// round (which enumerates the folder from scratch).
/// An in-memory store with the schema applied, for tests in modules that
/// cannot reach the private `db` module.
#[cfg(test)]
pub(crate) fn open_in_memory_for_test() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    db::run_migrations(&conn)?;
    Ok(conn)
}

pub fn get_folder_sync_state(
    conn: &Connection,
    account: &str,
    folder: &str,
) -> Result<Option<String>> {
    let state = conn
        .query_row(
            "SELECT sync_state FROM folder_state WHERE account = ?1 AND folder = ?2",
            params![account, folder],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    Ok(state)
}

pub fn set_folder_sync_state(
    conn: &Connection,
    account: &str,
    folder: &str,
    sync_state: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO folder_state(account, folder, sync_state) VALUES(?1, ?2, ?3)
         ON CONFLICT(account, folder) DO UPDATE SET sync_state = excluded.sync_state",
        params![account, folder, sync_state],
    )?;
    Ok(())
}

/// Resolve an EWS item to its local uid, minting one if this is the first time
/// the item is seen. Uids are allocated per folder from the current maximum, so
/// they ascend with discovery order the way IMAP uids ascend with arrival —
/// which is what the paging and prune logic assume.
///
/// `change_key` is refreshed on every call: it is the item's version stamp and
/// Exchange rejects writes carrying a stale one.
pub fn map_ews_item(
    conn: &Connection,
    account: &str,
    folder: &str,
    item_id: &str,
    change_key: Option<&str>,
) -> Result<u32> {
    if let Some(uid) = conn
        .query_row(
            "SELECT uid FROM ews_item_ids WHERE account = ?1 AND folder = ?2 AND item_id = ?3",
            params![account, folder, item_id],
            |row| row.get::<_, i64>(0),
        )
        .ok()
    {
        conn.execute(
            "UPDATE ews_item_ids SET change_key = ?4
             WHERE account = ?1 AND folder = ?2 AND item_id = ?3",
            params![account, folder, item_id, change_key],
        )?;
        return Ok(uid as u32);
    }
    // Allocate from the folder's high-water mark rather than from the current
    // maximum: a uid must never be reused after its item is deleted, because
    // the message cache, saved Kanban columns and open search snapshots all
    // reference uids that can outlive the row. `folder_state.uid_next` already
    // means exactly "the next uid to hand out", so EWS folders keep their
    // counter there.
    let next: i64 = conn.query_row(
        "INSERT INTO folder_state(account, folder, uid_next) VALUES(?1, ?2, 2)
         ON CONFLICT(account, folder)
           DO UPDATE SET uid_next = COALESCE(folder_state.uid_next, 1) + 1
         RETURNING uid_next - 1",
        params![account, folder],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO ews_item_ids(account, folder, uid, item_id, change_key)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![account, folder, next, item_id, change_key],
    )?;
    Ok(next as u32)
}

/// The newest `limit` mapped uids in a folder, oldest first.
///
/// Uids ascend with arrival, so the highest are the newest; the sync path uses
/// this to decide which messages to fetch envelopes for without re-enumerating
/// the folder.
pub fn newest_ews_uids(
    conn: &Connection,
    account: &str,
    folder: &str,
    limit: u32,
) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid FROM (
             SELECT uid FROM ews_item_ids
             WHERE account = ?1 AND folder = ?2
             ORDER BY uid DESC LIMIT ?3
         ) ORDER BY uid",
    )?;
    let uids = stmt
        .query_map(params![account, folder, limit], |row| {
            row.get::<_, i64>(0).map(|uid| uid as u32)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(uids)
}

/// The EWS item behind a local uid, as `(item_id, change_key)`.
pub fn ews_item_for_uid(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<(String, Option<String>)>> {
    let item = conn
        .query_row(
            "SELECT item_id, change_key FROM ews_item_ids
             WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, uid as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .ok();
    Ok(item)
}

/// The local uid an EWS item maps to, if it has been seen before.
pub fn uid_for_ews_item(
    conn: &Connection,
    account: &str,
    folder: &str,
    item_id: &str,
) -> Result<Option<u32>> {
    let uid = conn
        .query_row(
            "SELECT uid FROM ews_item_ids WHERE account = ?1 AND folder = ?2 AND item_id = ?3",
            params![account, folder, item_id],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .map(|uid| uid as u32);
    Ok(uid)
}

/// Drop the mapping for items deleted server-side. The uid is not recycled.
pub fn forget_ews_item(conn: &Connection, account: &str, folder: &str, item_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM ews_item_ids WHERE account = ?1 AND folder = ?2 AND item_id = ?3",
        params![account, folder, item_id],
    )?;
    Ok(())
}

pub fn get_folder_modseq(conn: &Connection, account: &str, folder: &str) -> Result<u64> {
    let modseq = conn
        .query_row(
            "SELECT highest_modseq FROM folder_state WHERE account = ?1 AND folder = ?2",
            params![account, folder],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
        .unwrap_or(0);
    Ok(modseq as u64)
}

pub fn set_folder_modseq(
    conn: &Connection,
    account: &str,
    folder: &str,
    modseq: u64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO folder_state(account, folder, highest_modseq) VALUES(?1, ?2, ?3)
         ON CONFLICT(account, folder) DO UPDATE SET highest_modseq = excluded.highest_modseq",
        params![account, folder, modseq as i64],
    )?;
    Ok(())
}

pub fn update_message_seen(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    seen: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seen = ?4 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
        params![account, folder, uid, seen as i64],
    )?;
    Ok(())
}

pub fn update_message_starred(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    starred: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET starred = ?4 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
        params![account, folder, uid, starred as i64],
    )?;
    Ok(())
}

pub fn update_thread_seen(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
    seen: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seen = ?4
         WHERE account = ?1 AND folder = ?2
           AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3",
        params![account, folder, thread_key, seen as i64],
    )?;
    Ok(())
}

pub fn update_thread_starred(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
    starred: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET starred = ?4
         WHERE account = ?1 AND folder = ?2
           AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3",
        params![account, folder, thread_key, starred as i64],
    )?;
    Ok(())
}

/// A folder's special-use role, resolved from the synced folders table (server
/// attribute when recorded, name heuristic otherwise).
pub fn folder_role(conn: &Connection, account: &str, folder: &str) -> Result<String> {
    let special_use: Option<String> = conn
        .query_row(
            "SELECT special_use FROM folders WHERE account = ?1 AND name = ?2",
            params![account, folder],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(classify_folder_role(folder, special_use.as_deref()).to_string())
}

/// Collapse multiple cached draft autosave rows in a conversation to the newest
/// one for display. This is intentionally render-time only: old builds could
/// mint different Message-IDs for the same quick-reply draft, so Message-ID
/// dedupe alone cannot hide them, but deleting by thread would be too broad for
/// a cache repair.
pub fn collapse_thread_draft_headers(
    conn: &Connection,
    account: &str,
    default_folder: &str,
    headers: Vec<MessageHeader>,
) -> Result<Vec<MessageHeader>> {
    let mut newest_draft: Option<(usize, i64, u32)> = None;
    let mut draft_flags = Vec::with_capacity(headers.len());
    for (idx, header) in headers.iter().enumerate() {
        let folder = if header.folder.is_empty() {
            default_folder
        } else {
            header.folder.as_str()
        };
        let is_draft = folder_role(conn, account, folder)? == "drafts";
        draft_flags.push(is_draft);
        if is_draft {
            match newest_draft {
                Some((_, date, uid)) if (header.date, header.uid) <= (date, uid) => {}
                _ => newest_draft = Some((idx, header.date, header.uid)),
            }
        }
    }
    let Some((keep_idx, _, _)) = newest_draft else {
        return Ok(headers);
    };
    Ok(headers
        .into_iter()
        .enumerate()
        .filter_map(|(idx, header)| {
            if draft_flags[idx] && idx != keep_idx {
                None
            } else {
                Some(header)
            }
        })
        .collect())
}

/// Delete every locally cached row in `folder` sharing a Message-ID with any of
/// `uids`. The thread read collapses same-Message-ID copies into one bubble, so
/// discarding the visible draft must also drop hidden stale autosave siblings —
/// otherwise the thread card keeps reporting `has_draft`. Call before
/// `delete_messages_by_uid` (it reads the rows to get their ids).
pub fn delete_draft_sibling_copies(
    conn: &Connection,
    account: &str,
    folder: &str,
    uids: &[u32],
) -> Result<usize> {
    let mut deleted = 0usize;
    for uid in uids {
        let message_id: Option<String> = conn
            .query_row(
                "SELECT json_extract(json, '$.message_id') FROM messages
                 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![account, folder, *uid],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if let Some(message_id) = message_id {
            deleted += delete_draft_copies(conn, account, folder, &message_id, Some(*uid))?;
        }
    }
    Ok(deleted)
}

/// Remove locally cached copies of a draft (matched by its stable Message-ID),
/// optionally keeping one UID — the copy that survived the server-side
/// replace/prune. Autosaves APPEND under a fresh UID each time, so without this
/// the expunged prior copy lingers locally as a duplicate until the next full
/// Drafts sync.
pub fn delete_draft_copies(
    conn: &Connection,
    account: &str,
    folder: &str,
    message_id: &str,
    keep_uid: Option<u32>,
) -> Result<usize> {
    if message_id.trim().is_empty() {
        return Ok(0);
    }
    let deleted = conn.execute(
        "DELETE FROM messages
         WHERE account = ?1 AND folder = ?2
           AND lower(COALESCE(json_extract(json, '$.message_id'), '')) = lower(?3)
           AND (?4 IS NULL OR uid <> ?4)",
        params![account, folder, message_id.trim(), keep_uid],
    )?;
    Ok(deleted)
}

/// Remove locally cached quick-reply draft rows in a thread. This repairs stale
/// duplicates left by older autosave code that minted multiple `meron-draft-*`
/// Message-IDs for the same quick reply; the server discard still targets the
/// one draft Message-ID the client knows about.
pub fn delete_quick_reply_drafts_in_thread(
    conn: &Connection,
    account: &str,
    folder: &str,
    thread_key: &str,
) -> Result<usize> {
    if thread_key.trim().is_empty() {
        return Ok(0);
    }
    let deleted = conn.execute(
        "DELETE FROM messages
         WHERE account = ?1 AND folder = ?2
           AND COALESCE(NULLIF(thread_key, ''), 'uid:' || uid) = ?3
           AND lower(COALESCE(json_extract(json, '$.message_id'), '')) LIKE 'meron-draft-%@meron'",
        params![account, folder, thread_key],
    )?;
    Ok(deleted)
}

pub fn delete_messages_by_uid(
    conn: &Connection,
    account: &str,
    folder: &str,
    uids: &[u32],
) -> Result<usize> {
    let mut deleted = 0usize;
    for uid in uids {
        deleted += conn.execute(
            "DELETE FROM messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, *uid],
        )?;
    }
    Ok(deleted)
}

/// Drop every cached message in a folder. Pairs with `imap::empty_folder`, which
/// clears the server side.
pub fn delete_folder_messages(conn: &Connection, account: &str, folder: &str) -> Result<usize> {
    let deleted = conn.execute(
        "DELETE FROM messages WHERE account = ?1 AND folder = ?2",
        params![account, folder],
    )?;
    Ok(deleted)
}

#[allow(dead_code)]
pub fn move_messages_by_uid(
    conn: &Connection,
    account: &str,
    source_folder: &str,
    target_folder: &str,
    uids: &[u32],
) -> Result<usize> {
    if source_folder == target_folder || uids.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let mut moved = 0usize;
    for uid in uids {
        let msg_id = tx
            .query_row(
                "SELECT msg_id FROM messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![account, source_folder, *uid],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(msg_id) = msg_id else {
            continue;
        };
        tx.execute(
            "DELETE FROM messages WHERE account = ?1 AND folder = ?2 AND msg_id = ?3",
            params![account, target_folder, msg_id],
        )?;
        moved += tx.execute(
            "UPDATE messages SET folder = ?4 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, source_folder, *uid, target_folder],
        )?;
    }
    tx.commit()?;
    Ok(moved)
}

/// UIDs of every unseen message in a folder. Used by "mark all as read" to set
/// `\Seen` on the server for exactly the messages currently flagged unread.
pub fn get_unseen_uids(conn: &Connection, account: &str, folder: &str) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid FROM messages WHERE account = ?1 AND folder = ?2 AND seen = 0 AND uid <> 0",
    )?;
    let rows = stmt.query_map(params![account, folder], |row| row.get::<_, u32>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Flip `seen` for every message in a folder (mark all read / unread).
pub fn mark_folder_seen(conn: &Connection, account: &str, folder: &str, seen: bool) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seen = ?3 WHERE account = ?1 AND folder = ?2",
        params![account, folder, seen as i64],
    )?;
    Ok(())
}

pub fn update_rss_thread_seen(
    conn: &Connection,
    account: &str,
    subscription_id: &str,
    seen: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seen = ?3 WHERE account = ?1 AND folder = ?2",
        params![account, subscription_id, seen as i64],
    )?;
    Ok(())
}

/// The feed equivalent of [`newest_thread_uids`]: flag only the newest item, so
/// "mark unread" on a feed brings back one item rather than claiming every item
/// in it is unread.
pub fn update_rss_newest_item_seen(
    conn: &Connection,
    account: &str,
    subscription_id: &str,
    seen: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seen = ?3 WHERE rowid = (
             SELECT rowid FROM messages WHERE account = ?1 AND folder = ?2
             ORDER BY date DESC, uid DESC LIMIT 1
         )",
        params![account, subscription_id, seen as i64],
    )?;
    Ok(())
}

pub fn update_rss_thread_starred(
    conn: &Connection,
    account: &str,
    subscription_id: &str,
    starred: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET starred = ?3 WHERE account = ?1 AND folder = ?2",
        params![account, subscription_id, starred as i64],
    )?;
    Ok(())
}

pub fn update_rss_item_seen(
    conn: &Connection,
    account: &str,
    subscription_id: &str,
    item_key: &str,
    seen: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seen = ?4 WHERE account = ?1 AND folder = ?2 AND msg_id = ?3",
        params![account, subscription_id, item_key, seen as i64],
    )?;
    Ok(())
}

pub fn update_rss_item_starred(
    conn: &Connection,
    account: &str,
    subscription_id: &str,
    item_key: &str,
    starred: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET starred = ?4 WHERE account = ?1 AND folder = ?2 AND msg_id = ?3",
        params![account, subscription_id, item_key, starred as i64],
    )?;
    Ok(())
}

/// Delete locally cached messages whose UIDs are no longer on the server.
/// `server_uids` must be the complete UID set for the folder. Returns the
/// number of rows removed.
pub fn prune_missing_messages(
    conn: &Connection,
    account: &str,
    folder: &str,
    server_uids: &std::collections::HashSet<u32>,
) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT uid FROM messages WHERE account = ?1 AND folder = ?2")?;
    let local_uids: Vec<u32> = stmt
        .query_map(params![account, folder], |row| row.get::<_, u32>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let mut removed = 0usize;
    for uid in local_uids {
        if !server_uids.contains(&uid) {
            conn.execute(
                "DELETE FROM messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![account, folder, uid],
            )?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub fn clear_folder_messages(conn: &Connection, account: &str, folder: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE account = ?1 AND folder = ?2",
        params![account, folder],
    )?;
    Ok(())
}

pub fn has_cached_body(conn: &Connection, account: &str, folder: &str, uid: u32) -> Result<bool> {
    let found = conn
        .query_row(
            "SELECT 1 FROM messages
             WHERE account = ?1 AND folder = ?2 AND uid = ?3
               AND (body IS NOT NULL
                    OR json_extract(json, '$.body_html') IS NOT NULL)",
            params![account, folder, uid],
            |_| Ok(()),
        )
        .ok()
        .is_some();
    Ok(found)
}

pub fn has_message(conn: &Connection, account: &str, folder: &str, uid: u32) -> Result<bool> {
    let found = conn
        .query_row(
            "SELECT 1 FROM messages
             WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![account, folder, uid],
            |_| Ok(()),
        )
        .ok()
        .is_some();
    Ok(found)
}

/// Render a stored recipient list (JSON `[{name, addr}]`) as a comma-separated
/// "Name <addr>" / "addr" string. Empty/missing/malformed input yields "".
fn format_recipient_list(json: Option<&str>) -> String {
    let Some(s) = json.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(s) else {
        return String::new();
    };
    arr.iter()
        .filter_map(|v| {
            let addr = v["addr"].as_str().unwrap_or_default().trim();
            if addr.is_empty() {
                return None;
            }
            let name = v["name"].as_str().unwrap_or_default().trim();
            Some(if name.is_empty() {
                addr.to_string()
            } else {
                format!("{name} <{addr}>")
            })
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_recipient_value(value: Option<&Value>) -> String {
    value
        .map(Value::to_string)
        .map(|json| format_recipient_list(Some(&json)))
        .unwrap_or_default()
}

pub fn get_cached_message(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<Message>> {
    let mut stmt = conn.prepare(
        "SELECT subject, from_name, from_addr, date, body, json
         FROM messages WHERE account = ?1 AND folder = ?2 AND uid = ?3",
    )?;

    let row = stmt
        .query_row(params![account, folder, uid], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .ok();

    let Some((subject, from_name, from_addr, date, body, json_extra)) = row else {
        return Ok(None);
    };
    let extra: Value = serde_json::from_str(&json_extra).unwrap_or_else(|_| json!({}));

    let to = format_recipient_value(extra.get("to"));

    let reply_to = extra["reply_to"].as_str().unwrap_or_default().to_string();
    let cc = format_recipient_value(extra.get("cc"));
    let bcc = extra["bcc"].as_str().unwrap_or_default().to_string();
    let message_id = extra["message_id"].as_str().unwrap_or_default().to_string();
    let references = extra["references"].as_str().unwrap_or_default().to_string();
    let body_html = extra["body_html"].as_str().map(str::to_string);

    // `body` is the canonical plain-text body. For legacy HTML-only rows where it
    // is missing, fall back to rendering the stored HTML source once.
    let body = match body {
        Some(body) => body,
        None => match &body_html {
            Some(html) => {
                let rendered = crate::parse::render_body(html);
                let _ = conn.execute(
                    "UPDATE messages SET body = ?4 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                    params![account, folder, uid, rendered],
                );
                rendered
            }
            None => return Ok(None),
        },
    };

    let attachments: Vec<Attachment> = extra
        .get("attachments")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();

    // Keep the HTML source on the returned message so the read handler can build
    // the iframe-ready view (it injects the remote-image CSP per account setting).
    Ok(Some(Message {
        subject,
        from_name,
        from_addr,
        to,
        reply_to,
        cc,
        bcc,
        message_id,
        references,
        delivered: extra["delivered"].as_bool().unwrap_or(false),
        date,
        body,
        body_html,
        body_is_rendered: extra["body_is_rendered"].as_bool().unwrap_or(false),
        preview: String::new(),
        attachments,
        // Cached before this existed reads as no protection, which for the
        // overwhelming majority of mail is also the truth. A message that was
        // encrypted is re-parsed on read, so it corrects itself.
        protection: extra["protection"].as_str().unwrap_or_default().to_string(),
    }))
}

pub fn save_cached_message(
    conn: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    message: &Message,
) -> Result<()> {
    let attachments_json = serde_json::to_value(&message.attachments).unwrap_or_else(|_| json!([]));
    // The `json` catch-all column carries header fields that don't have a typed
    // column. Envelope recipients are written by `upsert_messages`; body fetches
    // must not overwrite them.
    let extra_json = json!({
        "reply_to": message.reply_to,
        "bcc": message.bcc,
        "message_id": message.message_id,
        "references": message.references,
        "delivered": message.delivered,
        "body_html": message.body_html,
        "body_is_rendered": message.body_is_rendered,
        "protection": message.protection,
        "attachments": attachments_json,
    })
    .to_string();

    conn.execute(
        "INSERT INTO messages (account, folder, msg_id, uid, subject, from_name, from_addr, date, body, json)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(account, folder, msg_id) DO UPDATE SET
           subject = excluded.subject,
           from_name = excluded.from_name,
           from_addr = excluded.from_addr,
           date = excluded.date,
           body = excluded.body,
           json = json_patch(messages.json, excluded.json)",
        params![
            account,
            folder,
            uid,
            message.subject,
            message.from_name,
            message.from_addr,
            message.date,
            message.body,
            extra_json
        ],
    )?;

    Ok(())
}

// ---- RSS items (shared messages table) --------------------------------------

/// Per-item RSS fields that don't map to a typed mail column; stored as the
/// message row's `json` JSON.
pub struct RssItemExtra {
    pub author: String,
    pub link: String,
    pub summary: String,
    pub content: String,
    /// Inline images lifted from the item's HTML. Each carries its source `url`
    /// and, once downloaded to the media dir, a local `key` served at `/media`.
    pub images: Vec<RssMedia>,
    /// Inline videos lifted from the item's HTML. Remote-only (rendered straight
    /// from their source `url`); not cached to disk, so `key` stays `None`.
    pub videos: Vec<RssMedia>,
    pub published_at: i64,
    pub updated_at: i64,
    pub fetched_at: i64,
}

/// One inline feed media item (image or video): its remote source and, when
/// cached locally, its media key served at `/media`.
pub struct RssMedia {
    pub url: String,
    pub key: Option<String>,
}

/// Upsert one RSS item as a message row. `folder` is the subscription id and
/// `msg_id` the stable item key; the feed-specific payload lives in `json`.
/// Updates preserve the existing `seen` flag (don't un-read on refetch).
pub fn upsert_rss_item(
    conn: &Connection,
    account: &str,
    subscription_id: &str,
    item_key: &str,
    title: &str,
    unread: bool,
    body_html: Option<&str>,
    extra: &RssItemExtra,
) -> Result<bool> {
    // Tell new arrivals apart from re-syncs of items we already stored, so callers
    // can surface a "new items" notification only for genuinely new entries.
    let is_new = conn
        .query_row(
            "SELECT 1 FROM messages WHERE account = ?1 AND folder = ?2 AND msg_id = ?3",
            params![account, subscription_id, item_key],
            |_| Ok(()),
        )
        .optional()?
        .is_none();
    let extra_json = json!({
        "author": extra.author,
        "link": extra.link,
        "summary": extra.summary,
        "content": extra.content,
        "body_html": body_html,
        "images": extra.images.iter()
            .map(|img| json!({ "url": img.url, "key": img.key }))
            .collect::<Vec<_>>(),
        "videos": extra.videos.iter()
            .map(|vid| json!({ "url": vid.url, "key": vid.key }))
            .collect::<Vec<_>>(),
        "published_at": extra.published_at,
        "updated_at": extra.updated_at,
        "fetched_at": extra.fetched_at,
    })
    .to_string();
    conn.execute(
        "INSERT INTO messages(account, folder, msg_id, uid, subject, from_name, from_addr, date, seen, thread_key, json)
         VALUES(?1, ?2, ?3, 0, ?4, ?5, '', ?6, ?7, ?2, ?8)
         ON CONFLICT(account, folder, msg_id) DO UPDATE SET
           subject = excluded.subject,
           date    = excluded.date,
           json   = excluded.json",
        params![
            account,
            subscription_id,
            item_key,
            title,
            extra.author,
            item_date_epoch(extra.published_at, extra.updated_at, extra.fetched_at),
            (!unread) as i64,
            extra_json,
        ],
    )?;
    Ok(is_new)
}

/// Best available timestamp for an RSS item as epoch seconds (0 when none),
/// preferring published > updated > fetched. Stored in the `date` column so RSS
/// rows sort alongside mail.
fn item_date_epoch(published: i64, updated: i64, fetched: i64) -> i64 {
    if published != 0 {
        published
    } else if updated != 0 {
        updated
    } else {
        fetched
    }
}

#[cfg(test)]
mod tests;
