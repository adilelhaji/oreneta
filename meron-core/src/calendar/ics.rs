//! Writing iCalendar (RFC 5545) for servers that store it as it is: CalDAV
//! (#101) and files the person saves (`.ics` export).
//!
//! A new event is written whole. An existing one is patched: the properties
//! this client edits are replaced and everything else — attendees, the
//! organizer, other clients' X- properties, the time-zone definitions — is
//! kept line for line, so saving here never strips what another program put
//! there.
//!
//! Times: a single event is written in UTC. A series is written in a named
//! zone (the one it already had, or this computer's), because a rule is
//! expanded in local time and a series in UTC would move an hour at every
//! clock change.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, TimeZone, Utc};

use super::{Event, Recurrence};

pub const PRODID: &str = "-//Oreneta//Oreneta Calendar//EN";

/// Escapes a TEXT value (RFC 5545 §3.3.11).
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

/// Folds a content line at 75 octets without splitting a character.
pub fn fold(line: &str) -> String {
    if line.len() <= 75 {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + line.len() / 74 * 3);
    let mut width = 0usize;
    let mut first = true;
    for c in line.chars() {
        let limit = if first { 75 } else { 74 };
        if width + c.len_utf8() > limit {
            out.push_str("\r\n ");
            width = 0;
            first = false;
        }
        out.push(c);
        width += c.len_utf8();
    }
    out
}

/// Joins folded continuation lines and splits on line ends.
pub fn unfold(ics: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in ics.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix(' ').or_else(|| raw.strip_prefix('\t')) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        if !raw.is_empty() {
            lines.push(raw.to_string());
        }
    }
    lines
}

fn render(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&fold(line));
        out.push_str("\r\n");
    }
    out
}

/// The property name of a content line, upper-cased, without parameters.
fn name_of(line: &str) -> String {
    let end = line.find([':', ';']).unwrap_or(line.len());
    line[..end].to_ascii_uppercase()
}

fn utc(instant: i64) -> String {
    DateTime::<Utc>::from_timestamp(instant, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

fn date(instant: i64) -> String {
    DateTime::<Utc>::from_timestamp(instant, 0).unwrap_or_default().format("%Y%m%d").to_string()
}

/// `DTSTART`/`DTEND`/`RECURRENCE-ID`/`EXDATE` for an instant: a date for an
/// all-day event, local time in `zone` when one is given, UTC otherwise.
fn time_property(name: &str, instant: i64, all_day: bool, zone: Option<&str>) -> String {
    if all_day {
        return format!("{name};VALUE=DATE:{}", date(instant));
    }
    // A UTC zone gains nothing from a TZID, and servers rewrite the pair
    // into a form some readers reject.
    let zone = zone.filter(|zone| !matches!(*zone, "UTC" | "Etc/UTC" | "Etc/GMT" | "GMT" | "Etc/Universal" | "Universal" | "Zulu" | "Etc/Zulu"));
    if let Some(tz) = zone.and_then(|zone| zone.parse::<chrono_tz::Tz>().ok()) {
        if let Some(local) = tz.timestamp_opt(instant, 0).single() {
            return format!("{name};TZID={}:{}", tz.name(), local.format("%Y%m%dT%H%M%S"));
        }
    }
    format!("{name}:{}", utc(instant))
}

/// The TZID a property line names, if any.
fn tzid_of(line: &str) -> Option<String> {
    let params = &line[..line.find(':')?];
    params
        .split(';')
        .skip(1)
        .find_map(|param| param.strip_prefix("TZID=").map(|zone| zone.trim_matches('"').to_string()))
}

/// The reminder as an alarm, or nothing.
fn alarm(minutes: Option<i64>, subject: &str) -> Vec<String> {
    let Some(minutes) = minutes.filter(|minutes| *minutes >= 0) else {
        return Vec::new();
    };
    vec![
        "BEGIN:VALARM".into(),
        "ACTION:DISPLAY".into(),
        format!("DESCRIPTION:{}", escape(if subject.is_empty() { "Reminder" } else { subject })),
        format!("TRIGGER:-PT{minutes}M"),
        "END:VALARM".into(),
    ]
}

/// The lines this client owns on an event, in a stable order.
fn owned_lines(event: &Event, zone: Option<&str>, now: i64) -> Vec<String> {
    let end = if event.all_day && event.end <= event.start { event.start + 86_400 } else { event.end };
    let mut lines = vec![
        format!("DTSTAMP:{}", utc(now)),
        time_property("DTSTART", event.start, event.all_day, zone),
        time_property("DTEND", end, event.all_day, zone),
        format!("SUMMARY:{}", escape(&event.subject)),
    ];
    if let Some(location) = event.location.as_deref().filter(|l| !l.trim().is_empty()) {
        lines.push(format!("LOCATION:{}", escape(location)));
    }
    if !event.description.trim().is_empty() {
        lines.push(format!("DESCRIPTION:{}", escape(&event.description)));
    }
    lines
}

/// Properties replaced when an event is edited here.
const OWNED: &[&str] = &["DTSTAMP", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION", "DESCRIPTION", "LAST-MODIFIED"];

fn rrule_line(rule: &Recurrence, start: i64, all_day: bool) -> Option<String> {
    super::google::rrule(rule, start, all_day)
}

/// A new calendar object holding one event (and its rule, when it repeats).
pub fn new_object(event: &Event, uid: &str, now: i64) -> String {
    let zone = event.recurrence.as_ref().map(|_| super::google::local_timezone());
    new_object_in(event, uid, now, zone.as_deref())
}

/// [`new_object`] with the zone a series is written in named.
pub fn new_object_in(event: &Event, uid: &str, now: i64, zone: Option<&str>) -> String {
    let zone = event.recurrence.as_ref().and(zone).map(str::to_string);
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        format!("PRODID:{PRODID}"),
        "BEGIN:VEVENT".into(),
        format!("UID:{uid}"),
    ];
    lines.extend(owned_lines(event, zone.as_deref(), now));
    lines.push("SEQUENCE:0".into());
    if let Some(rule) = event.recurrence.as_ref().and_then(|rule| rrule_line(rule, event.start, event.all_day)) {
        lines.push(rule);
    }
    lines.extend(alarm(event.reminder_minutes, &event.subject));
    lines.push("END:VEVENT".into());
    lines.push("END:VCALENDAR".into());
    render(&lines)
}

/// Where each VEVENT of an object starts and ends, with its RECURRENCE-ID
/// line when it has one.
struct Component {
    begin: usize,
    end: usize,
    recurrence_id: Option<String>,
    uid: String,
}

fn components(lines: &[String]) -> Result<Vec<Component>> {
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut current: Option<Component> = None;
    for (index, line) in lines.iter().enumerate() {
        let upper = line.to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            current = Some(Component { begin: index, end: index, recurrence_id: None, uid: String::new() });
            depth = 0;
        } else if upper.starts_with("BEGIN:") && current.is_some() {
            depth += 1;
        } else if upper.starts_with("END:") && current.is_some() && depth > 0 {
            depth -= 1;
        } else if upper == "END:VEVENT" {
            let mut component = current.take().context("the calendar object is damaged")?;
            component.end = index;
            found.push(component);
        } else if let Some(component) = current.as_mut().filter(|_| depth == 0) {
            match name_of(line).as_str() {
                "RECURRENCE-ID" => component.recurrence_id = Some(line.clone()),
                "UID" => component.uid = line[line.find(':').map_or(line.len(), |i| i + 1)..].to_string(),
                _ => {}
            }
        }
    }
    if found.is_empty() {
        bail!("the calendar object holds no event");
    }
    Ok(found)
}

/// The instant a RECURRENCE-ID or EXDATE value names, read loosely: UTC,
/// floating or date. Enough to match an occurrence this client wrote or read.
fn instant_of(line: &str) -> Option<i64> {
    let value = &line[line.find(':')? + 1..];
    let zone = tzid_of(line).and_then(|zone| zone.parse::<chrono_tz::Tz>().ok());
    let first = value.split(',').next()?.trim();
    if first.len() == 8 {
        let day = chrono::NaiveDate::parse_from_str(first, "%Y%m%d").ok()?;
        return Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp());
    }
    let (text, is_utc) = match first.strip_suffix('Z') {
        Some(text) => (text, true),
        None => (first, false),
    };
    let naive = chrono::NaiveDateTime::parse_from_str(text, "%Y%m%dT%H%M%S").ok()?;
    if is_utc {
        return Some(naive.and_utc().timestamp());
    }
    match zone {
        Some(tz) => Some(tz.from_local_datetime(&naive).earliest()?.timestamp()),
        None => Some(chrono::Local.from_local_datetime(&naive).earliest()?.timestamp()),
    }
}

/// The series an event belongs to and the occurrence it stands for, from the
/// id this client gives CalDAV occurrences (`{uid}@{start}`).
pub fn occurrence_of(id: &str) -> Option<(&str, i64)> {
    let (uid, start) = id.rsplit_once('@')?;
    Some((uid, start.parse().ok()?))
}

fn master(components: &[Component]) -> Result<&Component> {
    components.iter().find(|c| c.recurrence_id.is_none()).context("the series has no main event")
}

fn bump_sequence(lines: &mut Vec<String>, at: &Component) {
    let found = (at.begin..at.end).find(|&i| name_of(&lines[i]) == "SEQUENCE");
    match found {
        Some(i) => {
            let next = lines[i].split(':').nth(1).and_then(|n| n.trim().parse::<i64>().ok()).unwrap_or(0) + 1;
            lines[i] = format!("SEQUENCE:{next}");
        }
        None => lines.insert(at.begin + 1, "SEQUENCE:1".into()),
    }
}

/// Replaces the owned properties (and alarms) inside one component.
fn rewrite(lines: &[String], at: &Component, replacement: Vec<String>, keep_rule: bool, rule: Option<String>) -> Vec<String> {
    let mut body: Vec<String> = Vec::new();
    let mut depth = 0usize;
    let mut in_alarm = false;
    for line in &lines[at.begin + 1..at.end] {
        let upper = line.to_ascii_uppercase();
        if upper == "BEGIN:VALARM" {
            in_alarm = true;
            continue;
        }
        if in_alarm {
            if upper == "END:VALARM" {
                in_alarm = false;
            }
            continue;
        }
        if upper.starts_with("BEGIN:") {
            depth += 1;
        } else if upper.starts_with("END:") && depth > 0 {
            depth -= 1;
        }
        let name = name_of(line);
        if depth == 0 && (OWNED.contains(&name.as_str()) || (name == "RRULE" && !keep_rule)) {
            continue;
        }
        body.push(line.clone());
    }
    let mut out = lines[..=at.begin].to_vec();
    // UID first, as is customary; then what was kept; then what was written.
    out.extend(body);
    out.extend(replacement);
    if let Some(rule) = rule {
        out.push(rule);
    }
    out.extend(lines[at.end..].iter().cloned());
    out
}

/// An edit of a single event, or of a whole series. For a series the edit
/// is made on the occurrence the person opened and carried to the series as
/// a shift: the series keeps its first date, and only the time, duration and
/// text change. `recurrence` replaces the rule when given.
pub fn patch_event(ics: &str, event: &Event, whole_series: bool, now: i64) -> Result<String> {
    let lines = unfold(ics);
    let found = components(&lines)?;
    let main = master(&found)?;
    let zone_line = lines[main.begin..main.end].iter().find(|line| name_of(line) == "DTSTART").cloned();
    let zone = zone_line.as_deref().and_then(tzid_of);
    let mut edited = event.clone();
    let is_series = lines[main.begin..main.end].iter().any(|line| name_of(line) == "RRULE") || event.recurrence.is_some();
    if is_series && whole_series {
        let original = occurrence_of(&event.id).map(|(_, start)| start).unwrap_or(event.start);
        let first = zone_line.as_deref().and_then(instant_of).unwrap_or(original);
        let shift = event.start - original;
        edited.start = first + shift;
        edited.end = edited.start + (event.end - event.start);
    }
    let zone = if is_series { zone.or_else(|| Some(super::google::local_timezone())) } else { None };
    let mut replacement = owned_lines(&edited, zone.as_deref(), now);
    replacement.extend(alarm(event.reminder_minutes, &event.subject));
    let rule = event.recurrence.as_ref().and_then(|rule| rrule_line(rule, edited.start, edited.all_day));
    let keep_rule = rule.is_none();
    let mut out = rewrite(&lines, main, replacement, keep_rule, rule);
    let again = components(&out)?;
    bump_sequence(&mut out, master(&again)?);
    Ok(render(&out))
}

/// One occurrence of a series changed on its own: an exception component
/// with the occurrence's RECURRENCE-ID, replacing any earlier one.
pub fn put_override(ics: &str, event: &Event, now: i64) -> Result<String> {
    let (uid, original) = occurrence_of(&event.id).context("this is not an occurrence of a series")?;
    let lines = unfold(ics);
    let found = components(&lines)?;
    let main = master(&found)?;
    let zone = lines[main.begin..main.end].iter().find(|line| name_of(line) == "DTSTART").and_then(|line| tzid_of(line));
    let mut out = without_override(&lines, &found, original);
    let kept_people: Vec<String> = lines[main.begin..main.end]
        .iter()
        .filter(|line| matches!(name_of(line).as_str(), "ORGANIZER" | "ATTENDEE"))
        .cloned()
        .collect();
    let mut component = vec!["BEGIN:VEVENT".to_string(), format!("UID:{uid}")];
    component.push(time_property("RECURRENCE-ID", original, event.all_day, zone.as_deref()));
    component.extend(owned_lines(event, zone.as_deref(), now));
    component.push("SEQUENCE:1".into());
    component.extend(kept_people);
    component.extend(alarm(event.reminder_minutes, &event.subject));
    component.push("END:VEVENT".into());
    let close = out.iter().rposition(|line| line.eq_ignore_ascii_case("END:VCALENDAR")).context("the calendar object is damaged")?;
    out.splice(close..close, component);
    Ok(render(&out))
}

fn without_override(lines: &[String], found: &[Component], original: i64) -> Vec<String> {
    let drop: Vec<&Component> = found
        .iter()
        .filter(|c| c.recurrence_id.as_deref().and_then(instant_of) == Some(original))
        .collect();
    lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !drop.iter().any(|c| *i >= c.begin && *i <= c.end))
        .map(|(_, line)| line.clone())
        .collect()
}

/// One occurrence removed from a series: an EXDATE on the series, and any
/// exception for that occurrence dropped.
pub fn exclude_occurrence(ics: &str, id: &str, all_day: bool) -> Result<String> {
    let (_, original) = occurrence_of(id).context("this is not an occurrence of a series")?;
    let lines = unfold(ics);
    let found = components(&lines)?;
    let mut out = without_override(&lines, &found, original);
    let again = components(&out)?;
    let main = master(&again)?;
    let zone = out[main.begin..main.end].iter().find(|line| name_of(line) == "DTSTART").and_then(|line| tzid_of(line));
    let exdate = time_property("EXDATE", original, all_day, zone.as_deref());
    let at = main.end;
    out.insert(at, exdate);
    let again = components(&out)?;
    bump_sequence(&mut out, master(&again)?);
    Ok(render(&out))
}

/// The reminders an object's events carry, by UID: the first relative alarm
/// before the start, in minutes.
pub fn reminders(ics: &str) -> std::collections::HashMap<String, i64> {
    let lines = unfold(ics);
    let mut out = std::collections::HashMap::new();
    let Ok(found) = components(&lines) else { return out };
    for component in found.iter().filter(|c| c.recurrence_id.is_none()) {
        let trigger = lines[component.begin..component.end]
            .iter()
            .find(|line| name_of(line) == "TRIGGER" && !line.to_ascii_uppercase().contains("VALUE=DATE-TIME"))
            .and_then(|line| line.split(':').nth(1))
            .and_then(minutes_before);
        if let Some(minutes) = trigger {
            out.insert(component.uid.clone(), minutes);
        }
    }
    out
}

/// `-PT15M`, `-P1D`, `-PT1H30M`, `PT0S`… as minutes before the start.
fn minutes_before(value: &str) -> Option<i64> {
    let value = value.trim();
    let (negative, rest) = match value.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };
    let rest = rest.strip_prefix('P')?;
    let (mut total, mut number, mut in_time) = (0i64, String::new(), false);
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            d if d.is_ascii_digit() => number.push(d),
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                total += match (unit, in_time) {
                    ('W', false) => n * 7 * 1440,
                    ('D', false) => n * 1440,
                    ('H', true) => n * 60,
                    ('M', true) => n,
                    ('S', true) => n / 60,
                    _ => return None,
                };
            }
        }
    }
    if !number.is_empty() {
        return None;
    }
    Some(if negative { total } else { -total }).filter(|m| *m >= 0)
}

/// Several events as one `.ics` file, each written whole.
pub fn export(events: &[Event], now: i64) -> String {
    let mut lines = vec!["BEGIN:VCALENDAR".to_string(), "VERSION:2.0".into(), format!("PRODID:{PRODID}")];
    for event in events {
        let uid = occurrence_of(&event.id).map(|(uid, _)| uid.to_string()).unwrap_or_else(|| event.id.clone());
        let body = unfold(&new_object(&Event { recurrence: None, ..event.clone() }, &uid, now));
        let begin = body.iter().position(|l| l == "BEGIN:VEVENT").unwrap_or(0);
        let end = body.iter().rposition(|l| l == "END:VEVENT").unwrap_or(body.len() - 1);
        let mut component = body[begin..=end].to_vec();
        if event.is_recurring {
            // Each occurrence stands alone in an export: the rule lives on the
            // server, and a file of occurrences opens the same everywhere.
            if let Some(i) = component.iter().position(|l| l.starts_with("UID:")) {
                component[i] = format!("UID:{}", escape(&event.id));
            }
        }
        lines.extend(component);
    }
    lines.push("END:VCALENDAR".into());
    render(&lines)
}

#[cfg(test)]
mod tests;
