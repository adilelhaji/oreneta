use super::*;
use crate::calendar::Response;

// After RFC 5546 §4.2.2 (a group meeting request), with a zone and a series.
const REQUEST: &str = "BEGIN:VCALENDAR\r\nPRODID:-//Example/ExampleCalendarClient//EN\r\nMETHOD:REQUEST\r\nVERSION:2.0\r\n\
BEGIN:VEVENT\r\nORGANIZER;CN=\"Smith, A\":mailto:A@example.com\r\n\
ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED;CN=A:mailto:A@example.com\r\n\
ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;CN=B:mailto:b@example.com\r\n\
ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;CN=C:mailto:c@example.com\r\n\
DTSTAMP:19970611T190000Z\r\nDTSTART;TZID=Europe/Madrid:20260701T100000\r\nDTEND;TZID=Europe/Madrid:20260701T110000\r\n\
RRULE:FREQ=WEEKLY;COUNT=4\r\nSUMMARY:Conference\\, quarterly\r\nLOCATION:Room 1\r\nUID:calsrv.example.com-873970198738777@example.com\r\n\
SEQUENCE:2\r\nSTATUS:CONFIRMED\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

#[test]
fn an_invitation_is_read_with_its_people_and_first_occurrence() {
    let invitation = parse(REQUEST).unwrap();
    assert_eq!(invitation.method, "REQUEST");
    assert_eq!(invitation.uid, "calsrv.example.com-873970198738777@example.com");
    assert_eq!(invitation.sequence, 2);
    assert_eq!(invitation.summary, "Conference, quarterly");
    assert_eq!(invitation.location.as_deref(), Some("Room 1"));
    assert!(invitation.repeats);
    // 10:00 in Madrid in July is 08:00 UTC.
    assert_eq!(invitation.start, chrono::DateTime::parse_from_rfc3339("2026-07-01T08:00:00Z").unwrap().timestamp());
    let organizer = invitation.organizer.unwrap();
    assert_eq!((organizer.name.as_str(), organizer.addr.as_str()), ("Smith, A", "a@example.com"));
    assert_eq!(invitation.attendees.len(), 3);
    assert_eq!(invitation.attendees[0].response, "accept");
    assert_eq!(invitation.attendees[1].addr, "b@example.com");
}

#[test]
fn a_published_calendar_is_not_an_invitation() {
    assert!(parse(&REQUEST.replace("METHOD:REQUEST\r\n", "")).is_none());
    assert!(parse("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n").is_none());
}

#[test]
fn an_answer_names_the_event_and_this_attendee_only() {
    let invitation = parse(REQUEST).unwrap();
    let me = Participant { name: "B".into(), addr: "b@example.com".into(), response: String::new() };
    let answer = reply(&invitation, &me, Response::Tentative, 1_760_000_000).unwrap();
    for want in [
        "METHOD:REPLY",
        "UID:calsrv.example.com-873970198738777@example.com",
        "SEQUENCE:2",
        "ATTENDEE;PARTSTAT=TENTATIVE;CN=B:mailto:b@example.com",
        "ORGANIZER;CN=\"Smith, A\":mailto:A@example.com",
        "DTSTART;TZID=Europe/Madrid:20260701T100000",
    ] {
        assert!(answer.contains(want), "{want} missing:\n{answer}");
    }
    assert!(!answer.contains("c@example.com"), "other attendees are not repeated");
    assert!(!answer.contains("VALARM") && !answer.contains("RRULE"));
    let read = parse(&answer).unwrap();
    assert_eq!((read.method.as_str(), read.attendees[0].response.as_str()), ("REPLY", "tentative"));

    let cancel = parse(&REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL")).unwrap();
    assert!(reply(&cancel, &me, Response::Accept, 0).is_err(), "a cancellation is not answered");
}

#[test]
fn the_kept_event_carries_the_answer_and_no_method() {
    let invitation = parse(REQUEST).unwrap();
    let kept = as_event(&invitation, "B@example.com", Response::Accept);
    assert!(!kept.contains("METHOD:"));
    assert!(kept.contains("ATTENDEE;CUTYPE=INDIVIDUAL;CN=B;PARTSTAT=ACCEPTED:mailto:b@example.com"), "{kept}");
    assert!(kept.contains("ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;CN=C:mailto:c@example.com"), "others untouched");
    assert_eq!(sequence_of(&kept), Some(2));
}

#[test]
fn an_older_version_is_recognised_by_its_sequence() {
    let invitation = parse(REQUEST).unwrap();
    assert!(!is_outdated(&invitation, None));
    assert!(!is_outdated(&invitation, Some(2)));
    assert!(is_outdated(&invitation, Some(3)));
}

#[test]
fn one_occurrence_of_a_series_is_named() {
    let single = REQUEST
        .replace("RRULE:FREQ=WEEKLY;COUNT=4\r\n", "RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000\r\n")
        .replace("DTSTART;TZID=Europe/Madrid:20260701T100000", "DTSTART;TZID=Europe/Madrid:20260708T120000")
        .replace("DTEND;TZID=Europe/Madrid:20260701T110000", "DTEND;TZID=Europe/Madrid:20260708T130000");
    let invitation = parse(&single).unwrap();
    assert!(invitation.recurrence_id.is_some());
    let me = Participant { name: String::new(), addr: "b@example.com".into(), response: String::new() };
    assert!(reply(&invitation, &me, Response::Accept, 0).unwrap().contains("RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000"));
}

#[test]
fn an_answer_to_an_older_version_does_not_undo_a_newer_one() {
    let conn = crate::store::open_at(":memory:").unwrap();
    let answer = |sequence: i64, response: &str| Answer { sequence, response: response.into(), calendar_id: String::new(), answered_at: 1 };
    assert!(record(&conn, "a", "uid", &answer(2, "accept")).unwrap());
    assert!(!record(&conn, "a", "uid", &answer(1, "decline")).unwrap());
    assert_eq!(answer_of(&conn, "a", "uid").unwrap().unwrap().response, "accept");
    assert!(record(&conn, "a", "uid", &answer(2, "tentative")).unwrap(), "the same version may be answered again");
    assert_eq!(answer_of(&conn, "a", "uid").unwrap().unwrap().response, "tentative");
    assert!(answer_of(&conn, "b", "uid").unwrap().is_none(), "answers are per account");
}

// ---- Proposing another time (ADR-0043) ---------------------------------------

const SINGLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meet@example.com\r\nSEQUENCE:3\r\n\
DTSTAMP:20300101T000000Z\r\nDTSTART:20300110T090000Z\r\nDTEND:20300110T100000Z\r\nSUMMARY:Planning\\, Q1\r\n\
ORGANIZER;CN=Ana:mailto:ana@example.com\r\nATTENDEE;RSVP=TRUE;CN=Bo:mailto:bo@example.com\r\n\
ATTENDEE;RSVP=TRUE;CN=Cy:mailto:cy@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

fn bo() -> Participant {
    Participant { name: "Bo".into(), addr: "bo@example.com".into(), response: String::new() }
}

fn at(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp()
}

#[test]
fn a_proposal_names_the_same_version_this_attendee_and_the_new_time() {
    let invitation = parse(SINGLE).unwrap();
    let comment = "Can we move it; I have a clash, sorry\nThanks";
    let ics = counter(&invitation, &bo(), at("2030-01-10T14:00:00Z"), at("2030-01-10T15:30:00Z"), comment, at("2030-01-05T08:00:00Z")).unwrap();
    for want in [
        "METHOD:COUNTER",
        "UID:meet@example.com",
        "SEQUENCE:3",
        "DTSTAMP:20300105T080000Z",
        "DTSTART:20300110T140000Z",
        "DTEND:20300110T153000Z",
        "ORGANIZER;CN=Ana:mailto:ana@example.com",
        "ATTENDEE;CN=Bo:mailto:bo@example.com",
        "SUMMARY:Planning\\, Q1",
        "COMMENT:Can we move it\\; I have a clash\\, sorry\\nThanks",
    ] {
        assert!(ics.contains(want), "{want} missing:\n{ics}");
    }
    assert!(!ics.contains("cy@example.com"), "only the person proposing");
    let read = parse(&ics).unwrap();
    assert_eq!((read.method.as_str(), read.uid.as_str(), read.sequence), ("COUNTER", "meet@example.com", 3));
    assert_eq!((read.start, read.end, read.all_day), (at("2030-01-10T14:00:00Z"), at("2030-01-10T15:30:00Z"), false));
    assert_eq!(read.attendees.len(), 1);
    assert_eq!(read.attendees[0].addr, "bo@example.com");
    assert_eq!(read.organizer.unwrap().addr, "ana@example.com");
    assert_eq!(read.summary, "Planning, Q1");
    assert_eq!(read.comment.as_deref(), Some(comment));
    assert!(!counter(&invitation, &bo(), at("2030-01-10T14:00:00Z"), at("2030-01-10T15:00:00Z"), "  ", 0).unwrap().contains("COMMENT"));
}

#[test]
fn an_all_day_invitation_gets_an_all_day_proposal() {
    let all_day = SINGLE
        .replace("DTSTART:20300110T090000Z", "DTSTART;VALUE=DATE:20300110")
        .replace("DTEND:20300110T100000Z", "DTEND;VALUE=DATE:20300111");
    let invitation = parse(&all_day).unwrap();
    assert!(invitation.all_day);
    let ics = counter(&invitation, &bo(), at("2030-01-12T00:00:00Z"), at("2030-01-14T00:00:00Z"), "", 0).unwrap();
    assert!(ics.contains("DTSTART;VALUE=DATE:20300112") && ics.contains("DTEND;VALUE=DATE:20300114"), "{ics}");
    let read = parse(&ics).unwrap();
    assert!(read.all_day);
    assert_eq!((read.start, read.end), (at("2030-01-12T00:00:00Z"), at("2030-01-14T00:00:00Z")));
    assert!(counter(&invitation, &bo(), at("2030-01-12T00:00:00Z"), at("2030-01-12T20:00:00Z"), "", 0).is_err(), "the same day is no range");
}

#[test]
fn a_proposal_is_refused_when_it_cannot_be_one() {
    let invitation = parse(SINGLE).unwrap();
    let (s, e) = (at("2030-01-10T14:00:00Z"), at("2030-01-10T15:00:00Z"));
    let err = |r: Result<String>| r.unwrap_err().to_string();
    assert!(err(counter(&invitation, &bo(), e, s, "", 0)).contains("end must be after"));
    assert!(err(counter(&invitation, &bo(), s, s, "", 0)).contains("end must be after"));
    let ana = Participant { name: "Ana".into(), addr: "Ana@Example.com".into(), response: String::new() };
    assert!(err(counter(&invitation, &ana, s, e, "", 0)).contains("you organize"));
    let cancel = parse(&SINGLE.replace("METHOD:REQUEST", "METHOD:CANCEL")).unwrap();
    assert!(err(counter(&cancel, &bo(), s, e, "", 0)).contains("cancelled"));
    let status = parse(&SINGLE.replace("SEQUENCE:3\r\n", "SEQUENCE:3\r\nSTATUS:CANCELLED\r\n")).unwrap();
    assert!(status.cancelled);
    assert!(err(counter(&status, &bo(), s, e, "", 0)).contains("cancelled"));
    let series = parse(&SINGLE.replace("SEQUENCE:3\r\n", "SEQUENCE:3\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\n")).unwrap();
    assert!(err(counter(&series, &bo(), s, e, "", 0)).contains("whole series"));
    // Outdated: an answered later version is what the caller compares.
    assert!(is_outdated(&invitation, Some(4)));
}

#[test]
fn one_occurrence_of_a_series_can_get_another_time() {
    let single = REQUEST
        .replace("RRULE:FREQ=WEEKLY;COUNT=4\r\n", "RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000\r\n")
        .replace("DTSTART;TZID=Europe/Madrid:20260701T100000", "DTSTART;TZID=Europe/Madrid:20260708T100000")
        .replace("DTEND;TZID=Europe/Madrid:20260701T110000", "DTEND;TZID=Europe/Madrid:20260708T110000");
    let invitation = parse(&single).unwrap();
    let me = Participant { name: String::new(), addr: "b@example.com".into(), response: String::new() };
    let ics = counter(&invitation, &me, at("2026-07-08T12:00:00Z"), at("2026-07-08T13:00:00Z"), "", 0).unwrap();
    assert!(ics.contains("RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000"));
    assert!(ics.contains("ATTENDEE:mailto:b@example.com"));
}

#[test]
fn a_proposal_and_its_refusal_are_read_as_such() {
    let invitation = parse(SINGLE).unwrap();
    let proposal = counter(&invitation, &bo(), at("2030-01-10T14:00:00Z"), at("2030-01-10T15:00:00Z"), "After lunch?", 0).unwrap();
    let read = parse(&proposal).unwrap();
    let ana = Participant { name: "Ana".into(), addr: "ana@example.com".into(), response: String::new() };
    let refusal = decline_counter(&read, &ana, "No, sorry; the room is booked", at("2030-01-06T00:00:00Z")).unwrap();
    for want in [
        "METHOD:DECLINECOUNTER",
        "UID:meet@example.com",
        "SEQUENCE:3",
        "DTSTAMP:20300106T000000Z",
        "ORGANIZER;CN=Ana:mailto:ana@example.com",
        "ATTENDEE;CN=Bo:mailto:bo@example.com",
        "COMMENT:No\\, sorry\\; the room is booked",
    ] {
        assert!(refusal.contains(want), "{want} missing:\n{refusal}");
    }
    assert!(!refusal.contains("DTSTART"), "the meeting stays as it was; no time is named");
    let declined = parse(&refusal).unwrap();
    assert_eq!((declined.method.as_str(), declined.sequence, declined.uid.as_str()), ("DECLINECOUNTER", 3, "meet@example.com"));
    assert_eq!(declined.attendees.len(), 1);
    assert_eq!(declined.comment.as_deref(), Some("No, sorry; the room is booked"));
    assert_eq!((declined.start, declined.end), (0, 0));

    assert!(decline_counter(&invitation, &ana, "", 0).is_err(), "only a proposal is declined");
    assert!(decline_counter(&read, &bo(), "", 0).unwrap_err().to_string().contains("only they can decline"));
}

#[test]
fn the_organizer_is_found_for_a_kept_event_and_nobody_else() {
    use crate::calendar::{put_local_event, upsert_calendars, Calendar, CalendarKind, Event};
    let conn = crate::store::open_in_memory_for_test().unwrap();
    let calendar = |id: &str, kind: CalendarKind| Calendar { id: id.into(), name: id.into(), enabled: true, kind, ..Default::default() };
    upsert_calendars(&conn, "ana@example.com", &[calendar("work", CalendarKind::CalDav), calendar("feed", CalendarKind::Subscribed)]).unwrap();
    let organizer = |addr: &str| Some(Participant { name: String::new(), addr: addr.into(), response: String::new() });
    let put = |calendar: &str, id: &str, start: i64, who: Option<Participant>, cancelled: bool| {
        put_local_event(&conn, "ana@example.com", &Event {
            id: id.into(),
            calendar_id: calendar.into(),
            subject: "Planning".into(),
            start,
            end: start + 3600,
            organizer: who,
            is_cancelled: cancelled,
            ..Default::default()
        })
        .unwrap()
    };
    put("work", "meet@example.com@1894269600", 1_894_269_600, organizer("MAILTO:Ana@Example.com"), false);
    put("work", "meet@example.com@1894874400", 1_894_874_400, organizer("ana@example.com"), false);
    put("work", "other@example.com@1894269600", 1_894_269_600, organizer("someone@else.org"), false);
    put("feed", "pub@example.com@1894269600", 1_894_269_600, organizer("ana@example.com"), false);
    put("work", "gone@example.com@1894269600", 1_894_269_600, organizer("ana@example.com"), true);

    let found = organized_event(&conn, "ana@example.com", "ana@example.com", "meet@example.com", None).unwrap().unwrap();
    assert_eq!(found.start, 1_894_269_600, "the earliest when no occurrence is named");
    let named = organized_event(&conn, "ana@example.com", "ana@example.com", "meet@example.com", Some(1_894_874_400)).unwrap().unwrap();
    assert_eq!(named.start, 1_894_874_400);
    assert!(organized_event(&conn, "ana@example.com", "ana@example.com", "other@example.com", None).unwrap().is_none(), "someone else organizes it");
    assert!(organized_event(&conn, "ana@example.com", "ana@example.com", "pub@example.com", None).unwrap().is_none(), "a subscription is not one's own");
    assert!(organized_event(&conn, "ana@example.com", "ana@example.com", "gone@example.com", None).unwrap().is_none(), "cancelled");
    assert!(organized_event(&conn, "ana@example.com", "ana@example.com", "missing@example.com", None).unwrap().is_none());
    assert!(organized_event(&conn, "bo@example.com", "bo@example.com", "meet@example.com", None).unwrap().is_none(), "per account");
}

// ---- The organizer telling the people on it ----------------------------------

/// A series Ana organizes on a CalDAV server, with its zone, an alarm of hers
/// and one occurrence moved, after two saves.
const ORGANIZED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Oreneta//Oreneta Calendar//EN\r\n\
BEGIN:VTIMEZONE\r\nTZID:Europe/Madrid\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\n\
TZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nUID:weekly@oreneta\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;TZID=Europe/Madrid:20260701T100000\r\n\
DTEND;TZID=Europe/Madrid:20260701T110000\r\nSUMMARY:Sync\\, weekly\r\nDESCRIPTION:Agenda in the doc\r\nSEQUENCE:2\r\n\
RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Europe/Madrid:20260722T100000\r\n\
ORGANIZER;CN=Ana:mailto:ana@example.com\r\nATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED;CN=Ana:mailto:ana@example.com\r\n\
ATTENDEE;PARTSTAT=ACCEPTED;CN=Bo:mailto:bo@example.com\r\nATTENDEE;CN=\"Cy, the intern\":mailto:Cy@Example.com\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:weekly@oreneta\r\nRECURRENCE-ID;TZID=Europe/Madrid:20260708T100000\r\nDTSTAMP:20260101T000000Z\r\n\
DTSTART;TZID=Europe/Madrid:20260708T120000\r\nDTEND;TZID=Europe/Madrid:20260708T130000\r\nSUMMARY:Sync (moved)\r\n\
SEQUENCE:3\r\nORGANIZER;CN=Ana:mailto:ana@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED;CN=Bo:mailto:bo@example.com\r\n\
ATTENDEE;CN=\"Cy, the intern\":mailto:Cy@Example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

fn ana() -> Participant {
    Participant { name: "Ana".into(), addr: "ana@example.com".into(), response: String::new() }
}

const NOTICE_NOW: i64 = 1_791_799_200;

/// The lines of the event components of a notice, unfolded.
fn notice_lines(ics: &str) -> Vec<String> {
    unfold(ics)
}

#[test]
fn an_update_of_a_series_carries_its_rule_zone_exceptions_and_people() {
    let notice = organizer_notice(ORGANIZED, Notice::Request, None, &ana(), NOTICE_NOW).unwrap();
    assert_eq!(notice.method, "REQUEST");
    assert_eq!(notice.to, vec!["bo@example.com", "cy@example.com"], "the organizer is not mailed her own invitation");
    assert_eq!(notice.summary, "Sync, weekly");
    assert_eq!(notice.sequence, 2, "the version the last save stored");
    let lines = notice_lines(&notice.ics);
    assert!(lines.contains(&"METHOD:REQUEST".to_string()));
    assert!(lines.contains(&"TZID:Europe/Madrid".to_string()), "the zone the times are in travels with them");
    assert!(lines.contains(&"RRULE:FREQ=WEEKLY;COUNT=4".to_string()));
    assert!(lines.contains(&"EXDATE;TZID=Europe/Madrid:20260722T100000".to_string()));
    assert_eq!(lines.iter().filter(|l| *l == "BEGIN:VEVENT").count(), 2, "the series and its exception");
    assert!(lines.contains(&"RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000".to_string()));
    assert!(lines.contains(&"SEQUENCE:3".to_string()), "each component keeps its own version");
    assert_eq!(lines.iter().filter(|l| **l == format!("DTSTAMP:{}", stamp(NOTICE_NOW))).count(), 2, "stamped when sent");
    assert!(!notice.ics.contains("VALARM"), "the organizer's alarms are hers");
    assert!(lines.contains(&"DESCRIPTION:Agenda in the doc".to_string()));
    // An answer already given stays; whoever has not answered is asked to.
    assert!(lines.contains(&"ATTENDEE;PARTSTAT=ACCEPTED;CN=Bo:mailto:bo@example.com".to_string()));
    assert!(lines.contains(&"ATTENDEE;CN=\"Cy, the intern\";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Cy@Example.com".to_string()));
    assert!(lines.contains(&"ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED;CN=Ana:mailto:ana@example.com".to_string()));
    // What goes out is a valid invitation in its own right.
    let read = parse(&notice.ics).unwrap();
    assert_eq!((read.method.as_str(), read.uid.as_str(), read.sequence), ("REQUEST", "weekly@oreneta", 2));
    assert!(read.repeats);
    assert_eq!(read.organizer.unwrap().addr, "ana@example.com");
    assert!(notice.ics.split("\r\n").all(|line| line.len() <= 75));
}

#[test]
fn an_update_of_one_occurrence_carries_only_it() {
    let moved = at("2026-07-08T08:00:00Z");
    let notice = organizer_notice(ORGANIZED, Notice::Request, Some(moved), &ana(), NOTICE_NOW).unwrap();
    let lines = notice_lines(&notice.ics);
    assert_eq!(lines.iter().filter(|l| *l == "BEGIN:VEVENT").count(), 1);
    assert!(lines.contains(&"RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000".to_string()));
    assert!(lines.contains(&"DTSTART;TZID=Europe/Madrid:20260708T120000".to_string()));
    assert!(!notice.ics.contains("RRULE"), "one occurrence does not restate the series");
    assert_eq!(notice.sequence, 3);
    assert_eq!(notice.summary, "Sync (moved)");
    let read = parse(&notice.ics).unwrap();
    assert_eq!(read.recurrence_id, Some(moved));

    // An occurrence with no exception of its own goes out as the series has it.
    let third = at("2026-07-15T08:00:00Z");
    let plain = organizer_notice(ORGANIZED, Notice::Request, Some(third), &ana(), NOTICE_NOW).unwrap();
    let lines = notice_lines(&plain.ics);
    assert!(lines.contains(&"RECURRENCE-ID;TZID=Europe/Madrid:20260715T100000".to_string()), "{}", plain.ics);
    assert!(lines.contains(&"DTSTART;TZID=Europe/Madrid:20260715T100000".to_string()));
    assert!(lines.contains(&"DTEND;TZID=Europe/Madrid:20260715T110000".to_string()));
    assert!(!plain.ics.contains("RRULE") && !plain.ics.contains("EXDATE"));
    assert_eq!(plain.sequence, 2);
}

#[test]
fn a_cancellation_supersedes_the_last_version_sent() {
    let notice = organizer_notice(ORGANIZED, Notice::Cancel, None, &ana(), NOTICE_NOW).unwrap();
    assert_eq!(notice.method, "CANCEL");
    assert_eq!(notice.sequence, 3, "one past the stored version");
    let lines = notice_lines(&notice.ics);
    assert!(lines.contains(&"METHOD:CANCEL".to_string()));
    assert!(lines.contains(&"STATUS:CANCELLED".to_string()));
    assert!(lines.contains(&"SEQUENCE:3".to_string()));
    assert_eq!(lines.iter().filter(|l| *l == "BEGIN:VEVENT").count(), 1, "cancelling the UID cancels every occurrence");
    assert!(!lines.iter().any(|l| l.starts_with("RECURRENCE-ID")));
    assert!(!notice.ics.contains("RRULE") && !notice.ics.contains("DESCRIPTION"));
    assert_eq!(notice.to, vec!["bo@example.com", "cy@example.com"]);
    let read = parse(&notice.ics).unwrap();
    assert!(read.cancelled);
    assert_eq!(read.sequence, 3);

    // One occurrence: named by its RECURRENCE-ID, one past its own version.
    let one = organizer_notice(ORGANIZED, Notice::Cancel, Some(at("2026-07-08T08:00:00Z")), &ana(), NOTICE_NOW).unwrap();
    assert!(notice_lines(&one.ics).contains(&"RECURRENCE-ID;TZID=Europe/Madrid:20260708T100000".to_string()));
    assert_eq!(one.sequence, 4);
}

#[test]
fn only_the_organizer_tells_and_only_when_someone_is_on_it() {
    let refused = organizer_notice(ORGANIZED, Notice::Request, None, &bo(), NOTICE_NOW).unwrap_err();
    assert!(refused.to_string().contains("ana@example.com organizes this meeting"), "{refused}");

    let alone = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:solo\r\nDTSTART:20300110T090000Z\r\n\
SUMMARY:Focus\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    assert!(organizer_notice(alone, Notice::Request, None, &ana(), NOTICE_NOW).unwrap_err().to_string().contains("nobody to tell"));
    let only_me = alone.replace("END:VEVENT", "ATTENDEE:mailto:ANA@example.com\r\nEND:VEVENT");
    assert!(organizer_notice(&only_me, Notice::Request, None, &ana(), NOTICE_NOW).is_err());

    // No organizer yet: the one sending becomes it.
    let unowned = alone.replace("END:VEVENT", "ATTENDEE:mailto:bo@example.com\r\nEND:VEVENT");
    let notice = organizer_notice(&unowned, Notice::Request, None, &ana(), NOTICE_NOW).unwrap();
    assert!(notice_lines(&notice.ics).contains(&"ORGANIZER;CN=Ana:mailto:ana@example.com".to_string()));
    assert!(notice_lines(&notice.ics).contains(&"ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.com".to_string()));

    let nameless = Participant { addr: String::new(), ..ana() };
    assert!(organizer_notice(&unowned, Notice::Request, None, &nameless, NOTICE_NOW).is_err());
}

#[test]
fn a_local_event_goes_out_with_its_own_uid_sequence_and_escaped_text() {
    use crate::calendar::Event;
    let event = Event {
        id: "local:3f1c".into(),
        calendar_id: "local:home".into(),
        subject: "Budget; draft, v2 — revisión con el equipo de finanzas y el comité de dirección".into(),
        location: Some("Sala 2, planta 3".into()),
        start: at("2030-01-10T09:00:00Z"),
        end: at("2030-01-10T10:00:00Z"),
        organizer: Some(ana()),
        attendees: vec![bo(), Participant { name: "Cy".into(), addr: "cy@example.com".into(), response: "accept".into() }],
        change_key: Some("5".into()),
        ..Default::default()
    };
    assert_eq!(local_uid(&event), ("local:3f1c".to_string(), None));
    let object = local_object(&event, crate::calendar::local_sequence(&event), NOTICE_NOW);
    let notice = organizer_notice(&object, Notice::Request, None, &ana(), NOTICE_NOW).unwrap();
    assert_eq!(notice.sequence, 5);
    assert_eq!(notice.to, vec!["bo@example.com", "cy@example.com"]);
    assert_eq!(notice.summary, event.subject);
    let lines = notice_lines(&notice.ics);
    assert!(lines.contains(&"UID:local:3f1c".to_string()));
    assert!(lines.contains(&"LOCATION:Sala 2\\, planta 3".to_string()));
    assert!(lines.contains(&format!("SUMMARY:{}", crate::calendar::ics::escape(&event.subject))));
    assert!(lines.contains(&"ATTENDEE;CN=Bo;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.com".to_string()));
    assert!(lines.contains(&"ATTENDEE;CN=Cy;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:cy@example.com".to_string()));
    assert!(notice.ics.contains("\r\n "), "a long line is folded");
    assert!(notice.ics.split("\r\n").all(|line| line.len() <= 75));
    let read = parse(&notice.ics).unwrap();
    assert_eq!((read.uid.as_str(), read.sequence, read.start), ("local:3f1c", 5, event.start));

    // An imported occurrence keeps the UID it came with and names itself.
    let imported = Event {
        id: format!("local:import:series@example.com@{}", event.start),
        is_recurring: true,
        ..event.clone()
    };
    assert_eq!(local_uid(&imported), ("series@example.com".to_string(), Some(event.start)));
    let object = local_object(&imported, 0, NOTICE_NOW);
    let cancel = organizer_notice(&object, Notice::Cancel, Some(event.start), &ana(), NOTICE_NOW).unwrap();
    assert!(notice_lines(&cancel.ics).contains(&"RECURRENCE-ID:20300110T090000Z".to_string()), "{}", cancel.ics);
    assert_eq!(cancel.sequence, 1);
}
