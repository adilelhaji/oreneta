use super::*;
use crate::calendar::{put_local_event, upsert_calendars, Calendar, CalendarKind};

const H: i64 = 3600;
// 2030-01-10T00:00:00Z
const DAY: i64 = 1_894_233_600;

fn store() -> Connection {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    let calendar = |id: &str, kind: CalendarKind| Calendar { id: id.into(), name: id.into(), enabled: true, kind, ..Default::default() };
    upsert_calendars(&conn, "a@x", &[calendar("home", CalendarKind::Local), calendar("holidays", CalendarKind::Subscribed)]).unwrap();
    upsert_calendars(&conn, "b@y", &[calendar("work", CalendarKind::CalDav)]).unwrap();
    conn
}

fn put(conn: &Connection, account: &str, calendar: &str, id: &str, start: i64, end: i64, patch: impl FnOnce(&mut Event)) {
    let mut event = Event { id: id.into(), calendar_id: calendar.into(), subject: id.into(), start, end, ..Default::default() };
    patch(&mut event);
    put_local_event(conn, account, &event).unwrap();
}

fn subjects(found: &[Overlap]) -> Vec<&str> {
    found.iter().map(|o| o.subject.as_str()).collect()
}

#[test]
fn only_busy_events_of_ones_own_calendars_overlap_earliest_first() {
    let conn = store();
    let at = DAY + 10 * H;
    put(&conn, "a@x", "home", "Dentist", at + H / 2, at + 2 * H, |_| {});
    put(&conn, "b@y", "work", "Standup", at - H / 2, at + H / 4, |_| {});
    put(&conn, "a@x", "home", "Cancelled", at, at + H, |e| e.is_cancelled = true);
    put(&conn, "a@x", "home", "Free", at, at + H, |e| e.free_busy = "free".into());
    put(&conn, "a@x", "home", "Declined", at, at + H, |e| e.my_response = "decline".into());
    put(&conn, "a@x", "holidays", "Published", at, at + H, |_| {});
    put(&conn, "a@x", "home", "Before", at - 2 * H, at, |_| {});
    put(&conn, "a@x", "home", "After", at + H, at + 2 * H, |_| {});
    put(&conn, "a@x", "home", "Tentative", at, at + H, |e| e.free_busy = "tentative".into());

    let found = overlapping(&conn, None, at, at + H, false, 0, &[]).unwrap();
    assert_eq!(subjects(&found), ["Standup", "Tentative", "Dentist"], "touching ends do not overlap");
    assert_eq!((found[0].account.as_str(), found[0].calendar_id.as_str()), ("b@y", "work"), "every account counts");
    let one = overlapping(&conn, Some("a@x"), at, at + H, false, 0, &[]).unwrap();
    assert_eq!(subjects(&one), ["Tentative", "Dentist"]);
    assert!(overlapping(&conn, None, at + H, at, false, 0, &[]).unwrap().is_empty(), "no range, nothing");
}

#[test]
fn the_event_itself_does_not_conflict_with_its_own_time() {
    let conn = store();
    let at = DAY + 9 * H;
    put(&conn, "a@x", "home", "local:import:meet@ex@1894269600", at, at + H, |e| e.subject = "Kept invitation".into());
    put(&conn, "b@y", "work", "meet@ex@1894269600", at, at + H, |e| e.subject = "CalDAV copy".into());
    put(&conn, "b@y", "work", "occ-1", at, at + H, |e| {
        e.subject = "Series".into();
        e.series_id = Some("series-9".into());
    });
    put(&conn, "a@x", "home", "other", at, at + H, |e| e.subject = "Other".into());
    let all = overlapping(&conn, None, at, at + H, false, 0, &[]).unwrap();
    assert_eq!(all.len(), 4);
    let found = overlapping(&conn, None, at, at + H, false, 0, &["meet@ex".into(), "series-9".into()]).unwrap();
    assert_eq!(subjects(&found), ["Other"]);
    let by_id = overlapping(&conn, None, at, at + H, false, 0, &["other".into()]).unwrap();
    assert_eq!(by_id.len(), 3);
}

#[test]
fn an_all_day_event_counts_when_the_proposed_time_touches_its_day_where_the_person_is() {
    let conn = store();
    // All day on the 10th, kept as midnight UTC to midnight UTC.
    put(&conn, "a@x", "home", "Holiday", DAY, DAY + 24 * H, |e| e.all_day = true);
    // 09:00–10:00 in UTC+2 on the 10th.
    let offset = 2 * H;
    assert_eq!(subjects(&overlapping(&conn, None, DAY + 7 * H, DAY + 8 * H, false, offset, &[]).unwrap()), ["Holiday"]);
    // 00:30–01:30 on the 11th in UTC+2 is still the 10th in UTC: not that day where the person is.
    assert!(overlapping(&conn, None, DAY + 22 * H + H / 2, DAY + 23 * H + H / 2, false, offset, &[]).unwrap().is_empty());
    // 23:00–23:30 on the 9th in UTC-5 is the 10th in UTC: not the 10th for the person.
    assert!(overlapping(&conn, None, DAY + 4 * H, DAY + 4 * H + H / 2, false, -5 * H, &[]).unwrap().is_empty());
    // A proposed all-day day overlaps the all-day event and the timed events of that day where the person is.
    put(&conn, "a@x", "home", "Lunch", DAY + 10 * H, DAY + 11 * H, |_| {});
    put(&conn, "a@x", "home", "Late", DAY + 23 * H, DAY + 24 * H, |_| {});
    let day = overlapping(&conn, None, DAY, DAY + 24 * H, true, offset, &[]).unwrap();
    assert_eq!(subjects(&day), ["Holiday", "Lunch"], "01:00 on the 11th where the person is, not the 10th");
    assert!(day[0].all_day);
    assert!(overlapping(&conn, None, DAY + 24 * H, DAY + 48 * H, true, 0, &[]).unwrap().iter().all(|o| o.subject != "Holiday"));
}
