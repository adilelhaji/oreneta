//! Presence and notifications (ADR-0055): the person's own status, the
//! status of their contacts, who is in each room, and when a message raises
//! a system notification.
//!
//! The person's status is announced without an address, so the server gives
//! it only to contacts the person allowed to see it; rooms hear only whether
//! they are away or busy, never the text. Seeing someone else's status, or
//! letting them see ours, is always the person's choice.
//!
//! Who may see it now comes from the server's own contact list (the roster,
//! RFC 6121), asked once per session and followed through its pushes; it is
//! kept only in memory, and is unknown until the server answers (ADR-0064).

use super::ChatMessage;
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use tokio_xmpp::parsers::{
    disco::DiscoInfoResult,
    jid::{BareJid, Jid},
    minidom::Element,
    muc::{
        MucUser,
        user::{Role, Status},
    },
    iq::Iq,
    presence::{Presence, Show, Type as PresenceType},
    roster::{Roster, Subscription},
};

/// What the person can choose for themselves.
pub const SHOWS: [&str; 4] = ["available", "away", "dnd", "invisible"];
/// Invisibility (XEP-0186), when the server offers it.
pub const NS_INVISIBLE: &str = "urn:xmpp:invisible:0";
pub const MAX_STATUS: usize = 200;
/// At most this many contacts, devices per contact and waiting requests are
/// kept for a session: anyone can send presence, so nobody can grow them
/// without end. What comes beyond is dropped.
pub const MAX_CONTACTS: usize = 1000;
pub const MAX_DEVICES: usize = 50;
pub const MAX_REQUESTS: usize = 200;
/// At most this many addresses allowed to see the person's status are kept
/// from the roster; when the server lists more, the app says so.
pub const MAX_ALLOWED: usize = 5000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OwnPresence {
    /// `available`, `away`, `dnd` or `invisible`.
    pub show: String,
    /// A short text, shown to contacts allowed to see it.
    pub status: String,
}

impl Default for OwnPresence {
    fn default() -> Self {
        OwnPresence { show: "available".into(), status: String::new() }
    }
}

fn key(account: &str) -> String {
    format!("chat_presence:{account}")
}

/// One line of at most 200 characters, without control characters.
fn clean_status(status: &str) -> String {
    let line: String = status.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    line.trim().chars().take(MAX_STATUS).collect::<String>().trim_end().to_string()
}

/// The person's chosen status for an account. A field that is not valid
/// falls back to its default without touching the other.
pub fn own(conn: &Connection, account: &str) -> Result<OwnPresence> {
    let saved: Value = crate::store::settings_get(conn, &[key(account)])?
        .get(key(account))
        .cloned()
        .unwrap_or(Value::Null);
    let show = saved["show"].as_str().filter(|s| SHOWS.contains(s)).unwrap_or("available");
    let status = saved["status"].as_str().map(clean_status).unwrap_or_default();
    Ok(OwnPresence { show: show.into(), status })
}

pub fn save_own(conn: &Connection, account: &str, show: &str, status: &str) -> Result<OwnPresence> {
    ensure!(SHOWS.contains(&show), "unknown status {show}");
    let own = OwnPresence { show: show.into(), status: clean_status(status) };
    crate::store::setting_set(conn, &key(account), &json!({ "show": own.show, "status": own.status }))?;
    Ok(own)
}

pub fn forget_own(conn: &Connection, account: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key(account)])?;
    Ok(())
}

/// Where the person's own status stands on the current connection.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Applied {
    /// Not connected.
    Offline,
    /// Invisible chosen; waiting to hear whether the server can do it.
    Waiting,
    /// Announced to contacts as chosen.
    Announced,
    /// Hidden by the server (XEP-0186), still receiving live.
    Invisible,
    /// Invisible chosen but the server cannot do it: nothing announced, so
    /// the person stays hidden and messages wait on the server.
    Withheld,
}

/// What to do with a chosen status, knowing (or not yet) whether the server
/// offers invisibility. Invisible never turns into visible on its own.
pub fn plan(show: &str, invisible_supported: Option<bool>) -> Applied {
    match (show, invisible_supported) {
        ("invisible", Some(true)) => Applied::Invisible,
        ("invisible", Some(false)) => Applied::Withheld,
        ("invisible", None) => Applied::Waiting,
        _ => Applied::Announced,
    }
}

/// Whether a change of what is applied made the person leave the rooms
/// they were in: going from announced to held back sends the server a
/// broadcast "unavailable", which leaves every room (RFC 6121 §4.6), so they
/// must be joined again.
pub fn rejoin_rooms(before: Applied, now: Applied) -> bool {
    before == Applied::Announced && now == Applied::Withheld
}

fn show_of(show: &str) -> Option<Show> {
    match show {
        "away" => Some(Show::Away),
        "dnd" => Some(Show::Dnd),
        _ => None,
    }
}

/// The presence announced to contacts: availability and the text.
pub fn own_stanza(show: &str, status: &str) -> Presence {
    let mut presence = Presence::available();
    presence.show = show_of(show);
    let status = status.trim();
    if !status.is_empty() {
        presence.set_status("", status);
    }
    presence
}

/// The presence a joined room hears when the status changes: availability
/// only, never the text (XEP-0045 §7.7).
pub fn room_stanza(to: Jid, show: &str) -> Presence {
    let mut presence = Presence::available().with_to(to);
    presence.show = show_of(show);
    presence
}

/// Going invisible or visible again (XEP-0186).
pub fn invisible_command(invisible: bool) -> Element {
    Element::builder(if invisible { "invisible" } else { "visible" }, NS_INVISIBLE).build()
}

pub fn supports_invisible(info: &DiscoInfoResult) -> bool {
    info.features.contains(NS_INVISIBLE)
}

/// A contact's status, in the words the app uses: `chat`, `available`,
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
    presence
        .statuses
        .get("")
        .or_else(|| presence.statuses.values().next())
        .map(|s| clean_status(s))
        .unwrap_or_default()
}

/// What a presence from someone who is not a room means.
#[derive(Debug, Clone, PartialEq)]
pub enum ContactPresence {
    /// One of their devices says how it is (or that it went: `offline`).
    Status { jid: String, resource: String, show: &'static str, status: String, priority: i8 },
    /// They ask to see the person's status: the person decides.
    Request { jid: String },
}

pub fn contact_presence(presence: &Presence, own: &BareJid) -> Option<ContactPresence> {
    let from = presence.from.as_ref()?;
    let jid = from.to_bare();
    if jid == *own {
        return None;
    }
    // Someone in a room (or a room's late word after we left it) is not a
    // contact, whatever address it comes from.
    if presence.payloads.iter().any(|p| p.is("x", tokio_xmpp::parsers::ns::MUC_USER)) {
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
/// with the highest priority, then the most available. A contact whose
/// status was seen and who went offline stays known as offline for the
/// session (the server also says so for those the person may see), so the
/// app does not offer to ask again.
#[derive(Debug, Default)]
pub struct Contacts {
    devices: HashMap<String, BTreeMap<String, (String, String, i8)>>,
}

impl Contacts {
    /// Takes one device's status; returns the contact's status as shown, or
    /// nothing when the contact is not kept (beyond `MAX_CONTACTS`), so
    /// nothing is said about them either.
    pub fn update(&mut self, jid: &str, resource: &str, show: &str, status: &str, priority: i8) -> Option<Seen> {
        if !self.devices.contains_key(jid) && self.devices.len() >= MAX_CONTACTS {
            return None;
        }
        let devices = self.devices.entry(jid.to_string()).or_default();
        if show == "offline" {
            devices.remove(resource);
        } else if devices.contains_key(resource) || devices.len() < MAX_DEVICES {
            devices.insert(resource.to_string(), (show.to_string(), status.to_string(), priority));
        }
        Some(self.seen(jid))
    }

    pub fn seen(&self, jid: &str) -> Seen {
        self.devices
            .get(jid)
            .and_then(|devices| devices.values().max_by_key(|(show, _, priority)| (*priority, rank(show))))
            .map(|(show, status, _)| Seen { show: show.clone(), status: status.clone() })
            .unwrap_or(Seen { show: "offline".into(), status: String::new() })
    }

    /// Every contact known this session, online or known to be offline.
    pub fn all(&self) -> BTreeMap<String, Seen> {
        self.devices.keys().map(|jid| (jid.clone(), self.seen(jid))).collect()
    }

    pub fn len(&self) -> usize {
        self.devices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.devices.is_empty()
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
    /// `moderator`, `participant` or `visitor`.
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
    if presence.type_ == PresenceType::Error {
        return None;
    }
    let nick = presence.from.as_ref()?.resource()?.to_string();
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
#[derive(Debug, Default)]
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
/// differs from ours (status 210, or our own nickname change). The room's
/// word is final: it is kept whatever it looks like.
pub fn own_nick_in(presence: &Presence, nick: &str) -> Option<String> {
    if presence.type_ != PresenceType::None {
        return None;
    }
    let user = presence.payloads.iter().find_map(|p| MucUser::try_from(p.clone()).ok())?;
    if !user.status.contains(&Status::SelfPresence) {
        return None;
    }
    let given = presence.from.as_ref()?.resource()?.to_string();
    (given != nick).then_some(given)
}

/// Asking to see someone's status, or answering their request. Answering
/// `unsubscribed` also withdraws a permission given before (RFC 6121 §3.2).
pub fn subscription(to: &BareJid, kind: PresenceType) -> Presence {
    let mut presence = Presence::new(kind);
    presence.to = Some(Jid::from(to.clone()));
    presence
}

// ---- Who may see the person's status (ADR-0064) ----------------------------------------------

/// The question for the whole roster, asked once per session.
pub fn roster_query() -> Element {
    Roster { ver: None, items: Vec::new() }.into()
}

/// Whether a roster entry lets that contact see the person's status.
fn lets_see(subscription: &Subscription) -> bool {
    matches!(subscription, Subscription::From | Subscription::Both)
}

/// A roster push (RFC 6121 §2.1.6): a roster in an IQ set from the person's
/// own server, which writes without an address or with the account's bare
/// one. Anyone else's is not a push and is not taken. Returns the roster and
/// the id to answer.
pub fn roster_push(iq: &Iq, own: &BareJid) -> Option<(Roster, String)> {
    let Iq::Set { from, id, payload, .. } = iq else { return None };
    if let Some(from) = from {
        if from.resource().is_some() || from.to_bare() != *own {
            return None;
        }
    }
    let roster = Roster::try_from(payload.clone()).ok()?;
    Some((roster, id.clone()))
}

/// The answer a roster push needs: an empty result, to the person's server.
pub fn roster_push_answer(id: String) -> Iq {
    Iq::Result { from: None, to: None, id, payload: None }
}

// ---- What a session knows now ---------------------------------------------------------------

/// What one account's session knows about presence, shared with the app.
#[derive(Debug)]
pub struct Live {
    pub own: OwnPresence,
    pub applied: Applied,
    /// Whether the server offers invisibility; unknown until it says.
    pub invisible_supported: Option<bool>,
    pub contacts: Contacts,
    /// People asking to see the person's status, waiting for their answer.
    pub requests: BTreeSet<String>,
    pub occupants: Occupants,
    /// Who may see the person's status (roster entries `from` or `both`):
    /// unknown (`None`) until the server answers on this session.
    pub allowed: Option<BTreeSet<String>>,
    /// The server listed more than `MAX_ALLOWED`: only those are kept.
    pub allowed_more: bool,
}

impl Default for Live {
    fn default() -> Self {
        Live {
            own: OwnPresence::default(),
            applied: Applied::Offline,
            invisible_supported: None,
            contacts: Contacts::default(),
            requests: BTreeSet::new(),
            occupants: Occupants::default(),
            allowed: None,
            allowed_more: false,
        }
    }
}

pub type Shared = Arc<Mutex<Live>>;

impl Live {
    /// A session's view starting from the person's saved status, so it is
    /// never reported as "available" before connecting.
    pub fn shared(conn: &Connection, account: &str) -> Shared {
        Arc::new(Mutex::new(Live { own: own(conn, account).unwrap_or_default(), ..Default::default() }))
    }

    /// Someone asks to see the person's status; returns whether it is new.
    /// No more than `MAX_REQUESTS` wait at once.
    pub fn request(&mut self, jid: &str) -> bool {
        if self.requests.contains(jid) || self.requests.len() >= MAX_REQUESTS {
            return false;
        }
        self.requests.insert(jid.to_string())
    }

    /// The person answers a request: the presence to send, or none when
    /// allowing someone who did not ask (denying is always possible).
    pub fn answer(&mut self, jid: &str, allow: bool) -> Option<PresenceType> {
        let asked = self.requests.remove(jid);
        match (allow, asked) {
            (true, true) => Some(PresenceType::Subscribed),
            (true, false) => None,
            (false, _) => Some(PresenceType::Unsubscribed),
        }
    }

    /// The server's whole roster: who may see the person's status now.
    pub fn set_roster(&mut self, roster: &Roster) {
        let mut allowed = BTreeSet::new();
        let mut more = false;
        for item in roster.items.iter().filter(|item| lets_see(&item.subscription)) {
            if allowed.len() >= MAX_ALLOWED {
                more = true;
                break;
            }
            allowed.insert(item.jid.to_string());
        }
        self.allowed = Some(allowed);
        self.allowed_more = more;
    }

    /// A roster push: some entries changed. Returns whether the list did.
    /// Before the whole roster is known, a push does not make it known.
    pub fn apply_roster_push(&mut self, roster: &Roster) -> bool {
        let Some(allowed) = self.allowed.as_mut() else { return false };
        let mut changed = false;
        for item in &roster.items {
            let jid = item.jid.to_string();
            if !lets_see(&item.subscription) {
                changed |= allowed.remove(&jid);
            } else if !allowed.contains(&jid) {
                if allowed.len() >= MAX_ALLOWED {
                    changed |= !self.allowed_more;
                    self.allowed_more = true;
                } else {
                    allowed.insert(jid);
                    changed = true;
                }
            }
        }
        changed
    }

    /// The person's side, as the app shows it.
    pub fn own_detail(&self) -> Value {
        json!({
            "show": self.own.show,
            "status": self.own.status,
            "applied": self.applied,
            "invisible_supported": self.invisible_supported,
        })
    }

    /// Everything, for the app to show.
    pub fn snapshot(&self) -> Value {
        json!({
            "own": self.own_detail(),
            "contacts": self.contacts.all(),
            "requests": self.requests,
            "allowed": self.allowed,
            "allowed_more": self.allowed_more,
        })
    }

    /// A new session (not a resumed one): nothing said on the old one holds
    /// any more. Contacts and rooms say it all again.
    pub fn fresh_session(&mut self) {
        self.invisible_supported = None;
        self.contacts.clear();
        self.requests.clear();
        self.occupants.clear();
        self.allowed = None;
        self.allowed_more = false;
    }
}

// ---- Notifications --------------------------------------------------------------------------

/// How a message reached us.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arrival {
    /// As it was sent.
    Live,
    /// A copy of something one of the person's other devices sent or got.
    Carbon,
    /// Catching up: an archive, a room's history, or anything delayed.
    Backfill,
}

/// Whether a message kept for the first time raises a system notification:
/// only one someone else just sent (or a copy of one another device got),
/// never what is caught up on; direct and private ones always, in a room
/// only a mention; never while the person's own status is busy, nor from a
/// conversation the person muted, mentions included (ADR-0064). Do not
/// disturb and quiet hours are the bridge's to apply on top (ADR-0049).
pub fn should_notify(message: &ChatMessage, arrival: Arrival, own_show: &str, muted: bool) -> bool {
    if muted || arrival == Arrival::Backfill || message.direction != "in" || own_show == "dnd" {
        return false;
    }
    if message.kind == super::KIND_GROUP {
        return message.mention;
    }
    true
}

/// What the app is told about presence for an account: the saved status
/// always (connected or not), and what the session knows, if one runs.
pub fn snapshot(conn: &Connection, account: &str, live: Option<&Shared>) -> Result<Value> {
    let saved = own(conn, account)?;
    let mut value = match live {
        Some(live) => live.lock().unwrap().snapshot(),
        None => Live { own: saved.clone(), ..Default::default() }.snapshot(),
    };
    value["own"]["show"] = json!(saved.show);
    value["own"]["status"] = json!(saved.status);
    Ok(value)
}

/// A notification's title is cut to this many characters.
pub const MAX_TITLE: usize = 120;

/// The `chat.notify` event: who, where, and the text (or the file's name),
/// cut short, the title too. The title needs no translation: the sender,
/// and the room.
pub fn notification(message: &ChatMessage) -> Value {
    let text = message.file_name.clone().unwrap_or_else(|| message.body.clone());
    let text: String = text.chars().take(280).collect();
    let room = match message.kind.as_str() {
        super::KIND_GROUP => Some(message.conversation.clone()),
        super::KIND_PRIVATE => super::split_private(&message.conversation).map(|(room, _)| room.to_string()),
        _ => None,
    };
    let title = match &room {
        Some(room) => format!("{} · {}", message.sender, room),
        None => message.sender.clone(),
    };
    let title: String = title.chars().take(MAX_TITLE).collect();
    json!({
        "account": message.account,
        "conversation": message.conversation,
        "kind": message.kind,
        "room": room,
        "sender": message.sender,
        "title": title,
        "body": text,
        "mention": message.mention,
    })
}
