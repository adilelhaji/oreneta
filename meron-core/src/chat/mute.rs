//! Muting one conversation (ADR-0064): no system notification from it,
//! mentions included, while what arrives still counts as unread.
//!
//! The muted conversations of an account live in one settings row,
//! `chat_mute:<account>` (a JSON list), like the person's own status
//! (ADR-0055): no table or column is added. A conversation is kept as the
//! core keeps it (`normalize_conversation`): a direct one, a private one
//! (`room@service/nick`) or a room.

use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// At most this many conversations are muted per account, so the row stays
/// small; muting one more is refused, never dropped silently.
pub const MAX_MUTED: usize = 1000;

fn key(account: &str) -> String {
    format!("chat_mute:{account}")
}

/// The account's muted conversations. Entries that are not text, or are
/// empty, are skipped; nothing else is guessed.
pub fn muted(conn: &Connection, account: &str) -> Result<BTreeSet<String>> {
    let saved: Value = crate::store::settings_get(conn, &[key(account)])?
        .get(key(account))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(saved
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(super::normalize_conversation)
                .filter(|c| !c.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

pub fn is_muted(conn: &Connection, account: &str, conversation: &str) -> Result<bool> {
    Ok(muted(conn, account)?.contains(&super::normalize_conversation(conversation)))
}

/// Mutes or unmutes one conversation; returns the account's muted ones.
pub fn set_muted(conn: &Connection, account: &str, conversation: &str, mute: bool) -> Result<BTreeSet<String>> {
    let conversation = super::normalize_conversation(conversation);
    ensure!(!conversation.is_empty(), "a conversation is needed");
    ensure!(!conversation.chars().any(char::is_control), "this is not a conversation");
    let mut list = muted(conn, account)?;
    if mute {
        ensure!(
            list.contains(&conversation) || list.len() < MAX_MUTED,
            "at most {MAX_MUTED} conversations can be muted; unmute one first"
        );
        list.insert(conversation);
    } else {
        list.remove(&conversation);
    }
    save(conn, account, &list)?;
    Ok(list)
}

fn save(conn: &Connection, account: &str, list: &BTreeSet<String>) -> Result<()> {
    if list.is_empty() {
        return forget(conn, account);
    }
    crate::store::setting_set(conn, &key(account), &json!(list))
}

/// Forgets one conversation's mute: its room was left, so nothing of it is
/// kept here any more.
pub fn forget_conversation(conn: &Connection, account: &str, conversation: &str) -> Result<()> {
    let mut list = muted(conn, account)?;
    if list.remove(&super::normalize_conversation(conversation)) {
        save(conn, account, &list)?;
    }
    Ok(())
}

/// Forgets every mute of an account, when the account is removed.
pub fn forget(conn: &Connection, account: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key(account)])?;
    Ok(())
}
