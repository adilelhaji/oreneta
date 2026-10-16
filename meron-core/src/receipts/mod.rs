//! Read receipts (SET-11, #107, ADR-0048).
//!
//! A message can ask to be told when it is read: `Disposition-Notification-To`
//! (RFC 8098). Answering says, to whoever asked, that this person opened it
//! and roughly when, which is exactly what tracking protection exists to keep
//! to themselves. So nothing here sends a receipt unless the person clicked
//! "Send receipt" for that message, or chose "always" in settings; and even
//! "always" never answers on its own for mail from a list, mail whose return
//! path is not where the receipt would go (RFC 8098 §2.1), or mail in Junk.
//! Each message is answered once: the answer, either way, is remembered.
//!
//! This module reads the request out of a message, decides what to do with
//! it, builds the report (`multipart/report`, RFC 8098 §3) and sends it
//! through the account that received the message. Asking for receipts on
//! outgoing mail lives with sending, in [`crate::smtp`] and each protocol's
//! own send; the rule they share is [`delivery_receipt`]. Reading the
//! delivery and read reports that come back is [`report`] (ADR-0057).

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use mail_builder::headers::content_type::ContentType;
use mail_builder::headers::text::Text;
use mail_builder::mime::MimePart;
use mail_builder::MessageBuilder;
use mailparse::{MailHeaderMap as _, ParsedMail};
use serde::{Deserialize, Serialize};

pub mod report;
#[cfg(test)]
mod tests;

/// The settings row holding the answering policy ("ask", "always", "never").
pub const POLICY_SETTING: &str = "read_receipt_policy";

/// What to do when a message asks for a read receipt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Ask each time, in the reader. The default.
    #[default]
    Ask,
    /// Send without asking, where that is safe; ask otherwise.
    Always,
    /// Never send, never ask.
    Never,
}

impl Policy {
    /// Anything not recognised is "ask": a stored value from another
    /// version must never turn into sending.
    pub fn parse(value: &str) -> Policy {
        match value.trim().to_ascii_lowercase().as_str() {
            "always" => Policy::Always,
            "never" => Policy::Never,
            _ => Policy::Ask,
        }
    }
}

/// The policy the person chose, from the settings table.
pub fn policy(conn: &rusqlite::Connection) -> Policy {
    crate::store::settings_get(conn, &[POLICY_SETTING.to_string()])
        .ok()
        .and_then(|prefs| prefs.get(POLICY_SETTING).and_then(serde_json::Value::as_str).map(Policy::parse))
        .unwrap_or_default()
}

/// A read receipt request, as read from the message that carries it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptRequest {
    /// Where the receipt would go: the `Disposition-Notification-To`
    /// addresses, bare and lower-cased.
    pub notify_to: Vec<String>,
    /// The `Return-Path` address, bare and lower-cased; empty when absent.
    #[serde(default)]
    pub return_path: String,
    /// Whether the message came through a mailing list (or says it is bulk).
    #[serde(default)]
    pub list: bool,
    /// The `Original-Recipient` field the receiving server added, verbatim
    /// (`rfc822;addr`), echoed in the report when present (RFC 8098 §3.2.3).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub original_recipient: String,
}

fn bare(value: &str) -> String {
    let value = value.trim();
    let value = match (value.find('<'), value.rfind('>')) {
        (Some(start), Some(end)) if end > start => &value[start + 1..end],
        _ => value,
    };
    value.trim().to_lowercase()
}

/// Every address in a header field, bare and lower-cased, groups flattened.
fn bare_addresses(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(list) = mailparse::addrparse(raw) {
        for entry in list.iter() {
            match entry {
                mailparse::MailAddr::Single(info) => out.push(info.addr.trim().to_lowercase()),
                mailparse::MailAddr::Group(group) => {
                    out.extend(group.addrs.iter().map(|info| info.addr.trim().to_lowercase()))
                }
            }
        }
    }
    out.retain(|addr| !addr.is_empty());
    out
}

fn domain_of(addr: &str) -> &str {
    addr.rsplit_once('@').map(|(_, domain)| domain).unwrap_or("")
}

/// The read receipt request a message carries, if any.
///
/// A report is never answered (RFC 8098 §3: no MDN about an MDN, and a
/// bounce is no person's message), nor is a request with no usable address.
pub fn request_of(mail: &ParsedMail) -> Option<ReceiptRequest> {
    if mail.ctype.mimetype.eq_ignore_ascii_case("multipart/report") {
        return None;
    }
    let raw = mail.headers.get_all_values("Disposition-Notification-To").join(", ");
    if raw.trim().is_empty() {
        return None;
    }
    let mut notify_to: Vec<String> = bare_addresses(&raw).into_iter().filter(|addr| addr.contains('@')).collect();
    notify_to.dedup();
    if notify_to.is_empty() {
        return None;
    }
    let return_path = mail.headers.get_first_value("Return-Path").map(|value| bare(&value)).unwrap_or_default();
    let precedence = mail.headers.get_first_value("Precedence").unwrap_or_default().trim().to_ascii_lowercase();
    let list = ["List-Id", "List-Post", "List-Unsubscribe"]
        .iter()
        .any(|name| mail.headers.get_first_value(name).is_some())
        || precedence == "list"
        || precedence == "bulk"
        || precedence == "junk";
    let original_recipient = mail
        .headers
        .get_first_value("Original-Recipient")
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    Some(ReceiptRequest { notify_to, return_path, list, original_recipient })
}

/// Why a receipt is not sent without asking, even under "always".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Caution {
    /// The message came through a mailing list: a receipt would tell the
    /// list, or whoever runs it, rather than one person.
    MailingList,
    /// The receipt would go to a domain other than the one the message came
    /// back from, or there is no return path to compare (RFC 8098 §2.1).
    AddressMismatch,
}

/// Whether this request is one to answer only when asked.
pub fn caution(request: &ReceiptRequest) -> Option<Caution> {
    if request.list {
        return Some(Caution::MailingList);
    }
    let return_domain = domain_of(&request.return_path);
    if return_domain.is_empty() || request.notify_to.iter().any(|addr| domain_of(addr) != return_domain) {
        return Some(Caution::AddressMismatch);
    }
    None
}

/// How a request was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Sent,
    Declined,
}

impl Answer {
    fn as_str(self) -> &'static str {
        match self {
            Answer::Sent => "sent",
            Answer::Declined => "declined",
        }
    }
}

/// Why nothing is shown and nothing is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Silence {
    /// The person chose never to send receipts.
    Never,
    /// The message is in Junk: answering would confirm the address works.
    Junk,
    /// The message has no Message-ID, so an answer could not be remembered
    /// and a receipt could not name it.
    Unidentified,
}

/// What to do about one message's request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The message does not ask.
    NotRequested,
    /// It was answered before, and is not asked about again.
    Answered(Answer),
    /// Neither asked nor sent.
    Silent(Silence),
    /// Put to the person, with the reason "always" did not apply, if any.
    Ask(Option<Caution>),
    /// "Always", and nothing makes it unsafe: send without asking.
    SendAutomatically,
}

/// The decision, from what is known about the message. Pure, so every rule
/// is tested on its own.
pub fn decide(
    policy: Policy,
    request: Option<&ReceiptRequest>,
    message_id: &str,
    in_junk: bool,
    answered: Option<Answer>,
) -> Verdict {
    let Some(request) = request else { return Verdict::NotRequested };
    if let Some(answer) = answered {
        return Verdict::Answered(answer);
    }
    if key(message_id).is_empty() {
        return Verdict::Silent(Silence::Unidentified);
    }
    if in_junk {
        return Verdict::Silent(Silence::Junk);
    }
    match (policy, caution(request)) {
        (Policy::Never, _) => Verdict::Silent(Silence::Never),
        (_, Some(caution)) => Verdict::Ask(Some(caution)),
        (Policy::Always, None) => Verdict::SendAutomatically,
        (Policy::Ask, None) => Verdict::Ask(None),
    }
}

/// What becomes of a delivery receipt request on one send (ADR-0048,
/// ADR-0057): the server is asked only when the sender wants a receipt and
/// the route can carry the request (SMTP that offers DSN; Graph with both
/// `Mail.Send` and `Mail.ReadWrite`). Otherwise the message goes without
/// one, and the sender is told it was not requested.
pub fn delivery_receipt(asked: bool, route_carries: bool) -> crate::smtp::DeliveryReceipt {
    match (asked, route_carries) {
        (false, _) => crate::smtp::DeliveryReceipt::NotAsked,
        (true, true) => crate::smtp::DeliveryReceipt::Requested,
        (true, false) => crate::smtp::DeliveryReceipt::Unsupported,
    }
}

// ---- Answers, remembered per message ---------------------------------------

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS receipt_answers (
  account     TEXT NOT NULL,
  message_id  TEXT NOT NULL,   -- lower case, no angle brackets
  answer      TEXT NOT NULL,   -- 'sent' or 'declined'
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (account, message_id)
);
";

fn key(message_id: &str) -> String {
    message_id.trim().trim_start_matches('<').trim_end_matches('>').trim().to_lowercase()
}

/// How this message's request was answered, if it was.
pub fn answered(conn: &rusqlite::Connection, account: &str, message_id: &str) -> Result<Option<Answer>> {
    use rusqlite::OptionalExtension as _;
    let stored: Option<String> = conn
        .query_row(
            "SELECT answer FROM receipt_answers WHERE account = ?1 AND message_id = ?2",
            rusqlite::params![account, key(message_id)],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored.map(|answer| if answer == "sent" { Answer::Sent } else { Answer::Declined }))
}

/// Records an answer unless there is one already; true when this call
/// recorded it. A receipt is claimed this way before it is sent, so two
/// readers of the same message cannot both send one.
pub fn claim(conn: &rusqlite::Connection, account: &str, message_id: &str, answer: Answer, now: i64) -> Result<bool> {
    let key = key(message_id);
    if key.is_empty() {
        bail!("this message has no Message-ID, so a receipt could not name it");
    }
    let changed = conn.execute(
        "INSERT OR IGNORE INTO receipt_answers(account, message_id, answer, answered_at) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![account, key, answer.as_str(), now],
    )?;
    Ok(changed > 0)
}

/// Takes back a claim whose receipt was refused by the server, so the
/// person can be asked again rather than told it went.
pub fn release(conn: &rusqlite::Connection, account: &str, message_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM receipt_answers WHERE account = ?1 AND message_id = ?2",
        rusqlite::params![account, key(message_id)],
    )?;
    Ok(())
}

// ---- The report --------------------------------------------------------------

/// Whether the person sent the receipt, or the "always" setting did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Manual,
    Automatic,
}

/// What a read receipt says, and to whom.
#[derive(Debug, Clone)]
pub struct Mdn<'a> {
    /// The person's name, for the From header.
    pub from_name: &'a str,
    /// The address the message was delivered to: From of the receipt, and
    /// its Final-Recipient.
    pub from_addr: &'a str,
    /// Where the receipt goes: the request's addresses.
    pub to: &'a [String],
    pub original_message_id: &'a str,
    pub original_subject: &'a str,
    /// The `Original-Recipient` field to echo, or empty.
    pub original_recipient: &'a str,
    pub mode: Mode,
}

/// One field of the notification, folded at whitespace before 78 columns
/// (RFC 5322 §2.2.3: the report's fields follow header syntax).
fn field(name: &str, value: &str) -> String {
    let mut out = format!("{name}:");
    let mut column = out.len();
    for word in value.split_whitespace() {
        if column + 1 + word.len() > 78 && column > name.len() + 1 {
            out.push_str("\r\n");
            column = 0;
        }
        out.push(' ');
        out.push_str(word);
        column += 1 + word.len();
    }
    out.push_str("\r\n");
    out
}

/// The machine-readable part (RFC 8098 §3.1): who reports, for whom, about
/// which message, and what happened to it ("displayed").
pub fn notification_fields(mdn: &Mdn) -> String {
    let mut out = String::new();
    out.push_str(&field("Reporting-UA", "Oreneta"));
    if !mdn.original_recipient.trim().is_empty() {
        out.push_str(&field("Original-Recipient", mdn.original_recipient.trim()));
    }
    out.push_str(&field("Final-Recipient", &format!("rfc822;{}", mdn.from_addr.trim())));
    out.push_str(&field("Original-Message-ID", &format!("<{}>", key_case_kept(mdn.original_message_id))));
    let disposition = match mdn.mode {
        Mode::Manual => "manual-action/MDN-sent-manually; displayed",
        Mode::Automatic => "automatic-action/MDN-sent-automatically; displayed",
    };
    out.push_str(&field("Disposition", disposition));
    out
}

fn key_case_kept(message_id: &str) -> String {
    message_id.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string()
}

/// The read receipt as a whole message: `multipart/report;
/// report-type=disposition-notification`, a sentence for a person to read,
/// then the notification itself (RFC 8098 §3).
pub fn build_mdn(mdn: &Mdn) -> Result<Vec<u8>> {
    if mdn.to.is_empty() {
        bail!("a read receipt needs somewhere to go");
    }
    let original_id = key_case_kept(mdn.original_message_id);
    if original_id.is_empty() {
        bail!("a read receipt must name the message it is about");
    }
    let from_addr = mdn.from_addr.trim();
    let subject = mdn.original_subject.trim();
    let human = format!(
        "This is a receipt for the message you sent to {from_addr}{}.\r\n\r\n\
         It only means the message was shown on the recipient's screen. It does not \
         mean it was read or understood.\r\n",
        if subject.is_empty() { String::new() } else { format!(" with the subject \"{subject}\"") },
    );
    let fields = notification_fields(mdn);
    // The fields are ASCII unless an address is not (RFC 6533, then the
    // global variant, in 8bit); either way they are written as they are,
    // never quoted-printable or base64 (RFC 2046 §5.2.4 for message/*).
    let (notification_type, encoding) = if fields.is_ascii() {
        ("message/disposition-notification", "7bit")
    } else {
        ("message/global-disposition-notification", "8bit")
    };
    let report = MimePart::new(
        ContentType::new("multipart/report").attribute("report-type", "disposition-notification"),
        vec![
            MimePart::new(ContentType::new("text/plain").attribute("charset", "utf-8"), human),
            MimePart::new(ContentType::new(notification_type), fields.into_bytes())
                .transfer_encoding(encoding),
        ],
    );
    let domain = domain_of(from_addr);
    let mut builder = MessageBuilder::new()
        .from((mdn.from_name.trim(), from_addr))
        .to(mdn.to.iter().map(String::as_str).collect::<Vec<_>>())
        .subject(format!("Read: {subject}"))
        .message_id(format!("{}@{}", uuid::Uuid::new_v4(), if domain.is_empty() { "localhost" } else { domain }))
        .in_reply_to(original_id.as_str())
        .references(original_id.as_str())
        .body(report);
    if mdn.mode == Mode::Automatic {
        // RFC 3834: no other responder should answer this one.
        builder = builder.header("Auto-Submitted", Text::new("auto-replied"));
    }
    builder.write_to_vec().context("build read receipt")
}

// ---- Asked by the reader -----------------------------------------------------

/// Where one message's request stands, for the reader.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// "none", "ask", "sent", "declined" or "silent".
    pub state: &'static str,
    /// Why "always" did not apply, when asking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caution: Option<Caution>,
    /// Why nothing is shown, when silent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silence: Option<Silence>,
    /// Where a receipt would go.
    pub to: Vec<String>,
    /// True when this very call sent it, under "always".
    pub automatic: bool,
}

/// The message as cached, and what is known around it.
struct Facts {
    message: crate::parse::Message,
    in_junk: bool,
    answered: Option<Answer>,
    policy: Policy,
}

async fn facts(engine: &Arc<crate::engine::Engine>, account: &str, folder: &str, uid: u32) -> Result<Facts> {
    let message = crate::engine::read_cached_or_fetch(engine, account, folder, uid).await?;
    let db = engine.db.lock().unwrap();
    let in_junk = crate::store::folder_role(&db, account, folder).map(|role| role == "junk").unwrap_or(false);
    let answered = answered(&db, account, &message.message_id)?;
    Ok(Facts { message, in_junk, answered, policy: policy(&db) })
}

/// What the reader should show for this message, sending the receipt first
/// when the person chose "always" and nothing makes that unsafe.
pub async fn status(engine: &Arc<crate::engine::Engine>, account: &str, folder: &str, uid: u32, now: i64) -> Result<Status> {
    let facts = facts(engine, account, folder, uid).await?;
    let request = facts.message.receipt.clone();
    let to = request.as_ref().map(|r| r.notify_to.clone()).unwrap_or_default();
    let verdict = decide(facts.policy, request.as_ref(), &facts.message.message_id, facts.in_junk, facts.answered);
    let status = |state, caution, silence, automatic| Status { state, caution, silence, to: to.clone(), automatic };
    Ok(match verdict {
        Verdict::NotRequested => status("none", None, None, false),
        Verdict::Answered(Answer::Sent) => status("sent", None, None, false),
        Verdict::Answered(Answer::Declined) => status("declined", None, None, false),
        Verdict::Silent(silence) => status("silent", None, Some(silence), false),
        Verdict::Ask(caution) => status("ask", caution, None, false),
        Verdict::SendAutomatically => {
            match send(engine, account, &facts.message, Mode::Automatic, now).await? {
                true => status("sent", None, None, true),
                // Someone else answered in the meantime; say what was.
                false => {
                    let answer = answered(&engine.db.lock().unwrap(), account, &facts.message.message_id)?;
                    status(if answer == Some(Answer::Declined) { "declined" } else { "sent" }, None, None, false)
                }
            }
        }
    })
}

/// The person's answer from the reader bar: send the receipt, or not.
/// Answered once: a message already answered is left as it is.
pub async fn answer(
    engine: &Arc<crate::engine::Engine>,
    account: &str,
    folder: &str,
    uid: u32,
    send_it: bool,
    now: i64,
) -> Result<Status> {
    let facts = facts(engine, account, folder, uid).await?;
    let Some(request) = facts.message.receipt.clone() else {
        bail!("this message did not ask for a read receipt");
    };
    let to = request.notify_to.clone();
    if facts.answered.is_none() {
        if send_it {
            send(engine, account, &facts.message, Mode::Manual, now).await?;
        } else {
            claim(&engine.db.lock().unwrap(), account, &facts.message.message_id, Answer::Declined, now)?;
        }
    }
    let answer = answered(&engine.db.lock().unwrap(), account, &facts.message.message_id)?;
    Ok(Status {
        state: match answer {
            Some(Answer::Sent) => "sent",
            Some(Answer::Declined) => "declined",
            None => "ask",
        },
        caution: None,
        silence: None,
        to,
        automatic: false,
    })
}

/// The address this account received the message at: one of its own that
/// the message was addressed to, else the account's own.
fn receiving_address(conn: &rusqlite::Connection, account: &str, login: &str, message: &crate::parse::Message) -> Result<(String, String)> {
    let mine = crate::store::self_addrs(conn, account);
    let addressed: Vec<String> = [message.to.as_str(), message.cc.as_str()]
        .iter()
        .flat_map(|field| bare_addresses(field))
        .collect();
    let chosen = addressed.into_iter().find(|addr| mine.contains(addr)).unwrap_or_default();
    crate::store::resolve_send_from(conn, account, login, &chosen)
        .or_else(|_| crate::store::resolve_send_from(conn, account, login, ""))
}

/// Claims, builds and sends one receipt through the account that received
/// the message. False when the message was already answered. A refusal
/// releases the claim, so the person can be asked again; a send whose
/// outcome is unknown keeps it, so no second receipt follows.
async fn send(
    engine: &Arc<crate::engine::Engine>,
    account: &str,
    message: &crate::parse::Message,
    mode: Mode,
    now: i64,
) -> Result<bool> {
    let Some(request) = message.receipt.as_ref() else {
        bail!("this message did not ask for a read receipt");
    };
    if !claim(&engine.db.lock().unwrap(), account, &message.message_id, Answer::Sent, now)? {
        return Ok(false);
    }
    let result = async {
        let creds = engine.ensure_valid_creds(account).await?;
        if creds.is_local() {
            bail!("the local archive cannot send mail");
        }
        let (from_addr, from_name) = receiving_address(&engine.db.lock().unwrap(), account, &creds.user, message)?;
        let raw = build_mdn(&Mdn {
            from_name: &from_name,
            from_addr: &from_addr,
            to: &request.notify_to,
            original_message_id: &message.message_id,
            original_subject: &message.subject,
            original_recipient: &request.original_recipient,
            mode,
        })?;
        if creds.is_ews() || creds.is_graph() {
            engine
                .with_write_session(account, |session| {
                    let raw = raw.clone();
                    Box::pin(async move { session.send_mime(raw).await })
                })
                .await
        } else {
            crate::smtp::send_report(&creds, &from_addr, &request.notify_to, &raw).await
        }
    }
    .await;
    match result {
        Ok(()) => Ok(true),
        Err(err) if crate::smtp::is_uncertain(&err) => Ok(true),
        Err(err) => {
            release(&engine.db.lock().unwrap(), account, &message.message_id)?;
            Err(err.context("the read receipt was not sent"))
        }
    }
}
