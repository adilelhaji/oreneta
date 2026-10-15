//! Recurrence rules read and written as RRULE values, and the next date a
//! rule falls on (ADR-0053).
//!
//! Events never need the next date: their servers expand series and hand
//! back occurrences (see the module above). A repeating *task* is different:
//! completing one occurrence moves the task itself to the next one, here, so
//! the rule has to be followed by this client. The subset followed is the one
//! the editors write — every N days, weeks on some weekdays, months on a day
//! or on the nth weekday, years — with an end date or a count. Anything
//! beyond it (BYSETPOS, several days of the month, hours…) is reported as
//! not understood, and such a task is not changed here rather than changed
//! wrongly.
//!
//! Dates, not instants: a rule is about calendar days. The time of day and
//! the zone are put back by [`next_instant`], which keeps the wall-clock time
//! across a daylight-saving change.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Weekday};

use super::{Frequency, Recurrence};

/// Days in a month, February in leap years included.
pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|first| first.pred_opt())
        .map(|last| last.day())
        .unwrap_or(28)
}

/// A day of the month, clamped to the month's last day: the 31st of a
/// 30-day month is its 30th, the 29th of February in a common year its 28th.
///
/// RFC 5545 skips such months instead. Clients people move from (Outlook,
/// eM Client) move to the last day, and a monthly task due "on the 31st"
/// that silently skipped half the year would be a task forgotten.
fn clamped(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month, day.min(days_in_month(year, month)).max(1))
}

/// The nth weekday of a month (1-based), or the last one for -1. `None` when
/// the month has no such day (a fifth Monday).
fn nth_weekday(year: i32, month: u32, weekday: Weekday, n: i8) -> Option<NaiveDate> {
    if n < 0 {
        let last = NaiveDate::from_ymd_opt(year, month, days_in_month(year, month))?;
        let back = (7 + last.weekday().num_days_from_monday() - weekday.num_days_from_monday()) % 7;
        let date = last - Duration::days(i64::from(back) + 7 * i64::from(-n - 1));
        return (date.month() == month).then_some(date);
    }
    NaiveDate::from_weekday_of_month_opt(year, month, weekday, u8::try_from(n).ok()?)
}

/// The ordinal of a date's weekday in its month: 1 for the first Tuesday,
/// and so on. The editor offers "the last" when this is also the last.
pub fn week_of_month(date: NaiveDate) -> i8 {
    ((date.day() - 1) / 7 + 1) as i8
}

fn weekday_of(index: u8) -> Weekday {
    Weekday::try_from(index.min(6)).unwrap_or(Weekday::Mon)
}

/// Adds months to a (year, month) pair.
fn plus_months(year: i32, month: u32, months: i64) -> Option<(i32, u32)> {
    let total = i64::from(year) * 12 + i64::from(month) - 1 + months;
    Some((i32::try_from(total.div_euclid(12)).ok()?, (total.rem_euclid(12) + 1) as u32))
}

/// The last day a rule may fall on, read the way the editors store it: the
/// last minute of that day on this machine's clock.
fn until_date(rule: &Recurrence) -> Option<NaiveDate> {
    rule.until.and_then(|until| super::start_date(until, false))
}

/// The first date after `current` that the rule falls on, `current` being
/// an occurrence of it (the task's present due date). `None` when the
/// series ends at `current`: its end date is passed, or its count — kept as
/// the occurrences left, `current` included — is spent.
///
/// The series is anchored on `current`: an interval counts from there,
/// which is what moving the task's due date to each occurrence in turn
/// amounts to.
pub fn next_date(rule: &Recurrence, current: NaiveDate) -> Option<NaiveDate> {
    if rule.count.is_some_and(|left| left <= 1) {
        return None;
    }
    let interval = i64::from(rule.interval.max(1));
    let next = match rule.freq {
        Frequency::Daily => current.checked_add_signed(Duration::days(interval))?,
        Frequency::Weekly => {
            let mut days = rule.weekdays.iter().copied().filter(|d| *d < 7).collect::<Vec<_>>();
            if days.is_empty() {
                days.push(current.weekday().num_days_from_monday() as u8);
            }
            days.sort_unstable();
            days.dedup();
            let today = current.weekday().num_days_from_monday() as u8;
            match days.iter().find(|day| **day > today) {
                Some(day) => current + Duration::days(i64::from(day - today)),
                None => {
                    let monday = current - Duration::days(i64::from(today));
                    monday + Duration::days(7 * interval + i64::from(days[0]))
                }
            }
        }
        Frequency::Monthly | Frequency::Yearly => {
            let step = if rule.freq == Frequency::Monthly { interval } else { 12 * interval };
            let weekday = rule.weekdays.first().copied().map(weekday_of).unwrap_or(current.weekday());
            let day = u32::from(rule.month_day.unwrap_or(current.day() as u8));
            // A fifth Monday may be absent for several periods running; four
            // years of them is more than any calendar needs to look.
            let mut found = None;
            for k in 0..=48 {
                let (year, month) = plus_months(current.year(), current.month(), step * k)?;
                let candidate = match rule.month_week {
                    Some(n) => nth_weekday(year, month, weekday, n),
                    None => clamped(year, month, day),
                };
                if let Some(date) = candidate.filter(|date| *date > current) {
                    found = Some(date);
                    break;
                }
            }
            found?
        }
    };
    match until_date(rule) {
        Some(last) if next > last => None,
        _ => Some(next),
    }
}

/// The rule as it stands at the next occurrence: a count is what is left.
pub fn advanced(rule: &Recurrence) -> Recurrence {
    let mut next = rule.clone();
    next.count = rule.count.map(|left| left.saturating_sub(1).max(1));
    next
}

/// The next occurrence after `due` as an instant in `zone`, at the same
/// wall-clock time: a task due at 09:00 is due at 09:00 the week after a
/// daylight-saving change too. A time the change skips (02:30 on the night
/// clocks go forward) becomes the first one that exists after it.
pub fn next_instant<Tz: TimeZone>(rule: &Recurrence, due: i64, zone: &Tz) -> Option<i64> {
    let local = zone.timestamp_opt(due, 0).earliest()?.naive_local();
    let date = next_date(rule, local.date())?;
    Some(resolve(zone, date.and_time(local.time()))?)
}

/// A wall-clock time in `zone` as an instant; a time the clock change skips
/// becomes the first one that exists.
pub(crate) fn resolve<Tz: TimeZone>(zone: &Tz, naive: NaiveDateTime) -> Option<i64> {
    if let Some(at) = zone.from_local_datetime(&naive).earliest() {
        return Some(at.timestamp());
    }
    (1..=4).find_map(|half_hours| {
        zone.from_local_datetime(&(naive + Duration::minutes(30 * half_hours))).earliest().map(|at| at.timestamp())
    })
}

/// [`next_instant`] on this machine's clock.
pub fn next_local(rule: &Recurrence, due: i64) -> Option<i64> {
    next_instant(rule, due, &chrono::Local)
}

// ---- RRULE text ------------------------------------------------------------------

/// A rule part this client does not follow, so the rule is not one it may
/// rewrite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported(pub String);

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "this repetition is not one Oreneta can change ({})", self.0)
    }
}

impl std::error::Error for Unsupported {}

fn day_code(text: &str) -> Option<u8> {
    Recurrence::RRULE_DAYS.iter().position(|code| code.eq_ignore_ascii_case(text)).map(|i| i as u8)
}

/// An RRULE `UNTIL`: a date, or a time in UTC (or floating), as the last
/// minute of that day on this machine's clock, the way the editors store it.
fn read_until(text: &str) -> Option<i64> {
    let day = if text.len() == 8 {
        NaiveDate::parse_from_str(text, "%Y%m%d").ok()?
    } else {
        let (body, utc) = match text.strip_suffix('Z') {
            Some(body) => (body, true),
            None => (text, false),
        };
        let naive = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S").ok()?;
        if utc {
            chrono::Local.from_utc_datetime(&naive).date_naive()
        } else {
            naive.date()
        }
    };
    resolve(&chrono::Local, day.and_hms_opt(23, 59, 0)?)
}

/// Reads an RRULE value (with or without the `RRULE:` name). Strict: any
/// part this client would not keep on writing the rule back makes it
/// [`Unsupported`].
pub fn parse(text: &str) -> Result<Recurrence, Unsupported> {
    parse_with_month(text).map(|(rule, _)| rule)
}

/// [`parse`], with the month a yearly rule names (`BYMONTH`): the caller
/// checks it is the month the task is due in, since writing the rule back
/// names that one.
pub fn parse_with_month(text: &str) -> Result<(Recurrence, Option<u32>), Unsupported> {
    let body = text.trim();
    let body = body.strip_prefix("RRULE:").or_else(|| body.strip_prefix("rrule:")).unwrap_or(body);
    let bad = |what: &str| Unsupported(what.to_string());
    let mut freq = None;
    let mut rule = Recurrence { interval: 1, ..Default::default() };
    let mut ordinal_days: Vec<(Option<i8>, u8)> = Vec::new();
    let mut month = None;
    for part in body.split(';').filter(|part| !part.trim().is_empty()) {
        let (name, value) = part.split_once('=').ok_or_else(|| bad(part))?;
        let value = value.trim();
        match name.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match value.to_ascii_uppercase().as_str() {
                    "DAILY" => Frequency::Daily,
                    "WEEKLY" => Frequency::Weekly,
                    "MONTHLY" => Frequency::Monthly,
                    "YEARLY" => Frequency::Yearly,
                    other => return Err(bad(&format!("FREQ={other}"))),
                })
            }
            "INTERVAL" => rule.interval = value.parse::<u16>().ok().filter(|n| *n >= 1).ok_or_else(|| bad(part))?,
            "COUNT" => rule.count = Some(value.parse::<u16>().ok().filter(|n| *n >= 1).ok_or_else(|| bad(part))?),
            "UNTIL" => rule.until = Some(read_until(value).ok_or_else(|| bad(part))?),
            "BYDAY" => {
                for day in value.split(',') {
                    let day = day.trim();
                    let split = day.len().checked_sub(2).ok_or_else(|| bad(part))?;
                    let (ordinal, code) = day.split_at(split);
                    let code = day_code(code).ok_or_else(|| bad(part))?;
                    let ordinal = match ordinal {
                        "" => None,
                        text => Some(text.trim_start_matches('+').parse::<i8>().map_err(|_| bad(part))?),
                    };
                    ordinal_days.push((ordinal, code));
                }
            }
            "BYMONTHDAY" => {
                let day = value.parse::<u8>().ok().filter(|d| (1..=31).contains(d)).ok_or_else(|| bad(part))?;
                rule.month_day = Some(day);
            }
            "BYMONTH" => month = Some(value.parse::<u32>().ok().filter(|m| (1..=12).contains(m)).ok_or_else(|| bad(part))?),
            "WKST" if value.eq_ignore_ascii_case("MO") => {}
            _ => return Err(bad(part)),
        }
    }
    rule.freq = freq.ok_or_else(|| bad("no FREQ"))?;
    if rule.until.is_some() && rule.count.is_some() {
        return Err(bad("UNTIL with COUNT"));
    }
    match rule.freq {
        Frequency::Daily | Frequency::Weekly => {
            if rule.month_day.is_some() || month.is_some() || ordinal_days.iter().any(|(n, _)| n.is_some()) {
                return Err(bad("a day of the month on a daily or weekly rule"));
            }
            rule.weekdays = ordinal_days.iter().map(|(_, day)| *day).collect();
            // "Every weekday" as some clients write it: daily, on some days.
            // Every day on those days is every week on them.
            if rule.freq == Frequency::Daily && !rule.weekdays.is_empty() {
                if rule.interval != 1 {
                    return Err(bad("BYDAY on a rule every few days"));
                }
                rule.freq = Frequency::Weekly;
            }
        }
        Frequency::Monthly | Frequency::Yearly => {
            if rule.freq == Frequency::Monthly && month.is_some() {
                return Err(bad("BYMONTH on a monthly rule"));
            }
            match ordinal_days.as_slice() {
                [] => {}
                [(Some(n), day)] if (1..=4).contains(n) || *n == -1 => {
                    if rule.month_day.is_some() {
                        return Err(bad("both a weekday and a day of the month"));
                    }
                    rule.month_week = Some(*n);
                    rule.weekdays = vec![*day];
                }
                _ => return Err(bad("BYDAY")),
            }
            if rule.freq == Frequency::Yearly && month.is_none() && (rule.month_day.is_some() || rule.month_week.is_some()) {
                // A day of every month, every year, is a monthly rule in
                // disguise; not one this client writes.
                return Err(bad("a yearly rule with no month"));
            }
        }
    }
    Ok((rule, month))
}

/// The RRULE value for a rule whose current occurrence is `anchor`, with
/// every part spelled out — weekdays, day of the month, month — so that
/// moving the series' start to a later occurrence never changes which days
/// it falls on. `all_day` chooses the form of `UNTIL`, which must match the
/// start's (RFC 5545 §3.3.10).
pub fn format(rule: &Recurrence, anchor: NaiveDate, all_day: bool) -> String {
    let mut parts = vec![match rule.freq {
        Frequency::Daily => "FREQ=DAILY",
        Frequency::Weekly => "FREQ=WEEKLY",
        Frequency::Monthly => "FREQ=MONTHLY",
        Frequency::Yearly => "FREQ=YEARLY",
    }
    .to_string()];
    let interval = rule.interval.max(1);
    if interval > 1 {
        parts.push(format!("INTERVAL={interval}"));
    }
    let anchor_day = anchor.weekday().num_days_from_monday() as u8;
    match rule.freq {
        Frequency::Daily => {}
        Frequency::Weekly => {
            let mut days: Vec<u8> = rule.weekdays.iter().copied().filter(|d| *d < 7).collect();
            if days.is_empty() {
                days.push(anchor_day);
            }
            days.sort_unstable();
            days.dedup();
            let codes: Vec<&str> = days.iter().map(|d| Recurrence::RRULE_DAYS[*d as usize]).collect();
            parts.push(format!("BYDAY={}", codes.join(",")));
        }
        Frequency::Monthly | Frequency::Yearly => {
            if rule.freq == Frequency::Yearly {
                parts.push(format!("BYMONTH={}", anchor.month()));
            }
            match rule.month_week {
                Some(n) => {
                    let day = rule.weekdays.first().copied().filter(|d| *d < 7).unwrap_or(anchor_day);
                    parts.push(format!("BYDAY={n}{}", Recurrence::RRULE_DAYS[day as usize]));
                }
                None => parts.push(format!("BYMONTHDAY={}", rule.month_day.map(u32::from).unwrap_or(anchor.day()))),
            }
        }
    }
    match (rule.until, rule.count) {
        (Some(until), _) => {
            if let Some(day) = super::start_date(until, false) {
                if all_day {
                    parts.push(format!("UNTIL={}", day.format("%Y%m%d")));
                } else if let Some(end) = resolve(&chrono::Local, day.and_hms_opt(23, 59, 59).unwrap_or_default()) {
                    let end = chrono::DateTime::<chrono::Utc>::from_timestamp(end, 0).unwrap_or_default();
                    parts.push(format!("UNTIL={}", end.format("%Y%m%dT%H%M%SZ")));
                }
            }
        }
        (None, Some(count)) => parts.push(format!("COUNT={}", count.max(1))),
        (None, None) => {}
    }
    parts.join(";")
}

/// A rule completed for writing, anchored on a due date: a monthly rule on
/// a day of the month names that day, so the series keeps it.
pub fn anchored(rule: &Recurrence, anchor: NaiveDate) -> Recurrence {
    let mut rule = rule.clone();
    rule.interval = rule.interval.max(1);
    match rule.freq {
        Frequency::Daily => {
            rule.weekdays.clear();
            rule.month_week = None;
            rule.month_day = None;
        }
        Frequency::Weekly => {
            rule.month_week = None;
            rule.month_day = None;
            if rule.weekdays.is_empty() {
                rule.weekdays = vec![anchor.weekday().num_days_from_monday() as u8];
            }
        }
        Frequency::Monthly | Frequency::Yearly => {
            if rule.month_week.is_some() {
                rule.month_day = None;
                if rule.weekdays.is_empty() {
                    rule.weekdays = vec![anchor.weekday().num_days_from_monday() as u8];
                }
                rule.weekdays.truncate(1);
            } else {
                rule.weekdays.clear();
                rule.month_day = Some(rule.month_day.unwrap_or(anchor.day() as u8));
            }
        }
    }
    rule
}

#[cfg(test)]
mod tests;
