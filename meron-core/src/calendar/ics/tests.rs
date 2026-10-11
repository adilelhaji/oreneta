use super::*;
use crate::calendar::subscription::parse_window;
use crate::calendar::{Frequency, Participant};

const NOW: i64 = 1_760_000_000;

fn at(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp()
}

fn event(subject: &str, start: &str, end: &str) -> Event {
    Event {
        id: String::new(),
        calendar_id: "cal".into(),
        subject: subject.into(),
        start: at(start),
        end: at(end),
        ..Default::default()
    }
}

#[test]
fn text_is_escaped_and_long_lines_are_folded_on_characters() {
    assert_eq!(escape("a;b,c\\d\ne"), r"a\;b\,c\\d\ne");
    let long = format!("SUMMARY:{}", "ñ".repeat(60));
    let folded = fold(&long);
    assert!(folded.split("\r\n").all(|line| line.len() <= 75));
    assert_eq!(unfold(&folded), vec![long]);
}

#[test]
fn a_new_event_reads_back_the_same() {
    let mut e = event("Dentist; then lunch, maybe", "2026-03-10T09:00:00Z", "2026-03-10T10:30:00Z");
    e.location = Some("Carrer Major, 1".into());
    e.description = "Bring the card\nand the form".into();
    e.reminder_minutes = Some(30);
    let ics = new_object(&e, "uid-1", NOW);
    let (events, skipped) = parse_window(&ics, "cal", at("2026-03-01T00:00:00Z"), at("2026-04-01T00:00:00Z")).unwrap();
    assert_eq!((events.len(), skipped), (1, 0));
    let back = &events[0];
    assert_eq!((back.start, back.end), (e.start, e.end));
    assert_eq!(back.subject, e.subject);
    assert_eq!(back.location, e.location);
    assert_eq!(back.description, e.description);
    assert_eq!(reminders(&ics).get("uid-1"), Some(&30));
}

#[test]
fn an_all_day_event_keeps_its_date() {
    let mut e = event("Holiday", "2026-08-15T00:00:00Z", "2026-08-16T00:00:00Z");
    e.all_day = true;
    let ics = new_object(&e, "uid-2", NOW);
    assert!(ics.contains("DTSTART;VALUE=DATE:20260815") && ics.contains("DTEND;VALUE=DATE:20260816"));
    let (events, _) = parse_window(&ics, "cal", at("2026-08-01T00:00:00Z"), at("2026-09-01T00:00:00Z")).unwrap();
    assert!(events[0].all_day);
}

#[test]
fn a_series_is_written_in_its_zone_and_keeps_its_hour_across_a_clock_change() {
    // 09:00 in Madrid every Monday, either side of the 29 March 2026 change.
    let mut e = event("Stand-up", "2026-03-16T08:00:00Z", "2026-03-16T08:15:00Z");
    e.recurrence = Some(Recurrence { freq: Frequency::Weekly, interval: 1, count: Some(4), ..Default::default() });
    let ics = new_object_in(&e, "uid-3", NOW, Some("Europe/Madrid"));
    assert!(ics.contains("DTSTART;TZID=Europe/Madrid:20260316T090000"), "{ics}");
    let (events, _) = parse_window(&ics, "cal", at("2026-03-01T00:00:00Z"), at("2026-05-01T00:00:00Z")).unwrap();
    let mut starts: Vec<i64> = events.iter().map(|e| e.start).collect();
    starts.sort();
    assert_eq!(
        starts,
        vec![at("2026-03-16T08:00:00Z"), at("2026-03-23T08:00:00Z"), at("2026-03-30T07:00:00Z"), at("2026-04-06T07:00:00Z")]
    );
}

const FOREIGN: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VEVENT\r\nUID:abc@other\r\n\
DTSTAMP:20260101T000000Z\r\nDTSTART;TZID=Europe/Madrid:20260302T100000\r\nDTEND;TZID=Europe/Madrid:20260302T110000\r\n\
RRULE:FREQ=WEEKLY;COUNT=5\r\nSUMMARY:Review\r\nSEQUENCE:3\r\nORGANIZER;CN=Ana:mailto:ana@x.cat\r\n\
ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@x.cat\r\nX-OTHER-CLIENT:keep me\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\n\
TRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

fn occurrences(ics: &str) -> Vec<Event> {
    let (mut events, skipped) = parse_window(ics, "cal", at("2026-03-01T00:00:00Z"), at("2026-05-01T00:00:00Z")).unwrap();
    assert_eq!(skipped, 0);
    events.sort_by_key(|e| e.start);
    events
}

#[test]
fn editing_keeps_every_line_this_client_does_not_own() {
    let mut first = occurrences(FOREIGN)[0].clone();
    first.subject = "Review, now longer".into();
    first.reminder_minutes = Some(5);
    let patched = patch_event(FOREIGN, &first, true, NOW).unwrap();
    for kept in ["ORGANIZER;CN=Ana:mailto:ana@x.cat", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@x.cat", "X-OTHER-CLIENT:keep me", "RRULE:FREQ=WEEKLY;COUNT=5", "UID:abc@other"] {
        assert!(patched.contains(kept), "{kept} lost:\n{patched}");
    }
    assert!(patched.contains("SEQUENCE:4"));
    assert!(patched.contains("TRIGGER:-PT5M") && !patched.contains("TRIGGER:-PT10M"), "the alarm is replaced, not added");
    assert_eq!(patched.matches("BEGIN:VALARM").count(), 1);
    let after = occurrences(&patched);
    assert_eq!(after.len(), 5);
    assert!(after.iter().all(|e| e.subject == "Review, now longer"));
}

#[test]
fn moving_a_whole_series_from_one_occurrence_keeps_its_first_date() {
    let all = occurrences(FOREIGN);
    // The third occurrence, moved an hour later: the whole series moves an hour.
    let mut third = all[2].clone();
    third.start += 3600;
    third.end += 3600;
    let patched = patch_event(FOREIGN, &third, true, NOW).unwrap();
    assert!(patched.contains("DTSTART;TZID=Europe/Madrid:20260302T110000"), "{patched}");
    let after = occurrences(&patched);
    assert_eq!(after.len(), 5);
    for (before, now) in all.iter().zip(&after) {
        assert_eq!(now.start, before.start + 3600);
    }
}

#[test]
fn one_occurrence_is_changed_or_removed_on_its_own() {
    let all = occurrences(FOREIGN);
    let mut second = all[1].clone();
    second.subject = "Review (moved)".into();
    second.start += 7200;
    second.end += 7200;
    let with_override = put_override(FOREIGN, &second, NOW).unwrap();
    let after = occurrences(&with_override);
    assert_eq!(after.len(), 5);
    assert_eq!(after[1].subject, "Review (moved)");
    assert_eq!(after[1].start, all[1].start + 7200);
    assert_eq!(after[1].id, all[1].id, "the occurrence keeps its identity");
    assert!(with_override.contains("ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@x.cat"));

    // Changing it again replaces the exception rather than adding a second.
    second.subject = "Review (moved again)".into();
    let twice = put_override(&with_override, &second, NOW).unwrap();
    assert_eq!(twice.matches("RECURRENCE-ID").count(), 1);

    let removed = exclude_occurrence(&twice, &all[1].id, false).unwrap();
    let after = occurrences(&removed);
    assert_eq!(after.len(), 4);
    assert!(after.iter().all(|e| e.id != all[1].id));
    assert!(!removed.contains("RECURRENCE-ID"));
}

#[test]
fn reminders_are_read_in_minutes_before_the_start() {
    assert_eq!(minutes_before("-PT15M"), Some(15));
    assert_eq!(minutes_before("-P1D"), Some(1440));
    assert_eq!(minutes_before("-PT1H30M"), Some(90));
    assert_eq!(minutes_before("PT0S"), Some(0));
    assert_eq!(minutes_before("PT10M"), None, "after the start is not a reminder this client keeps");
    assert_eq!(minutes_before("nonsense"), None);
}

#[test]
fn an_export_holds_each_occurrence_as_its_own_event() {
    let mut a = event("One", "2026-03-10T09:00:00Z", "2026-03-10T10:00:00Z");
    a.id = "local:1".into();
    a.attendees = vec![Participant { addr: "x@y".into(), ..Default::default() }];
    let series = occurrences(FOREIGN);
    let file = export(&[a, series[0].clone(), series[1].clone()], NOW);
    let (events, skipped) = parse_window(&file, "cal", at("2026-03-01T00:00:00Z"), at("2026-05-01T00:00:00Z")).unwrap();
    assert_eq!((events.len(), skipped), (3, 0));
    assert!(!file.contains("RRULE"));
}

#[test]
fn a_series_in_a_utc_zone_is_written_in_plain_utc() {
    let mut e = event("Stand-up", "2026-03-16T08:00:00Z", "2026-03-16T08:15:00Z");
    e.recurrence = Some(Recurrence { freq: Frequency::Weekly, interval: 1, count: Some(3), ..Default::default() });
    let ics = new_object_in(&e, "uid-u", NOW, Some("Etc/UTC"));
    assert!(ics.contains("DTSTART:20260316T080000Z"), "{ics}");
}

#[test]
fn a_utc_time_beside_a_tzid_is_read_as_utc() {
    // What Radicale stores for a series written with TZID=Etc/UTC.
    let stored = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Etc/UTC:20260316T080000Z\r\n\
DTEND;TZID=Etc/UTC:20260316T081500Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:S\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let (events, skipped) = parse_window(stored, "cal", at("2026-03-01T00:00:00Z"), at("2026-04-01T00:00:00Z")).unwrap();
    assert_eq!((events.len(), skipped), (3, 0));
    assert!(events.iter().any(|e| e.start == at("2026-03-16T08:00:00Z")));
}
