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

use super::files::{self, FileError};
use super::{ChatAccount, ChatMessage, Invitation, KIND_CHAT, KIND_GROUP};
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

/// Joining a room (or joining it again): with its password if it has one,
/// and asking only for what was said since the newest message kept here, or
/// the last 50 when nothing is.
pub fn join_presence(room: &BareJid, nick: &str, password: Option<&str>, since: Option<i64>) -> Result<Presence> {
    let to = room.with_resource_str(nick).context("this nickname cannot be used in a room")?;
    let history = match since.and_then(|s| chrono::DateTime::from_timestamp(s, 0)) {
        Some(at) => History::new().with_since(tokio_xmpp::parsers::date::DateTime(at.fixed_offset())),
        None => History::new().with_maxstanzas(50),
    };
    let mut muc = Muc::new().with_history(history);
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        muc = muc.with_password(password.to_string());
    }
    Ok(Presence::available().with_to(to).with_payload(muc))
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
    Send { conversation: String, id: String, body: String, group: bool, file: Option<String> },
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
}

impl Default for Options {
    fn default() -> Self {
        Options { room_password: Arc::new(|_| None), file_roots: Vec::new() }
    }
}

/// What an answer to one of our questions (iq) is about.
enum Asked {
    Mam(Option<String>),
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
                        let _ = client.send_stanza(Presence::available().into()).await;
                        let _ = client.send_iq(None, tokio_xmpp::IqRequest::Set(carbons::Enable.into())).await;
                        let after = super::last_archive_id(&db.lock().unwrap(), &account.id).ok().flatten();
                        let token = client.send_iq(None, tokio_xmpp::IqRequest::Set(archive_query(after).into())).await;
                        ask(&pending, Asked::Mam(None), token);
                        // A resumed stream is still in its rooms; a new one joins them again.
                        if !resumed {
                            let rooms = super::rooms(&db.lock().unwrap(), &account.id).unwrap_or_default();
                            for room in rooms {
                                let password = if room.has_password { (options.room_password)(&room.room) } else { None };
                                join(&mut client, &db, &account.id, &room.room, &room.nick, password.as_deref(), &room_state).await;
                            }
                        }
                    }
                    Event::Disconnected(error) => {
                        let _ = super::after_disconnect(&db.lock().unwrap(), &account.id);
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
                        let reply = handle_message(&db, &account.id, &own, &message, &changed, &invited);
                        if let Some(receipt) = reply {
                            let _ = client.send_stanza(receipt.into()).await;
                        }
                    }
                    Event::Stanza(Stanza::Presence(presence)) => {
                        let Some(from) = presence.from.as_ref().map(|j| j.to_bare()) else { continue };
                        let room = from.to_string();
                        if super::room(&db.lock().unwrap(), &account.id, &room).ok().flatten().is_none() { continue }
                        match room_presence(&presence) {
                            Some(RoomPresence::Joined { created }) => {
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
                            Some(RoomPresence::Out) => room_state(&room, "out", Value::Null),
                            Some(RoomPresence::Error { condition, message }) => {
                                room_state(&room, "error", json!({ "condition": condition, "message": message }))
                            }
                            None => {}
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
                        let sender = if upload.group {
                            super::room(&db.lock().unwrap(), &account.id, &upload.conversation).ok().flatten().map(|r| r.nick).unwrap_or_default()
                        } else {
                            own.to_string()
                        };
                        let mut message = ChatMessage::chat(&account.id, &upload.conversation, &id, "out", &sender, &link, crate::store::now_unix(), "sending");
                        message.kind = if upload.group { KIND_GROUP } else { KIND_CHAT }.into();
                        message.file_url = Some(link.clone());
                        message.file_name = Some(upload.name.clone());
                        message.file_size = Some(upload.size as i64);
                        let queued = super::queue_message(&db.lock().unwrap(), &message);
                        match queued {
                            Err(error) => uploaded(&upload, Err(FileError::File { detail: error.to_string() })),
                            Ok(()) => {
                                deliver(&mut client, &db, &account.id, &emit, &upload.conversation, &id, &link, upload.group, Some(&link)).await;
                                uploaded(&upload, Ok(id));
                            }
                        }
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    None | Some(Command::Stop) => break,
                    Some(Command::Send { conversation, id, body, group, file }) => {
                        deliver(&mut client, &db, &account.id, &emit, &conversation, &id, &body, group, file.as_deref()).await;
                    }
                    Some(Command::Join { room, nick, password }) => {
                        join(&mut client, &db, &account.id, &room, &nick, password.as_deref(), &room_state).await;
                    }
                    Some(Command::Leave { room, nick }) => {
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
    emit("chat.status", json!({ "account": account.id, "state": "stopped" }));
}

/// Joins a room, asking for what was said since the newest message kept.
async fn join(
    client: &mut Client,
    db: &Arc<Mutex<Connection>>,
    account: &str,
    room: &str,
    nick: &str,
    password: Option<&str>,
    room_state: &(dyn Fn(&str, &str, Value) + Sync),
) {
    let Ok(jid) = BareJid::from_str(room) else { return };
    let since = super::last_room_stamp(&db.lock().unwrap(), account, room).ok().flatten();
    match join_presence(&jid, nick, password, since) {
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
) {
    let changed = |c: &str| emit("chat.changed", json!({ "account": account, "conversation": c }));
    let Ok(to) = BareJid::from_str(conversation) else {
        let _ = super::set_state(&db.lock().unwrap(), account, id, "failed");
        changed(conversation);
        return;
    };
    match client.send_stanza(outgoing_message(&to, id, body, group, file).into()).await {
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

/// Records one incoming message stanza; returns a delivery receipt to send,
/// when the sender asked for one.
fn handle_message(
    db: &Arc<Mutex<Connection>>,
    account: &str,
    own: &BareJid,
    message: &Message,
    changed: &dyn Fn(&str),
    invited: &dyn Fn(&Invitation, Option<String>),
) -> Option<Message> {
    let now = crate::store::now_unix();
    let conn = db.lock().unwrap();
    let joined = |jid: &BareJid| super::room(&conn, account, &jid.to_string()).ok().flatten();
    let from = message.from.as_ref().map(|j| j.to_bare());

    // A message that bounced: one of ours did not get there.
    if message.type_ == MessageType::Error {
        if let (Some(id), Some(from)) = (&message.id, &from) {
            if super::is_ours(&conn, account, &from.to_string(), &id.0).unwrap_or(false) {
                let _ = super::set_state(&conn, account, &id.0, "failed");
                changed(&from.to_string());
            }
        }
        return None;
    }

    // An invitation is kept for the person to answer, nothing more.
    if let Some((invitation, password)) = invitation(message, account, now) {
        if super::save_invitation(&conn, &invitation).unwrap_or(false) {
            invited(&invitation, password);
        }
        return None;
    }

    let mut wrapped: Option<(Message, Option<String>, i64)> = None;
    for payload in &message.payloads {
        // From an archive: the account's, or a room's (then from the room).
        if let Ok(result) = mam::Result_::try_from(payload.clone()) {
            let archive_ok = from.as_ref().is_none_or(|f| f == own || joined(f).is_some());
            if archive_ok {
                let stamp = result.forwarded.delay.as_ref().map(|d| d.stamp.0.timestamp()).unwrap_or(now);
                wrapped = Some((result.forwarded.message.clone(), Some(result.id.clone()), stamp));
            }
        }
        // A copy from another of the person's devices; only our server sends those.
        if from.as_ref().is_none_or(|f| f == own) {
            if let Ok(carbon) = carbons::Received::try_from(payload.clone()) {
                wrapped = Some((carbon.forwarded.message.clone(), None, now));
            }
            if let Ok(carbon) = carbons::Sent::try_from(payload.clone()) {
                wrapped = Some((carbon.forwarded.message.clone(), None, now));
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
    let (inner, archive_id, stamp) = wrapped.unwrap_or((message.clone(), None, now));

    // A room's message, live or from its history or archive.
    if inner.type_ == MessageType::Groupchat {
        let room_jid = inner.from.as_ref().map(|j| j.to_bare())?;
        let room = joined(&room_jid)?;
        let mut recorded = interpret_group(&inner, &room_jid, &room.nick, archive_id, stamp, account)?;
        // Ours, reflected by the room, even if our nickname changed since.
        if recorded.direction == "in" && super::is_ours(&conn, account, &recorded.conversation, &recorded.id).unwrap_or(false) {
            recorded.direction = "out".into();
            recorded.state = "accepted".into();
        }
        if super::record(&conn, &recorded).unwrap_or(false) {
            changed(&recorded.conversation);
        }
        return None;
    }

    let recorded = interpret(&inner, own, archive_id, stamp, account)?;
    // Private messages through a room are not taken in yet.
    if BareJid::from_str(&recorded.conversation).ok().is_some_and(|c| joined(&c).is_some()) {
        return None;
    }
    if super::record(&conn, &recorded).unwrap_or(false) {
        changed(&recorded.conversation);
    }
    // A receipt only for a live message to us that asks for one.
    let asked = inner.payloads.iter().any(|p| receipts::Request::try_from(p.clone()).is_ok());
    if live && asked && recorded.direction == "in" {
        let mut receipt = Message::new(inner.from.clone());
        receipt.payloads.push(receipts::Received { id: recorded.id.clone() }.into());
        return Some(receipt);
    }
    None
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
