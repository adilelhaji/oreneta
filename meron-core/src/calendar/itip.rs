//! Meeting invitations that arrive by mail (iMIP, RFC 6047; iTIP, RFC 5546)
//! (#102, ADR-0019).
//!
//! A message carrying a `text/calendar` part with a METHOD is an invitation
//! (REQUEST), a cancellation (CANCEL) or an answer (REPLY). Reading one only
//! describes it. Nothing is sent and nothing reaches a calendar unless the
//! person asks: received mail never answers on anyone's behalf.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::ics::{escape, fold, unfold};
use super::Participant;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invitation {
    /// "REQUEST", "CANCEL", "REPLY", … upper-cased.
    pub method: String,
    pub uid: String,
    pub sequence: i64,
    /// The occurrence this is about, when only one of a series is.
    #[serde(default)]
    pub recurrence_id: Option<i64>,
    pub summary: String,
    #[serde(default)]
    pub location: Option<String>,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub repeats: bool,
    #[serde(default)]
    pub organizer: Option<Participant>,
    #[serde(default)]
    pub attendees: Vec<Participant>,
    /// The calendar object as it arrived, for answering and for adding it.
    pub ics: String,
}

fn value(line: &str) -> &str {
    line.find(':').map(|i| &line[i + 1..]).unwrap_or("")
}

fn name_of(line: &str) -> String {
    let end = line.find([':', ';']).unwrap_or(line.len());
    line[..end].to_ascii_uppercase()
}

fn param(line: &str, key: &str) -> Option<String> {
    let head = &line[..line.find(':')?];
    head.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.eq_ignore_ascii_case(key).then(|| v.trim_matches('"').to_string())
    })
}

fn person(line: &str) -> Participant {
    let addr = value(line);
    let addr = addr.strip_prefix("mailto:").or_else(|| addr.strip_prefix("MAILTO:")).unwrap_or(addr);
    Participant {
        name: param(line, "CN").unwrap_or_default(),
        addr: addr.trim().to_ascii_lowercase(),
        response: match param(line, "PARTSTAT").map(|s| s.to_ascii_uppercase()).as_deref() {
            Some("ACCEPTED") => "accept".into(),
            Some("DECLINED") => "decline".into(),
            Some("TENTATIVE") => "tentative".into(),
            Some("NEEDS-ACTION") => "none".into(),
            _ => String::new(),
        },
    }
}

/// Reads an invitation out of a calendar object. `None` when it is not one:
/// a published calendar has no METHOD, and a file with no event says nothing.
pub fn parse(ics: &str) -> Option<Invitation> {
    let lines = unfold(ics);
    let method = lines.iter().find(|l| name_of(l) == "METHOD").map(|l| value(l).trim().to_ascii_uppercase())?;
    let begin = lines.iter().position(|l| l.eq_ignore_ascii_case("BEGIN:VEVENT"))?;
    let end = lines[begin..].iter().position(|l| l.eq_ignore_ascii_case("END:VEVENT"))? + begin;
    let mut depth = 0usize;
    let mut invitation = Invitation { method, ics: ics.to_string(), ..Default::default() };
    for line in &lines[begin + 1..end] {
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("BEGIN:") {
            depth += 1;
            continue;
        }
        if upper.starts_with("END:") {
            depth = depth.saturating_sub(1);
            continue;
        }
        if depth > 0 {
            continue;
        }
        match name_of(line).as_str() {
            "UID" => invitation.uid = value(line).trim().to_string(),
            "SEQUENCE" => invitation.sequence = value(line).trim().parse().unwrap_or(0),
            "SUMMARY" => invitation.summary = unescape(value(line)),
            "LOCATION" => invitation.location = Some(unescape(value(line))).filter(|l| !l.is_empty()),
            "RRULE" => invitation.repeats = true,
            "ORGANIZER" => invitation.organizer = Some(person(line)),
            "ATTENDEE" => invitation.attendees.push(person(line)),
            _ => {}
        }
    }
    if invitation.uid.is_empty() {
        return None;
    }
    // Times are read by the RFC 5545 reader the calendar uses, from the first
    // occurrence: zones, all-day dates and durations come out right.
    let (mut events, _) = super::subscription::parse_window(ics, "invitation", 0, 4_102_444_800).ok()?;
    events.sort_by_key(|e| e.start);
    if let Some(first) = events.first() {
        invitation.start = first.start;
        invitation.end = first.end;
        invitation.all_day = first.all_day;
        if let Some((_, original)) = super::ics::occurrence_of(&first.id).filter(|_| {
            lines[begin..end].iter().any(|l| name_of(l) == "RECURRENCE-ID")
        }) {
            invitation.recurrence_id = Some(original);
        }
    }
    Some(invitation)
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// An answer to an invitation (RFC 5546 §3.2.3): the event's identity and
/// this attendee's status, nothing else of the event.
pub fn reply(invitation: &Invitation, me: &Participant, response: super::Response, now: i64) -> Result<String> {
    if invitation.method != "REQUEST" {
        bail!("only an invitation can be answered");
    }
    let organizer = invitation.organizer.as_ref().context("this invitation names no organizer to answer")?;
    let lines = unfold(&invitation.ics);
    let begin = lines.iter().position(|l| l.eq_ignore_ascii_case("BEGIN:VEVENT")).context("no event")?;
    let end = lines[begin..].iter().position(|l| l.eq_ignore_ascii_case("END:VEVENT")).context("no event")? + begin;
    let original = |name: &str| lines[begin..end].iter().find(|l| name_of(l) == name).cloned();
    let partstat = match response {
        super::Response::Accept => "ACCEPTED",
        super::Response::Tentative => "TENTATIVE",
        super::Response::Decline => "DECLINED",
    };
    let mut out = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        format!("PRODID:{}", super::ics::PRODID),
        "METHOD:REPLY".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}", invitation.uid),
        format!("SEQUENCE:{}", invitation.sequence),
        format!("DTSTAMP:{}", chrono::DateTime::from_timestamp(now, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ")),
    ];
    for name in ["RECURRENCE-ID", "DTSTART", "DTEND"] {
        if let Some(line) = original(name) {
            out.push(line);
        }
    }
    out.push(original("ORGANIZER").unwrap_or_else(|| format!("ORGANIZER:mailto:{}", organizer.addr)));
    let cn = if me.name.is_empty() { String::new() } else { format!(";CN={}", quote_param(&me.name)) };
    out.push(format!("ATTENDEE;PARTSTAT={partstat}{cn}:mailto:{}", me.addr));
    out.push(format!("SUMMARY:{}", escape(&invitation.summary)));
    out.push("END:VEVENT".into());
    out.push("END:VCALENDAR".into());
    Ok(out.iter().map(|l| fold(l) + "\r\n").collect())
}

fn quote_param(text: &str) -> String {
    let clean: String = text.chars().filter(|c| *c != '"' && !c.is_control()).collect();
    if clean.contains([';', ':', ',']) {
        format!("\"{clean}\"")
    } else {
        clean
    }
}

/// The invitation as an event to keep in one's own calendar: no METHOD, and
/// this attendee's status set to the answer given.
pub fn as_event(invitation: &Invitation, me: &str, response: super::Response) -> String {
    let partstat = match response {
        super::Response::Accept => "ACCEPTED",
        super::Response::Tentative => "TENTATIVE",
        super::Response::Decline => "DECLINED",
    };
    let me = me.to_ascii_lowercase();
    unfold(&invitation.ics)
        .into_iter()
        .filter(|line| name_of(line) != "METHOD")
        .map(|line| {
            if name_of(&line) == "ATTENDEE" && person(&line).addr == me {
                let head_end = line.find(':').unwrap_or(line.len());
                let params: Vec<&str> = line[..head_end]
                    .split(';')
                    .filter(|p| !p.to_ascii_uppercase().starts_with("PARTSTAT=") && !p.to_ascii_uppercase().starts_with("RSVP="))
                    .collect();
                format!("{};PARTSTAT={partstat}{}", params.join(";"), &line[head_end..])
            } else {
                line
            }
        })
        .map(|l| fold(&l) + "\r\n")
        .collect()
}

/// Whether this invitation is older than the version already kept: a
/// lower SEQUENCE, the RFC's own ordering. Equal is not older.
pub fn is_outdated(invitation: &Invitation, kept_sequence: Option<i64>) -> bool {
    kept_sequence.is_some_and(|kept| invitation.sequence < kept)
}

/// The SEQUENCE of a stored calendar object's main event.
pub fn sequence_of(ics: &str) -> Option<i64> {
    let lines = unfold(ics);
    let begin = lines.iter().position(|l| l.eq_ignore_ascii_case("BEGIN:VEVENT"))?;
    lines[begin..]
        .iter()
        .take_while(|l| !l.eq_ignore_ascii_case("END:VEVENT"))
        .find(|l| name_of(l) == "SEQUENCE")
        .and_then(|l| value(l).trim().parse().ok())
        .or(Some(0))
}

#[cfg(test)]
mod tests;
