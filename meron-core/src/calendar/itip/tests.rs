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
