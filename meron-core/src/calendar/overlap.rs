//! Which of the person's own events a proposed time falls on (ADR-0043).
//!
//! A local check over the events kept here, across every account: no server
//! is asked, so it says only what this copy of the calendar knows.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::Event;

/// One kept event a proposed time overlaps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Overlap {
    pub account: String,
    pub calendar_id: String,
    pub event_id: String,
    pub subject: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
}

/// Text matched literally by a LIKE with `ESCAPE '\'`.
pub fn like_escaped(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Whether an occurrence belongs to the event named by `key`: its own id,
/// its series, or the iCalendar UID its id was made from (`uid@start`,
/// `local:import:uid@start`).
pub fn is_of(event: &Event, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let from_uid = |id: &str| {
        let id = id.strip_prefix("local:import:").unwrap_or(id);
        super::ics::occurrence_of(id).is_some_and(|(uid, _)| uid == key)
    };
    event.id == key || event.series_id.as_deref() == Some(key) || from_uid(&event.id)
}

/// The proposed range and a kept event, compared as the person reads them.
///
/// All-day events are dates kept at midnight UTC; a timed range is an
/// instant. `offset` (seconds east of UTC, the person's zone at that time)
/// puts a timed range on the same footing as a date, so an all-day event
/// counts only when the proposed time touches its day where the person is.
fn overlaps(start: i64, end: i64, all_day: bool, offset: i64, event: &Event) -> bool {
    let (s, e, es, ee) = match (all_day, event.all_day) {
        (false, true) => (start + offset, end + offset, event.start, event.end),
        (true, false) => (start, end, event.start + offset, event.end + offset),
        _ => (start, end, event.start, event.end),
    };
    // A zero-length event still sits at its instant.
    let ee = ee.max(es + 1);
    s < ee && e > es
}

/// The person's own events overlapping `[start, end)`, earliest first: every
/// account's calendars (or one account's), except subscriptions, which are
/// someone else's. Cancelled events, free (transparent) ones, ones the
/// person declined and the event being proposed or edited (`exclude`: ids,
/// series ids or UIDs) do not count.
pub fn overlapping(
    conn: &Connection,
    account: Option<&str>,
    start: i64,
    end: i64,
    all_day: bool,
    offset: i64,
    exclude: &[String],
) -> Result<Vec<Overlap>> {
    if end <= start {
        return Ok(Vec::new());
    }
    // Wide enough for any zone; the exact test is below.
    let margin = 2 * 86_400;
    let mut stmt = conn.prepare(&format!(
        "SELECT e.account, {}
         FROM calendar_events e
         JOIN calendars c
           ON c.account = e.account AND c.provider_id = e.calendar_id
         WHERE (?1 IS NULL OR e.account = ?1) AND c.kind != 'subscribed'
           AND e.is_cancelled = 0
           AND lower(coalesce(e.free_busy, '')) != 'free'
           AND lower(coalesce(e.my_response, '')) != 'decline'
           AND e.end_utc > ?2 AND e.start_utc < ?3
         ORDER BY e.start_utc, e.subject, e.account, e.event_id",
        super::EVENT_COLUMNS
    ))?;
    let rows = stmt
        .query_map(params![account, start - margin, end + margin], |row| {
            let account: String = row.get(0)?;
            Ok((account, super::event_row_at(row, 1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, event)| overlaps(start, end, all_day, offset, event))
        .filter(|(_, event)| !exclude.iter().any(|key| is_of(event, key)))
        .map(|(account, event)| Overlap {
            account,
            calendar_id: event.calendar_id,
            event_id: event.id,
            subject: event.subject,
            start: event.start,
            end: event.end,
            all_day: event.all_day,
        })
        .collect())
}

#[cfg(test)]
mod tests;
