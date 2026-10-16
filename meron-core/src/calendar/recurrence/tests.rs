use super::*;

fn d(y: i32, m: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, day).unwrap()
}

fn rule(freq: Frequency) -> Recurrence {
    Recurrence { freq, interval: 1, ..Default::default() }
}

/// The last minute of a day here, as the editors store an end date.
fn until(y: i32, m: u32, day: u32) -> i64 {
    chrono::Local.from_local_datetime(&d(y, m, day).and_hms_opt(23, 59, 0).unwrap()).earliest().unwrap().timestamp()
}

fn walk(rule: &Recurrence, from: NaiveDate, steps: usize) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    let mut rule = rule.clone();
    let mut at = from;
    for _ in 0..steps {
        match next_date(&rule, at) {
            Some(next) => {
                out.push(next);
                rule = advanced(&rule);
                at = next;
            }
            None => break,
        }
    }
    out
}

#[test]
fn daily_and_every_few_days() {
    assert_eq!(next_date(&rule(Frequency::Daily), d(2026, 12, 31)), Some(d(2027, 1, 1)));
    let every_three = Recurrence { interval: 3, ..rule(Frequency::Daily) };
    assert_eq!(walk(&every_three, d(2026, 2, 26), 2), vec![d(2026, 3, 1), d(2026, 3, 4)]);
}

#[test]
fn weekly_on_some_weekdays_moves_through_the_week_then_skips_the_interval() {
    // Monday, Wednesday, Friday every other week, from a Wednesday.
    let r = Recurrence { interval: 2, weekdays: vec![0, 2, 4], ..rule(Frequency::Weekly) };
    assert_eq!(
        walk(&r, d(2026, 10, 14), 4),
        vec![d(2026, 10, 16), d(2026, 10, 26), d(2026, 10, 28), d(2026, 10, 30)]
    );
    // Every weekday, from a Friday: Monday next.
    let weekdays = Recurrence { weekdays: vec![0, 1, 2, 3, 4], ..rule(Frequency::Weekly) };
    assert_eq!(next_date(&weekdays, d(2026, 10, 16)), Some(d(2026, 10, 19)));
    // No day named: the day it is due on.
    assert_eq!(next_date(&rule(Frequency::Weekly), d(2026, 10, 13)), Some(d(2026, 10, 20)));
}

#[test]
fn the_31st_becomes_the_last_day_of_shorter_months_and_comes_back() {
    let r = Recurrence { month_day: Some(31), ..rule(Frequency::Monthly) };
    assert_eq!(
        walk(&r, d(2027, 1, 31), 4),
        vec![d(2027, 2, 28), d(2027, 3, 31), d(2027, 4, 30), d(2027, 5, 31)],
        "Feb 28 in a common year, and the 31st again after"
    );
    assert_eq!(next_date(&r, d(2028, 1, 31)), Some(d(2028, 2, 29)), "a leap year's February has 29 days");
    // Without the day spelled out, the due date's own day is the anchor.
    assert_eq!(next_date(&rule(Frequency::Monthly), d(2026, 10, 30)), Some(d(2026, 11, 30)));
    // Every three months across the year end.
    let quarterly = Recurrence { interval: 3, month_day: Some(30), ..rule(Frequency::Monthly) };
    assert_eq!(walk(&quarterly, d(2026, 11, 30), 2), vec![d(2027, 2, 28), d(2027, 5, 30)]);
}

#[test]
fn the_29th_of_february_every_year() {
    let r = Recurrence { month_day: Some(29), ..rule(Frequency::Yearly) };
    assert_eq!(walk(&r, d(2028, 2, 29), 4), vec![d(2029, 2, 28), d(2030, 2, 28), d(2031, 2, 28), d(2032, 2, 29)]);
}

#[test]
fn the_nth_and_the_last_weekday_of_the_month() {
    // The second Tuesday.
    let second_tuesday = Recurrence { month_week: Some(2), weekdays: vec![1], ..rule(Frequency::Monthly) };
    assert_eq!(
        walk(&second_tuesday, d(2026, 10, 13), 3),
        vec![d(2026, 11, 10), d(2026, 12, 8), d(2027, 1, 12)]
    );
    // The last Friday.
    let last_friday = Recurrence { month_week: Some(-1), weekdays: vec![4], ..rule(Frequency::Monthly) };
    assert_eq!(walk(&last_friday, d(2026, 10, 30), 3), vec![d(2026, 11, 27), d(2026, 12, 25), d(2027, 1, 29)]);
    // The fourth Thursday of November, yearly.
    let thanksgiving = Recurrence { month_week: Some(4), weekdays: vec![3], ..rule(Frequency::Yearly) };
    assert_eq!(next_date(&thanksgiving, d(2026, 11, 26)), Some(d(2027, 11, 25)));
    assert_eq!(week_of_month(d(2026, 10, 13)), 2);
    assert_eq!(week_of_month(d(2026, 10, 31)), 5);
}

#[test]
fn a_count_is_what_is_left_and_an_end_date_is_inclusive() {
    let three = Recurrence { count: Some(3), ..rule(Frequency::Daily) };
    assert_eq!(walk(&three, d(2026, 10, 13), 10), vec![d(2026, 10, 14), d(2026, 10, 15)], "three in all");
    assert_eq!(advanced(&three).count, Some(2));
    assert_eq!(next_date(&Recurrence { count: Some(1), ..rule(Frequency::Daily) }, d(2026, 10, 13)), None);

    let to_friday = Recurrence { until: Some(until(2026, 10, 16)), ..rule(Frequency::Daily) };
    assert_eq!(walk(&to_friday, d(2026, 10, 13), 10), vec![d(2026, 10, 14), d(2026, 10, 15), d(2026, 10, 16)]);
}

#[test]
fn the_wall_clock_time_survives_a_daylight_saving_change() {
    let madrid: chrono_tz::Tz = "Europe/Madrid".parse().unwrap();
    // 09:00 on Friday 23 October 2026, summer time (07:00 UTC).
    let due = madrid.with_ymd_and_hms(2026, 10, 23, 9, 0, 0).unwrap().timestamp();
    let next = next_instant(&rule(Frequency::Weekly), due, &madrid).unwrap();
    let local = madrid.timestamp_opt(next, 0).unwrap();
    assert_eq!(local.naive_local(), d(2026, 10, 30).and_hms_opt(9, 0, 0).unwrap(), "still 09:00, now winter time");
    assert_eq!(next - due, 7 * 86_400 + 3600, "the week had an extra hour");

    // 02:30 does not exist on 29 March 2026 in Madrid: the next time that does.
    let skipped = madrid.with_ymd_and_hms(2026, 3, 22, 2, 30, 0).unwrap().timestamp();
    let next = next_instant(&rule(Frequency::Weekly), skipped, &madrid).unwrap();
    assert_eq!(madrid.timestamp_opt(next, 0).unwrap().naive_local(), d(2026, 3, 29).and_hms_opt(3, 0, 0).unwrap());

    let los_angeles: chrono_tz::Tz = "America/Los_Angeles".parse().unwrap();
    let due = los_angeles.with_ymd_and_hms(2026, 10, 31, 18, 0, 0).unwrap().timestamp();
    let next = next_instant(&rule(Frequency::Daily), due, &los_angeles).unwrap();
    assert_eq!(los_angeles.timestamp_opt(next, 0).unwrap().naive_local(), d(2026, 11, 1).and_hms_opt(18, 0, 0).unwrap());
    assert_eq!(next - due, 86_400 + 3600);
}

#[test]
fn rules_read_back_as_written() {
    for (text, anchor, all_day) in [
        ("FREQ=DAILY", d(2026, 10, 13), true),
        ("FREQ=DAILY;INTERVAL=2;COUNT=5", d(2026, 10, 13), false),
        ("FREQ=WEEKLY;BYDAY=MO,WE,FR", d(2026, 10, 14), true),
        ("FREQ=MONTHLY;BYMONTHDAY=31", d(2027, 2, 28), true),
        ("FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR", d(2026, 10, 30), true),
        ("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", d(2029, 2, 28), true),
        ("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", d(2026, 11, 26), true),
        ("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231", d(2026, 10, 13), true),
    ] {
        let parsed = parse(text).unwrap_or_else(|e| panic!("{text}: {e}"));
        assert_eq!(format(&parsed, anchor, all_day), text, "round trip of {text}");
    }
    // A timed task's end is read as the date that instant falls on here, and
    // written back as the end of that day here, in UTC. Noon UTC on 31
    // December is that day from UTC-11 to UTC+11, but already 1 January at
    // UTC+12 and beyond (#221; zone by zone in the test below).
    let r = parse("FREQ=DAILY;UNTIL=20261231T120000Z").unwrap();
    let noon = chrono::Utc.with_ymd_and_hms(2026, 12, 31, 12, 0, 0).unwrap();
    let here = noon.with_timezone(&chrono::Local).date_naive();
    assert_eq!(super::super::start_date(r.until.unwrap(), false), Some(here));
    let written = format(&r, d(2026, 10, 13), false);
    assert!(written.starts_with("FREQ=DAILY;UNTIL=") && written.ends_with('Z'), "{written}");
    let again = parse(&written).unwrap();
    assert_eq!(super::super::start_date(again.until.unwrap(), false), Some(here), "{written}");
}

/// RFC 5545 bounds a series at an `UNTIL` in UTC as an instant: an
/// occurrence on the date that instant falls on where the reader is, at a
/// time up to it, belongs to the series. So the last date is read in the
/// reader's zone, not in UTC: at UTC+12 and beyond (Auckland's summer is
/// UTC+13) noon UTC on 31 December is 1 January, and a task due at 00:30
/// on 1 January there (11:30 UTC on the 31st) is the series' last (#221).
#[test]
fn a_utc_until_is_the_date_it_falls_on_where_the_reader_is() {
    let noon = chrono::Utc.with_ymd_and_hms(2026, 12, 31, 12, 0, 0).unwrap();
    for (name, last) in [
        ("Pacific/Auckland", d(2027, 1, 1)),
        ("Pacific/Kiritimati", d(2027, 1, 1)),
        // UTC+12 exactly: noon UTC is midnight, the first moment of 1 January.
        ("Etc/GMT-12", d(2027, 1, 1)),
        // UTC-12: noon UTC is midnight starting 31 December.
        ("Etc/GMT+12", d(2026, 12, 31)),
        ("Asia/Tokyo", d(2026, 12, 31)),
        ("Europe/Madrid", d(2026, 12, 31)),
        ("America/Los_Angeles", d(2026, 12, 31)),
        ("Pacific/Pago_Pago", d(2026, 12, 31)),
    ] {
        let zone: chrono_tz::Tz = name.parse().unwrap();
        let until = read_until_in("20261231T120000Z", &zone).unwrap();
        let end = zone.timestamp_opt(until, 0).unwrap();
        assert_eq!(end.naive_local(), last.and_hms_opt(23, 59, 0).unwrap(), "{name}");
        // Whatever the zone, an occurrence at the UNTIL instant itself is in.
        assert!(noon.timestamp() <= until, "{name}");
    }
    // In Auckland, the 00:30 occurrence on 1 January is before the UNTIL.
    let auckland: chrono_tz::Tz = "Pacific/Auckland".parse().unwrap();
    let half_past = auckland.with_ymd_and_hms(2027, 1, 1, 0, 30, 0).unwrap();
    assert!(half_past.timestamp() <= noon.timestamp());
    // The known limit (ADR-0053): the rule keeps a date. An end of day in
    // UTC, read in Madrid, is 00:59 on 1 January, so 1 January is the last
    // date, and a task due at 09:00 that day is kept, which the RFC would not.
    let madrid: chrono_tz::Tz = "Europe/Madrid".parse().unwrap();
    let until = read_until_in("20261231T235959Z", &madrid).unwrap();
    assert_eq!(madrid.timestamp_opt(until, 0).unwrap().date_naive(), d(2027, 1, 1));
    // A date, or a floating time, is that date wherever the reader is.
    for text in ["20261231", "20261231T120000"] {
        let until = read_until_in(text, &auckland).unwrap();
        assert_eq!(auckland.timestamp_opt(until, 0).unwrap().date_naive(), d(2026, 12, 31), "{text}");
    }
}

#[test]
fn implicit_parts_are_spelled_out_from_the_due_date() {
    let monthly = parse("RRULE:FREQ=MONTHLY").unwrap();
    assert_eq!(format(&monthly, d(2026, 1, 31), true), "FREQ=MONTHLY;BYMONTHDAY=31");
    assert_eq!(format(&rule(Frequency::Weekly), d(2026, 10, 13), true), "FREQ=WEEKLY;BYDAY=TU");
    assert_eq!(format(&rule(Frequency::Yearly), d(2026, 10, 13), true), "FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=13");
    let anchored = anchored(&monthly, d(2026, 1, 31));
    assert_eq!(anchored.month_day, Some(31));
    // "Every weekday" as Thunderbird writes it is every week on those days.
    let weekdays = parse("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR").unwrap();
    assert_eq!((weekdays.freq, weekdays.weekdays.len()), (Frequency::Weekly, 5));
}

#[test]
fn rules_beyond_the_editor_are_refused_not_bent() {
    for text in [
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "FREQ=MONTHLY;BYMONTHDAY=1,15",
        "FREQ=MONTHLY;BYMONTHDAY=-1",
        "FREQ=HOURLY",
        "FREQ=DAILY;BYHOUR=9",
        "FREQ=WEEKLY;BYDAY=1MO",
        "FREQ=YEARLY;BYMONTHDAY=3",
        "FREQ=DAILY;COUNT=2;UNTIL=20261231",
        "INTERVAL=2",
        "FREQ=WEEKLY;WKST=SU;INTERVAL=2",
    ] {
        assert!(parse(text).is_err(), "{text} should not be taken");
    }
}
