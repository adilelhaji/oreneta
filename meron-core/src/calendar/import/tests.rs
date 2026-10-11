use super::*;

const FILE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\n\
BEGIN:VTIMEZONE\r\nTZID:Europe/Madrid\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nUID:once@x\r\nDTSTART:20240110T090000Z\r\nDTEND:20240110T100000Z\r\nSUMMARY:Long ago\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:weekly@x\r\nDTSTART;TZID=Europe/Madrid:20260302T100000\r\nDTEND;TZID=Europe/Madrid:20260302T110000\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Forever\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:weekly@x\r\nRECURRENCE-ID;TZID=Europe/Madrid:20260309T100000\r\nDTSTART;TZID=Europe/Madrid:20260309T120000\r\nDTEND;TZID=Europe/Madrid:20260309T130000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nDTSTART:20260401T090000Z\r\nDTEND:20260401T091500Z\r\nSUMMARY:No uid\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n";

#[test]
fn a_file_is_split_by_uid_with_exceptions_and_zones_kept_together() {
    let items = split(FILE).unwrap();
    assert_eq!(items.len(), 3);
    let weekly = items.iter().find(|i| i.uid == "weekly@x").unwrap();
    assert!(weekly.repeats);
    assert_eq!(weekly.object.matches("BEGIN:VEVENT").count(), 2, "the exception travels with its series");
    assert!(weekly.object.contains("TZID:Europe/Madrid"), "the zone it uses goes with it");
    let once = items.iter().find(|i| i.uid == "once@x").unwrap();
    assert!(!once.repeats && !once.object.contains("Forever"));
    let anonymous = items.iter().find(|i| i.uid.starts_with("imported-")).unwrap();
    assert!(anonymous.object.contains(&format!("UID:{}", anonymous.uid)));
    assert_eq!(split(FILE).unwrap()[0].uid, items[0].uid, "the same file gives the same UIDs");
}

#[test]
fn a_local_calendar_gets_single_events_and_a_bounded_series() {
    let items = split(FILE).unwrap();
    let from = 1_772_323_200; // 2026-03-01
    let once = items.iter().find(|i| i.uid == "once@x").unwrap();
    let (events, _) = local_events(once, "local:1", from).unwrap();
    assert_eq!(events.len(), 1, "a past event is still imported");
    assert_eq!(events[0].id, "local:import:once@x@1704877200");

    let weekly = items.iter().find(|i| i.uid == "weekly@x").unwrap();
    let (events, _) = local_events(weekly, "local:1", from).unwrap();
    assert!(events.len() > 50 && events.len() <= 512, "{}", events.len());
    assert!(events.iter().all(|e| !e.is_recurring && e.series_id.is_none() && e.calendar_id == "local:1"));
    assert!(events.iter().any(|e| e.subject == "Moved"));
}

#[test]
fn something_that_is_not_a_calendar_is_refused() {
    assert!(split("BEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n").is_err());
    assert!(split(&"x".repeat(MAX_FILE_BYTES + 1)).is_err());
}
