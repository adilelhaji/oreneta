//! Subscribed calendars: a published iCalendar file, fetched over HTTPS.
//!
//! Everywhere else a server expands recurring series for us, which is what
//! keeps recurrence rules out of this codebase. A published file has no server
//! behind it — it carries the rules themselves — so they have to be expanded
//! here. That work is delegated to an RFC 5545 implementation rather than
//! hand-rolled: recurrence with its exception dates, and the daylight-saving
//! transitions a series crosses, is exactly the arithmetic that looks simple
//! and is not.
//!
//! A subscription is read-only. The file belongs to whoever publishes it, and
//! there is nothing to write back to.

use anyhow::{Context as _, Result};
// `rrule` is reached through icalendar's reexport rather than as a direct
// dependency, so the two can never drift apart in version.
use icalendar::Tz as RRuleTz;
use icalendar::{Component, EventLike};

use super::{Event, Participant};

/// Cap on one fetch. A calendar file is small; a URL that streams forever is
/// not a calendar.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Cap on the occurrences one series may contribute to a window, so a rule
/// with no end cannot fill the store.
const MAX_OCCURRENCES: u16 = 512;

/// Downloads a calendar file.
///
/// Blocking, like the rest of the crate's HTTP; callers wrap it in
/// `spawn_blocking`. Goes through the shared proxy-aware agent, so a
/// subscription honours the app's proxy like everything else.
pub fn fetch(url: &str) -> Result<String> {
    let mut response = crate::proxy::agent()?
        .get(url)
        .config()
        .http_status_as_error(false)
        .timeout_global(Some(FETCH_TIMEOUT))
        .build()
        .call()
        .with_context(|| format!("fetch calendar {url}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        anyhow::bail!("calendar {url} answered HTTP {status}");
    }
    response
        .body_mut()
        .read_to_string()
        .with_context(|| format!("read calendar {url}"))
}

/// Accepts the URL forms calendar links come in. `webcal://` and `webcals://`
/// are how most sites publish a subscription link (so a click opens a
/// calendar app); they are plain HTTPS underneath.
pub fn normalize_url(url: &str) -> Result<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    for scheme in ["webcals://", "webcal://"] {
        if lower.starts_with(scheme) {
            return Ok(format!("https://{}", &url[scheme.len()..]));
        }
    }
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Ok(url.to_string());
    }
    anyhow::bail!("a subscription needs an http(s) or webcal URL")
}

/// Parses a calendar file and returns the occurrences falling in a window,
/// with recurring series expanded.
///
/// A component that cannot be read is skipped rather than failing the file: a
/// published calendar is written by someone else's software, and one malformed
/// entry should not cost the user every other appointment in it.
///
/// RFC 5545 identifies a series by its UID. The component without a
/// `RECURRENCE-ID` is the series; a component with one replaces the single
/// occurrence it names (moved, renamed, or `STATUS:CANCELLED`). Expanding each
/// component on its own showed a moved occurrence twice and a cancelled one
/// anyway.
pub fn parse_window(
    body: &str,
    calendar_id: &str,
    from: i64,
    to: i64,
) -> Result<(Vec<Event>, usize)> {
    let body = with_iana_tzids(body);
    let parsed: icalendar::Calendar = body
        .parse()
        .map_err(|err: String| anyhow::anyhow!("parse calendar: {err}"))?;

    let mut events = Vec::new();
    let mut skipped = 0usize;
    let mut series = Vec::new();
    let mut overrides: std::collections::HashMap<String, Vec<(i64, &icalendar::Event)>> =
        std::collections::HashMap::new();
    for component in parsed.components.iter() {
        let icalendar::CalendarComponent::Event(source) = component else {
            continue;
        };
        match source.get_recurrence_id() {
            None => series.push(source),
            Some(id) => match instant(&id) {
                Some(original) => overrides
                    .entry(source.get_uid().unwrap_or_default().to_string())
                    .or_default()
                    .push((original, source)),
                None => skipped += 1,
            },
        }
    }

    for source in series {
        let uid = source.get_uid().unwrap_or_default();
        let replaced: std::collections::HashSet<i64> = overrides
            .get(uid)
            .map(|list| list.iter().map(|(original, _)| *original).collect())
            .unwrap_or_default();
        match expand(source, calendar_id, from, to, &replaced) {
            Ok(mut occurrences) => events.append(&mut occurrences),
            Err(_) => skipped += 1,
        }
    }
    for (uid, list) in &overrides {
        for (original, source) in list {
            if is_cancelled(source) {
                // It exists to remove its occurrence, which expand() left out.
                continue;
            }
            match single(source, calendar_id, uid, *original, from, to) {
                Ok(Some(event)) => events.push(event),
                Ok(None) => {}
                Err(_) => skipped += 1,
            }
        }
    }
    Ok((events, skipped))
}

/// Longest an occurrence is looked back for: one that began before the window
/// but still runs into it belongs in it.
const MAX_LOOKBACK: i64 = 31 * 24 * 3600;

/// Expands one series into the occurrences that overlap the window, leaving
/// out those a `RECURRENCE-ID` component replaces.
fn expand(
    source: &icalendar::Event,
    calendar_id: &str,
    from: i64,
    to: i64,
    replaced: &std::collections::HashSet<i64>,
) -> Result<Vec<Event>> {
    let uid = source.get_uid().unwrap_or_default().to_string();
    // The duration is taken from the first instance and applied to each
    // occurrence: RFC 5545 defines a series as one shape repeated, and this is
    // what keeps a two-hour meeting two hours long on every date.
    let (first_start, first_end) = span(source)?;
    let duration = (first_end - first_start).max(0);
    let all_day = is_all_day(source);

    let recurrence = source
        .get_recurrence()
        .map_err(|err| anyhow::anyhow!("recurrence: {err}"))?;
    let repeats = uid_repeats(source);
    let lookback = duration.max(if all_day { 24 * 3600 } else { 0 }).min(MAX_LOOKBACK);
    let after = chrono::DateTime::from_timestamp(from - lookback - 1, 0).context("window start")?;
    let before = chrono::DateTime::from_timestamp(to, 0).context("window end")?;
    let expanded = recurrence
        .after(after.with_timezone(&RRuleTz::UTC))
        .before(before.with_timezone(&RRuleTz::UTC))
        .all(MAX_OCCURRENCES);

    Ok(expanded
        .dates
        .into_iter()
        .filter_map(|occurrence| {
            // rrule places a date-only start at local midnight of the
            // machine; the calendar reads all-day events as UTC dates, so the
            // date itself is what is kept, not that instant. East of UTC the
            // instant fell on the previous UTC day.
            let start = if all_day {
                occurrence.date_naive().and_hms_opt(0, 0, 0)?.and_utc().timestamp()
            } else {
                occurrence.timestamp()
            };
            if replaced.contains(&start) || !overlaps(start, start + duration, from, to) {
                return None;
            }
            Some(event_from(source, calendar_id, &uid, start, start + duration, all_day, repeats))
        })
        .collect())
}

/// One component standing for a single occurrence of a series it replaces.
fn single(
    source: &icalendar::Event,
    calendar_id: &str,
    uid: &str,
    original: i64,
    from: i64,
    to: i64,
) -> Result<Option<Event>> {
    let (start, end) = span(source)?;
    if !overlaps(start, end, from, to) {
        return Ok(None);
    }
    let mut event = event_from(source, calendar_id, uid, start, end, is_all_day(source), true);
    // Identified by the occurrence it replaces, so moving it again in the file
    // updates the same row instead of adding one.
    event.id = format!("{uid}@{original}");
    Ok(Some(event))
}

fn overlaps(start: i64, end: i64, from: i64, to: i64) -> bool {
    start < to && (end > from || (end == start && start >= from))
}

fn event_from(
    source: &icalendar::Event,
    calendar_id: &str,
    uid: &str,
    start: i64,
    end: i64,
    all_day: bool,
    repeats: bool,
) -> Event {
    let organizer = source.multi_properties().get("ORGANIZER").and_then(|list| {
        list.first().map(|property| Participant {
            name: property
                .params()
                .get("CN")
                .map(|param| param.value().to_string())
                .unwrap_or_default(),
            addr: property.value().trim_start_matches("mailto:").to_string(),
            response: String::new(),
        })
    });
    Event {
        // An occurrence is identified by its series and its instant: the file
        // gives one UID for the whole series, so a per-date suffix is what
        // keeps two dates from being one row.
        id: format!("{uid}@{start}"),
        calendar_id: calendar_id.to_string(),
        change_key: None,
        subject: source.get_summary().unwrap_or_default().to_string(),
        location: source.get_location().map(str::to_string),
        start,
        end,
        all_day,
        is_recurring: repeats,
        series_id: repeats.then(|| uid.to_string()),
        recurrence: None,
        description: super::plain_notes(source.get_description().unwrap_or_default()),
        // A published file's alarms belong to whoever publishes it, and this
        // client cannot act on them from a read-only subscription; reporting
        // one it will never raise would be a promise it cannot keep.
        reminder_minutes: None,
        is_cancelled: is_cancelled(source),
        // A subscription is read-only and its publisher decides what these
        // mean; reporting a response we cannot give would be inventing one.
        free_busy: String::new(),
        my_response: String::new(),
        organizer,
        attendees: Vec::new(),
    }
}

fn is_cancelled(source: &icalendar::Event) -> bool {
    source
        .properties()
        .get("STATUS")
        .is_some_and(|status| status.value().eq_ignore_ascii_case("CANCELLED"))
}

fn is_all_day(source: &icalendar::Event) -> bool {
    matches!(source.get_start(), Some(icalendar::DatePerhapsTime::Date(_)))
}

/// Whether the component carries a recurrence rule of its own, as opposed to
/// being a single dated event.
fn uid_repeats(source: &icalendar::Event) -> bool {
    source.properties().contains_key("RRULE") || source.properties().contains_key("RDATE")
}

/// The first instance's start and end, as epoch seconds.
///
/// The end is `DTEND`, else `DTSTART` plus `DURATION`, else (RFC 5545 §3.6.1)
/// one day for an all-day event and the start itself for a timed one.
fn span(source: &icalendar::Event) -> Result<(i64, i64)> {
    let start = instant(&source.get_start().context("event without a start")?)
        .context("start time that names no instant")?;
    let end = match source.get_end() {
        Some(end) => instant(&end).context("end time that names no instant")?,
        None => match source.property_value("DURATION") {
            Some(text) => start + duration_seconds(text).context("unreadable DURATION")?,
            None if is_all_day(source) => start + 24 * 3600,
            None => start,
        },
    };
    Ok((start, end))
}

/// A DATE or DATE-TIME as epoch seconds.
///
/// - A date is UTC midnight, the reading the calendar uses for all-day events.
/// - A floating time is the machine's wall clock, which is what floating means.
/// - A time with a TZID is read in that zone (IANA, or a Windows name). When
///   the clock is set back that hour happens twice; the first is taken.
fn instant(value: &icalendar::DatePerhapsTime) -> Option<i64> {
    use chrono::TimeZone as _;
    use icalendar::{CalendarDateTime, DatePerhapsTime};
    match value {
        DatePerhapsTime::Date(date) => Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp()),
        DatePerhapsTime::DateTime(CalendarDateTime::Utc(at)) => Some(at.timestamp()),
        DatePerhapsTime::DateTime(CalendarDateTime::Floating(naive)) => {
            Some(chrono::Local.from_local_datetime(naive).earliest()?.timestamp())
        }
        DatePerhapsTime::DateTime(CalendarDateTime::WithTimezone { date_time, tzid }) => Some(
            named_zone(tzid)?
                .from_local_datetime(date_time)
                .earliest()?
                .timestamp(),
        ),
    }
}

/// An RFC 5545 duration (`P1D`, `PT1H30M`, `P2W`, `-PT15M`) in seconds.
fn duration_seconds(text: &str) -> Option<i64> {
    let text = text.trim();
    let (sign, rest) = match text.as_bytes().first()? {
        b'-' => (-1, &text[1..]),
        b'+' => (1, &text[1..]),
        _ => (1, text),
    };
    let rest = rest.strip_prefix('P')?;
    let (mut total, mut number, mut in_time, mut any) = (0i64, String::new(), false, false);
    for ch in rest.chars() {
        match ch {
            '0'..='9' => number.push(ch),
            'T' if number.is_empty() && !in_time => in_time = true,
            unit => {
                let value: i64 = number.parse().ok()?;
                number.clear();
                total += value
                    * match (in_time, unit) {
                        (false, 'W') => 7 * 24 * 3600,
                        (false, 'D') => 24 * 3600,
                        (true, 'H') => 3600,
                        (true, 'M') => 60,
                        (true, 'S') => 1,
                        _ => return None,
                    };
                any = true;
            }
        }
    }
    (any && number.is_empty()).then_some(sign * total)
}

/// A TZID as a time zone: an IANA name, or the Windows name Outlook and
/// Exchange publish (`W. Europe Standard Time`).
fn named_zone(tzid: &str) -> Option<chrono_tz::Tz> {
    let tzid = tzid.trim().trim_matches('"');
    tzid.parse()
        .ok()
        .or_else(|| windows_zone(tzid).and_then(|iana| iana.parse().ok()))
}

/// Rewrites Windows TZID parameters to IANA names before the file is parsed,
/// because the recurrence expansion resolves TZIDs itself and knows only
/// IANA: a series published by Outlook was otherwise skipped whole.
fn with_iana_tzids(body: &str) -> std::borrow::Cow<'_, str> {
    if !body.contains("TZID=") {
        return std::borrow::Cow::Borrowed(body);
    }
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find("TZID=") {
        let (before, after) = rest.split_at(at + "TZID=".len());
        out.push_str(before);
        let quoted = after.starts_with('"');
        let value_end = if quoted {
            after[1..].find('"').map(|end| end + 2).unwrap_or(after.len())
        } else {
            after.find([':', ';', '\r', '\n']).unwrap_or(after.len())
        };
        let value = &after[..value_end];
        let name = value.trim_matches('"');
        match (name.parse::<chrono_tz::Tz>(), windows_zone(name)) {
            (Err(_), Some(iana)) => out.push_str(iana),
            _ => out.push_str(value),
        }
        rest = &after[value_end..];
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// Windows time zone names to IANA, for the zones calendars are most often
/// published from (CLDR windowsZones, territory 001).
fn windows_zone(name: &str) -> Option<&'static str> {
    Some(match name {
        "UTC" | "Coordinated Universal Time" => "UTC",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" => "Atlantic/Reykjavik",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Romance Standard Time" => "Europe/Paris",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Central European Standard Time" => "Europe/Warsaw",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "FLE Standard Time" => "Europe/Kiev",
        "GTB Standard Time" => "Europe/Bucharest",
        "Russian Standard Time" => "Europe/Moscow",
        "Turkey Standard Time" => "Europe/Istanbul",
        "Azores Standard Time" => "Atlantic/Azores",
        "Cape Verde Standard Time" => "Atlantic/Cape_Verde",
        "Morocco Standard Time" => "Africa/Casablanca",
        "W. Central Africa Standard Time" => "Africa/Lagos",
        "South Africa Standard Time" => "Africa/Johannesburg",
        "Egypt Standard Time" => "Africa/Cairo",
        "E. Africa Standard Time" => "Africa/Nairobi",
        "Israel Standard Time" => "Asia/Jerusalem",
        "Jordan Standard Time" => "Asia/Amman",
        "Middle East Standard Time" => "Asia/Beirut",
        "Syria Standard Time" => "Asia/Damascus",
        "Arabic Standard Time" => "Asia/Baghdad",
        "Arab Standard Time" => "Asia/Riyadh",
        "Arabian Standard Time" => "Asia/Dubai",
        "Iran Standard Time" => "Asia/Tehran",
        "Georgian Standard Time" => "Asia/Tbilisi",
        "Caucasus Standard Time" => "Asia/Yerevan",
        "Azerbaijan Standard Time" => "Asia/Baku",
        "Afghanistan Standard Time" => "Asia/Kabul",
        "Pakistan Standard Time" => "Asia/Karachi",
        "West Asia Standard Time" => "Asia/Tashkent",
        "India Standard Time" => "Asia/Kolkata",
        "Sri Lanka Standard Time" => "Asia/Colombo",
        "Nepal Standard Time" => "Asia/Kathmandu",
        "Bangladesh Standard Time" => "Asia/Dhaka",
        "Myanmar Standard Time" => "Asia/Yangon",
        "SE Asia Standard Time" => "Asia/Bangkok",
        "N. Central Asia Standard Time" => "Asia/Novosibirsk",
        "North Asia Standard Time" => "Asia/Krasnoyarsk",
        "China Standard Time" => "Asia/Shanghai",
        "Singapore Standard Time" => "Asia/Singapore",
        "Taipei Standard Time" => "Asia/Taipei",
        "W. Australia Standard Time" => "Australia/Perth",
        "Ulaanbaatar Standard Time" => "Asia/Ulaanbaatar",
        "Tokyo Standard Time" => "Asia/Tokyo",
        "Korea Standard Time" => "Asia/Seoul",
        "Cen. Australia Standard Time" => "Australia/Adelaide",
        "AUS Central Standard Time" => "Australia/Darwin",
        "E. Australia Standard Time" => "Australia/Brisbane",
        "AUS Eastern Standard Time" => "Australia/Sydney",
        "New Zealand Standard Time" => "Pacific/Auckland",
        "Hawaiian Standard Time" => "Pacific/Honolulu",
        "Alaskan Standard Time" => "America/Anchorage",
        "Pacific Standard Time" => "America/Los_Angeles",
        "US Mountain Standard Time" => "America/Phoenix",
        "Mountain Standard Time" => "America/Denver",
        "Central America Standard Time" => "America/Guatemala",
        "Central Standard Time" => "America/Chicago",
        "Central Standard Time (Mexico)" => "America/Mexico_City",
        "Canada Central Standard Time" => "America/Regina",
        "SA Pacific Standard Time" => "America/Bogota",
        "Eastern Standard Time" => "America/New_York",
        "Venezuela Standard Time" => "America/Caracas",
        "Atlantic Standard Time" => "America/Halifax",
        "Pacific SA Standard Time" => "America/Santiago",
        "Newfoundland Standard Time" => "America/St_Johns",
        "E. South America Standard Time" => "America/Sao_Paulo",
        "Argentina Standard Time" => "America/Argentina/Buenos_Aires",
        "SA Eastern Standard Time" => "America/Cayenne",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A published calendar with a weekly series that crosses the end of
    /// daylight saving, one single event, and one entry too broken to read.
    const PUBLISHED: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//test//test//EN\r\n\
BEGIN:VEVENT\r\n\
UID:weekly@example.org\r\n\
DTSTART:20261001T080000Z\r\n\
DTEND:20261001T093000Z\r\n\
RRULE:FREQ=WEEKLY;COUNT=6\r\n\
SUMMARY:Standup\r\n\
LOCATION:Room 1\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:single@example.org\r\n\
DTSTART:20261005T120000Z\r\n\
DTEND:20261005T130000Z\r\n\
SUMMARY:Lunch\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:broken@example.org\r\n\
SUMMARY:No start at all\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    fn at(text: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp()
    }

    #[test]
    fn a_published_series_is_expanded_into_its_occurrences() {
        let (events, skipped) = parse_window(
            PUBLISHED,
            "cal",
            at("2026-10-01T00:00:00Z"),
            at("2026-11-30T00:00:00Z"),
        )
        .expect("the file should parse");

        // The entry with no start cannot be placed on a calendar, and is
        // skipped rather than costing the reader the other two.
        assert_eq!(skipped, 1, "the unreadable entry is skipped, not fatal");

        let standups: Vec<_> = events.iter().filter(|e| e.subject == "Standup").collect();
        assert_eq!(standups.len(), 6, "the weekly series is expanded");
        assert!(standups.iter().all(|e| e.is_recurring));
        assert!(standups.iter().all(|e| e.location.as_deref() == Some("Room 1")));

        // Each occurrence keeps the series' shape: 90 minutes, every time.
        assert!(standups.iter().all(|e| e.end - e.start == 90 * 60));

        // Occurrences of one series are distinct rows, not one row overwritten.
        let ids: std::collections::HashSet<_> = standups.iter().map(|e| &e.id).collect();
        assert_eq!(ids.len(), 6);

        let single: Vec<_> = events.iter().filter(|e| e.subject == "Lunch").collect();
        assert_eq!(single.len(), 1);
        assert!(!single[0].is_recurring, "a dated event is not a series");
    }

    #[test]
    fn a_window_only_yields_what_falls_inside_it() {
        // The series runs weekly from 1 October; a window over the first
        // fortnight must not return the later ones.
        let (events, _) = parse_window(
            PUBLISHED,
            "cal",
            at("2026-10-01T00:00:00Z"),
            at("2026-10-15T00:00:00Z"),
        )
        .expect("parse");
        let standups = events.iter().filter(|e| e.subject == "Standup").count();
        // 1 and 8 October only: the window ends at midnight on the 15th and
        // that day's occurrence is at 08:00, which is outside it.
        assert_eq!(standups, 2, "the window bounds the series, not the file");
    }

    fn calendar(events: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n{events}END:VCALENDAR\r\n")
    }

    fn starts(events: &[Event], subject: &str) -> Vec<i64> {
        let mut found: Vec<i64> = events.iter().filter(|e| e.subject == subject).map(|e| e.start).collect();
        found.sort();
        found
    }

    #[test]
    fn a_moved_or_cancelled_occurrence_replaces_the_one_it_names() {
        // Daily at 09:00Z for five days. The 3rd is moved to 15:00Z and
        // renamed; the 4th is cancelled; the 5th is excluded by EXDATE.
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:s@x\r\nDTSTART:20261012T090000Z\r\nDTEND:20261012T100000Z\r\n\
RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20261016T090000Z\r\nSUMMARY:Daily\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s@x\r\nRECURRENCE-ID:20261014T090000Z\r\nDTSTART:20261014T150000Z\r\n\
DTEND:20261014T160000Z\r\nSUMMARY:Daily (moved)\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s@x\r\nRECURRENCE-ID:20261015T090000Z\r\nDTSTART:20261015T090000Z\r\n\
DTEND:20261015T100000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Daily\r\nEND:VEVENT\r\n",
        );
        let (events, skipped) =
            parse_window(&body, "cal", at("2026-10-12T00:00:00Z"), at("2026-10-20T00:00:00Z")).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(
            starts(&events, "Daily"),
            vec![at("2026-10-12T09:00:00Z"), at("2026-10-13T09:00:00Z")],
            "the moved, cancelled and excluded dates are gone from the series"
        );
        let moved: Vec<_> = events.iter().filter(|e| e.subject == "Daily (moved)").collect();
        assert_eq!(moved.len(), 1, "the moved occurrence appears once, at its new time");
        assert_eq!(moved[0].start, at("2026-10-14T15:00:00Z"));
        assert_eq!(moved[0].series_id.as_deref(), Some("s@x"));
        assert_eq!(moved[0].id, format!("s@x@{}", at("2026-10-14T09:00:00Z")), "keyed by the date it replaces");
    }

    #[test]
    fn duration_and_missing_ends_follow_rfc_5545() {
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:d@x\r\nDTSTART:20261012T090000Z\r\nDURATION:PT1H30M\r\nSUMMARY:Timed\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:a@x\r\nDTSTART;VALUE=DATE:20261013\r\nSUMMARY:All day\r\nEND:VEVENT\r\n",
        );
        let (events, _) =
            parse_window(&body, "cal", at("2026-10-12T00:00:00Z"), at("2026-10-20T00:00:00Z")).unwrap();
        let timed = events.iter().find(|e| e.subject == "Timed").unwrap();
        assert_eq!(timed.end - timed.start, 90 * 60, "DURATION gives the length when DTEND is absent");
        let all_day = events.iter().find(|e| e.subject == "All day").unwrap();
        assert_eq!(all_day.end - all_day.start, 24 * 3600, "a date with no end lasts that day");
    }

    /// Holds in every machine time zone: run with TZ=Europe/Madrid,
    /// TZ=Asia/Tokyo or TZ=America/Los_Angeles to see it. East of UTC the
    /// expansion's local midnight fell on the previous UTC day, and the event
    /// was shown a day early.
    #[test]
    fn an_all_day_series_stays_on_its_dates_whatever_the_machine_zone() {
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:w@x\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261013\r\n\
RRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Bins\r\nEND:VEVENT\r\n",
        );
        let (events, _) =
            parse_window(&body, "cal", at("2026-10-01T00:00:00Z"), at("2026-11-30T00:00:00Z")).unwrap();
        assert_eq!(
            starts(&events, "Bins"),
            vec![at("2026-10-12T00:00:00Z"), at("2026-10-19T00:00:00Z"), at("2026-10-26T00:00:00Z")]
        );
        assert!(events.iter().all(|e| e.all_day && e.end - e.start == 24 * 3600));
    }

    #[test]
    fn a_windows_time_zone_name_keeps_the_wall_clock_across_daylight_saving() {
        // Outlook publishes Windows zone names. 09:00 in Berlin is 07:00Z in
        // summer and 08:00Z after the clocks go back on 25 October 2026.
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:o@x\r\nDTSTART;TZID=W. Europe Standard Time:20261019T090000\r\n\
DTEND;TZID=\"W. Europe Standard Time\":20261019T100000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\n\
SUMMARY:Outlook\r\nEND:VEVENT\r\n",
        );
        let (events, skipped) =
            parse_window(&body, "cal", at("2026-10-01T00:00:00Z"), at("2026-11-30T00:00:00Z")).unwrap();
        assert_eq!(skipped, 0, "a Windows zone name is not a reason to drop the series");
        assert_eq!(
            starts(&events, "Outlook"),
            vec![at("2026-10-19T07:00:00Z"), at("2026-10-26T08:00:00Z")]
        );
        assert!(events.iter().all(|e| e.end - e.start == 3600));
    }

    #[test]
    fn a_yearly_series_on_29_february_occurs_only_in_leap_years() {
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:l@x\r\nDTSTART;VALUE=DATE:20240229\r\nRRULE:FREQ=YEARLY\r\n\
SUMMARY:Leap\r\nEND:VEVENT\r\n",
        );
        let (events, _) =
            parse_window(&body, "cal", at("2024-01-01T00:00:00Z"), at("2030-01-01T00:00:00Z")).unwrap();
        assert_eq!(starts(&events, "Leap"), vec![at("2024-02-29T00:00:00Z"), at("2028-02-29T00:00:00Z")]);
    }

    #[test]
    fn an_occurrence_that_began_before_the_window_but_runs_into_it_is_included() {
        // Sunday to Tuesday; a week view starting on Monday must show it.
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:c@x\r\nDTSTART:20261011T180000Z\r\nDTEND:20261013T120000Z\r\n\
SUMMARY:Conference\r\nEND:VEVENT\r\n",
        );
        let (events, _) =
            parse_window(&body, "cal", at("2026-10-12T00:00:00Z"), at("2026-10-19T00:00:00Z")).unwrap();
        assert_eq!(starts(&events, "Conference"), vec![at("2026-10-11T18:00:00Z")]);
    }

    #[test]
    fn a_floating_time_is_the_machine_wall_clock_and_keeps_its_length() {
        use chrono::TimeZone as _;
        let body = calendar(
            "BEGIN:VEVENT\r\nUID:f@x\r\nDTSTART:20261012T090000\r\nDTEND:20261012T103000\r\n\
SUMMARY:Floating\r\nEND:VEVENT\r\n",
        );
        let (events, _) =
            parse_window(&body, "cal", at("2026-10-10T00:00:00Z"), at("2026-10-14T00:00:00Z")).unwrap();
        let expected = chrono::Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(2026, 10, 12).unwrap().and_hms_opt(9, 0, 0).unwrap(),
            )
            .earliest()
            .unwrap()
            .timestamp();
        let event = events.iter().find(|e| e.subject == "Floating").unwrap();
        assert_eq!(event.start, expected);
        assert_eq!(event.end - event.start, 90 * 60, "it used to come out zero-length");
    }

    #[test]
    fn webcal_links_are_fetched_over_https() {
        assert_eq!(normalize_url("webcal://example.org/a.ics").unwrap(), "https://example.org/a.ics");
        assert_eq!(normalize_url(" WEBCALS://example.org/a.ics").unwrap(), "https://example.org/a.ics");
        assert_eq!(normalize_url("https://example.org/a.ics").unwrap(), "https://example.org/a.ics");
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("ftp://example.org/a.ics").is_err());
    }

    #[test]
    fn durations_parse_as_rfc_5545_writes_them() {
        assert_eq!(duration_seconds("PT1H30M"), Some(5400));
        assert_eq!(duration_seconds("P1D"), Some(86400));
        assert_eq!(duration_seconds("P2W"), Some(14 * 86400));
        assert_eq!(duration_seconds("P1DT12H"), Some(36 * 3600));
        assert_eq!(duration_seconds("-PT15M"), Some(-900));
        for bad in ["", "P", "PT", "1H", "PT1X", "P1H", "PT5"] {
            assert_eq!(duration_seconds(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn every_windows_zone_in_the_table_resolves() {
        for name in ["W. Europe Standard Time", "Pacific Standard Time", "India Standard Time", "Tokyo Standard Time"] {
            assert!(named_zone(name).is_some(), "{name}");
        }
        // The table itself: an entry that does not name a real zone is dead.
        let body = std::fs::read_to_string(file!()).unwrap();
        let table = &body[body.find("fn windows_zone").unwrap()..];
        let table = &table[..table.find("_ => return None").unwrap()];
        for line in table.lines().filter(|line| line.contains("=> \"")) {
            let iana = line.rsplit("=> \"").next().unwrap().trim_end_matches("\",").trim_end_matches('"');
            assert!(iana.parse::<chrono_tz::Tz>().is_ok(), "{iana}");
        }
    }

    #[test]
    fn a_file_that_is_not_a_calendar_fails_rather_than_reporting_nothing() {
        // Reporting an empty calendar for a 404 page would look like a working
        // subscription with no events in it.
        assert!(parse_window("<html>not a calendar</html>", "cal", 0, 1).is_err());
    }
}
