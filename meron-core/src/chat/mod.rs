//! Chat (#110, #111, ADR-0036).
//!
//! XMPP first: an open standard with servers anyone can run, no provider
//! registration and no spending. Teams, Slack, Rocket.Chat and IceWarp
//! TeamChat are in the ADR's matrix and wait on their registrations.
//!
//! What the store guarantees:
//! - a message is kept once, whether it arrives live, as a copy from another
//!   of the person's devices (carbons) or from the server's archive (MAM);
//! - a message sent here moves only forward — sending, sent, accepted by the
//!   server (XEP-0198), delivered (XEP-0184) — and one whose fate is unknown
//!   after a disconnection is marked uncertain, never sent again on its own;
//!   the archive, when it has it, settles it as accepted.
//!
//! Group chats (MUC, XEP-0045) and files (HTTP File Upload, XEP-0363) follow
//! ADR-0044: a room's messages are kept like a conversation's, once each, and
//! a file is a message whose link is fetched only when the person saves it.
//!
//! Presence, mentions, notifications and private messages in rooms follow
//! ADR-0055: the person's status lives in a settings row, contacts' and
//! occupants' only in the session, a mention is worked out from the text,
//! and a private message is its own conversation, `room@service/nick`.

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub mod files;
pub mod mentions;
pub mod presence;
pub mod xmpp;

/// A one-to-one conversation.
pub const KIND_CHAT: &str = "chat";
/// A group chat (a MUC room).
pub const KIND_GROUP: &str = "groupchat";
/// A private conversation with someone in a room (XEP-0045 §7.5), kept as
/// its own conversation, `room@service/nick`, tied to that room.
pub const KIND_PRIVATE: &str = "private";

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS chat_accounts (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
    chat_account TEXT NOT NULL,
    conversation TEXT NOT NULL,
    id TEXT NOT NULL,
    stanza_id TEXT,
    direction TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    stamp INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (chat_account, conversation, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_order ON chat_messages(chat_account, conversation, stamp);
CREATE INDEX IF NOT EXISTS chat_messages_archive ON chat_messages(chat_account, stanza_id);
CREATE TABLE IF NOT EXISTS chat_reads (
    chat_account TEXT NOT NULL,
    conversation TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (chat_account, conversation)
);
";

/// Group chats and files (schema 58, ADR-0044): rooms joined, invitations
/// waiting for the person's answer, and what each message is.
pub const SCHEMA_GROUPS: &str = "
CREATE TABLE IF NOT EXISTS chat_rooms (
    chat_account TEXT NOT NULL,
    room TEXT NOT NULL,
    nick TEXT NOT NULL,
    has_password INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_account, room)
);
CREATE TABLE IF NOT EXISTS chat_invitations (
    chat_account TEXT NOT NULL,
    room TEXT NOT NULL,
    inviter TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    has_password INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (chat_account, room)
);
";

/// Schema 58: the tables above and, on each message, its kind and its file.
/// Safe to run again.
pub fn migrate_groups(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA_GROUPS)?;
    for (column, ddl) in [
        ("kind", "ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'"),
        ("file_url", "ALTER TABLE chat_messages ADD COLUMN file_url TEXT"),
        ("file_name", "ALTER TABLE chat_messages ADD COLUMN file_name TEXT"),
        ("file_size", "ALTER TABLE chat_messages ADD COLUMN file_size INTEGER"),
    ] {
        let has = conn
            .prepare("SELECT 1 FROM pragma_table_info('chat_messages') WHERE name = ?1")?
            .exists([column])?;
        if !has {
            conn.execute_batch(ddl)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatAccount {
    pub id: String,
    /// The person's address, e.g. `ana@chat.example`.
    pub jid: String,
    /// The server to connect to; empty means the address's own domain.
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_port() -> u16 {
    5222
}

pub fn secret_key(id: &str) -> String {
    format!("chat:{id}")
}

/// The keychain name of a room's password, for one account.
pub fn room_secret_key(account: &str, room: &str) -> String {
    format!("chat-room:{account}:{room}")
}

pub fn save_account(conn: &Connection, account: &ChatAccount, now: i64) -> Result<()> {
    let jid = account.jid.trim();
    ensure!(
        jid.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.')),
        "a chat address looks like name@server.example"
    );
    ensure!(!account.id.trim().is_empty(), "an id is needed");
    conn.execute(
        "INSERT INTO chat_accounts(id, jid, host, port, created_at) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET jid = ?2, host = ?3, port = ?4",
        params![account.id, jid.to_lowercase(), account.host.trim(), account.port, now],
    )?;
    Ok(())
}

pub fn accounts(conn: &Connection) -> Result<Vec<ChatAccount>> {
    let mut stmt = conn.prepare("SELECT id, jid, host, port FROM chat_accounts ORDER BY created_at, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(ChatAccount { id: r.get(0)?, jid: r.get(1)?, host: r.get(2)?, port: r.get::<_, i64>(3)? as u16 })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn account(conn: &Connection, id: &str) -> Result<ChatAccount> {
    accounts(conn)?.into_iter().find(|a| a.id == id).context("no such chat account")
}

/// Removes the account and everything kept for it here.
pub fn remove_account(conn: &Connection, id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM chat_messages WHERE chat_account = ?1", [id])?;
    tx.execute("DELETE FROM chat_reads WHERE chat_account = ?1", [id])?;
    tx.execute("DELETE FROM chat_rooms WHERE chat_account = ?1", [id])?;
    tx.execute("DELETE FROM chat_invitations WHERE chat_account = ?1", [id])?;
    presence::forget_own(&tx, id)?;
    tx.execute("DELETE FROM chat_accounts WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

// ---- Messages ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChatMessage {
    pub account: String,
    /// The other person's bare address.
    pub conversation: String,
    /// The sender's own id for it (origin-id), the same on every copy.
    pub id: String,
    /// The server archive's id, once known.
    pub stanza_id: Option<String>,
    /// `in` or `out`.
    pub direction: String,
    pub sender: String,
    pub body: String,
    pub stamp: i64,
    /// Out: `sending`, `sent`, `accepted`, `delivered`, `uncertain`, `failed`.
    /// In: `received`.
    pub state: String,
    /// `chat` or `groupchat`.
    pub kind: String,
    /// A file shared as a link (XEP-0066): where it is and what it is called.
    /// It is fetched only when the person saves it.
    pub file_url: Option<String>,
    pub file_name: Option<String>,
    pub file_size: Option<i64>,
    /// An incoming room message that mentions the person: worked out from
    /// its text and the person's nickname when read (ADR-0055).
    pub mention: bool,
}

impl ChatMessage {
    /// A plain one-to-one message, for tests and callers that build one.
    #[allow(clippy::too_many_arguments)]
    pub fn chat(account: &str, conversation: &str, id: &str, direction: &str, sender: &str, body: &str, stamp: i64, state: &str) -> Self {
        ChatMessage {
            account: account.into(),
            conversation: conversation.into(),
            id: id.into(),
            stanza_id: None,
            direction: direction.into(),
            sender: sender.into(),
            body: body.into(),
            stamp,
            state: state.into(),
            kind: KIND_CHAT.into(),
            file_url: None,
            file_name: None,
            file_size: None,
            mention: false,
        }
    }
}

fn rank(state: &str) -> i32 {
    match state {
        "failed" | "uncertain" => 0,
        "sending" => 1,
        "sent" => 2,
        "accepted" => 3,
        "delivered" => 4,
        _ => 0,
    }
}

/// Keeps a message once, however many times and ways it arrives. A copy of
/// one sent here (from the archive or another device) proves the server has
/// it. Returns whether anything changed.
pub fn record(conn: &Connection, message: &ChatMessage) -> Result<bool> {
    if let Some(archive) = &message.stanza_id {
        // An archive id is the archive's own: the account's for a
        // conversation, the room's for a group.
        let known: Option<String> = conn
            .query_row(
                "SELECT id FROM chat_messages WHERE chat_account = ?1 AND conversation = ?3 AND stanza_id = ?2",
                params![message.account, archive, message.conversation],
                |r| r.get(0),
            )
            .optional()?;
        if known.is_some() {
            return Ok(false);
        }
    }
    let existing: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT state, stanza_id, direction FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2 AND id = ?3",
            params![message.account, message.conversation, message.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match existing {
        Some((state, stanza_id, direction)) => {
            let mut changed = false;
            if stanza_id.is_none() && message.stanza_id.is_some() {
                conn.execute(
                    "UPDATE chat_messages SET stanza_id = ?4 WHERE chat_account = ?1 AND conversation = ?2 AND id = ?3",
                    params![message.account, message.conversation, message.id, message.stanza_id],
                )?;
                changed = true;
            }
            // Our own message seen back from the server, or reflected by the
            // room: it was accepted.
            if message.direction == "out" && direction == "out" && rank(&state) < rank("accepted") {
                set_state(conn, &message.account, &message.id, "accepted")?;
                changed = true;
            }
            Ok(changed)
        }
        None => {
            conn.execute(
                "INSERT INTO chat_messages(chat_account, conversation, id, stanza_id, direction, sender, body, stamp, state,
                                           kind, file_url, file_name, file_size)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    message.account,
                    message.conversation,
                    message.id,
                    message.stanza_id,
                    message.direction,
                    message.sender,
                    message.body,
                    message.stamp,
                    message.state,
                    message.kind,
                    message.file_url,
                    message.file_name,
                    message.file_size
                ],
            )?;
            Ok(true)
        }
    }
}

/// Notes a message being sent from here, before it goes anywhere.
pub fn queue(conn: &Connection, account: &str, conversation: &str, id: &str, sender: &str, body: &str, now: i64) -> Result<()> {
    queue_message(conn, &ChatMessage::chat(account, conversation, id, "out", sender, body, now, "sending"))
}

/// Notes any message being sent from here (to a room, or a file's link),
/// before it goes anywhere.
pub fn queue_message(conn: &Connection, message: &ChatMessage) -> Result<()> {
    ensure!(!message.body.trim().is_empty(), "nothing to send");
    ensure!(message.body.len() <= 64 * 1024, "the message is too long");
    let mut message = message.clone();
    message.direction = "out".into();
    message.state = "sending".into();
    record(conn, &message)?;
    Ok(())
}

/// Moves a sent message's state forward; never back, except that a message
/// not yet accepted can become uncertain or failed.
pub fn set_state(conn: &Connection, account: &str, id: &str, state: &str) -> Result<()> {
    let current: Option<String> = conn
        .query_row(
            "SELECT state FROM chat_messages WHERE chat_account = ?1 AND id = ?2 AND direction = 'out'",
            params![account, id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(current) = current else { return Ok(()) };
    let allowed = match state {
        "uncertain" | "failed" => matches!(current.as_str(), "sending" | "sent"),
        // A retried message starts again.
        "sending" => matches!(current.as_str(), "uncertain" | "failed"),
        _ => rank(state) > rank(&current),
    };
    if allowed {
        conn.execute(
            "UPDATE chat_messages SET state = ?3 WHERE chat_account = ?1 AND id = ?2 AND direction = 'out'",
            params![account, id, state],
        )?;
    }
    Ok(())
}

/// After a disconnection, what was sending or sent without the server's
/// word is uncertain: maybe it arrived, maybe not. It is never sent again on
/// its own; the archive settles those it has.
pub fn after_disconnect(conn: &Connection, account: &str) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE chat_messages SET state = 'uncertain'
          WHERE chat_account = ?1 AND direction = 'out' AND state IN ('sending', 'sent')",
        [account],
    )?)
}

/// The newest archive id, where catching up starts.
pub fn last_archive_id(conn: &Connection, account: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT stanza_id FROM chat_messages WHERE chat_account = ?1 AND kind IN ('chat', 'private') AND stanza_id IS NOT NULL
              ORDER BY stamp DESC, rowid DESC LIMIT 1",
            [account],
            |r| r.get(0),
        )
        .optional()?)
}

/// The newest id of a room's own archive known here, where catching up on
/// that room starts.
pub fn last_room_archive_id(conn: &Connection, account: &str, room: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT stanza_id FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2 AND kind = 'groupchat'
                AND stanza_id IS NOT NULL ORDER BY stamp DESC, rowid DESC LIMIT 1",
            params![account, room],
            |r| r.get(0),
        )
        .optional()?)
}

/// When the newest message of a room kept here was said, if any: on joining,
/// the room is asked only for what came since.
pub fn last_room_stamp(conn: &Connection, account: &str, room: &str) -> Result<Option<i64>> {
    Ok(conn.query_row(
        "SELECT MAX(stamp) FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2 AND direction = 'in'",
        params![account, room],
        |r| r.get(0),
    )?)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Conversation {
    pub conversation: String,
    pub last_body: String,
    pub last_stamp: i64,
    pub last_direction: String,
    pub unread: i64,
    /// `chat`, or `private` for one with someone in a room.
    pub kind: String,
    /// For a private one, the room it goes through.
    pub room: Option<String>,
}

pub fn conversations(conn: &Connection, account: &str) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT m.conversation, COALESCE(m.file_name, m.body), m.stamp, m.direction,
                (SELECT COUNT(*) FROM chat_messages u
                  WHERE u.chat_account = m.chat_account AND u.conversation = m.conversation AND u.direction = 'in'
                    AND u.stamp > COALESCE((SELECT read_at FROM chat_reads r
                                             WHERE r.chat_account = m.chat_account AND r.conversation = m.conversation), 0)),
                m.kind
           FROM chat_messages m
          WHERE m.chat_account = ?1 AND m.kind IN ('chat', 'private')
            AND m.rowid = (SELECT rowid FROM chat_messages l WHERE l.chat_account = m.chat_account
                             AND l.conversation = m.conversation ORDER BY l.stamp DESC, l.rowid DESC LIMIT 1)
          ORDER BY m.stamp DESC",
    )?;
    let rows = stmt.query_map([account], |r| {
        let conversation: String = r.get(0)?;
        let kind: String = r.get(5)?;
        Ok(Conversation {
            room: if kind == KIND_PRIVATE { split_private(&conversation).map(|(room, _)| room.to_string()) } else { None },
            conversation,
            last_body: r.get(1)?,
            last_stamp: r.get(2)?,
            last_direction: r.get(3)?,
            unread: r.get(4)?,
            kind,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One conversation, oldest first, at most `limit` of the newest messages.
/// In a room, what others said that names the person (by their nickname
/// there now) is marked as a mention.
pub fn history(conn: &Connection, account: &str, conversation: &str, limit: i64) -> Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        &format!(
            "SELECT * FROM (SELECT {COLUMNS}, rowid
                              FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2
                              ORDER BY stamp DESC, rowid DESC LIMIT ?3)
              ORDER BY stamp, rowid"
        ),
    )?;
    let rows = stmt.query_map(params![account, conversation, limit], from_row)?;
    let mut messages: Vec<ChatMessage> = rows.collect::<rusqlite::Result<_>>()?;
    if let Some(nick) = room_nick(conn, account, conversation)? {
        for message in messages.iter_mut().filter(|m| m.kind == KIND_GROUP && m.direction == "in") {
            message.mention = mentions::mentions_nick(&message.body, &nick);
        }
    }
    Ok(messages)
}

const COLUMNS: &str =
    "chat_account, conversation, id, stanza_id, direction, sender, body, stamp, state, kind, file_url, file_name, file_size";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        account: r.get(0)?,
        conversation: r.get(1)?,
        id: r.get(2)?,
        stanza_id: r.get(3)?,
        direction: r.get(4)?,
        sender: r.get(5)?,
        body: r.get(6)?,
        stamp: r.get(7)?,
        state: r.get(8)?,
        kind: r.get(9)?,
        file_url: r.get(10)?,
        file_name: r.get(11)?,
        file_size: r.get(12)?,
        mention: false,
    })
}

pub fn mark_read(conn: &Connection, account: &str, conversation: &str, at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO chat_reads(chat_account, conversation, read_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(chat_account, conversation) DO UPDATE SET read_at = MAX(read_at, ?3)",
        params![account, conversation, at],
    )?;
    Ok(())
}

/// A message of ours, for sending again by the person's choice.
pub fn outgoing(conn: &Connection, account: &str, id: &str) -> Result<ChatMessage> {
    history_where(conn, "chat_account = ?1 AND id = ?2 AND direction = 'out'", params![account, id])?
        .pop()
        .context("no such message")
}

fn history_where(conn: &Connection, filter: &str, args: impl rusqlite::Params) -> Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM chat_messages WHERE {filter}"))?;
    let rows = stmt.query_map(args, from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Whether a message with this id was sent from here to this conversation:
/// a room's echo of it is ours, whatever nickname it carries.
pub fn is_ours(conn: &Connection, account: &str, conversation: &str, id: &str) -> Result<bool> {
    Ok(conn
        .prepare(
            "SELECT 1 FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2 AND id = ?3 AND direction = 'out'",
        )?
        .exists(params![account, conversation, id])?)
}

// ---- Rooms (XEP-0045) ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Room {
    pub account: String,
    /// The room's bare address, e.g. `team@rooms.chat.example`.
    pub room: String,
    /// The person's nickname in it.
    pub nick: String,
    pub has_password: bool,
    pub last_body: String,
    pub last_stamp: i64,
    pub unread: i64,
}

/// A room address looks like a person's: `name@service.example`.
pub fn check_room(room: &str) -> Result<String> {
    let room = room.trim().to_lowercase();
    ensure!(
        room.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.contains('/')),
        "a room address looks like room@rooms.server.example"
    );
    Ok(room)
}

pub fn check_nick(nick: &str) -> Result<String> {
    let nick = nick.trim().to_string();
    ensure!(!nick.is_empty(), "a nickname is needed");
    ensure!(nick.chars().count() <= 64, "the nickname is too long");
    ensure!(!nick.chars().any(char::is_control), "the nickname has characters a room does not accept");
    Ok(nick)
}

/// Keeps a room the person joined; it is joined again on every connection.
/// Its invitation, if any, is answered.
pub fn save_room(conn: &Connection, account: &str, room: &str, nick: &str, has_password: bool, now: i64) -> Result<()> {
    let room = check_room(room)?;
    let nick = check_nick(nick)?;
    conn.execute(
        "INSERT INTO chat_rooms(chat_account, room, nick, has_password, joined_at) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(chat_account, room) DO UPDATE SET nick = ?3, has_password = ?4",
        params![account, room, nick, has_password, now],
    )?;
    conn.execute("DELETE FROM chat_invitations WHERE chat_account = ?1 AND room = ?2", params![account, room])?;
    Ok(())
}

pub fn rooms(conn: &Connection, account: &str) -> Result<Vec<Room>> {
    let mut stmt = conn.prepare(
        "SELECT r.chat_account, r.room, r.nick, r.has_password,
                COALESCE((SELECT COALESCE(l.file_name, l.body) FROM chat_messages l
                           WHERE l.chat_account = r.chat_account AND l.conversation = r.room
                           ORDER BY l.stamp DESC, l.rowid DESC LIMIT 1), ''),
                COALESCE((SELECT MAX(l.stamp) FROM chat_messages l
                           WHERE l.chat_account = r.chat_account AND l.conversation = r.room), r.joined_at),
                (SELECT COUNT(*) FROM chat_messages u
                  WHERE u.chat_account = r.chat_account AND u.conversation = r.room AND u.direction = 'in'
                    AND u.stamp > COALESCE((SELECT read_at FROM chat_reads d
                                             WHERE d.chat_account = r.chat_account AND d.conversation = r.room), 0))
           FROM chat_rooms r WHERE r.chat_account = ?1
          ORDER BY 6 DESC, r.room",
    )?;
    let rows = stmt.query_map([account], |r| {
        Ok(Room {
            account: r.get(0)?,
            room: r.get(1)?,
            nick: r.get(2)?,
            has_password: r.get(3)?,
            last_body: r.get(4)?,
            last_stamp: r.get(5)?,
            unread: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn room(conn: &Connection, account: &str, room: &str) -> Result<Option<Room>> {
    Ok(rooms(conn, account)?.into_iter().find(|r| r.room == room))
}

/// The person's nickname in a joined room, if it is one.
pub fn room_nick(conn: &Connection, account: &str, room: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT nick FROM chat_rooms WHERE chat_account = ?1 AND room = ?2", params![account, room], |r| r.get(0))
        .optional()?)
}

/// Keeps the nickname a room gave the person (status 210), so mentions and
/// the room's echo of our messages follow it. It is the room's to decide,
/// so it is kept as given, even when it is not one we would have chosen;
/// only an empty one is refused.
pub fn set_room_nick(conn: &Connection, account: &str, room: &str, nick: &str) -> Result<()> {
    ensure!(!nick.is_empty(), "a nickname is needed");
    conn.execute("UPDATE chat_rooms SET nick = ?3 WHERE chat_account = ?1 AND room = ?2", params![account, room, nick])?;
    Ok(())
}

/// A private conversation's room and nickname: `room@service/nick`.
pub fn split_private(conversation: &str) -> Option<(&str, &str)> {
    let (room, nick) = conversation.split_once('/')?;
    (!room.is_empty() && !nick.is_empty()).then_some((room, nick))
}

/// A conversation as typed or passed around: the address in lower case, and
/// a nickname (for a private one) kept as it is, since rooms tell nicknames
/// apart by case.
pub fn normalize_conversation(conversation: &str) -> String {
    let conversation = conversation.trim();
    match conversation.split_once('/') {
        Some((bare, nick)) => format!("{}/{}", bare.to_lowercase(), nick),
        None => conversation.to_lowercase(),
    }
}

/// Leaves a room here: it is not joined again, and what was kept of it on
/// this computer goes. The room's own archive keeps what it keeps. Private
/// conversations had through it stay, to read: the room's archive does not
/// keep them, so they would be lost (ADR-0055). Writing in them again needs
/// the room.
pub fn leave_room(conn: &Connection, account: &str, room: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM chat_rooms WHERE chat_account = ?1 AND room = ?2", params![account, room])?;
    tx.execute("DELETE FROM chat_messages WHERE chat_account = ?1 AND conversation = ?2", params![account, room])?;
    tx.execute("DELETE FROM chat_reads WHERE chat_account = ?1 AND conversation = ?2", params![account, room])?;
    tx.commit()?;
    Ok(())
}

// ---- Invitations (XEP-0249) ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Invitation {
    pub account: String,
    pub room: String,
    /// Who invited, as their address says.
    pub inviter: String,
    pub reason: String,
    /// The invitation carried the room's password, kept in the keychain.
    pub has_password: bool,
    pub received_at: i64,
}

/// At most this many invitations wait at once, so nobody can fill the list
/// (or the keychain) by inviting again and again.
pub const MAX_INVITATIONS: i64 = 20;

/// Keeps an invitation for the person to answer; joining is their choice.
/// Returns false when it is not kept: the room is already joined, or too
/// many are waiting.
pub fn save_invitation(conn: &Connection, invitation: &Invitation) -> Result<bool> {
    let room = check_room(&invitation.room)?;
    let joined = conn
        .prepare("SELECT 1 FROM chat_rooms WHERE chat_account = ?1 AND room = ?2")?
        .exists(params![invitation.account, room])?;
    if joined {
        return Ok(false);
    }
    let waiting: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chat_invitations WHERE chat_account = ?1 AND room <> ?2",
        params![invitation.account, room],
        |r| r.get(0),
    )?;
    if waiting >= MAX_INVITATIONS {
        return Ok(false);
    }
    let reason: String = invitation.reason.chars().take(500).collect();
    conn.execute(
        "INSERT INTO chat_invitations(chat_account, room, inviter, reason, has_password, received_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(chat_account, room) DO UPDATE SET inviter = ?3, reason = ?4, has_password = ?5, received_at = ?6",
        params![invitation.account, room, invitation.inviter, reason, invitation.has_password, invitation.received_at],
    )?;
    Ok(true)
}

pub fn invitations(conn: &Connection, account: &str) -> Result<Vec<Invitation>> {
    let mut stmt = conn.prepare(
        "SELECT chat_account, room, inviter, reason, has_password, received_at FROM chat_invitations
          WHERE chat_account = ?1 ORDER BY received_at DESC, room",
    )?;
    let rows = stmt.query_map([account], |r| {
        Ok(Invitation {
            account: r.get(0)?,
            room: r.get(1)?,
            inviter: r.get(2)?,
            reason: r.get(3)?,
            has_password: r.get(4)?,
            received_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Sets an invitation aside without joining.
pub fn dismiss_invitation(conn: &Connection, account: &str, room: &str) -> Result<()> {
    conn.execute("DELETE FROM chat_invitations WHERE chat_account = ?1 AND room = ?2", params![account, room])?;
    Ok(())
}

/// Every room (joined or offered) of an account whose password may be in the
/// keychain.
pub fn room_secret_keys(conn: &Connection, account: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT room FROM chat_rooms WHERE chat_account = ?1 AND has_password = 1
          UNION SELECT room FROM chat_invitations WHERE chat_account = ?1 AND has_password = 1",
    )?;
    let rows = stmt.query_map([account], |r| r.get::<_, String>(0))?;
    Ok(rows.map(|r| r.map(|room| room_secret_key(account, &room))).collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
