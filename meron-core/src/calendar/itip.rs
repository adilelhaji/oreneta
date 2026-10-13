//! Meeting invitations that arrive by mail (iMIP, RFC 6047; iTIP, RFC 5546)
//! (#102, ADR-0019).
//!
//! A message carrying a `text/calendar` part with a METHOD is an invitation
//! (REQUEST), a cancellation (CANCEL), an answer (REPLY), a proposal of
//! another time (COUNTER) or the organizer turning one down (DECLINECOUNTER,
//! ADR-0043). Reading one only
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
    /// The note the sender wrote with it (COMMENT): what a proposal of
    /// another time or its refusal says in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// STATUS:CANCELLED on the event itself.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
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
            "COMMENT" => invitation.comment = Some(unescape(value(line))).filter(|c| !c.trim().is_empty()),
            "STATUS" => invitation.cancelled = value(line).trim().eq_ignore_ascii_case("CANCELLED"),
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

fn stamp(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

fn date(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0).unwrap_or_default().format("%Y%m%d").to_string()
}

fn same_person(a: &str, b: &str) -> bool {
    let bare = |s: &str| {
        let s = s.trim();
        let s = match s.get(..7) {
            Some(scheme) if scheme.eq_ignore_ascii_case("mailto:") => &s[7..],
            _ => s,
        };
        s.to_ascii_lowercase()
    };
    !a.trim().is_empty() && bare(a) == bare(b)
}

/// The main event's lines of a calendar object, without the wrapper.
fn event_lines(ics: &str) -> Result<Vec<String>> {
    let lines = unfold(ics);
    let begin = lines.iter().position(|l| l.eq_ignore_ascii_case("BEGIN:VEVENT")).context("no event")?;
    let end = lines[begin..].iter().position(|l| l.eq_ignore_ascii_case("END:VEVENT")).context("no event")? + begin;
    Ok(lines[begin..end].to_vec())
}

/// A proposal of another time for an invitation (RFC 5546 §3.2.7): the same
/// UID and SEQUENCE (a proposal does not make a new version), the organizer
/// as the invitation names them, only this attendee, the proposed start and
/// end, and what the person wrote.
///
/// The times are instants; for an all-day invitation they are dates at
/// midnight UTC, as this calendar keeps them, and go out as `VALUE=DATE`.
pub fn counter(
    invitation: &Invitation,
    me: &Participant,
    start: i64,
    end: i64,
    comment: &str,
    now: i64,
) -> Result<String> {
    if invitation.method == "CANCEL" || invitation.cancelled {
        bail!("this meeting was cancelled; there is no time to propose");
    }
    if invitation.method != "REQUEST" {
        bail!("another time can be proposed only for an invitation");
    }
    let organizer = invitation.organizer.as_ref().context("this invitation names no organizer to propose to")?;
    if same_person(&organizer.addr, &me.addr) {
        bail!("you organize this meeting; change its time in your calendar instead");
    }
    if invitation.repeats && invitation.recurrence_id.is_none() {
        bail!("another time can be proposed for one meeting, not for a whole series");
    }
    let (dtstart, dtend) = if invitation.all_day {
        let (from, to) = (date(start), date(end));
        if to <= from {
            bail!("the proposed end must be after its start");
        }
        (format!("DTSTART;VALUE=DATE:{from}"), format!("DTEND;VALUE=DATE:{to}"))
    } else {
        if end <= start {
            bail!("the proposed end must be after its start");
        }
        (format!("DTSTART:{}", stamp(start)), format!("DTEND:{}", stamp(end)))
    };
    let lines = event_lines(&invitation.ics)?;
    let original = |name: &str| lines.iter().find(|l| name_of(l) == name).cloned();
    let mut out = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        format!("PRODID:{}", super::ics::PRODID),
        "METHOD:COUNTER".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}", invitation.uid),
        format!("SEQUENCE:{}", invitation.sequence),
        format!("DTSTAMP:{}", stamp(now)),
    ];
    if let Some(line) = original("RECURRENCE-ID") {
        out.push(line);
    }
    out.push(dtstart);
    out.push(dtend);
    out.push(original("ORGANIZER").unwrap_or_else(|| format!("ORGANIZER:mailto:{}", organizer.addr)));
    let cn = if me.name.is_empty() { String::new() } else { format!(";CN={}", quote_param(&me.name)) };
    out.push(format!("ATTENDEE{cn}:mailto:{}", me.addr.to_ascii_lowercase()));
    out.push(format!("SUMMARY:{}", escape(&invitation.summary)));
    if let Some(location) = invitation.location.as_deref() {
        out.push(format!("LOCATION:{}", escape(location)));
    }
    if !comment.trim().is_empty() {
        out.push(format!("COMMENT:{}", escape(comment.trim())));
    }
    out.push("END:VEVENT".into());
    out.push("END:VCALENDAR".into());
    Ok(out.iter().map(|l| fold(l) + "\r\n").collect())
}

/// The organizer turning a proposal down (RFC 5546 §3.2.8): the proposal's
/// UID and SEQUENCE, the organizer, the attendee who proposed it and,
/// optionally, why. The meeting stays as it was.
pub fn decline_counter(counter: &Invitation, me: &Participant, comment: &str, now: i64) -> Result<String> {
    if counter.method != "COUNTER" {
        bail!("only a proposal of another time can be declined this way");
    }
    let proposer = counter.attendees.first().context("this proposal names nobody who proposed it")?;
    if let Some(organizer) = counter.organizer.as_ref().filter(|o| !same_person(&o.addr, &me.addr)) {
        bail!("this proposal was sent to {}, who organizes the meeting; only they can decline it", organizer.addr);
    }
    let lines = event_lines(&counter.ics)?;
    let original = |name: &str| lines.iter().find(|l| name_of(l) == name).cloned();
    let mut out = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        format!("PRODID:{}", super::ics::PRODID),
        "METHOD:DECLINECOUNTER".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}", counter.uid),
        format!("SEQUENCE:{}", counter.sequence),
        format!("DTSTAMP:{}", stamp(now)),
    ];
    if let Some(line) = original("RECURRENCE-ID") {
        out.push(line);
    }
    out.push(original("ORGANIZER").unwrap_or_else(|| {
        let cn = if me.name.is_empty() { String::new() } else { format!(";CN={}", quote_param(&me.name)) };
        format!("ORGANIZER{cn}:mailto:{}", me.addr.to_ascii_lowercase())
    }));
    let cn = if proposer.name.is_empty() { String::new() } else { format!(";CN={}", quote_param(&proposer.name)) };
    out.push(format!("ATTENDEE{cn}:mailto:{}", proposer.addr));
    if !counter.summary.is_empty() {
        out.push(format!("SUMMARY:{}", escape(&counter.summary)));
    }
    if !comment.trim().is_empty() {
        out.push(format!("COMMENT:{}", escape(comment.trim())));
    }
    out.push("END:VEVENT".into());
    out.push("END:VCALENDAR".into());
    Ok(out.iter().map(|l| fold(l) + "\r\n").collect())
}

/// The event this account keeps for a proposal's meeting and organizes: an
/// occurrence in one of its own calendars (not a subscription) with this
/// UID, whose organizer is `me`. The occurrence the proposal names when it
/// names one, else the earliest. `None` when it is not kept here or someone
/// else organizes it: then the proposal is only information.
pub fn organized_event(
    conn: &rusqlite::Connection,
    account: &str,
    me: &str,
    uid: &str,
    recurrence_id: Option<i64>,
) -> Result<Option<super::Event>> {
    let mut found: Vec<super::Event> = super::events_with_uid(conn, account, uid)?
        .into_iter()
        .filter(|e| !e.is_cancelled)
        .filter(|e| e.organizer.as_ref().is_some_and(|o| same_person(&o.addr, me)))
        .collect();
    found.sort_by_key(|e| e.start);
    let named = recurrence_id.and_then(|at| {
        found.iter().position(|e| super::ics::occurrence_of(&e.id).is_some_and(|(_, s)| s == at) || e.start == at)
    });
    Ok(match named {
        Some(i) => Some(found.swap_remove(i)),
        None => found.into_iter().next(),
    })
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

// ---- The organizer telling the people on it (2026-10-12) --------------------

/// What an organizer sends after saving or deleting a meeting kept in a
/// local or CalDAV calendar: the new version (REQUEST, RFC 5546 §3.2.2) or
/// its cancellation (CANCEL, §3.2.5). Google and Exchange tell the people
/// on their own events themselves and never come here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    Request,
    Cancel,
}

impl Notice {
    pub fn parse(text: &str) -> Option<Notice> {
        match text.to_ascii_lowercase().as_str() {
            "request" => Some(Notice::Request),
            "cancel" => Some(Notice::Cancel),
            _ => None,
        }
    }

    pub fn method(self) -> &'static str {
        match self {
            Notice::Request => "REQUEST",
            Notice::Cancel => "CANCEL",
        }
    }
}

/// A notice ready to be mailed: who gets it, what the meeting is called,
/// the SEQUENCE it carries and the calendar object itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrganizerNotice {
    pub method: String,
    pub to: Vec<String>,
    pub summary: String,
    pub sequence: i64,
    pub ics: String,
}

/// One top-level block of a calendar object: its lines, BEGIN to END.
struct Block {
    lines: Vec<String>,
    /// The instant a VEVENT's RECURRENCE-ID names, when it has one.
    recurrence_id: Option<i64>,
}

fn blocks(lines: &[String], kind: &str) -> Vec<Block> {
    let begin = format!("BEGIN:{kind}");
    let end = format!("END:{kind}");
    let mut found = Vec::new();
    let mut current: Option<Vec<String>> = None;
    let mut depth = 0usize;
    for line in lines {
        let upper = line.to_ascii_uppercase();
        match current.as_mut() {
            None if upper == begin => {
                current = Some(vec![line.clone()]);
                depth = 0;
            }
            None => {}
            Some(block) => {
                block.push(line.clone());
                if upper.starts_with("BEGIN:") {
                    depth += 1;
                } else if upper.starts_with("END:") && depth > 0 {
                    depth -= 1;
                } else if upper == end {
                    let lines = current.take().unwrap_or_default();
                    let recurrence_id = top_level(&lines)
                        .find(|l| name_of(l) == "RECURRENCE-ID")
                        .and_then(|l| super::ics::instant_of(l));
                    found.push(Block { lines, recurrence_id });
                }
            }
        }
    }
    found
}

/// The lines of a block that are its own properties: not its BEGIN/END and
/// not those of a component inside it (an alarm).
fn top_level(lines: &[String]) -> impl Iterator<Item = &String> {
    let mut depth = 0usize;
    let inner = if lines.len() >= 2 { &lines[1..lines.len() - 1] } else { &lines[..0] };
    inner.iter().filter(move |line| {
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("BEGIN:") {
            depth += 1;
            return false;
        }
        if upper.starts_with("END:") && depth > 0 {
            depth -= 1;
            return false;
        }
        depth == 0
    })
}

fn sequence_in(lines: &[String]) -> i64 {
    top_level(lines).find(|l| name_of(l) == "SEQUENCE").and_then(|l| value(l).trim().parse().ok()).unwrap_or(0)
}

/// One occurrence of a series that has no exception of its own, as a
/// component: the series' properties without its rule, at that instant.
fn occurrence_from(master: &[String], at: i64) -> Vec<String> {
    let start = top_level(master).find(|l| name_of(l) == "DTSTART").cloned();
    let end = top_level(master).find(|l| name_of(l) == "DTEND").cloned();
    let all_day = start.as_deref().is_some_and(|l| {
        let upper = l.to_ascii_uppercase();
        (upper.contains("VALUE=DATE") && !upper.contains("VALUE=DATE-TIME")) || value(l).trim().len() == 8
    });
    let zone = start.as_deref().and_then(super::ics::tzid_of);
    let length = match (start.as_deref().and_then(super::ics::instant_of), end.as_deref().and_then(super::ics::instant_of)) {
        (Some(from), Some(to)) if to >= from => Some(to - from),
        _ => None,
    };
    let mut out = vec!["BEGIN:VEVENT".to_string()];
    out.push(super::ics::time_property("RECURRENCE-ID", at, all_day, zone.as_deref()));
    out.push(super::ics::time_property("DTSTART", at, all_day, zone.as_deref()));
    if let Some(length) = length {
        out.push(super::ics::time_property("DTEND", at + length, all_day, zone.as_deref()));
    }
    out.extend(
        top_level(master)
            .filter(|l| !matches!(name_of(l).as_str(), "RRULE" | "RDATE" | "EXDATE" | "EXRULE" | "DTSTART" | "DTEND" | "RECURRENCE-ID"))
            .cloned(),
    );
    out.push("END:VEVENT".into());
    out
}

/// Adds a parameter to a property line unless it already has one by that
/// name.
fn with_param(line: &str, key: &str, value: &str) -> String {
    if param(line, key).is_some() {
        return line.to_string();
    }
    let at = line.find(':').unwrap_or(line.len());
    format!("{};{key}={value}{}", &line[..at], &line[at..])
}

/// The component as it goes out: identity and version first, the organizer
/// checked to be `me`, attendees asked to answer, alarms (which are the
/// organizer's own) left behind. A cancellation keeps only what names the
/// meeting and its people.
fn outgoing(component: &[String], notice: Notice, me: &Participant, now: i64) -> Result<(Vec<String>, i64)> {
    let own: Vec<&String> = top_level(component).collect();
    let find = |name: &str| own.iter().find(|l| name_of(l) == name).map(|l| (*l).clone());
    let uid = find("UID").context("the event has no UID")?;
    let organizer = match find("ORGANIZER") {
        Some(line) if !same_person(&super::ics::address_of(&line), &me.addr) => {
            bail!("{} organizes this meeting; only they can tell the people on it", super::ics::address_of(&line))
        }
        Some(line) => line,
        None => super::ics::organizer_line(me),
    };
    let stored = sequence_in(component);
    let sequence = match notice {
        Notice::Request => stored,
        // A cancellation supersedes the last version sent.
        Notice::Cancel => stored + 1,
    };
    let mut out = vec!["BEGIN:VEVENT".to_string(), uid];
    if let Some(line) = find("RECURRENCE-ID") {
        out.push(line);
    }
    out.push(format!("SEQUENCE:{sequence}"));
    out.push(format!("DTSTAMP:{}", stamp(now)));
    out.push(organizer);
    let skipped = ["UID", "RECURRENCE-ID", "SEQUENCE", "DTSTAMP", "ORGANIZER", "METHOD"];
    for line in own {
        let name = name_of(line);
        if skipped.contains(&name.as_str()) {
            continue;
        }
        match notice {
            Notice::Request => {
                if name == "ATTENDEE" && !same_person(&super::ics::address_of(line), &me.addr) {
                    let line = with_param(line, "PARTSTAT", "NEEDS-ACTION");
                    let asked = param(&line, "PARTSTAT").is_some_and(|p| p.eq_ignore_ascii_case("NEEDS-ACTION"));
                    out.push(if asked { with_param(&line, "RSVP", "TRUE") } else { line });
                } else {
                    out.push(line.clone());
                }
            }
            Notice::Cancel => {
                if matches!(name.as_str(), "DTSTART" | "DTEND" | "DURATION" | "SUMMARY" | "LOCATION" | "ATTENDEE") {
                    out.push(line.clone());
                }
            }
        }
    }
    if notice == Notice::Cancel {
        out.retain(|l| name_of(l) != "STATUS");
        out.push("STATUS:CANCELLED".into());
    }
    out.push("END:VEVENT".into());
    Ok((out, sequence))
}

/// The notice for a meeting the person organizes, built from the calendar
/// object stored for it (the CalDAV server's, or [`local_object`]'s).
///
/// `occurrence` names one occurrence of a series by the instant it was
/// originally at; `None` is the whole event. For one occurrence the notice
/// carries its exception (or the occurrence as the series has it) with its
/// RECURRENCE-ID; for a whole series, the series and every exception, rule
/// and time zones included. A REQUEST carries the SEQUENCE the last save
/// stored; a CANCEL one more.
///
/// Recipients are the attendees with an address, the organizer excluded.
/// Refused when someone else organizes it or nobody is left to tell.
pub fn organizer_notice(
    object: &str,
    notice: Notice,
    occurrence: Option<i64>,
    me: &Participant,
    now: i64,
) -> Result<OrganizerNotice> {
    if !me.addr.contains('@') {
        bail!("no address to send this from");
    }
    let lines = unfold(object);
    let zones = blocks(&lines, "VTIMEZONE");
    let events = blocks(&lines, "VEVENT");
    let master = events.iter().find(|b| b.recurrence_id.is_none());
    let repeats = master.is_some_and(|m| top_level(&m.lines).any(|l| matches!(name_of(l).as_str(), "RRULE" | "RDATE")));
    // An occurrence is only one when the event repeats (or the object holds
    // exceptions alone); otherwise the event is the whole thing.
    let occurrence = occurrence.filter(|_| repeats || master.is_none());
    let chosen: Vec<Vec<String>> = match (occurrence, notice) {
        (Some(at), _) => match events.iter().find(|b| b.recurrence_id == Some(at)) {
            Some(exception) => vec![exception.lines.clone()],
            None => vec![occurrence_from(&master.context("the series has no main event")?.lines, at)],
        },
        (None, Notice::Request) => events.iter().map(|b| b.lines.clone()).collect(),
        // Cancelling the UID cancels every occurrence; the series stands for
        // all of them.
        (None, Notice::Cancel) => match master {
            Some(master) => vec![master.lines.clone()],
            None => events.iter().map(|b| b.lines.clone()).collect(),
        },
    };
    if chosen.is_empty() {
        bail!("the calendar object holds no event");
    }
    let mut out = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        format!("PRODID:{}", super::ics::PRODID),
        format!("METHOD:{}", notice.method()),
    ];
    for zone in &zones {
        out.extend(zone.lines.iter().cloned());
    }
    let mut to: Vec<String> = Vec::new();
    let mut summary = String::new();
    let mut sequence = 0;
    for (n, component) in chosen.iter().enumerate() {
        let (lines, at) = outgoing(component, notice, me, now)?;
        if n == 0 {
            sequence = at;
            summary = lines.iter().find(|l| name_of(l) == "SUMMARY").map(|l| unescape(value(l))).unwrap_or_default();
        }
        for line in lines.iter().filter(|l| name_of(l) == "ATTENDEE") {
            let addr = super::ics::address_of(line);
            if addr.contains('@') && !same_person(&addr, &me.addr) && !to.contains(&addr) {
                to.push(addr);
            }
        }
        out.extend(lines);
    }
    out.push("END:VCALENDAR".into());
    if to.is_empty() {
        bail!("this event has nobody to tell");
    }
    Ok(OrganizerNotice {
        method: notice.method().into(),
        to,
        summary,
        sequence,
        ics: out.iter().map(|l| fold(l) + "\r\n").collect(),
    })
}

/// The calendar object a local event stands for, which a local calendar
/// does not keep: written from its row, with the UID it is known by
/// ([`local_uid`]), the SEQUENCE kept for it, and the RECURRENCE-ID of an
/// imported occurrence.
pub fn local_object(event: &super::Event, sequence: i64, now: i64) -> String {
    let (uid, occurrence) = local_uid(event);
    let written = super::ics::new_object(&super::Event { recurrence: None, ..event.clone() }, &uid, now);
    let mut lines = unfold(&written);
    if let Some(i) = lines.iter().position(|l| name_of(l) == "SEQUENCE") {
        lines[i] = format!("SEQUENCE:{sequence}");
    }
    if let (Some(at), Some(i)) = (occurrence, lines.iter().position(|l| name_of(l) == "UID")) {
        lines.insert(i + 1, super::ics::time_property("RECURRENCE-ID", at, event.all_day, None));
    }
    lines.iter().map(|l| fold(l) + "\r\n").collect()
}

/// The UID a local event goes out with, and the occurrence it stands for
/// when it is one of an imported series. An event made here is known by its
/// own id (`local:…`), which is what [`super::events_with_uid`] finds when
/// an answer or a proposal comes back; an imported one by the UID it came
/// with.
pub fn local_uid(event: &super::Event) -> (String, Option<i64>) {
    match event.id.strip_prefix("local:import:").and_then(super::ics::occurrence_of) {
        Some((uid, at)) => (uid.to_string(), event.is_recurring.then_some(at)),
        None => (event.id.clone(), None),
    }
}

// ---- What was answered (#102) ------------------------------------------------

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS invitation_answers (
  account     TEXT NOT NULL,
  uid         TEXT NOT NULL,
  sequence    INTEGER NOT NULL DEFAULT 0,
  response    TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT '',
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (account, uid)
);
";

/// The last answer given to an invitation, from this account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Answer {
    pub sequence: i64,
    /// "accept", "tentative", "decline", or "cancelled" when a cancellation
    /// was applied.
    pub response: String,
    pub calendar_id: String,
    pub answered_at: i64,
}

pub fn answer_of(conn: &rusqlite::Connection, account: &str, uid: &str) -> Result<Option<Answer>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT sequence, response, calendar_id, answered_at FROM invitation_answers WHERE account = ?1 AND uid = ?2",
            rusqlite::params![account, uid],
            |row| Ok(Answer { sequence: row.get(0)?, response: row.get(1)?, calendar_id: row.get(2)?, answered_at: row.get(3)? }),
        )
        .optional()?)
}

/// Records an answer, unless one for a later version is already kept: an
/// old invitation answered late does not undo a newer answer.
pub fn record(conn: &rusqlite::Connection, account: &str, uid: &str, answer: &Answer) -> Result<bool> {
    if answer_of(conn, account, uid)?.is_some_and(|kept| kept.sequence > answer.sequence) {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO invitation_answers(account, uid, sequence, response, calendar_id, answered_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account, uid) DO UPDATE SET sequence = excluded.sequence, response = excluded.response,
           calendar_id = excluded.calendar_id, answered_at = excluded.answered_at",
        rusqlite::params![account, uid, answer.sequence, answer.response, answer.calendar_id, answer.answered_at],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests;
