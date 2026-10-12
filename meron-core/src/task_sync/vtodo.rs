//! A task as a CalDAV server stores it: one VTODO (RFC 5545) in a calendar
//! object (ADR-0039).
//!
//! Reading takes the fields the Tasks view shows. Writing over an object
//! the server already has changes only the properties whose value differs
//! from that copy, line for line, and keeps everything else: other clients'
//! X- properties, categories, relations, time-zone definitions, alarms the
//! reminder did not change. A field this client cannot represent exactly
//! (a priority of 3, a due date in a named zone) is not rewritten unless
//! the person changed it here.

use anyhow::{bail, Result};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};

use crate::calendar::ics::{escape, fold, unfold, PRODID};

/// The fields the Tasks view edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fields {
    pub title: String,
    pub note: String,
    pub due_at: Option<i64>,
    /// 0 low, 1 normal, 2 high.
    pub priority: i64,
    pub completed_at: Option<i64>,
    pub reminder_at: Option<i64>,
}

impl Default for Fields {
    fn default() -> Self {
        Self { title: String::new(), note: String::new(), due_at: None, priority: 1, completed_at: None, reminder_at: None }
    }
}

/// One task read from a calendar object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Todo {
    pub uid: String,
    pub fields: Fields,
    pub created_at: Option<i64>,
    /// It repeats (`RRULE`/`RDATE`, or carries changed occurrences). Such a
    /// task is shown but not edited here: completing one occurrence of a
    /// series is not something this client writes yet.
    pub recurring: bool,
}

// ---- Lines -----------------------------------------------------------------

/// Where the value starts: the first colon outside a quoted parameter.
fn colon(line: &str) -> Option<usize> {
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some(i),
            _ => {}
        }
    }
    None
}

fn name_of(line: &str) -> String {
    let head = &line[..colon(line).unwrap_or(line.len())];
    head.split(';').next().unwrap_or_default().trim().to_ascii_uppercase()
}

fn value_of(line: &str) -> &str {
    colon(line).map(|i| &line[i + 1..]).unwrap_or_default()
}

fn param(line: &str, key: &str) -> Option<String> {
    let head = &line[..colon(line)?];
    head.split(';').skip(1).find_map(|part| {
        let (k, v) = part.split_once('=')?;
        k.trim().eq_ignore_ascii_case(key).then(|| v.trim().trim_matches('"').to_string())
    })
}

/// Undoes [`escape`].
pub fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

fn render(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&fold(line));
        out.push_str("\r\n");
    }
    out
}

fn utc(instant: i64) -> String {
    DateTime::<Utc>::from_timestamp(instant, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

/// A DATE or DATE-TIME value as an instant. A date is the start of that day
/// here; a time without a zone (floating) is read as local time; a zone the
/// time-zone database does not know is read as local time too.
fn time_value(line: &str) -> Option<i64> {
    let value = value_of(line).trim();
    let is_date = param(line, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE")) || value.len() == 8;
    if is_date {
        let day = NaiveDate::parse_from_str(value.get(..8)?, "%Y%m%d").ok()?;
        return Some(Local.from_local_datetime(&day.and_hms_opt(0, 0, 0)?).earliest()?.timestamp());
    }
    let (text, is_utc) = match value.strip_suffix('Z').or_else(|| value.strip_suffix('z')) {
        Some(text) => (text, true),
        None => (value, false),
    };
    let naive = NaiveDateTime::parse_from_str(text, "%Y%m%dT%H%M%S").ok()?;
    if is_utc {
        return Some(naive.and_utc().timestamp());
    }
    match param(line, "TZID").and_then(|zone| zone.parse::<chrono_tz::Tz>().ok()) {
        Some(tz) => Some(tz.from_local_datetime(&naive).earliest()?.timestamp()),
        None => Some(Local.from_local_datetime(&naive).earliest()?.timestamp()),
    }
}

/// `-PT15M`, `P1D`, `-P1W`, `PT1H30M`… in seconds, signed.
fn duration(value: &str) -> Option<i64> {
    let value = value.trim();
    let (sign, rest) = match value.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, value.strip_prefix('+').unwrap_or(value)),
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
                    ('W', false) => n * 7 * 86_400,
                    ('D', false) => n * 86_400,
                    ('H', true) => n * 3600,
                    ('M', true) => n * 60,
                    ('S', true) => n,
                    _ => return None,
                };
            }
        }
    }
    number.is_empty().then_some(sign * total)
}

/// PRIORITY 1–4 is high, 6–9 low, and 5, 0 or none normal (RFC 5545 §3.8.1.9).
fn priority_from(value: Option<i64>) -> i64 {
    match value {
        Some(1..=4) => 2,
        Some(6..=9) => 0,
        _ => 1,
    }
}

// ---- Components --------------------------------------------------------------

#[derive(Clone, Copy)]
struct Span {
    begin: usize,
    end: usize,
}

/// Every VTODO, outermost level, with whether it is an exception.
fn todos(lines: &[String]) -> Result<Vec<(Span, bool)>> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim().eq_ignore_ascii_case("BEGIN:VTODO") {
            let begin = i;
            let mut depth = 0usize;
            let mut end = None;
            for (j, line) in lines.iter().enumerate().skip(begin) {
                let upper = line.trim().to_ascii_uppercase();
                if upper.starts_with("BEGIN:") {
                    depth += 1;
                } else if upper.starts_with("END:") {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
            }
            let Some(end) = end else { bail!("a task in this object is not closed") };
            let span = Span { begin, end };
            let exception = own(lines, span).iter().any(|&k| name_of(&lines[k]) == "RECURRENCE-ID");
            found.push((span, exception));
            i = end + 1;
        } else {
            i += 1;
        }
    }
    Ok(found)
}

/// The indices of a component's own properties, not those of what it nests.
fn own(lines: &[String], span: Span) -> Vec<usize> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    for k in span.begin + 1..span.end {
        let upper = lines[k].trim().to_ascii_uppercase();
        if upper.starts_with("BEGIN:") {
            depth += 1;
        } else if upper.starts_with("END:") {
            depth = depth.saturating_sub(1);
        } else if depth == 0 {
            out.push(k);
        }
    }
    out
}

/// The alarms a component nests, as spans.
fn alarms(lines: &[String], span: Span) -> Vec<Span> {
    let mut out = Vec::new();
    let mut start = None;
    for k in span.begin + 1..span.end {
        let upper = lines[k].trim().to_ascii_uppercase();
        if upper == "BEGIN:VALARM" {
            start = Some(k);
        } else if upper == "END:VALARM" {
            if let Some(begin) = start.take() {
                out.push(Span { begin, end: k });
            }
        }
    }
    out
}

fn master(lines: &[String]) -> Result<(Span, bool)> {
    let found = todos(lines)?;
    let Some((span, _)) = found.iter().find(|(_, exception)| !exception) else {
        bail!("this object holds no task");
    };
    let repeats = found.len() > 1
        || own(lines, *span).iter().any(|&k| matches!(name_of(&lines[k]).as_str(), "RRULE" | "RDATE"));
    Ok((*span, repeats))
}

// ---- Reading -----------------------------------------------------------------

fn read(lines: &[String]) -> Result<Todo> {
    let (span, recurring) = master(lines)?;
    let props = own(lines, span);
    let get = |name: &str| props.iter().map(|&k| lines[k].as_str()).find(|line| name_of(line) == name);
    let text = |name: &str| get(name).map(|line| unescape(value_of(line))).unwrap_or_default();
    let due_at = get("DUE").and_then(time_value);
    let start = get("DTSTART").and_then(time_value);
    let status = get("STATUS").map(|line| value_of(line).trim().to_ascii_uppercase()).unwrap_or_default();
    let completed_at = match status.as_str() {
        "NEEDS-ACTION" | "IN-PROCESS" => None,
        _ => match get("COMPLETED").and_then(time_value) {
            Some(at) => Some(at),
            None if matches!(status.as_str(), "COMPLETED" | "CANCELLED") => Some(
                get("LAST-MODIFIED").or_else(|| get("DTSTAMP")).and_then(time_value).unwrap_or_default(),
            ),
            None => None,
        },
    };
    let reminder_at = alarms(lines, span).into_iter().find_map(|alarm| {
        let trigger = (alarm.begin + 1..alarm.end).map(|k| lines[k].as_str()).find(|l| name_of(l) == "TRIGGER")?;
        if param(trigger, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE-TIME")) {
            return time_value(trigger);
        }
        let offset = duration(value_of(trigger))?;
        let anchor = if param(trigger, "RELATED").is_some_and(|v| v.eq_ignore_ascii_case("END")) {
            due_at
        } else {
            start.or(due_at)
        };
        Some(anchor? + offset)
    });
    Ok(Todo {
        uid: get("UID").map(|line| value_of(line).trim().to_string()).unwrap_or_default(),
        fields: Fields {
            title: text("SUMMARY"),
            note: text("DESCRIPTION"),
            due_at,
            priority: priority_from(get("PRIORITY").and_then(|line| value_of(line).trim().parse().ok())),
            completed_at,
            reminder_at,
        },
        created_at: get("CREATED").and_then(time_value),
        recurring,
    })
}

/// The task a calendar object holds.
pub fn parse(ics: &str) -> Result<Todo> {
    read(&unfold(ics))
}

// ---- Writing -----------------------------------------------------------------

/// Sets one of the task's own properties: replaces the first line of that
/// name and drops the others, or adds it before any nested component; with
/// `None`, removes it.
fn set(lines: &mut Vec<String>, name: &str, line: Option<String>) -> Result<()> {
    let (span, _) = master(lines)?;
    let matching: Vec<usize> = own(lines, span).into_iter().filter(|&k| name_of(&lines[k]) == name).collect();
    match (line, matching.first()) {
        (Some(line), Some(&first)) => {
            lines[first] = line;
            for &k in matching.iter().skip(1).rev() {
                lines.remove(k);
            }
        }
        (Some(line), None) => {
            let at = (span.begin + 1..span.end)
                .find(|&k| lines[k].trim().to_ascii_uppercase().starts_with("BEGIN:"))
                .unwrap_or(span.end);
            lines.insert(at, line);
        }
        (None, _) => {
            for &k in matching.iter().rev() {
                lines.remove(k);
            }
        }
    }
    Ok(())
}

fn get_own(lines: &[String], name: &str) -> Result<Option<String>> {
    let (span, _) = master(lines)?;
    Ok(own(lines, span).into_iter().map(|k| lines[k].clone()).find(|line| name_of(line) == name))
}

/// A due instant at midnight here is a date (`VALUE=DATE`); any other is a
/// time, in UTC.
fn due_line(instant: i64) -> String {
    match Local.timestamp_opt(instant, 0).single() {
        Some(local) if local.num_seconds_from_midnight() == 0 => {
            format!("DUE;VALUE=DATE:{}", local.format("%Y%m%d"))
        }
        _ => format!("DUE:{}", utc(instant)),
    }
}

/// Writes `after` over the lines, changing only what differs from `before`.
fn apply(lines: &mut Vec<String>, before: &Fields, after: &Fields, now: i64, bump: bool) -> Result<()> {
    if before.title != after.title {
        let line = (!after.title.is_empty()).then(|| format!("SUMMARY:{}", escape(&after.title)));
        set(lines, "SUMMARY", line)?;
    }
    if before.note != after.note {
        let line = (!after.note.is_empty()).then(|| format!("DESCRIPTION:{}", escape(&after.note)));
        set(lines, "DESCRIPTION", line)?;
    }
    if before.due_at != after.due_at {
        set(lines, "DUE", after.due_at.map(due_line))?;
    }
    if before.priority != after.priority {
        let line = match after.priority {
            2 => Some("PRIORITY:1".to_string()),
            0 => Some("PRIORITY:9".to_string()),
            _ => None,
        };
        set(lines, "PRIORITY", line)?;
    }
    if before.completed_at != after.completed_at {
        match after.completed_at {
            Some(at) => {
                set(lines, "STATUS", Some("STATUS:COMPLETED".into()))?;
                set(lines, "COMPLETED", Some(format!("COMPLETED:{}", utc(at))))?;
                if get_own(lines, "PERCENT-COMPLETE")?.is_some() {
                    set(lines, "PERCENT-COMPLETE", Some("PERCENT-COMPLETE:100".into()))?;
                }
            }
            None => {
                set(lines, "STATUS", Some("STATUS:NEEDS-ACTION".into()))?;
                set(lines, "COMPLETED", None)?;
                set(lines, "PERCENT-COMPLETE", None)?;
            }
        }
    }
    if before.reminder_at != after.reminder_at {
        let (span, _) = master(lines)?;
        for alarm in alarms(lines, span).into_iter().rev() {
            lines.drain(alarm.begin..=alarm.end);
        }
        if let Some(at) = after.reminder_at {
            let (span, _) = master(lines)?;
            let title = if after.title.is_empty() { "Reminder" } else { after.title.as_str() };
            let alarm = [
                "BEGIN:VALARM".to_string(),
                "ACTION:DISPLAY".into(),
                format!("DESCRIPTION:{}", escape(title)),
                format!("TRIGGER;VALUE=DATE-TIME:{}", utc(at)),
                "END:VALARM".into(),
            ];
            for (offset, line) in alarm.into_iter().enumerate() {
                lines.insert(span.end + offset, line);
            }
        }
    }
    set(lines, "DTSTAMP", Some(format!("DTSTAMP:{}", utc(now))))?;
    set(lines, "LAST-MODIFIED", Some(format!("LAST-MODIFIED:{}", utc(now))))?;
    if bump {
        let sequence = get_own(lines, "SEQUENCE")?
            .and_then(|line| value_of(&line).trim().parse::<i64>().ok())
            .map(|n| n + 1)
            .unwrap_or(1);
        set(lines, "SEQUENCE", Some(format!("SEQUENCE:{sequence}")))?;
    }
    Ok(())
}

/// The object as the server has it (`ics`), with the task's fields written
/// over it. Only the properties whose value changed are touched.
pub fn patch(ics: &str, fields: &Fields, now: i64) -> Result<String> {
    let mut lines = unfold(ics);
    let before = read(&lines)?;
    if before.recurring {
        bail!("this task repeats; change it in the app that made it");
    }
    apply(&mut lines, &before.fields, fields, now, true)?;
    Ok(render(&lines))
}

/// A new calendar object holding one task.
pub fn new_object(fields: &Fields, uid: &str, now: i64) -> String {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        format!("PRODID:{PRODID}"),
        "BEGIN:VTODO".into(),
        format!("UID:{uid}"),
        format!("CREATED:{}", utc(now)),
        "SEQUENCE:0".into(),
        "STATUS:NEEDS-ACTION".into(),
        "END:VTODO".into(),
        "END:VCALENDAR".into(),
    ];
    // The skeleton has nothing to keep, so every set field is written.
    apply(&mut lines, &Fields::default(), fields, now, false).expect("a skeleton holds a task");
    render(&lines)
}

#[cfg(test)]
mod tests;
