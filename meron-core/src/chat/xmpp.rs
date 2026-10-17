//! The XMPP side of chat (ADR-0036): the connection, and what each stanza
//! means for the store.
//!
//! The connection is the app's own (`crate::tls`): the account's proxy and
//! certificate pin apply, TLS is negotiated with STARTTLS, and a server that
//! does not offer it is not sent the password. Signing in (SASL), stream
//! management and stanzas come from `tokio-xmpp` and `xmpp-parsers`.
//!
//! Group chats (XEP-0045) and files (XEP-0363) ride the same session
//! (ADR-0044): rooms are joined again on each new connection, and a file's
//! upload is asked for, put over HTTPS and then sent as a link.
//!
//! Presence, mentions, notifications and private messages in rooms follow
//! ADR-0055: the person's status is announced (so only contacts allowed to
//! see it get it), contacts' and occupants' statuses are kept for the
//! session, and a message new to the person may raise a system notification.
//!
//! Who may see the person's status follows ADR-0064: the roster is asked for
//! on each new session and its pushes, from the person's own server only,
//! are answered and followed. A muted conversation raises no notification.

use super::files::{self, FileError};
use super::presence::{self, Applied, Arrival, ContactPresence};
use super::{ChatAccount, ChatMessage, Invitation, KIND_CHAT, KIND_GROUP, KIND_PRIVATE, mentions};
use anyhow::{Context, Result};
use futures::stream::FuturesUnordered;
use futures::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::BufStream;
use tokio_xmpp::connect::ServerConnector;
use tokio_xmpp::parsers::{
    carbons,
    delay::Delay,
    disco::{DiscoInfoQuery, DiscoInfoResult, DiscoItemsQuery, DiscoItemsResult},
    http_upload::SlotResult,
    jid::BareJid,
    jid::Jid,
    mam,
    message::Message,
    message::MessageType,
    minidom::Element,
    muc::{Muc, MucUser, muc::History, user::Status},
    presence::{Presence, Type as PresenceType},
    receipts,
    roster::Roster,
    rsm::SetQuery,
    stanza_error::{DefinedCondition, StanzaError},
    stanza_id::OriginId,
    stanza_id::StanzaId,
};
use tokio_xmpp::xmlstream::{
    PendingFeaturesRecv, ReadError, StreamHeader, Timeouts, XmppStreamElement, initiate_stream,
};
use tokio_xmpp::{Client, Event, Stanza};

// ---- The connection ---------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Connector {
    pub host: String,
    pub port: u16,
    pub proxy: Option<crate::proxy::ProxyConfig>,
    pub cert_pin: Option<String>,
    /// Plain XMPP is allowed only to a server on this machine, for tests.
    pub plain_loopback: bool,
}

fn io_error(e: impl std::fmt::Display) -> tokio_xmpp::Error {
    tokio_xmpp::Error::Io(std::io::Error::other(e.to_string()))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost")
}

impl ServerConnector for Connector {
    type Stream = BufStream<crate::tls::Stream>;

    async fn connect(
        &self,
        jid: &Jid,
        ns: &'static str,
        timeouts: Timeouts,
    ) -> Result<(PendingFeaturesRecv<Self::Stream>, sasl::common::ChannelBinding), tokio_xmpp::Error> {
        let header = || StreamHeader { to: Some(Cow::Owned(jid.domain().to_string())), from: None, id: None };
        let tcp = crate::tls::open_socket(&self.host, self.port, self.proxy.as_ref()).await.map_err(io_error)?;
        if self.plain_loopback && is_loopback(&self.host) {
            let stream = BufStream::new(crate::tls::Stream::Plain(tcp));
            return Ok((initiate_stream(stream, ns, header(), timeouts).await?, sasl::common::ChannelBinding::None));
        }
        let plain = BufStream::new(crate::tls::Stream::Plain(tcp));
        let (features, mut stream) = initiate_stream(plain, ns, header(), timeouts).await?.recv_features::<tokio_xmpp::xmlstream::FallibleStreamElement>().await?;
        if !features.can_starttls() {
            return Err(io_error("the chat server does not offer TLS, so the password is not sent to it"));
        }
        stream
            .send(&XmppStreamElement::Starttls(tokio_xmpp::parsers::starttls::Nonza::Request(
                tokio_xmpp::parsers::starttls::Request,
            )))
            .await?;
        loop {
            match stream.next().await.map(|v| v.map(|v| v.into_read_error()).flatten()) {
                Some(Ok(XmppStreamElement::Starttls(tokio_xmpp::parsers::starttls::Nonza::Proceed(_)))) => break,
                Some(Ok(_)) | Some(Err(ReadError::SoftTimeout)) => {}
                Some(Err(ReadError::HardError(e))) => return Err(e.into()),
                Some(Err(ReadError::ParseError(e))) => return Err(io_error(e)),
                None | Some(Err(ReadError::StreamFooterReceived)) => return Err(tokio_xmpp::Error::Disconnected),
            }
        }
        let crate::tls::Stream::Plain(tcp) = stream.into_inner().into_inner() else {
            return Err(io_error("TLS was already on"));
        };
        let tls = crate::tls::upgrade_to_tls(jid.domain().as_str(), tcp, self.cert_pin.as_deref())
            .await
            .map_err(io_error)?;
        let stream = BufStream::new(crate::tls::Stream::Tls(Box::new(tls)));
        Ok((initiate_stream(stream, ns, header(), timeouts).await?, sasl::common::ChannelBinding::None))
    }
}

// ---- What a stanza means ------------------------------------------------------------------

/// The ids a message carries: its origin-id, the archive id stamped by `by`
/// (our server for a conversation, the room for a group; any other is
/// ignored) and when it was said, if delayed.
fn ids(message: &Message, by: &BareJid, archive_id: Option<String>, stamp: i64) -> (Option<String>, Option<String>, i64) {
    let mut origin = None;
    let mut archived = archive_id;
    let mut when = stamp;
    for payload in &message.payloads {
        if let Ok(o) = OriginId::try_from(payload.clone()) {
            origin = Some(o.id);
        } else if let Ok(s) = StanzaId::try_from(payload.clone()) {
            if archived.is_none() && s.by.to_bare() == *by {
                archived = Some(s.id);
            }
        } else if let Ok(d) = Delay::try_from(payload.clone()) {
            when = d.stamp.0.timestamp();
        }
    }
    (origin, archived, when)
}

/// The text of a message, or its link when it carries only that.
fn body_of(message: &Message, link: &Option<String>) -> Option<String> {
    let body = message
        .bodies
        .get("")
        .or_else(|| message.bodies.values().next())
        .cloned()
        .filter(|b| !b.trim().is_empty())
        .or_else(|| link.clone())?;
    Some(body)
}

/// A message's meaning for the store, from a live stanza, a carbon copy or
/// the archive. `own` is the account's bare address.
pub fn interpret(message: &Message, own: &BareJid, archive_id: Option<String>, stamp: i64, account: &str) -> Option<ChatMessage> {
    if !matches!(message.type_, MessageType::Chat | MessageType::Normal) {
        return None;
    }
    let link = files::link_of(message);
    let body = body_of(message, &link)?;
    let from = message.from.as_ref().map(|j| j.to_bare());
    let to = message.to.as_ref().map(|j| j.to_bare());
    let outgoing = from.as_ref().is_none_or(|f| f == own);
    let other = if outgoing { to? } else { from? };
    // Only the archive id our own server stamped counts.
    let (origin, archived, when) = ids(message, own, archive_id, stamp);
    let id = origin
        .or_else(|| message.id.as_ref().map(|i| i.0.clone()))
        .or_else(|| archived.clone())?;
    Some(ChatMessage {
        account: account.into(),
        conversation: other.to_string(),
        id,
        stanza_id: archived,
        direction: if outgoing { "out" } else { "in" }.into(),
        sender: if outgoing { own.to_string() } else { other.to_string() },
        body,
        stamp: when,
        state: if outgoing { "accepted" } else { "received" }.into(),
        kind: KIND_CHAT.into(),
        file_name: link.as_deref().map(files::file_name_of),
        file_url: link,
        file_size: None,
        mention: false,
    })
}

/// A room's message (XEP-0045): who said it is the occupant's nickname, and
/// one said with ours is our own, reflected by the room. Only the room's own
/// archive id counts. The room itself speaking (no nickname) and subject
/// changes are not messages here.
pub fn interpret_group(
    message: &Message,
    room: &BareJid,
    nick: &str,
    archive_id: Option<String>,
    stamp: i64,
    account: &str,
) -> Option<ChatMessage> {
    if message.type_ != MessageType::Groupchat {
        return None;
    }
    let from = message.from.as_ref()?;
    if from.to_bare() != *room {
        return None;
    }
    let speaker = from.resource()?.as_str().to_string();
    let link = files::link_of(message);
    let body = body_of(message, &link)?;
    let (origin, archived, when) = ids(message, room, archive_id, stamp);
    let id = origin
        .or_else(|| message.id.as_ref().map(|i| i.0.clone()))
        .or_else(|| archived.clone())?;
    let own = speaker == nick;
    Some(ChatMessage {
        account: account.into(),
        conversation: room.to_string(),
        id,
        stanza_id: archived,
        direction: if own { "out" } else { "in" }.into(),
        sender: speaker,
        body,
        stamp: when,
        state: if own { "accepted" } else { "received" }.into(),
        kind: KIND_GROUP.into(),
        file_name: link.as_deref().map(files::file_name_of),
        file_url: link,
        file_size: None,
        mention: false,
    })
}

/// A private message with someone in a room (XEP-0045 §7.5): a chat
/// message to or from `room/nick`. It is its own conversation, tied to the
/// room; who speaks is a nickname. Our own (a copy from another device, or
/// from our archive) is addressed to the occupant.
pub fn interpret_private(
    message: &Message,
    own: &BareJid,
    room: &BareJid,
    nick: &str,
    archive_id: Option<String>,
    stamp: i64,
    account: &str,
) -> Option<ChatMessage> {
    if !matches!(message.type_, MessageType::Chat | MessageType::Normal) {
        return None;
    }
    let from = message.from.as_ref();
    let outgoing = from.is_none_or(|f| f.to_bare() == *own);
    let other = if outgoing { message.to.as_ref()? } else { from? };
    if other.to_bare() != *room {
        return None;
    }
    let occupant = other.resource()?.as_str().to_string();
    let link = files::link_of(message);
    let body = body_of(message, &link)?;
    // Only our own server's archive id counts, as for any direct message.
    let (origin, archived, when) = ids(message, own, archive_id, stamp);
    let id = origin
        .or_else(|| message.id.as_ref().map(|i| i.0.clone()))
        .or_else(|| archived.clone())?;
    Some(ChatMessage {
        account: account.into(),
        conversation: super::normalize_conversation(&format!("{room}/{occupant}")),
        id,
        stanza_id: archived,
        direction: if outgoing { "out" } else { "in" }.into(),
        sender: if outgoing { nick.to_string() } else { occupant },
        body,
        stamp: when,
        state: if outgoing { "accepted" } else { "received" }.into(),
        kind: KIND_PRIVATE.into(),
        file_name: link.as_deref().map(files::file_name_of),
        file_url: link,
        file_size: None,
        mention: false,
    })
}

/// An invitation to a room: direct (XEP-0249) from a person, or mediated
/// by the room (XEP-0045). It only offers; joining is the person's choice.
/// Returns it and the room password it carried, if any.
pub fn invitation(message: &Message, account: &str, now: i64) -> Option<(Invitation, Option<String>)> {
    let from = message.from.as_ref()?.to_bare();
    for payload in &message.payloads {
        if payload.is("x", "jabber:x:conference") {
            let room = BareJid::from_str(payload.attr("jid")?).ok()?;
            let password = payload.attr("password").map(str::to_string).filter(|p| !p.is_empty());
            return Some((
                Invitation {
                    account: account.into(),
                    room: room.to_string(),
                    inviter: from.to_string(),
                    reason: payload.attr("reason").unwrap_or_default().to_string(),
                    has_password: password.is_some(),
                    received_at: now,
                },
                password,
            ));
        }
        if let Ok(user) = MucUser::try_from(payload.clone()) {
            if let Some(invite) = user.invite {
                let password = payload
                    .get_child("password", tokio_xmpp::parsers::ns::MUC_USER)
                    .map(|p| p.text())
                    .filter(|p| !p.is_empty());
                return Some((
                    Invitation {
                        account: account.into(),
                        room: from.to_string(),
                        inviter: invite.from.map(|j| j.to_bare().to_string()).unwrap_or_default(),
                        reason: invite.reason.unwrap_or_default(),
                        has_password: password.is_some(),
                        received_at: now,
                    },
                    password,
                ));
            }
        }
    }
    None
}

/// A message to send: its id is also its origin-id, so every copy of it
/// anywhere is known as the same message. A direct one asks for a delivery
/// receipt; one to a room does not (rooms reflect it instead). A file goes
/// as its link, in the body and out of band.
pub fn outgoing_message(to: &BareJid, id: &str, body: &str, group: bool, file: Option<&str>) -> Message {
    let mut message = Message::new(Some(Jid::from(to.clone())));
    message.type_ = if group { MessageType::Groupchat } else { MessageType::Chat };
    message.id = Some(tokio_xmpp::parsers::message::Id(id.into()));
    message.bodies.insert(tokio_xmpp::parsers::message::Lang::default(), body.into());
    message.payloads.push(OriginId { id: id.into() }.into());
    if !group {
        message.payloads.push(receipts::Request.into());
    }
    match file {
        Some(url) => files::with_link(message, url),
        None => message,
    }
}

/// A chat message to one person.
pub fn outgoing(to: &BareJid, id: &str, body: &str) -> Message {
    outgoing_message(to, id, body, false, None)
}

/// A private message to someone in a room, addressed to their place in it
/// (`room/nick`) and marked as going through the room (XEP-0045 §7.5), so
/// it is not mistaken for a direct one. No receipt is asked: the room
/// relays it, and the other person need not tell us when they read it.
pub fn outgoing_private(room: &BareJid, nick: &str, id: &str, body: &str, file: Option<&str>) -> Result<Message> {
    let to = room.with_resource_str(nick).context("this nickname cannot be written to")?;
    let mut message = Message::new(Some(Jid::from(to)));
    message.type_ = MessageType::Chat;
    message.id = Some(tokio_xmpp::parsers::message::Id(id.into()));
    message.bodies.insert(tokio_xmpp::parsers::message::Lang::default(), body.into());
    message.payloads.push(OriginId { id: id.into() }.into());
    message.payloads.push(Element::builder("x", tokio_xmpp::parsers::ns::MUC_USER).build());
    Ok(match file {
        Some(url) => files::with_link(message, url),
        None => message,
    })
}

/// A message to a room with XEP-0372 references for the nicknames the
/// person picked from the suggestions and kept in the text (ADR-0055).
pub fn outgoing_group(room: &BareJid, id: &str, body: &str, file: Option<&str>, mentioned: &[String]) -> Message {
    let mut message = outgoing_message(room, id, body, true, file);
    message.payloads.extend(mentions::references(room, body, mentioned));
    message
}

/// Joining a room (or joining it again): with its password if it has one,
/// and asking only for what was said since the newest message kept here, or
/// the last 50 when nothing is.
pub fn join_presence(room: &BareJid, nick: &str, password: Option<&str>, since: Option<i64>) -> Result<Presence> {
    join_presence_as(room, nick, password, since, "available")
}

/// Joining while away or busy says so (availability only, never the text).
pub fn join_presence_as(room: &BareJid, nick: &str, password: Option<&str>, since: Option<i64>, show: &str) -> Result<Presence> {
    let to = room.with_resource_str(nick).context("this nickname cannot be used in a room")?;
    let history = match since.and_then(|s| chrono::DateTime::from_timestamp(s, 0)) {
        Some(at) => History::new().with_since(tokio_xmpp::parsers::date::DateTime(at.fixed_offset())),
        None => History::new().with_maxstanzas(50),
    };
    let mut muc = Muc::new().with_history(history);
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        muc = muc.with_password(password.to_string());
    }
    Ok(presence::room_stanza(Jid::from(to), show).with_payload(muc))
}

pub fn leave_presence(room: &BareJid, nick: &str) -> Result<Presence> {
    Ok(Presence::unavailable().with_to(room.with_resource_str(nick).context("this nickname cannot be used in a room")?))
}

/// What a room said about our place in it.
#[derive(Debug, Clone, PartialEq)]
pub enum RoomPresence {
    Joined { created: bool },
    /// Out of the room: left, kicked, or the room went.
    Out,
    Error { condition: String, message: String },
}

/// A presence from a room, about us (status 110) or an error for our join.
pub fn room_presence(presence: &Presence) -> Option<RoomPresence> {
    if presence.type_ == PresenceType::Error {
        let error = presence.payloads.iter().find_map(|p| StanzaError::try_from(p.clone()).ok());
        let (condition, message) = match error.as_ref().map(|e| &e.defined_condition) {
            Some(DefinedCondition::NotAuthorized) => ("password", "the room needs a password, or it was wrong"),
            Some(DefinedCondition::Conflict) => ("nick", "someone in the room already has this nickname"),
            Some(DefinedCondition::RegistrationRequired) => ("members", "the room is for its members only"),
            Some(DefinedCondition::Forbidden) => ("banned", "the room does not let this account in"),
            Some(DefinedCondition::ItemNotFound) => ("missing", "there is no such room"),
            Some(DefinedCondition::ServiceUnavailable) => ("full", "the room is full"),
            _ => ("other", "the room did not let this account in"),
        };
        return Some(RoomPresence::Error { condition: condition.into(), message: message.into() });
    }
    let user = presence.payloads.iter().find_map(|p| MucUser::try_from(p.clone()).ok())?;
    if !user.status.contains(&Status::SelfPresence) {
        return None;
    }
    if presence.type_ == PresenceType::Unavailable {
        return Some(RoomPresence::Out);
    }
    Some(RoomPresence::Joined { created: user.status.contains(&Status::RoomHasBeenCreated) })
}

/// Accepting a new room's default settings, so others can join it.
pub fn instant_room() -> Element {
    "<query xmlns='http://jabber.org/protocol/muc#owner'><x xmlns='jabber:x:data' type='submit'/></query>"
        .parse()
        .expect("a fixed element")
}

// ---- The session --------------------------------------------------------------------------

/// A file to send, once the server gives it a place.
#[derive(Debug, Clone)]
pub struct Upload {
    pub id: String,
    pub conversation: String,
    pub group: bool,
    pub path: std::path::PathBuf,
    pub name: String,
    pub size: u64,
    pub cancel: Arc<AtomicBool>,
}

pub enum Command {
    /// A conversation with `/` is a private one in a room (`room/nick`).
    /// `mentions`: nicknames picked from the suggestions, for references.
    Send { conversation: String, id: String, body: String, group: bool, file: Option<String>, mentions: Vec<String> },
    /// The person changed their status: read again from the store.
    Presence,
    /// Ask to see someone's status.
    Subscribe { jid: String },
    /// Answer someone's request to see the person's status.
    AnswerSubscription { jid: String, allow: bool },
    Join { room: String, nick: String, password: Option<String> },
    Leave { room: String, nick: String },
    Upload(Upload),
    Stop,
}

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
/// A room's saved password, by room address.
pub type RoomPassword = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What a session needs besides its account.
#[derive(Clone)]
pub struct Options {
    pub room_password: RoomPassword,
    /// Certificate authorities (PEM) trusted for files instead of the usual
    /// ones: only for tests against a local server.
    pub file_roots: Vec<Vec<u8>>,
    /// What the session knows about presence, shared with the app.
    pub live: presence::Shared,
}

impl Default for Options {
    fn default() -> Self {
        Options { room_password: Arc::new(|_| None), file_roots: Vec::new(), live: Default::default() }
    }
}

/// What an answer to one of our questions (iq) is about.
enum Asked {
    Mam(Option<String>),
    /// What the account's own server offers (invisibility).
    Features,
    /// The roster: who may see the person's status (ADR-0064).
    Roster,
    Items,
    Info(Jid),
    Slot(String),
    Ignored,
}

type Answer = (Asked, Result<tokio_xmpp::IqResponse, tokio_xmpp::IqFailure>);
type Pending = FuturesUnordered<Pin<Box<dyn Future<Output = Answer> + Send>>>;

fn ask(pending: &Pending, what: Asked, token: tokio_xmpp::IqResponseToken) {
    pending.push(Box::pin(async move { (what, token.await) }));
}

/// The upload service, found once per session.
#[derive(Default)]
struct Uploads {
    service: Option<(Jid, Option<u64>)>,
    /// Discovery questions still unanswered.
    searching: usize,
    waiting: Vec<Upload>,
    asked: HashMap<String, Upload>,
}

/// Runs one account's connection until stopped: catches up from the archive
/// when online, joins its rooms, records what arrives, sends what is asked.
pub async fn run(
    account: ChatAccount,
    password: String,
    db: Arc<Mutex<Connection>>,
    connector: Connector,
    mut commands: tokio::sync::mpsc::UnboundedReceiver<Command>,
    emit: Emit,
    options: Options,
) {
    let own = match BareJid::from_str(&account.jid) {
        Ok(j) => j,
        Err(e) => {
            emit("chat.status", json!({ "account": account.id, "state": "error", "message": e.to_string() }));
            return;
        }
    };
    let mut client = Client::new_with_connector(own.clone(), password, connector, Timeouts::default());
    let pending: Pending = FuturesUnordered::new();
    let mut pending = pending;
    let mut uploads = Uploads::default();
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<(Upload, String, Result<(), FileError>)>();
    let changed = |conversation: &str| emit("chat.changed", json!({ "account": account.id, "conversation": conversation }));
    let room_state = |room: &str, state: &str, detail: Value| {
        emit("chat.room", json!({ "account": account.id, "room": room, "state": state, "detail": detail }))
    };
    let uploaded = |upload: &Upload, result: Result<String, FileError>| {
        let detail = match result {
            Ok(id) => json!({ "account": account.id, "upload_id": upload.id, "conversation": upload.conversation, "id": id }),
            Err(error) => json!({
                "account": account.id,
                "upload_id": upload.id,
                "conversation": upload.conversation,
                "error": { "message": error.to_string(), "detail": error },
            }),
        };
        emit("chat.uploaded", detail);
    };
    let live = options.live.clone();
    // The saved status from the start, so it is never reported as
    // "available" before the first connection.
    if let Ok(saved) = super::presence::own(&db.lock().unwrap(), &account.id) {
        live.lock().unwrap().own = saved;
    }
    let own_changed = || {
        let mut detail = live.lock().unwrap().own_detail();
        detail["account"] = json!(account.id);
        emit("chat.own", detail);
    };
    let occupants_changed = |room: &str| emit("chat.occupants", json!({ "account": account.id, "room": room }));
    // Who may see the person's status changed, or became known.
    let permissions_changed = || emit("chat.permissions", json!({ "account": account.id }));
    // Rooms the room itself said we are in, on this stream.
    let mut in_rooms: std::collections::HashSet<String> = Default::default();
    loop {
        tokio::select! {
            event = client.next() => {
                let Some(event) = event else { break };
                match event {
                    Event::Online { resumed, .. } => {
                        // Whatever was in flight when the connection went is now
                        // uncertain; the archive settles what the server got.
                        if let Ok(n) = super::after_disconnect(&db.lock().unwrap(), &account.id) {
                            if n > 0 { changed(""); }
                        }
                        emit("chat.status", json!({ "account": account.id, "state": "online" }));
                        // A new session starts from nothing; a resumed one keeps
                        // what it had (XEP-0198), rooms and contacts included.
                        if !resumed {
                            live.lock().unwrap().fresh_session();
                            in_rooms.clear();
                            // The app drops what it showed of the old session;
                            // contacts, requests and rooms say it all again.
                            emit("chat.presence", json!({ "account": account.id, "reset": true }));
                        }
                        // The person's status: announced now, or, when invisible,
                        // once the server says whether it can hide them.
                        let own_presence = super::presence::own(&db.lock().unwrap(), &account.id).unwrap_or_default();
                        live.lock().unwrap().own = own_presence;
                        let domain = Jid::from(BareJid::from_parts(None, own.domain()));
                        let token = client.send_iq(Some(domain), tokio_xmpp::IqRequest::Get(DiscoInfoQuery { node: None }.into())).await;
                        ask(&pending, Asked::Features, token);
                        // Who may see the status, asked before announcing it
                        // (RFC 6121 §2.2), unless this session already knows.
                        let known = live.lock().unwrap().allowed.is_some();
                        if !known {
                            let token = client.send_iq(None, tokio_xmpp::IqRequest::Get(presence::roster_query())).await;
                            ask(&pending, Asked::Roster, token);
                        }
                        announce(&mut client, &mut pending, &live, Applied::Offline).await;
                        own_changed();
                        let _ = client.send_iq(None, tokio_xmpp::IqRequest::Set(carbons::Enable.into())).await;
                        let after = super::last_archive_id(&db.lock().unwrap(), &account.id).ok().flatten();
                        let token = client.send_iq(None, tokio_xmpp::IqRequest::Set(archive_query(after).into())).await;
                        ask(&pending, Asked::Mam(None), token);
                        // A resumed stream is still in its rooms; a new one joins them again.
                        if !resumed {
                            let rooms = super::rooms(&db.lock().unwrap(), &account.id).unwrap_or_default();
                            let show = room_show(&live);
                            for room in rooms {
                                let password = if room.has_password { (options.room_password)(&room.room) } else { None };
                                join(&mut client, &db, &account.id, &room.room, &room.nick, password.as_deref(), &show, &room_state).await;
                            }
                        }
                    }
                    Event::Disconnected(error) => {
                        let _ = super::after_disconnect(&db.lock().unwrap(), &account.id);
                        // What contacts and rooms said stays until the stream is
                        // resumed or replaced; the app shows it only while online.
                        live.lock().unwrap().applied = Applied::Offline;
                        own_changed();
                        emit("chat.status", json!({ "account": account.id, "state": "offline", "message": error.to_string() }));
                        // Questions asked on the old stream get no answer: uploads
                        // still waiting for a place were not sent, and say so.
                        pending = FuturesUnordered::new();
                        uploads.searching = 0;
                        for upload in uploads.waiting.drain(..).chain(uploads.asked.drain().map(|(_, u)| u)) {
                            uploaded(&upload, Err(FileError::Disconnected));
                        }
                    }
                    Event::Stanza(Stanza::Message(message)) => {
                        let invited = |invitation: &Invitation, password: Option<String>| {
                            emit("chat.invitation", json!({
                                "account": invitation.account,
                                "room": invitation.room,
                                "inviter": invitation.inviter,
                                "reason": invitation.reason,
                                "password": password,
                            }));
                        };
                        let own_show = live.lock().unwrap().own.show.clone();
                        let handled = handle_message(&db, &account.id, &own, &message, &own_show, &changed, &invited);
                        if let Some(receipt) = handled.receipt {
                            let _ = client.send_stanza(receipt.into()).await;
                        }
                        if let Some(new) = handled.notify {
                            emit("chat.notify", presence::notification(&new));
                        }
                    }
                    Event::Stanza(Stanza::Presence(presence)) => {
                        let Some(from) = presence.from.as_ref().map(|j| j.to_bare()) else { continue };
                        let room = from.to_string();
                        let Some(nick) = super::room_nick(&db.lock().unwrap(), &account.id, &room).ok().flatten() else {
                            // Not a room: a contact's status, or someone asking to see ours.
                            match presence::contact_presence(&presence, &own) {
                                Some(ContactPresence::Status { jid, resource, show, status, priority }) => {
                                    // A contact beyond the bound is not kept, nor told to the app.
                                    let seen = live.lock().unwrap().contacts.update(&jid, &resource, show, &status, priority);
                                    if let Some(seen) = seen {
                                        emit("chat.presence", json!({ "account": account.id, "jid": jid, "show": seen.show, "status": seen.status }));
                                    }
                                }
                                Some(ContactPresence::Request { jid }) => {
                                    if live.lock().unwrap().request(&jid) {
                                        emit("chat.subscription", json!({ "account": account.id, "jid": jid }));
                                    }
                                }
                                None => {}
                            }
                            continue;
                        };
                        // The room may give us another nickname than the one asked (210).
                        if let Some(given) = presence::own_nick_in(&presence, &nick) {
                            let _ = super::set_room_nick(&db.lock().unwrap(), &account.id, &room, &given);
                        }
                        match room_presence(&presence) {
                            // Our own presence again (after a status change): already in.
                            Some(RoomPresence::Joined { .. }) if in_rooms.contains(&room) => {}
                            Some(RoomPresence::Joined { created }) => {
                                in_rooms.insert(room.clone());
                                room_state(&room, "joined", Value::Null);
                                if created {
                                    let token = client.send_iq(Some(Jid::from(from.clone())), tokio_xmpp::IqRequest::Set(instant_room())).await;
                                    ask(&pending, Asked::Ignored, token);
                                }
                                // The room's own archive, from where we left it, when it has one.
                                let after = super::last_room_archive_id(&db.lock().unwrap(), &account.id, &room).ok().flatten();
                                if after.is_some() {
                                    let token = client.send_iq(Some(Jid::from(from.clone())), tokio_xmpp::IqRequest::Set(archive_query(after).into())).await;
                                    ask(&pending, Asked::Mam(Some(room.clone())), token);
                                }
                            }
                            Some(RoomPresence::Out) => {
                                in_rooms.remove(&room);
                                live.lock().unwrap().occupants.forget(&room);
                                occupants_changed(&room);
                                room_state(&room, "out", Value::Null)
                            }
                            Some(RoomPresence::Error { condition, message }) => {
                                room_state(&room, "error", json!({ "condition": condition, "message": message }))
                            }
                            None => {
                                // Someone else in the room came, changed or went.
                                if let Some(change) = presence::occupant_change(&presence) {
                                    if live.lock().unwrap().occupants.apply(&room, change) {
                                        occupants_changed(&room);
                                    }
                                }
                            }
                        }
                    }
                    // A roster push from the person's own server: answered, and
                    // who may see the status follows it. Any other question is
                    // left unanswered, as before.
                    Event::Stanza(Stanza::Iq(iq)) => {
                        if let Some((roster, id)) = presence::roster_push(&iq, &own) {
                            let changed = live.lock().unwrap().apply_roster_push(&roster);
                            let _ = client.send_stanza(presence::roster_push_answer(id).into()).await;
                            if changed {
                                permissions_changed();
                            }
                        }
                    }
                    Event::Stanza(_) => {}
                }
            }
            Some((what, answer)) = pending.next(), if !pending.is_empty() => {
                match what {
                    Asked::Mam(room) => {
                        // Page after page until the archive says it is done.
                        if let Ok(tokio_xmpp::IqResponse::Result(Some(element))) = answer {
                            if let Ok(fin) = mam::Fin::try_from(element) {
                                if !fin.complete {
                                    if let Some(last) = fin.set.last {
                                        let to = room.as_deref().and_then(|r| Jid::from_str(r).ok());
                                        let token = client.send_iq(to, tokio_xmpp::IqRequest::Set(archive_query(Some(last)).into())).await;
                                        ask(&pending, Asked::Mam(room), token);
                                    }
                                }
                            }
                        }
                    }
                    Asked::Features => {
                        let supported = match answer {
                            Ok(tokio_xmpp::IqResponse::Result(Some(element))) => {
                                DiscoInfoResult::try_from(element).is_ok_and(|info| presence::supports_invisible(&info))
                            }
                            // No answer, or an error: the server does not say it can.
                            _ => false,
                        };
                        let before = {
                            let mut l = live.lock().unwrap();
                            l.invisible_supported = Some(supported);
                            l.applied
                        };
                        if before == Applied::Waiting {
                            announce(&mut client, &mut pending, &live, before).await;
                        }
                        own_changed();
                    }
                    Asked::Roster => {
                        // No answer, or an error: it stays unknown, never "nobody".
                        if let Ok(tokio_xmpp::IqResponse::Result(Some(element))) = answer {
                            if let Ok(roster) = Roster::try_from(element) {
                                live.lock().unwrap().set_roster(&roster);
                                permissions_changed();
                            }
                        }
                    }
                    Asked::Items => {
                        uploads.searching = uploads.searching.saturating_sub(1);
                        if let Ok(tokio_xmpp::IqResponse::Result(Some(element))) = answer {
                            if let Ok(items) = DiscoItemsResult::try_from(element) {
                                for item in items.items.into_iter().take(20) {
                                    let token = client.send_iq(Some(item.jid.clone()), tokio_xmpp::IqRequest::Get(DiscoInfoQuery { node: None }.into())).await;
                                    uploads.searching += 1;
                                    ask(&pending, Asked::Info(item.jid), token);
                                }
                            }
                        }
                        next_uploads(&mut client, &mut pending, &mut uploads, &uploaded).await;
                    }
                    Asked::Info(jid) => {
                        uploads.searching = uploads.searching.saturating_sub(1);
                        if let Ok(tokio_xmpp::IqResponse::Result(Some(element))) = answer {
                            if let Ok(info) = DiscoInfoResult::try_from(element) {
                                if let (None, Some(max)) = (&uploads.service, files::upload_service(&info)) {
                                    uploads.service = Some((jid, max));
                                }
                            }
                        }
                        next_uploads(&mut client, &mut pending, &mut uploads, &uploaded).await;
                    }
                    Asked::Slot(id) => {
                        let Some(upload) = uploads.asked.remove(&id) else { continue };
                        let slot = match answer {
                            Ok(tokio_xmpp::IqResponse::Result(Some(element))) => SlotResult::try_from(element)
                                .map_err(|e| FileError::Refused { detail: e.to_string() })
                                .and_then(files::parse_slot),
                            Ok(tokio_xmpp::IqResponse::Error(error)) => Err(FileError::Refused {
                                detail: error.texts.values().next().cloned().unwrap_or_else(|| format!("{:?}", error.defined_condition)),
                            }),
                            Ok(tokio_xmpp::IqResponse::Result(None)) => Err(FileError::Refused { detail: "no place was given".into() }),
                            Err(_) => Err(FileError::Disconnected),
                        };
                        match slot {
                            Err(error) => uploaded(&upload, Err(error)),
                            Ok(_) if upload.cancel.load(Ordering::Relaxed) => uploaded(&upload, Err(FileError::Cancelled)),
                            Ok(slot) => spawn_put(upload, slot, &options, &emit, &account.id, done_tx.clone()),
                        }
                    }
                    Asked::Ignored => {}
                }
            }
            Some((upload, link, result)) = done_rx.recv() => {
                match result {
                    Err(error) => uploaded(&upload, Err(error)),
                    Ok(()) => {
                        // The file is up: its link goes as a message like any other.
                        let id = uuid::Uuid::new_v4().to_string();
                        let private = super::split_private(&upload.conversation).map(|(room, _)| room.to_string());
                        // In a room, and privately through one, we speak with our nickname.
                        let sender = match (upload.group, &private) {
                            (true, _) => super::room_nick(&db.lock().unwrap(), &account.id, &upload.conversation).ok().flatten().unwrap_or_default(),
                            (false, Some(room)) => super::room_nick(&db.lock().unwrap(), &account.id, room).ok().flatten().unwrap_or_default(),
                            (false, None) => own.to_string(),
                        };
                        let mut message = ChatMessage::chat(&account.id, &upload.conversation, &id, "out", &sender, &link, crate::store::now_unix(), "sending");
                        message.kind = match (upload.group, &private) {
                            (true, _) => KIND_GROUP,
                            (false, Some(_)) => KIND_PRIVATE,
                            (false, None) => KIND_CHAT,
                        }
                        .into();
                        message.file_url = Some(link.clone());
                        message.file_name = Some(upload.name.clone());
                        message.file_size = Some(upload.size as i64);
                        let queued = super::queue_message(&db.lock().unwrap(), &message);
                        match queued {
                            Err(error) => uploaded(&upload, Err(FileError::File { detail: error.to_string() })),
                            Ok(()) => {
                                deliver(&mut client, &db, &account.id, &emit, &upload.conversation, &id, &link, upload.group, Some(&link), &[]).await;
                                uploaded(&upload, Ok(id));
                            }
                        }
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    None | Some(Command::Stop) => break,
                    Some(Command::Send { conversation, id, body, group, file, mentions }) => {
                        deliver(&mut client, &db, &account.id, &emit, &conversation, &id, &body, group, file.as_deref(), &mentions).await;
                    }
                    Some(Command::Presence) => {
                        let own_presence = super::presence::own(&db.lock().unwrap(), &account.id).unwrap_or_default();
                        let before = {
                            let mut l = live.lock().unwrap();
                            l.own = own_presence;
                            l.applied
                        };
                        // Offline, it is applied on connecting.
                        if before != Applied::Offline {
                            let now = announce(&mut client, &mut pending, &live, before).await;
                            // Going unannounced takes the server's broadcast of
                            // "unavailable", which also leaves every room
                            // (RFC 6121 §4.6): join them again at once, so the
                            // rooms keep the person in, as chosen.
                            if presence::rejoin_rooms(before, now) {
                                in_rooms.clear();
                                live.lock().unwrap().occupants.clear();
                                let rooms = super::rooms(&db.lock().unwrap(), &account.id).unwrap_or_default();
                                let show = room_show(&live);
                                for room in rooms {
                                    let password = if room.has_password { (options.room_password)(&room.room) } else { None };
                                    join(&mut client, &db, &account.id, &room.room, &room.nick, password.as_deref(), &show, &room_state).await;
                                }
                            }
                            // What came while held back waited in the archive.
                            if before == Applied::Withheld && now != Applied::Withheld {
                                let after = super::last_archive_id(&db.lock().unwrap(), &account.id).ok().flatten();
                                let token = client.send_iq(None, tokio_xmpp::IqRequest::Set(archive_query(after).into())).await;
                                ask(&pending, Asked::Mam(None), token);
                            }
                            // Rooms hear the availability only, never the text.
                            let show = room_show(&live);
                            for room in &in_rooms {
                                let Some(nick) = super::room_nick(&db.lock().unwrap(), &account.id, room).ok().flatten() else { continue };
                                if let Some(to) = BareJid::from_str(room).ok().and_then(|r| r.with_resource_str(&nick).ok()) {
                                    let _ = client.send_stanza(presence::room_stanza(Jid::from(to), &show).into()).await;
                                }
                            }
                        }
                        own_changed();
                    }
                    Some(Command::Subscribe { jid }) => {
                        if let Ok(jid) = BareJid::from_str(&jid) {
                            let _ = client.send_stanza(presence::subscription(&jid, PresenceType::Subscribe).into()).await;
                        }
                    }
                    Some(Command::AnswerSubscription { jid, allow }) => {
                        // Allowing goes only to someone who asked; denying, to anyone.
                        let answer = live.lock().unwrap().answer(&jid, allow);
                        if let (Some(kind), Ok(bare)) = (answer, BareJid::from_str(&jid)) {
                            let _ = client.send_stanza(presence::subscription(&bare, kind).into()).await;
                        }
                        emit("chat.subscription", json!({ "account": account.id, "jid": jid, "answered": true }));
                    }
                    Some(Command::Join { room, nick, password }) => {
                        let show = room_show(&live);
                        join(&mut client, &db, &account.id, &room, &nick, password.as_deref(), &show, &room_state).await;
                    }
                    Some(Command::Leave { room, nick }) => {
                        in_rooms.remove(&room);
                        live.lock().unwrap().occupants.forget(&room);
                        if let Ok(room) = BareJid::from_str(&room) {
                            if let Ok(presence) = leave_presence(&room, &nick) {
                                let _ = client.send_stanza(presence.into()).await;
                            }
                        }
                    }
                    Some(Command::Upload(upload)) => {
                        if upload.cancel.load(Ordering::Relaxed) {
                            uploaded(&upload, Err(FileError::Cancelled));
                            continue;
                        }
                        uploads.waiting.push(upload);
                        if uploads.service.is_none() && uploads.searching == 0 {
                            // Find the upload service: the server itself, or one of its components.
                            let domain = Jid::from(BareJid::from_parts(None, own.domain()));
                            let token = client.send_iq(Some(domain.clone()), tokio_xmpp::IqRequest::Get(DiscoItemsQuery { node: None, rsm: None }.into())).await;
                            ask(&pending, Asked::Items, token);
                            let token = client.send_iq(Some(domain.clone()), tokio_xmpp::IqRequest::Get(DiscoInfoQuery { node: None }.into())).await;
                            ask(&pending, Asked::Info(domain), token);
                            uploads.searching = 2;
                        } else {
                            next_uploads(&mut client, &mut pending, &mut uploads, &uploaded).await;
                        }
                    }
                }
            }
        }
    }
    let _ = client.send_end().await;
    {
        let mut l = live.lock().unwrap();
        l.fresh_session();
        l.applied = Applied::Offline;
    }
    emit("chat.status", json!({ "account": account.id, "state": "stopped" }));
}

/// What joined rooms hear of the person's status: away or busy, or plainly
/// there (also while hidden from contacts).
fn room_show(live: &presence::Shared) -> String {
    let show = live.lock().unwrap().own.show.clone();
    if show == "invisible" { "available".into() } else { show }
}

/// Puts the person's chosen status on the stream, from where it stood
/// (`before`): announced, hidden by the server (XEP-0186), or held back when
/// invisible was chosen and the server cannot hide them. Never visible
/// unless chosen.
async fn announce(client: &mut Client, pending: &mut Pending, live: &presence::Shared, before: Applied) -> Applied {
    let (own, supported) = {
        let l = live.lock().unwrap();
        (l.own.clone(), l.invisible_supported)
    };
    let now = presence::plan(&own.show, supported);
    match now {
        Applied::Announced => {
            if before == Applied::Invisible {
                let token = client.send_iq(None, tokio_xmpp::IqRequest::Set(presence::invisible_command(false))).await;
                ask(pending, Asked::Ignored, token);
            }
            let _ = client.send_stanza(presence::own_stanza(&own.show, &own.status).into()).await;
        }
        Applied::Invisible if before != Applied::Invisible => {
            let token = client.send_iq(None, tokio_xmpp::IqRequest::Set(presence::invisible_command(true))).await;
            ask(pending, Asked::Ignored, token);
        }
        // Already announced on this stream: offline to contacts is what was chosen.
        Applied::Withheld if before == Applied::Announced => {
            let _ = client.send_stanza(Presence::unavailable().into()).await;
        }
        _ => {}
    }
    live.lock().unwrap().applied = now;
    now
}

/// Joins a room, asking for what was said since the newest message kept.
#[allow(clippy::too_many_arguments)]
async fn join(
    client: &mut Client,
    db: &Arc<Mutex<Connection>>,
    account: &str,
    room: &str,
    nick: &str,
    password: Option<&str>,
    show: &str,
    room_state: &(dyn Fn(&str, &str, Value) + Sync),
) {
    let Ok(jid) = BareJid::from_str(room) else { return };
    let since = super::last_room_stamp(&db.lock().unwrap(), account, room).ok().flatten();
    match join_presence_as(&jid, nick, password, since, show) {
        Ok(presence) => {
            room_state(room, "joining", Value::Null);
            let _ = client.send_stanza(presence.into()).await;
        }
        Err(error) => room_state(room, "error", json!({ "condition": "nick", "message": error.to_string() })),
    }
}

/// Sends one message (already noted as sending) and follows it: sent once
/// written, accepted when the server acknowledges it (XEP-0198).
#[allow(clippy::too_many_arguments)]
async fn deliver(
    client: &mut Client,
    db: &Arc<Mutex<Connection>>,
    account: &str,
    emit: &Emit,
    conversation: &str,
    id: &str,
    body: &str,
    group: bool,
    file: Option<&str>,
    mentions: &[String],
) {
    let changed = |c: &str| emit("chat.changed", json!({ "account": account, "conversation": c }));
    // A private one goes to someone's place in a room; others to an address.
    let stanza = match super::split_private(conversation) {
        Some((room, nick)) => BareJid::from_str(room).ok().and_then(|room| outgoing_private(&room, nick, id, body, file).ok()),
        None => BareJid::from_str(conversation).ok().map(|to| {
            if group { outgoing_group(&to, id, body, file, mentions) } else { outgoing_message(&to, id, body, false, file) }
        }),
    };
    let Some(stanza) = stanza else {
        let _ = super::set_state(&db.lock().unwrap(), account, id, "failed");
        changed(conversation);
        return;
    };
    match client.send_stanza(stanza.into()).await {
        Ok(mut token) => {
            let _ = super::set_state(&db.lock().unwrap(), account, id, "sent");
            changed(conversation);
            let db = db.clone();
            let emit = emit.clone();
            let (account, conversation, id) = (account.to_string(), conversation.to_string(), id.to_string());
            tokio::spawn(async move {
                if let Some(tokio_xmpp::stanzastream::StanzaState::Acked { .. }) =
                    token.wait_for(tokio_xmpp::stanzastream::StanzaStage::Acked).await
                {
                    let _ = super::set_state(&db.lock().unwrap(), &account, &id, "accepted");
                    emit("chat.changed", json!({ "account": account, "conversation": conversation }));
                }
            });
        }
        Err(_) => {
            let _ = super::set_state(&db.lock().unwrap(), account, id, "failed");
            changed(conversation);
        }
    }
}

/// Moves waiting uploads on once the service is known: each is checked
/// against its size limit, then a place (slot) is asked for it. With the
/// search over and no service, they fail.
async fn next_uploads(
    client: &mut Client,
    pending: &mut Pending,
    uploads: &mut Uploads,
    uploaded: &(dyn Fn(&Upload, Result<String, FileError>) + Sync),
) {
    let Some((service, max)) = uploads.service.clone() else {
        if uploads.searching == 0 {
            for upload in uploads.waiting.drain(..) {
                uploaded(&upload, Err(FileError::NoService));
            }
        }
        return;
    };
    for upload in std::mem::take(&mut uploads.waiting) {
        if let Err(error) = files::check_size(upload.size, max) {
            uploaded(&upload, Err(error));
            continue;
        }
        let request = files::slot_request(&upload.name, upload.size);
        let token = client.send_iq(Some(service.clone()), tokio_xmpp::IqRequest::Get(request.into())).await;
        ask(pending, Asked::Slot(upload.id.clone()), token);
        uploads.asked.insert(upload.id.clone(), upload);
    }
}

/// Puts the file in its place off the reactor, reporting progress about
/// every 256 KB, and hands the outcome back to the session.
fn spawn_put(
    upload: Upload,
    slot: files::Slot,
    options: &Options,
    emit: &Emit,
    account: &str,
    done: tokio::sync::mpsc::UnboundedSender<(Upload, String, Result<(), FileError>)>,
) {
    let roots = options.file_roots.clone();
    let emit = emit.clone();
    let account = account.to_string();
    tokio::task::spawn_blocking(move || {
        let result = files::agent(&roots)
            .map_err(|e| FileError::Network { detail: e.to_string() })
            .and_then(|agent| {
                let mut last = 0u64;
                let total = upload.size;
                files::put(&agent, &slot, &upload.path, &upload.cancel, &mut |sent| {
                    if sent == total || sent - last >= 256 * 1024 {
                        last = sent;
                        emit("chat.progress", json!({ "account": account, "upload_id": upload.id, "done": sent, "total": total }));
                    }
                })
            });
        let _ = done.send((upload, slot.get, result));
    });
}

/// The archive query: everything after the last id known here, or the most
/// recent page when nothing is known yet.
pub fn archive_query(after: Option<String>) -> mam::Query {
    mam::Query {
        queryid: Some(mam::QueryId("oreneta".into())),
        node: None,
        form: None,
        set: Some(SetQuery { max: Some(100), after, before: None, index: None }),
        flip_page: false,
    }
}

/// What one incoming message stanza led to: a delivery receipt to send,
/// when the sender asked for one, and a message to notify about.
#[derive(Debug, Default)]
pub struct Handled {
    pub receipt: Option<Message>,
    pub notify: Option<ChatMessage>,
}

/// Whether a message carries a delay stamp: history a room replays on
/// joining, or what the server kept while we were away.
fn delayed(message: &Message) -> bool {
    message.payloads.iter().any(|p| Delay::try_from(p.clone()).is_ok())
}

/// Records one incoming message stanza. `own_show` is the person's status
/// now: busy holds notifications back.
pub fn handle_message(
    db: &Arc<Mutex<Connection>>,
    account: &str,
    own: &BareJid,
    message: &Message,
    own_show: &str,
    changed: &dyn Fn(&str),
    invited: &dyn Fn(&Invitation, Option<String>),
) -> Handled {
    let mut handled = Handled::default();
    let now = crate::store::now_unix();
    let conn = db.lock().unwrap();
    let nick_in = |jid: &BareJid| super::room_nick(&conn, account, &jid.to_string()).ok().flatten();
    let from = message.from.as_ref().map(|j| j.to_bare());

    // A message that bounced: one of ours did not get there. A private one
    // bounces from `room/nick`; a direct or room one from the bare address.
    if message.type_ == MessageType::Error {
        if let (Some(id), Some(from_full)) = (&message.id, &message.from) {
            for conversation in [super::normalize_conversation(&from_full.to_string()), from_full.to_bare().to_string()] {
                if super::is_ours(&conn, account, &conversation, &id.0).unwrap_or(false) {
                    let _ = super::set_state(&conn, account, &id.0, "failed");
                    changed(&conversation);
                    break;
                }
            }
        }
        return handled;
    }

    // An invitation is kept for the person to answer, nothing more.
    if let Some((invitation, password)) = invitation(message, account, now) {
        if super::save_invitation(&conn, &invitation).unwrap_or(false) {
            invited(&invitation, password);
        }
        return handled;
    }

    let mut wrapped: Option<(Message, Option<String>, i64, Arrival)> = None;
    for payload in &message.payloads {
        // From an archive: the account's, or a room's (then from the room).
        if let Ok(result) = mam::Result_::try_from(payload.clone()) {
            let archive_ok = from.as_ref().is_none_or(|f| f == own || nick_in(f).is_some());
            if archive_ok {
                let stamp = result.forwarded.delay.as_ref().map(|d| d.stamp.0.timestamp()).unwrap_or(now);
                wrapped = Some((result.forwarded.message.clone(), Some(result.id.clone()), stamp, Arrival::Backfill));
            }
        }
        // A copy from another of the person's devices; only our server sends those.
        if from.as_ref().is_none_or(|f| f == own) {
            if let Ok(carbon) = carbons::Received::try_from(payload.clone()) {
                wrapped = Some((carbon.forwarded.message.clone(), None, now, Arrival::Carbon));
            }
            if let Ok(carbon) = carbons::Sent::try_from(payload.clone()) {
                wrapped = Some((carbon.forwarded.message.clone(), None, now, Arrival::Carbon));
            }
        }
        // Someone's client says our message arrived.
        if let Ok(received) = receipts::Received::try_from(payload.clone()) {
            let _ = super::set_state(&conn, account, &received.id, "delivered");
            if let Some(from) = &from {
                changed(&from.to_string());
            }
        }
    }
    let live = wrapped.is_none();
    let (inner, archive_id, stamp, arrival) = wrapped.unwrap_or_else(|| {
        // Live, unless it says it was kept for us (a room's history, offline storage).
        let arrival = if delayed(message) { Arrival::Backfill } else { Arrival::Live };
        (message.clone(), None, now, arrival)
    });
    let notify = |recorded: &ChatMessage| {
        // A conversation the person muted raises nothing (ADR-0064). Should
        // the setting not be readable, the notification is not held back:
        // a missed message is worse than an unwanted popup.
        let muted = super::mute::is_muted(&conn, account, &recorded.conversation).unwrap_or(false);
        presence::should_notify(recorded, arrival, own_show, muted).then(|| recorded.clone())
    };

    // A room's message, live or from its history or archive.
    if inner.type_ == MessageType::Groupchat {
        let Some(room_jid) = inner.from.as_ref().map(|j| j.to_bare()) else { return handled };
        let Some(nick) = nick_in(&room_jid) else { return handled };
        let Some(mut recorded) = interpret_group(&inner, &room_jid, &nick, archive_id, stamp, account) else { return handled };
        // Ours, reflected by the room, even if our nickname changed since.
        if recorded.direction == "in" && super::is_ours(&conn, account, &recorded.conversation, &recorded.id).unwrap_or(false) {
            recorded.direction = "out".into();
            recorded.state = "accepted".into();
        }
        if recorded.direction == "in" {
            recorded.mention = mentions::is_mention(&inner, &recorded.body, own, &room_jid, &nick);
        }
        if super::record(&conn, &recorded).unwrap_or(false) {
            changed(&recorded.conversation);
            handled.notify = notify(&recorded);
        }
        return handled;
    }

    // A private message through a room we are in: to or from `room/nick`.
    let outgoing = inner.from.as_ref().is_none_or(|f| f.to_bare() == *own);
    let counterpart = if outgoing { inner.to.as_ref() } else { inner.from.as_ref() };
    if let Some(counterpart) = counterpart {
        let room_jid = counterpart.to_bare();
        if let Some(nick) = nick_in(&room_jid) {
            // The room itself writing to us directly is not a conversation here.
            if counterpart.resource().is_none() {
                return handled;
            }
            let Some(recorded) = interpret_private(&inner, own, &room_jid, &nick, archive_id, stamp, account) else { return handled };
            if super::record(&conn, &recorded).unwrap_or(false) {
                changed(&recorded.conversation);
                handled.notify = notify(&recorded);
            }
            return handled;
        }
    }

    let Some(recorded) = interpret(&inner, own, archive_id, stamp, account) else { return handled };
    if super::record(&conn, &recorded).unwrap_or(false) {
        changed(&recorded.conversation);
        handled.notify = notify(&recorded);
    }
    // A receipt only for a live message to us that asks for one.
    let asked = inner.payloads.iter().any(|p| receipts::Request::try_from(p.clone()).is_ok());
    if live && asked && recorded.direction == "in" {
        let mut receipt = Message::new(inner.from.clone());
        receipt.payloads.push(receipts::Received { id: recorded.id.clone() }.into());
        handled.receipt = Some(receipt);
    }
    handled
}

/// The connection settings for an account.
pub fn connector(account: &ChatAccount, plain_loopback: bool) -> Result<Connector> {
    let host = if account.host.trim().is_empty() {
        account.jid.split_once('@').map(|(_, d)| d.to_string()).context("no server in the address")?
    } else {
        account.host.trim().to_string()
    };
    Ok(Connector {
        host,
        port: account.port,
        proxy: crate::proxy::global()?,
        cert_pin: None,
        plain_loopback,
    })
}
