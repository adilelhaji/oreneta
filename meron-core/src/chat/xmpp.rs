//! The XMPP side of chat (ADR-0036): the connection, and what each stanza
//! means for the store.
//!
//! The connection is the app's own (`crate::tls`): the account's proxy and
//! certificate pin apply, TLS is negotiated with STARTTLS, and a server that
//! does not offer it is not sent the password. Signing in (SASL), stream
//! management and stanzas come from `tokio-xmpp` and `xmpp-parsers`.

use super::{ChatAccount, ChatMessage};
use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tokio::io::BufStream;
use tokio_xmpp::connect::ServerConnector;
use tokio_xmpp::parsers::{
    carbons, delay::Delay, jid::BareJid, jid::Jid, mam, message::Message, message::MessageType,
    presence::Presence, receipts, rsm::SetQuery, stanza_id::OriginId, stanza_id::StanzaId,
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

/// A message's meaning for the store, from a live stanza, a carbon copy or
/// the archive. `own` is the account's bare address.
pub fn interpret(message: &Message, own: &BareJid, archive_id: Option<String>, stamp: i64, account: &str) -> Option<ChatMessage> {
    if !matches!(message.type_, MessageType::Chat | MessageType::Normal) {
        return None;
    }
    let body = message.bodies.get("").or_else(|| message.bodies.values().next())?.clone();
    if body.trim().is_empty() {
        return None;
    }
    let from = message.from.as_ref().map(|j| j.to_bare());
    let to = message.to.as_ref().map(|j| j.to_bare());
    let outgoing = from.as_ref().is_none_or(|f| f == own);
    let other = if outgoing { to? } else { from? };
    let mut origin = None;
    let mut archived = archive_id;
    let mut when = stamp;
    for payload in &message.payloads {
        if let Ok(o) = OriginId::try_from(payload.clone()) {
            origin = Some(o.id);
        } else if let Ok(s) = StanzaId::try_from(payload.clone()) {
            // Only the archive id our own server stamped counts.
            if archived.is_none() && s.by.to_bare() == *own {
                archived = Some(s.id);
            }
        } else if let Ok(d) = Delay::try_from(payload.clone()) {
            when = d.stamp.0.timestamp();
        }
    }
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
    })
}

/// A chat message to send: its id is also its origin-id, so every copy of it
/// anywhere is known as the same message, and a delivery receipt is asked.
pub fn outgoing(to: &BareJid, id: &str, body: &str) -> Message {
    let mut message = Message::new(Some(Jid::from(to.clone())));
    message.type_ = MessageType::Chat;
    message.id = Some(tokio_xmpp::parsers::message::Id(id.into()));
    message.bodies.insert(tokio_xmpp::parsers::message::Lang::default(), body.into());
    message.payloads.push(OriginId { id: id.into() }.into());
    message.payloads.push(receipts::Request.into());
    message
}

// ---- The session --------------------------------------------------------------------------

pub enum Command {
    Send { conversation: String, id: String, body: String },
    Stop,
}

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Runs one account's connection until stopped: catches up from the archive
/// when online, records what arrives, sends what is asked.
pub async fn run(
    account: ChatAccount,
    password: String,
    db: Arc<Mutex<Connection>>,
    connector: Connector,
    mut commands: tokio::sync::mpsc::UnboundedReceiver<Command>,
    emit: Emit,
) {
    let own = match BareJid::from_str(&account.jid) {
        Ok(j) => j,
        Err(e) => {
            emit("chat.status", json!({ "account": account.id, "state": "error", "message": e.to_string() }));
            return;
        }
    };
    let mut client = Client::new_with_connector(own.clone(), password, connector, Timeouts::default());
    let mut mam: Option<tokio_xmpp::IqResponseToken> = None;
    let changed = |conversation: &str| emit("chat.changed", json!({ "account": account.id, "conversation": conversation }));
    loop {
        tokio::select! {
            event = client.next() => {
                let Some(event) = event else { break };
                match event {
                    Event::Online { .. } => {
                        // Whatever was in flight when the connection went is now
                        // uncertain; the archive settles what the server got.
                        if let Ok(n) = super::after_disconnect(&db.lock().unwrap(), &account.id) {
                            if n > 0 { changed(""); }
                        }
                        emit("chat.status", json!({ "account": account.id, "state": "online" }));
                        let _ = client.send_stanza(Presence::available().into()).await;
                        let _ = client.send_iq(None, tokio_xmpp::IqRequest::Set(carbons::Enable.into())).await;
                        let after = super::last_archive_id(&db.lock().unwrap(), &account.id).ok().flatten();
                        mam = Some(client.send_iq(None, tokio_xmpp::IqRequest::Set(archive_query(after).into())).await);
                    }
                    Event::Disconnected(error) => {
                        let _ = super::after_disconnect(&db.lock().unwrap(), &account.id);
                        emit("chat.status", json!({ "account": account.id, "state": "offline", "message": error.to_string() }));
                    }
                    Event::Stanza(Stanza::Message(message)) => {
                        let reply = handle_message(&db, &account.id, &own, &message, &changed);
                        if let Some(receipt) = reply {
                            let _ = client.send_stanza(receipt.into()).await;
                        }
                    }
                    Event::Stanza(_) => {}
                }
            }
            answer = async { mam.as_mut().unwrap().await }, if mam.is_some() => {
                mam = None;
                // Page after page until the archive says it is done.
                if let Ok(tokio_xmpp::IqResponse::Result(Some(element))) = answer {
                    if let Ok(fin) = mam::Fin::try_from(element) {
                        if !fin.complete {
                            if let Some(last) = fin.set.last {
                                mam = Some(client.send_iq(None, tokio_xmpp::IqRequest::Set(archive_query(Some(last)).into())).await);
                            }
                        }
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    None | Some(Command::Stop) => break,
                    Some(Command::Send { conversation, id, body }) => {
                        let Ok(to) = BareJid::from_str(&conversation) else { continue };
                        match client.send_stanza(outgoing(&to, &id, &body).into()).await {
                            Ok(mut token) => {
                                let _ = super::set_state(&db.lock().unwrap(), &account.id, &id, "sent");
                                changed(&conversation);
                                // The server's word (XEP-0198), when the stream has it.
                                let db = db.clone();
                                let emit = emit.clone();
                                let account_id = account.id.clone();
                                tokio::spawn(async move {
                                    if let Some(tokio_xmpp::stanzastream::StanzaState::Acked { .. }) =
                                        token.wait_for(tokio_xmpp::stanzastream::StanzaStage::Acked).await
                                    {
                                        let _ = super::set_state(&db.lock().unwrap(), &account_id, &id, "accepted");
                                        emit("chat.changed", json!({ "account": account_id, "conversation": conversation }));
                                    }
                                });
                            }
                            Err(_) => {
                                let _ = super::set_state(&db.lock().unwrap(), &account.id, &id, "failed");
                                changed(&conversation);
                            }
                        }
                    }
                }
            }
        }
    }
    let _ = client.send_end().await;
    emit("chat.status", json!({ "account": account.id, "state": "stopped" }));
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
) -> Option<Message> {
    let now = crate::store::now_unix();
    let conn = db.lock().unwrap();
    let mut wrapped: Option<(Message, Option<String>, i64)> = None;
    for payload in &message.payloads {
        // From the archive.
        if let Ok(result) = mam::Result_::try_from(payload.clone()) {
            let stamp = result.forwarded.delay.as_ref().map(|d| d.stamp.0.timestamp()).unwrap_or(now);
            wrapped = Some((result.forwarded.message.clone(), Some(result.id.clone()), stamp));
        }
        // A copy from another of the person's devices.
        if let Ok(carbon) = carbons::Received::try_from(payload.clone()) {
            wrapped = Some((carbon.forwarded.message.clone(), None, now));
        }
        if let Ok(carbon) = carbons::Sent::try_from(payload.clone()) {
            wrapped = Some((carbon.forwarded.message.clone(), None, now));
        }
        // Someone's client says our message arrived.
        if let Ok(received) = receipts::Received::try_from(payload.clone()) {
            let _ = super::set_state(&conn, account, &received.id, "delivered");
            if let Some(from) = &message.from {
                changed(&from.to_bare().to_string());
            }
        }
    }
    let live = wrapped.is_none();
    let (inner, archive_id, stamp) = wrapped.unwrap_or((message.clone(), None, now));
    let recorded = interpret(&inner, own, archive_id, stamp, account)?;
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
        proxy: crate::proxy::global(),
        cert_pin: None,
        plain_loopback,
    })
}
