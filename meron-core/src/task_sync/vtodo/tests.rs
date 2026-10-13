use super::*;

fn at(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text).unwrap().timestamp()
}

fn local_midnight(y: i32, m: u32, d: u32) -> i64 {
    Local.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp()
}

/// What another client wrote: properties this app does not show, a
/// time-zone definition, a relation, two alarms.
const OTHER: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\n\
BEGIN:VTIMEZONE\r\nTZID:Europe/Madrid\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VTODO\r\nUID:abc@other\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:Call the plumber\\, again\r\n\
DESCRIPTION:Line one\\nLine two\\; and more\r\nDUE;TZID=Europe/Madrid:20260310T180000\r\nPRIORITY:3\r\n\
CATEGORIES:home,urgent\r\nRELATED-TO:parent@other\r\nX-OTHER-COLOR:teal\r\nSEQUENCE:4\r\nSTATUS:IN-PROCESS\r\nPERCENT-COMPLETE:40\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:a\r\nTRIGGER;RELATED=END:-PT30M\r\nEND:VALARM\r\n\
BEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER;RELATED=END:-PT5M\r\nEND:VALARM\r\n\
END:VTODO\r\nEND:VCALENDAR\r\n";

#[test]
fn another_clients_task_is_read_with_its_zone_priority_and_alarm() {
    let todo = parse(OTHER).unwrap();
    assert_eq!(todo.uid, "abc@other");
    assert_eq!(todo.fields.title, "Call the plumber, again");
    assert_eq!(todo.fields.note, "Line one\nLine two; and more");
    assert_eq!(todo.fields.due_at, Some(at("2026-03-10T17:00:00Z")), "18:00 in Madrid is 17:00 UTC in March");
    assert_eq!(todo.fields.priority, 2, "PRIORITY 3 is high");
    assert_eq!(todo.fields.completed_at, None);
    assert_eq!(todo.fields.reminder_at, Some(at("2026-03-10T16:30:00Z")), "30 minutes before it is due");
    assert!(!todo.recurring);
}

#[test]
fn an_edit_changes_only_what_changed_and_keeps_everything_else() {
    let mut fields = parse(OTHER).unwrap().fields;
    fields.title = "Call the plumber; today".into();
    let out = patch(OTHER, &fields, at("2026-03-01T10:00:00Z")).unwrap();
    for kept in [
        "BEGIN:VTIMEZONE",
        "CATEGORIES:home,urgent",
        "RELATED-TO:parent@other",
        "X-OTHER-COLOR:teal",
        "DUE;TZID=Europe/Madrid:20260310T180000",
        "PRIORITY:3",
        "PERCENT-COMPLETE:40",
        "TRIGGER;RELATED=END:-PT30M",
        "ACTION:AUDIO",
        "DESCRIPTION:Line one\\nLine two\\; and more",
        "UID:abc@other",
    ] {
        assert!(out.contains(kept), "lost {kept}:\n{out}");
    }
    assert!(out.contains("SUMMARY:Call the plumber\\; today"));
    assert!(out.contains("SEQUENCE:5"));
    assert!(out.contains("DTSTAMP:20260301T100000Z") && out.contains("LAST-MODIFIED:20260301T100000Z"));
    assert_eq!(parse(&out).unwrap().fields, fields, "what was written reads back the same");
}

#[test]
fn priority_maps_both_ways() {
    for (value, expected) in [("1", 2), ("4", 2), ("5", 1), ("0", 1), ("6", 0), ("9", 0)] {
        let ics = OTHER.replace("PRIORITY:3", &format!("PRIORITY:{value}"));
        assert_eq!(parse(&ics).unwrap().fields.priority, expected, "PRIORITY:{value}");
    }
    assert_eq!(parse(&OTHER.replace("PRIORITY:3\r\n", "")).unwrap().fields.priority, 1);

    let base = parse(OTHER).unwrap().fields;
    let low = patch(OTHER, &Fields { priority: 0, ..base.clone() }, 1).unwrap();
    assert!(low.contains("PRIORITY:9") && !low.contains("PRIORITY:3"));
    let normal = patch(OTHER, &Fields { priority: 1, ..base.clone() }, 1).unwrap();
    assert!(!normal.contains("PRIORITY"), "normal is written as no priority");
    let five = OTHER.replace("PRIORITY:3", "PRIORITY:5");
    let kept = patch(&five, &Fields { title: "x".into(), ..parse(&five).unwrap().fields }, 1).unwrap();
    assert!(kept.contains("PRIORITY:5"), "a priority that already means normal stays");
    let high = patch(&five, &Fields { priority: 2, ..parse(&five).unwrap().fields }, 1).unwrap();
    assert!(high.contains("PRIORITY:1"));
}

#[test]
fn a_date_only_due_is_midnight_here_and_is_written_back_as_a_date() {
    let ics = OTHER.replace("DUE;TZID=Europe/Madrid:20260310T180000", "DUE;VALUE=DATE:20260310");
    let fields = parse(&ics).unwrap().fields;
    assert_eq!(fields.due_at, Some(local_midnight(2026, 3, 10)));
    let moved = Fields { due_at: Some(local_midnight(2026, 3, 12)), ..fields.clone() };
    let out = patch(&ics, &moved, 1).unwrap();
    assert!(out.contains("DUE;VALUE=DATE:20260312"), "{out}");
    let timed = Fields { due_at: Some(at("2026-03-12T09:15:00Z")), ..fields };
    let out = patch(&ics, &timed, 1).unwrap();
    assert!(out.contains("DUE:20260312T091500Z") || out.contains("DUE;VALUE=DATE"), "{out}");
    assert_eq!(parse(&out).unwrap().fields.due_at, Some(at("2026-03-12T09:15:00Z")));
}

#[test]
fn completing_and_reopening() {
    let base = parse(OTHER).unwrap().fields;
    let done = Fields { completed_at: Some(at("2026-03-02T08:00:00Z")), ..base.clone() };
    let out = patch(OTHER, &done, 1).unwrap();
    assert!(out.contains("STATUS:COMPLETED") && out.contains("COMPLETED:20260302T080000Z"));
    assert!(out.contains("PERCENT-COMPLETE:100") && !out.contains("STATUS:IN-PROCESS"));
    assert_eq!(parse(&out).unwrap().fields.completed_at, done.completed_at);

    let reopened = patch(&out, &base, 2).unwrap();
    assert!(reopened.contains("STATUS:NEEDS-ACTION"));
    assert!(!reopened.contains("COMPLETED:") && !reopened.contains("PERCENT-COMPLETE"), "{reopened}");
    assert_eq!(parse(&reopened).unwrap().fields.completed_at, None);

    // A status of completed without the time it was done uses the last change.
    let bare = OTHER.replace("STATUS:IN-PROCESS", "STATUS:COMPLETED").replace("DTSTAMP:20260101T000000Z", "LAST-MODIFIED:20260105T000000Z");
    assert_eq!(parse(&bare).unwrap().fields.completed_at, Some(at("2026-01-05T00:00:00Z")));
}

#[test]
fn alarms_are_replaced_only_when_the_reminder_changes() {
    let base = parse(OTHER).unwrap().fields;
    let untouched = patch(OTHER, &Fields { note: "other".into(), ..base.clone() }, 1).unwrap();
    assert_eq!(untouched.matches("BEGIN:VALARM").count(), 2);

    let moved = Fields { reminder_at: Some(at("2026-03-10T08:00:00Z")), ..base.clone() };
    let out = patch(OTHER, &moved, 1).unwrap();
    assert_eq!(out.matches("BEGIN:VALARM").count(), 1, "{out}");
    assert!(out.contains("TRIGGER;VALUE=DATE-TIME:20260310T080000Z") && !out.contains("ACTION:AUDIO"));
    assert_eq!(parse(&out).unwrap().fields.reminder_at, moved.reminder_at);

    let none = patch(OTHER, &Fields { reminder_at: None, ..base }, 1).unwrap();
    assert!(!none.contains("VALARM"));
}

#[test]
fn a_new_task_is_a_whole_object_that_reads_back_the_same() {
    let fields = Fields {
        title: "Buy stamps, envelopes; glue\\tape".into(),
        note: "two lines\nhere".into(),
        due_at: Some(at("2026-04-01T12:30:00Z")),
        priority: 0,
        completed_at: None,
        reminder_at: Some(at("2026-04-01T11:30:00Z")),
        rrule: String::new(),
    };
    let ics = new_object(&fields, "n1@oreneta", at("2026-03-01T00:00:00Z"));
    assert!(ics.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Oreneta//"));
    assert!(ics.contains("UID:n1@oreneta") && ics.contains("SUMMARY:Buy stamps\\, envelopes\\; glue\\\\tape"));
    assert!(ics.contains("STATUS:NEEDS-ACTION") && ics.contains("PRIORITY:9"));
    let todo = parse(&ics).unwrap();
    assert_eq!((todo.uid.as_str(), todo.fields), ("n1@oreneta", fields));
}

/// A monthly task on the 31st from another client: a date-only due date,
/// a start, a count, an alarm relative to the due date and properties this
/// client does not show.
const MONTHLY: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VTODO\r\nUID:rent@other\r\n\
DTSTAMP:20260101T000000Z\r\nSUMMARY:Pay the rent\r\nDTSTART;VALUE=DATE:20270131\r\nDUE;VALUE=DATE:20270131\r\n\
RRULE:FREQ=MONTHLY;COUNT=5\r\nX-APPLE-SORT-ORDER:12\r\nCATEGORIES:home\r\nSEQUENCE:2\r\nSTATUS:NEEDS-ACTION\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Rent\r\nTRIGGER;RELATED=END:-PT15H\r\nX-WR-ALARMUID:a1\r\nEND:VALARM\r\n\
END:VTODO\r\nEND:VCALENDAR\r\n";

#[test]
fn a_repeating_task_the_editor_can_write_is_read_with_its_rule_spelled_out() {
    let todo = parse(MONTHLY).unwrap();
    assert!(!todo.recurring, "not locked");
    assert_eq!(todo.fields.rrule, "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=5");
    assert_eq!(todo.fields.reminder_at, Some(local_midnight(2027, 1, 31) - 15 * 3600));
    // An edit of something else leaves the rule as the other client wrote it.
    let out = patch(MONTHLY, &Fields { title: "Pay rent".into(), ..todo.fields.clone() }, 1).unwrap();
    assert!(out.contains("RRULE:FREQ=MONTHLY;COUNT=5") && out.contains("DTSTART;VALUE=DATE:20270131"), "{out}");
}

#[test]
fn moving_to_the_next_occurrence_writes_due_start_and_rule_and_keeps_the_rest() {
    let fields = parse(MONTHLY).unwrap().fields;
    let rule = recurrence::parse(&fields.rrule).unwrap();
    let due = fields.due_at.unwrap();
    let next = recurrence::next_local(&rule, due).unwrap();
    assert_eq!(next, local_midnight(2027, 2, 28), "the 31st becomes the last day of February");
    let day = NaiveDate::from_ymd_opt(2027, 2, 28).unwrap();
    let moved = Fields {
        due_at: Some(next),
        reminder_at: fields.reminder_at.map(|at| at + (next - due)),
        rrule: recurrence::format(&recurrence::anchored(&recurrence::advanced(&rule), day), day, true),
        ..fields.clone()
    };
    let out = patch(MONTHLY, &moved, at("2027-01-31T10:00:00Z")).unwrap();
    for expected in [
        "DUE;VALUE=DATE:20270228",
        "DTSTART;VALUE=DATE:20270228",
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4",
        "X-APPLE-SORT-ORDER:12",
        "CATEGORIES:home",
        "TRIGGER;RELATED=END:-PT15H",
        "X-WR-ALARMUID:a1",
        "STATUS:NEEDS-ACTION",
        "SEQUENCE:3",
    ] {
        assert!(out.contains(expected), "lost {expected}:\n{out}");
    }
    assert_eq!(parse(&out).unwrap().fields, moved, "what was written reads back the same");

    // And on from there, back to the 31st.
    let again = recurrence::next_local(&recurrence::parse(&moved.rrule).unwrap(), next).unwrap();
    assert_eq!(again, local_midnight(2027, 3, 31));
}

#[test]
fn a_rule_added_here_brings_a_start_and_an_alarm_that_follows_the_task() {
    let base = parse(&OTHER.replace("DUE;TZID=Europe/Madrid:20260310T180000", "DUE;VALUE=DATE:20260310")).unwrap().fields;
    let fields = Fields {
        rrule: "FREQ=WEEKLY;BYDAY=TU".into(),
        reminder_at: Some(local_midnight(2026, 3, 10) - 3600),
        ..base
    };
    let ics = new_object(&fields, "w@oreneta", 1);
    assert!(ics.contains("RRULE:FREQ=WEEKLY;BYDAY=TU") && ics.contains("DTSTART;VALUE=DATE:20260310"), "{ics}");
    assert!(ics.contains("TRIGGER;RELATED=END:-PT60M"), "{ics}");
    assert_eq!(parse(&ics).unwrap().fields, fields);
}

#[test]
fn repetitions_beyond_the_editor_are_read_and_flagged_but_not_patched() {
    for extra in [
        "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "RRULE:FREQ=WEEKLY\r\nRDATE;VALUE=DATE:20260320",
        "RRULE:FREQ=WEEKLY\r\nEXDATE;VALUE=DATE:20260317",
        "RRULE:FREQ=WEEKLY\r\nRRULE:FREQ=MONTHLY",
        "RDATE;VALUE=DATE:20260320",
    ] {
        let ics = OTHER.replace("SEQUENCE:4", &format!("SEQUENCE:4\r\n{extra}"));
        let todo = parse(&ics).unwrap();
        assert!(todo.recurring && todo.fields.rrule.is_empty(), "{extra}");
        assert!(patch(&ics, &todo.fields, 1).is_err(), "{extra}");
    }
    // A changed occurrence alongside the series.
    let exception = MONTHLY.replace(
        "END:VCALENDAR",
        "BEGIN:VTODO\r\nUID:rent@other\r\nRECURRENCE-ID;VALUE=DATE:20270228\r\nSUMMARY:Pay the rent late\r\nEND:VTODO\r\nEND:VCALENDAR",
    );
    assert!(parse(&exception).unwrap().recurring);
    // A rule with no due date to follow it from.
    let undated = MONTHLY.replace("DUE;VALUE=DATE:20270131\r\n", "");
    assert!(parse(&undated).unwrap().recurring);
}

#[test]
fn an_object_without_a_task_is_refused() {
    assert!(parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").is_err());
}

#[test]
fn long_lines_are_folded_and_unfolded() {
    let fields = Fields { title: "é".repeat(80), ..Default::default() };
    let ics = new_object(&fields, "u", 1);
    assert!(ics.lines().all(|line| line.len() <= 76));
    assert_eq!(parse(&ics).unwrap().fields.title, fields.title);
}
