//! Presence (ADR-0056): the person's own status, the status of their
//! contacts, the occupants of a room, and when a message may raise a system
//! notification.
//!
//! Privacy follows XMPP itself: the person's status is broadcast without an
//! address, so the server gives it only to contacts with a presence
//! subscription the person approved. Nothing is sent to anyone else, except
//! the plain presence a room needs to keep the person in it. Subscribing is
//! always the person's choice: a request from someone else waits for their
//! answer.

use super::ChatMessage;
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use tokio_xmpp::parsers::{
    jid::{BareJid, Jid},
    muc::{
        MucUser,
        user::{Role, Status},
    },
    presence::{Presence, Show, Type as PresenceType},
};

/// What the person can choose for themselves.
pub const OWN_SHOWS: [&str; 4] = ["available", "away", "dnd", "invisible"];

/// The person's own status and how idleness may change it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OwnPresence {
    /// `available`, `away`, `dnd` or `invisible` (appear offline).
    pub show: String,
    /// A short status message, shown to subscribed contacts.
    pub status: String,
    /// Minutes without activity before the status says away; 0 never.
    pub away_after: i64,
    /// Whether going idle may change the status on its own at all.
    pub share_idle: bool,
}

impl Default for OwnPresence {
    fn default() -> Self {
        OwnPresence { show: "available".into(), status: String::new(), away_after: 10, share_idle: true }
    }
}

pub fn own(conn: &Connection, account: &str) -> Result<OwnPresence> {
    Ok(conn
        .query_row(
            "SELECT show, status, away_after, share_idle FROM chat_own_presence WHERE chat_account = ?1",
            [account],
            |r| Ok(OwnPresence { show: r.get(0)?, status: r.get(1)?, away_after: r.get(2)?, share_idle: r.get(3)? }),
        )
        .optional()?
        .unwrap_or_default())
}

pub fn save_own(conn: &Connection, account: &str, own: &OwnPresence) -> Result<OwnPresence> {
    ensure!(OWN_SHOWS.contains(&own.show.as_str()), "unknown status {}", own.show);
    let status: String = own.status.trim().chars().filter(|c| !c.is_control()).take(200).collect();
    let away_after = own.away_after.clamp(0, 24 * 60);
    conn.execute(
        "INSERT INTO chat_own_presence(chat_account, show, status, away_after, share_idle) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(chat_account) DO UPDATE SET show = ?2, status = ?3, away_after = ?4, share_idle = ?5",
        params![account, own.show, status, away_after, own.share_idle],
    )?;
    self::own(conn, account)
}

/// What the status actually is now: the chosen one, or away once the
/// person has been idle long enough, when they allow that and are
/// available. Busy and invisible are never changed by idleness.
pub fn effective_show(own: &OwnPresence, idle_since: Option<i64>, now: i64) -> &str {
    let idle_long = idle_since.is_some_and(|since| own.away_after > 0 && now - since >= own.away_after * 60);
    if own.show == "available" && own.share_idle && idle_long { "away" } else { own.show.as_str() }
}

/// The presence to broadcast for a status. Invisible is "unavailable": to
/// contacts the person appears offline, and what is sent to them meanwhile
/// is fetched from the server's archive (see `run`).
pub fn own_stanza(show: &str, status: &str) -> Presence {
    let mut presence = match show {
        "invisible" => return Presence::unavailable(),
        "away" => Presence::available().with_show(Show::Away),
        "dnd" => Presence::available().with_show(Show::Dnd),
        _ => Presence::available(),
    };
    if !status.trim().is_empty() {
        presence.set_status("", status.trim());
    }
    presence
}

/// A contact's status, in the words the app uses: `available`, `chat`,
/// `away`, `xa`, `dnd` or `offline`.
pub fn show_name(presence: &Presence) -> &'static str {
    if presence.type_ == PresenceType::Unavailable {
        return "offline";
    }
    match presence.show {
        None => "available",
        Some(Show::Chat) => "chat",
        Some(Show::Away) => "away",
        Some(Show::Xa) => "xa",
        Some(Show::Dnd) => "dnd",
    }
}

fn status_text(presence: &Presence) -> String {
    presence.statuses.get("").or_else(|| presence.statuses.values().next()).cloned().unwrap_or_default()
}

/// What a presence from someone who is not a room means.
#[derive(Debug, Clone, PartialEq)]
pub enum ContactPresence {
    /// One of their devices says how it is (or that it went: `offline`).
    Status { jid: String, resource: String, show: &'static str, status: String, priority: i8 },
    /// They ask to see the person's status: the person decides.
    Request { jid: String },
    /// They allowed, or stopped allowing, the person to see theirs.
    Subscription { jid: String, allowed: bool },
}

pub fn contact_presence(presence: &Presence, own: &BareJid) -> Option<ContactPresence> {
    let from = presence.from.as_ref()?;
    let jid = from.to_bare();
    if jid == *own {
        return None;
    }
    let jid = jid.to_string();
    match presence.type_ {
        PresenceType::None | PresenceType::Unavailable => Some(ContactPresence::Status {
            jid,
            resource: from.resource().map(|r| r.to_string()).unwrap_or_default(),
            show: show_name(presence),
            status: status_text(presence),
            priority: presence.priority.0,
        }),
        PresenceType::Subscribe => Some(ContactPresence::Request { jid }),
        PresenceType::Subscribed => Some(ContactPresence::Subscription { jid, allowed: true }),
        PresenceType::Unsubscribed => Some(ContactPresence::Subscription { jid, allowed: false }),
        _ => None,
    }
}

/// How available a status is, for choosing among a contact's devices.
fn rank(show: &str) -> i32 {
    match show {
        "chat" => 5,
        "available" => 4,
        "away" => 3,
        "xa" => 2,
        "dnd" => 1,
        _ => 0,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Seen {
    pub show: String,
    pub status: String,
}

/// Every contact's devices, and what to show for each contact: the device
/// with the highest priority, then the most available.
#[derive(Default)]
pub struct Contacts {
    devices: HashMap<String, BTreeMap<String, (String, String, i8)>>,
}

impl Contacts {
    /// Takes one device's status; returns the contact's status as shown.
    pub fn update(&mut self, jid: &str, resource: &str, show: &str, status: &str, priority: i8) -> Seen {
        let devices = self.devices.entry(jid.to_string()).or_default();
        if show == "offline" {
            devices.remove(resource);
        } else {
            devices.insert(resource.to_string(), (show.to_string(), status.to_string(), priority));
        }
        let seen = self.seen(jid);
        if self.devices.get(jid).is_some_and(|d| d.is_empty()) {
            self.devices.remove(jid);
        }
        seen
    }

    pub fn seen(&self, jid: &str) -> Seen {
        self.devices
            .get(jid)
            .and_then(|devices| devices.values().max_by_key(|(show, _, priority)| (*priority, rank(show))))
            .map(|(show, status, _)| Seen { show: show.clone(), status: status.clone() })
            .unwrap_or(Seen { show: "offline".into(), status: String::new() })
    }

    pub fn clear(&mut self) {
        self.devices.clear();
    }
}

// ---- Room occupants -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Occupant {
    pub nick: String,
    pub show: String,
    /// `moderator`, `participant`, `visitor`.
    pub role: String,
}

/// What a presence from a room says about someone else in it.
#[derive(Debug, Clone, PartialEq)]
pub enum OccupantChange {
    Here(Occupant),
    Gone { nick: String },
    Renamed { from: String, to: String },
}

pub fn occupant_change(presence: &Presence) -> Option<OccupantChange> {
    let nick = presence.from.as_ref()?.resource()?.to_string();
    if presence.type_ == PresenceType::Error {
        return None;
    }
    let user = presence.payloads.iter().find_map(|p| MucUser::try_from(p.clone()).ok())?;
    if user.status.contains(&Status::SelfPresence) {
        return None;
    }
    if presence.type_ == PresenceType::Unavailable {
        if user.status.contains(&Status::NewNick) {
            if let Some(to) = user.items.iter().find_map(|i| i.nick.clone()) {
                return Some(OccupantChange::Renamed { from: nick, to });
            }
        }
        return Some(OccupantChange::Gone { nick });
    }
    let role = match user.items.first().map(|i| &i.role) {
        Some(Role::Moderator) => "moderator",
        Some(Role::Visitor) => "visitor",
        _ => "participant",
    };
    Some(OccupantChange::Here(Occupant { nick, show: show_name(presence).into(), role: role.into() }))
}

/// Everyone in each joined room, as the room last said.
#[derive(Default)]
pub struct Occupants {
    rooms: HashMap<String, BTreeMap<String, Occupant>>,
}

impl Occupants {
    /// Applies a change; returns whether the list changed.
    pub fn apply(&mut self, room: &str, change: OccupantChange) -> bool {
        let list = self.rooms.entry(room.to_string()).or_default();
        match change {
            OccupantChange::Here(occupant) => list.insert(occupant.nick.clone(), occupant.clone()) != Some(occupant),
            OccupantChange::Gone { nick } => list.remove(&nick).is_some(),
            OccupantChange::Renamed { from, to } => match list.remove(&from) {
                Some(mut occupant) => {
                    occupant.nick = to.clone();
                    list.insert(to, occupant);
                    true
                }
                None => false,
            },
        }
    }

    pub fn list(&self, room: &str) -> Vec<Occupant> {
        self.rooms.get(room).map(|l| l.values().cloned().collect()).unwrap_or_default()
    }

    pub fn forget(&mut self, room: &str) {
        self.rooms.remove(room);
    }

    pub fn clear(&mut self) {
        self.rooms.clear();
    }
}

/// The nickname a room gave us, when its presence about us carries one that
/// differs from ours (status 210, or a nickname change it reports).
pub fn own_nick_in(presence: &Presence, nick: &str) -> Option<String> {
    let user = presence.payloads.iter().find_map(|p| MucUser::try_from(p.clone()).ok())?;
    if !user.status.contains(&Status::SelfPresence) || presence.type_ != PresenceType::None {
        return None;
    }
    let given = presence.from.as_ref()?.resource()?.to_string();
    (given != nick).then_some(given)
}

/// Asking to see someone's status (and so offering ours), or answering
/// their request.
pub fn subscription(to: &BareJid, kind: PresenceType) -> Presence {
    let mut presence = Presence::new(kind);
    presence.to = Some(Jid::from(to.clone()));
    presence
}

// ---- Notifications --------------------------------------------------------------------------

/// How a message reached us.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Arrival {
    /// As it was sent.
    Live,
    /// A copy of something one of the person's other devices sent or got.
    Carbon,
    /// Catching up from an archive or a room's history.
    Backfill,
    /// The archive asked while appearing offline: new to the person, as if live.
    Poll,
}

/// Per conversation: `all`, `mentions` (rooms only) or `mute`.
pub const NOTIFY_MODES: [&str; 3] = ["all", "mentions", "mute"];

pub fn default_mode(kind: &str) -> &'static str {
    if kind == super::KIND_GROUP { "mentions" } else { "all" }
}

pub fn notify_mode(conn: &Connection, account: &str, conversation: &str, kind: &str) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT mode FROM chat_notify WHERE chat_account = ?1 AND conversation = ?2",
            params![account, conversation],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| default_mode(kind).to_string()))
}

pub fn set_notify_mode(conn: &Connection, account: &str, conversation: &str, mode: &str) -> Result<()> {
    ensure!(NOTIFY_MODES.contains(&mode), "unknown notification setting {mode}");
    conn.execute(
        "INSERT INTO chat_notify(chat_account, conversation, mode) VALUES(?1, ?2, ?3)
         ON CONFLICT(chat_account, conversation) DO UPDATE SET mode = ?3",
        params![account, conversation, mode],
    )?;
    Ok(())
}

/// Whether a newly kept message raises a system notification: only one
/// someone else just sent, never a copy from the person's own devices nor
/// one caught up from an archive; never while the person is busy (their
/// chat status) or the conversation is muted; in a room, only a mention,
/// unless the room is set to every message. Quiet hours are the bridge's
/// to apply on top.
pub fn should_notify(message: &ChatMessage, arrival: Arrival, mode: &str, own_show: &str) -> bool {
    if !matches!(arrival, Arrival::Live | Arrival::Poll) || message.direction != "in" {
        return false;
    }
    if own_show == "dnd" || mode == "mute" {
        return false;
    }
    if message.kind == super::KIND_GROUP {
        return mode == "all" || message.mention;
    }
    true
}
