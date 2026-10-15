//! Delivery and read reports that arrive (SET-11, #210, ADR-0057).
//!
//! A delivery status notification (DSN, RFC 3464) says what a mail server did
//! with a message for each recipient: delivered, failed, delayed or passed on.
//! A message disposition notification (MDN, RFC 8098) says what a recipient's
//! mail program did with it: usually that it was displayed. Both arrive as
//! `multipart/report`, for every kind of account, and are read here from the
//! machine-readable part, never from the text meant for a person.
//!
//! Each report names the message it is about by Message-ID: the MDN in its
//! `Original-Message-ID` field, the DSN in the copy or headers of the original
//! it returns. What a report says is kept per account and that Message-ID, so
//! the sent message can show it; a report that names nothing, or a message
//! this account did not send, links to nothing and stays an ordinary message.
//! A report is a claim made by whoever sent it, and is shown as one.

use anyhow::Result;
use mailparse::{MailHeaderMap as _, ParsedMail};
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

/// No more than this many recipients are read from one report.
const MAX_RECIPIENTS: usize = 100;
/// A diagnostic is cut to this many characters; it is for a person to read.
const MAX_TEXT: usize = 500;
/// The machine-readable part is read up to this size; real ones are small.
const MAX_FIELDS: usize = 64 * 1024;

/// Which kind of report it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// From a mail server: RFC 3464.
    Delivery,
    /// From the recipient's mail program: RFC 8098.
    Disposition,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Delivery => "delivery",
            Kind::Disposition => "disposition",
        }
    }
}

/// What happened to the message for one recipient.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Delivered to the recipient's mailbox (DSN `delivered`).
    Delivered,
    /// Handed on to a system that sends no further reports (DSN `relayed`
    /// or `expanded`): not a delivery, and not a failure either.
    Relayed,
    /// Not delivered yet; the server keeps trying (DSN `delayed`).
    Delayed,
    /// Not delivered, and the server gave up (DSN `failed`).
    Failed,
    /// Shown on the recipient's screen (MDN `displayed`). Not that it was
    /// read or understood.
    Displayed,
    /// Handled by the recipient's program without being shown (MDN
    /// `deleted`, `dispatched` or `processed`).
    NotDisplayed,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Delivered => "delivered",
            Outcome::Relayed => "relayed",
            Outcome::Delayed => "delayed",
            Outcome::Failed => "failed",
            Outcome::Displayed => "displayed",
            Outcome::NotDisplayed => "notDisplayed",
        }
    }

    fn parse(value: &str) -> Option<Outcome> {
        Some(match value {
            "delivered" => Outcome::Delivered,
            "relayed" => Outcome::Relayed,
            "delayed" => Outcome::Delayed,
            "failed" => Outcome::Failed,
            "displayed" => Outcome::Displayed,
            "notDisplayed" => Outcome::NotDisplayed,
            _ => return None,
        })
    }
}

/// What one report says about one recipient.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipientReport {
    /// The recipient as the sender addressed them (`Original-Recipient`)
    /// when the report says, else as finally delivered (`Final-Recipient`).
    pub recipient: String,
    pub outcome: Outcome,
    /// The enhanced status code (RFC 3463), such as `5.1.1`; empty when the
    /// report gives none or a malformed one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    /// The server's own words about it (`Diagnostic-Code`), bounded.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub diagnostic: String,
}

/// A report as read from the message that carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub kind: Kind,
    /// The Message-ID of the message it is about, without angle brackets;
    /// empty when the report does not say, and then it links to nothing.
    #[serde(default)]
    pub original_message_id: String,
    pub recipients: Vec<RecipientReport>,
}

/// The report a message carries, if it is one this can read.
///
/// Only a top-level `multipart/report` counts: one forwarded inside another
/// message is somebody's message about a report, not a report to this
/// mailbox. A report whose machine-readable part is missing, or says nothing
/// that can be read, is no report here; the message stays an ordinary one.
pub fn report_of(mail: &ParsedMail) -> Option<Report> {
    if !mail.ctype.mimetype.eq_ignore_ascii_case("multipart/report") {
        return None;
    }
    let report_type = mail.ctype.params.get("report-type").map(|value| value.trim().to_ascii_lowercase());
    let (kind, parts): (Kind, &[&str]) = match report_type.as_deref() {
        Some("delivery-status") => (Kind::Delivery, &["message/delivery-status", "message/global-delivery-status"]),
        Some("disposition-notification") => {
            (Kind::Disposition, &["message/disposition-notification", "message/global-disposition-notification"])
        }
        _ => return None,
    };
    let part = mail
        .subparts
        .iter()
        .find(|part| parts.iter().any(|wanted| part.ctype.mimetype.eq_ignore_ascii_case(wanted)))?;
    let bytes = part.get_body_raw().ok()?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_FIELDS)]).into_owned();
    let groups = field_groups(&text);
    match kind {
        Kind::Delivery => {
            let recipients: Vec<RecipientReport> =
                groups.iter().filter_map(|group| delivery_recipient(group)).take(MAX_RECIPIENTS).collect();
            if recipients.is_empty() {
                return None;
            }
            Some(Report { kind, original_message_id: returned_message_id(mail), recipients })
        }
        Kind::Disposition => {
            // One notification per MDN (RFC 8098 §3.1); its fields are read
            // wherever a server put the blank lines.
            let fields: Vec<(String, String)> = groups.into_iter().flatten().collect();
            let outcome = disposition_outcome(field(&fields, "Disposition")?)?;
            let recipient = recipient_of(&fields)?;
            let original = field(&fields, "Original-Message-ID")
                .map(bare_id)
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| returned_message_id(mail));
            Some(Report {
                kind,
                original_message_id: original,
                recipients: vec![RecipientReport { recipient, outcome, status: String::new(), diagnostic: String::new() }],
            })
        }
    }
}

/// The fields of a report part, in blank-line separated groups (RFC 3464
/// §2.1: the per-message group, then one per recipient). Folded lines are
/// unfolded; anything that is not a field is skipped.
fn field_groups(text: &str) -> Vec<Vec<(String, String)>> {
    let mut groups = Vec::new();
    let mut current: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            if !current.is_empty() {
                groups.push(std::mem::take(&mut current));
            }
            continue;
        }
        if line.starts_with([' ', '\t']) {
            if let Some((_, value)) = current.last_mut() {
                value.push(' ');
                value.push_str(line.trim());
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            current.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields.iter().find(|(field, _)| field.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

/// One recipient's block of a DSN; a block without a known `Action` (the
/// per-message block, or a malformed one) is none.
fn delivery_recipient(fields: &[(String, String)]) -> Option<RecipientReport> {
    let action = field(fields, "Action")?.split_whitespace().next()?.to_ascii_lowercase();
    let outcome = match action.as_str() {
        "delivered" => Outcome::Delivered,
        "relayed" | "expanded" => Outcome::Relayed,
        "delayed" => Outcome::Delayed,
        "failed" => Outcome::Failed,
        _ => return None,
    };
    Some(RecipientReport {
        recipient: recipient_of(fields)?,
        outcome,
        status: field(fields, "Status").map(status_code).unwrap_or_default(),
        diagnostic: field(fields, "Diagnostic-Code").map(diagnostic_text).unwrap_or_default(),
    })
}

fn recipient_of(fields: &[(String, String)]) -> Option<String> {
    ["Original-Recipient", "Final-Recipient"]
        .iter()
        .filter_map(|name| field(fields, name))
        .map(address_of)
        .find(|address| !address.is_empty())
}

/// `rfc822; Bob@Example.com` → `bob@example.com`. Another address type
/// (`x400;`) is kept as written, since it cannot be compared anyway.
fn address_of(value: &str) -> String {
    let (kind, address) = value.split_once(';').unwrap_or(("rfc822", value));
    let address = address.trim().trim_start_matches('<').trim_end_matches('>').trim();
    let address = clean(address, 320);
    let kind = kind.trim().to_ascii_lowercase();
    if kind == "rfc822" || kind == "utf-8" {
        address.to_lowercase()
    } else {
        address
    }
}

/// The enhanced status code (RFC 3463 §2: class.subject.detail), or empty.
fn status_code(value: &str) -> String {
    let code = value.split_whitespace().next().unwrap_or("");
    let parts: Vec<&str> = code.split('.').collect();
    let valid = parts.len() == 3
        && matches!(parts[0], "2" | "4" | "5")
        && parts[1..].iter().all(|part| (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()));
    if valid { code.to_string() } else { String::new() }
}

/// `smtp; 550 5.1.1 <bob@x>: user unknown` → the text after the type,
/// on one line, without control characters, bounded.
fn diagnostic_text(value: &str) -> String {
    let text = match value.split_once(';') {
        Some((kind, rest)) if !kind.trim().is_empty() && !kind.contains(' ') => rest,
        _ => value,
    };
    clean(&text.split_whitespace().collect::<Vec<_>>().join(" "), MAX_TEXT)
}

fn clean(value: &str, limit: usize) -> String {
    value.chars().filter(|c| !c.is_control()).take(limit).collect::<String>().trim().to_string()
}

/// An MDN's disposition type (RFC 8098 §3.2.6): `displayed`, or one of the
/// ways it was handled without being shown. Anything else (the obsolete
/// `denied` and `failed`, or nothing known) is not read as either.
fn disposition_outcome(value: &str) -> Option<Outcome> {
    let (_, kind) = value.split_once(';')?;
    let kind = kind.trim().split(['/', ' ', '\t']).next()?.to_ascii_lowercase();
    match kind.as_str() {
        "displayed" => Some(Outcome::Displayed),
        "deleted" | "dispatched" | "processed" => Some(Outcome::NotDisplayed),
        _ => None,
    }
}

fn bare_id(value: &str) -> String {
    clean(value.trim().trim_start_matches('<').trim_end_matches('>').trim(), 998)
}

/// The Message-ID in the copy of the original a report returns: the whole
/// message (`message/rfc822`, `message/global`) or only its headers
/// (`text/rfc822-headers`, `message/global-headers`).
fn returned_message_id(mail: &ParsedMail) -> String {
    const RETURNED: [&str; 5] =
        ["message/rfc822", "text/rfc822-headers", "message/rfc822-headers", "message/global", "message/global-headers"];
    mail.subparts
        .iter()
        .filter(|part| RETURNED.iter().any(|kind| part.ctype.mimetype.eq_ignore_ascii_case(kind)))
        .find_map(|part| {
            let bytes = part.get_body_raw().ok()?;
            let (headers, _) = mailparse::parse_headers(&bytes).ok()?;
            headers.get_first_value("Message-ID").map(|id| bare_id(&id)).filter(|id| !id.is_empty())
        })
        .unwrap_or_default()
}

// ---- Kept per sent message ------------------------------------------------------

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS delivery_reports (
  account             TEXT NOT NULL,
  original_message_id TEXT NOT NULL,   -- lower case, no angle brackets
  kind                TEXT NOT NULL,   -- 'delivery' or 'disposition'
  recipient           TEXT NOT NULL,
  outcome             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT '',
  diagnostic          TEXT NOT NULL DEFAULT '',
  reported_at         INTEGER NOT NULL,
  PRIMARY KEY (account, original_message_id, kind, recipient)
);
";

/// Keeps what a report says, for the account that received it. A final word
/// (delivered, failed, relayed) replaces a delay and is never replaced by
/// one; otherwise the later report wins. Recording the same report again
/// changes nothing. A report that names no message is not kept.
pub fn record(conn: &rusqlite::Connection, account: &str, report: &Report, reported_at: i64) -> Result<()> {
    let original = super::key(&report.original_message_id);
    if original.is_empty() {
        return Ok(());
    }
    for item in &report.recipients {
        conn.execute(
            "INSERT INTO delivery_reports(account, original_message_id, kind, recipient, outcome, status, diagnostic, reported_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account, original_message_id, kind, recipient) DO UPDATE SET
               outcome = excluded.outcome, status = excluded.status,
               diagnostic = excluded.diagnostic, reported_at = excluded.reported_at
             WHERE (delivery_reports.outcome = 'delayed' AND excluded.outcome <> 'delayed')
                OR ((delivery_reports.outcome = 'delayed') = (excluded.outcome = 'delayed')
                    AND excluded.reported_at >= delivery_reports.reported_at)",
            rusqlite::params![
                account,
                original,
                report.kind.as_str(),
                item.recipient,
                item.outcome.as_str(),
                item.status,
                item.diagnostic,
                reported_at
            ],
        )?;
    }
    Ok(())
}

/// What the reports received so far say about one message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stored {
    pub kind: Kind,
    pub recipient: String,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub diagnostic: String,
    /// The report's own date (seconds), 0 when it had none.
    pub reported_at: i64,
}

/// The reports this account received about its message `message_id`, by
/// kind then recipient. Another account's reports are never included.
pub fn outcomes(conn: &rusqlite::Connection, account: &str, message_id: &str) -> Result<Vec<Stored>> {
    let original = super::key(message_id);
    if original.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT kind, recipient, outcome, status, diagnostic, reported_at FROM delivery_reports
          WHERE account = ?1 AND original_message_id = ?2 ORDER BY kind, recipient",
    )?;
    let rows = stmt.query_map(rusqlite::params![account, original], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (kind, recipient, outcome, status, diagnostic, reported_at) = row?;
        // A value this version does not know is left out rather than guessed.
        let kind = match kind.as_str() {
            "delivery" => Kind::Delivery,
            "disposition" => Kind::Disposition,
            _ => continue,
        };
        let Some(outcome) = Outcome::parse(&outcome) else { continue };
        out.push(Stored { kind, recipient, outcome, status, diagnostic, reported_at });
    }
    Ok(out)
}
