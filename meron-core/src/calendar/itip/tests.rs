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
