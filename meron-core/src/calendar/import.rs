//! Bringing `.ics` files into a calendar, and writing one out (#101).
//!
//! A file is split by UID: each series travels with its exceptions and the
//! time-zone definitions it may use. Into a CalDAV calendar each goes as its
//! own object, rule and all, and only where nothing with that UID is yet. A
//! local calendar keeps single events, so a series arrives there as its
//! occurrences over the next years, each bounded like a subscription's.
//! Importing the same file twice adds nothing the second time.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::Serialize;

use super::ics::unfold;
use super::Event;

pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
/// How far ahead a series is laid out in a local calendar.
pub const LOCAL_YEARS: i64 = 5;

/// One event or series from a file: its UID and a calendar object holding
/// just it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub uid: String,
    pub object: String,
    pub repeats: bool,
}

/// Splits a file by UID. Components without a UID are given one, so they
/// can still be imported (and imported once).
pub fn split(ics: &str) -> Result<Vec<Item>> {
    if ics.len() > MAX_FILE_BYTES {
        bail!("this file is larger than a calendar file may be (20 MB)");
    }
    let lines = unfold(ics);
    if !lines.iter().any(|line| line.eq_ignore_ascii_case("BEGIN:VCALENDAR")) {
        bail!("this is not a calendar file");
    }
    let mut zones: Vec<Vec<String>> = Vec::new();
    let mut groups: BTreeMap<String, (Vec<Vec<String>>, bool)> = BTreeMap::new();
    let mut current: Option<Vec<String>> = None;
    let mut kind = String::new();
    let mut depth = 0usize;
    let mut anonymous = 0usize;
    for line in lines {
        let upper = line.to_ascii_uppercase();
        if current.is_none() {
            if upper == "BEGIN:VEVENT" || upper == "BEGIN:VTIMEZONE" {
                kind = upper[6..].to_string();
                current = Some(vec![line]);
                depth = 0;
            }
            continue;
        }
        let component = current.as_mut().expect("open component");
        component.push(line.clone());
        if upper.starts_with("BEGIN:") {
            depth += 1;
        } else if upper.starts_with("END:") && depth > 0 {
            depth -= 1;
        } else if upper == format!("END:{kind}") {
            let done = current.take().expect("open component");
            if kind == "VTIMEZONE" {
                zones.push(done);
                continue;
            }
            let uid = done
                .iter()
                .find(|l| l.to_ascii_uppercase().starts_with("UID:"))
                .map(|l| l[4..].trim().to_string())
                .filter(|uid| !uid.is_empty());
            let (uid, done) = match uid {
                Some(uid) => (uid, done),
                None => {
                    anonymous += 1;
                    let uid = format!("imported-{anonymous}-{}", stable_hash(&done.join("\n")));
                    let mut with_uid = done;
                    with_uid.insert(1, format!("UID:{uid}"));
                    (uid, with_uid)
                }
            };
            let repeats = done.iter().any(|l| l.to_ascii_uppercase().starts_with("RRULE"));
            let entry = groups.entry(uid).or_default();
            entry.0.push(done);
            entry.1 |= repeats;
        }
    }
    Ok(groups
        .into_iter()
        .map(|(uid, (components, repeats))| {
            let mut lines = vec![
                "BEGIN:VCALENDAR".to_string(),
                "VERSION:2.0".into(),
                format!("PRODID:{}", super::ics::PRODID),
            ];
            for zone in &zones {
                lines.extend(zone.iter().cloned());
            }
            for component in components {
                lines.extend(component);
            }
            lines.push("END:VCALENDAR".into());
            let object = lines.iter().map(|l| super::ics::fold(l) + "\r\n").collect();
            Item { uid, object, repeats }
        })
        .collect())
}

/// A short, stable name for content, so a file without UIDs imports once.
fn stable_hash(text: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    digest.as_ref()[..6].iter().map(|b| format!("{b:02x}")).collect()
}

/// The events a local calendar keeps for an item: the event itself, or a
/// series' occurrences from `from` for [`LOCAL_YEARS`].
pub fn local_events(item: &Item, calendar_id: &str, from: i64) -> Result<(Vec<Event>, usize)> {
    let to = from + LOCAL_YEARS * 366 * 86_400;
    // A single event is kept whenever it falls (1970 to 2100); a series is
    // laid out from now on.
    let start = if item.repeats { from } else { 0 };
    let end = if item.repeats { to } else { 4_102_444_800 };
    let (events, skipped) = super::subscription::parse_window(&item.object, calendar_id, start, end)?;
    let events = events
        .into_iter()
        .map(|event| Event {
            id: format!("local:import:{}", event.id),
            calendar_id: calendar_id.to_string(),
            // A local calendar holds single events: there is no series to
            // edit, so none is claimed.
            is_recurring: false,
            series_id: None,
            ..event
        })
        .collect();
    Ok((events, skipped))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Summary {
    /// Events or series that would be (or were) added.
    pub added: usize,
    /// Already in the calendar: not added twice.
    pub duplicates: usize,
    /// Could not be read.
    pub skipped: usize,
    /// Of those added, how many repeat.
    pub series: usize,
}

#[cfg(test)]
mod tests;
