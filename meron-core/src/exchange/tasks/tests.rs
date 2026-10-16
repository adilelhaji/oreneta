//! Exchange tasks on recorded SOAP (ADR-0058): reading, rules, and what a
//! write sends.

use super::*;

/// A task as Exchange answers it; `extra` goes after the subject.
pub(crate) fn task_xml(id: &str, change_key: &str, subject: &str, extra: &str) -> String {
    format!(r#"<t:Task><t:ItemId Id="{id}" ChangeKey="{change_key}"/><t:Subject>{subject}</t:Subject>{extra}</t:Task>"#)
}

fn parse(xml: &str) -> RemoteTask {
    let node = soap::parse(xml.as_bytes()).unwrap();
    parse_task(node.child("Task").unwrap()).unwrap()
}

fn midnight(y: i32, m: u32, d: u32) -> i64 {
    local_midnight(NaiveDate::from_ymd_opt(y, m, d).unwrap()).unwrap()
}

/// Midnight here of a date: how a due date with no time is kept.
pub(crate) fn local_day_midnight(y: i32, m: u32, d: u32) -> i64 {
    midnight(y, m, d)
}

#[test]
fn ews_task_read_maps_every_field_of_the_model() {
    let task = parse(&task_xml(
        "T1",
        "ck1",
        "Informe &amp; pressupost",
        r#"<t:Body BodyType="Text">Revisar xifres
</t:Body><t:Importance>High</t:Importance><t:DateTimeCreated>2026-10-01T08:00:00Z</t:DateTimeCreated><t:ReminderDueBy>2026-10-19T07:00:00Z</t:ReminderDueBy><t:ReminderIsSet>true</t:ReminderIsSet><t:DueDate>2026-10-19T22:00:00Z</t:DueDate><t:Status>NotStarted</t:Status>"#,
    ));
    assert_eq!((task.id.as_str(), task.change_key.as_str()), ("T1", "ck1"));
    assert_eq!(task.fields.title, "Informe & pressupost");
    assert_eq!(task.fields.note, "Revisar xifres");
    assert_eq!(task.fields.priority, 2);
    // Midnight in Madrid, written as 22:00Z the day before, is the 20th.
    assert_eq!(task.fields.due_at, Some(midnight(2026, 10, 20)));
    assert_eq!(task.fields.reminder_at, Some(1_792_393_200));
    assert_eq!(task.fields.completed_at, None);
    assert_eq!(task.created_at, Some(1_790_841_600));
    assert!(!task.recurring && task.fields.rrule.is_empty());

    let done = parse(&task_xml(
        "T2",
        "ck2",
        "Fet",
        "<t:Importance>Low</t:Importance><t:ReminderIsSet>false</t:ReminderIsSet><t:CompleteDate>2026-10-02T10:00:00Z</t:CompleteDate><t:Status>Completed</t:Status>",
    ));
    assert_eq!((done.fields.priority, done.fields.completed_at, done.fields.due_at), (0, Some(1_790_935_200), None));
}

fn rule(pattern: &str, range: &str) -> RemoteTask {
    parse(&task_xml(
        "R",
        "ck",
        "Repeats",
        &format!("<t:DueDate>2026-10-13T00:00:00Z</t:DueDate><t:Recurrence>{pattern}{range}</t:Recurrence>"),
    ))
}

const NO_END: &str = "<t:NoEndRecurrence><t:StartDate>2026-10-13</t:StartDate></t:NoEndRecurrence>";

#[test]
fn ews_task_rules_the_editor_writes_are_read_as_rules_and_the_rest_as_read_only() {
    // 2026-10-13 is the second Tuesday of October.
    let weekly = rule("<t:WeeklyRecurrence><t:Interval>2</t:Interval><t:DaysOfWeek>Monday Wednesday</t:DaysOfWeek></t:WeeklyRecurrence>", NO_END);
    assert_eq!((weekly.fields.rrule.as_str(), weekly.recurring), ("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", false));
    let nth = rule(
        "<t:RelativeMonthlyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Tuesday</t:DaysOfWeek><t:DayOfWeekIndex>Second</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>",
        "<t:NumberedRecurrence><t:StartDate>2026-10-13</t:StartDate><t:NumberOfOccurrences>5</t:NumberOfOccurrences></t:NumberedRecurrence>",
    );
    assert_eq!(nth.fields.rrule, "FREQ=MONTHLY;BYDAY=2TU;COUNT=5");
    let monthly = rule("<t:AbsoluteMonthlyRecurrence><t:Interval>1</t:Interval><t:DayOfMonth>31</t:DayOfMonth></t:AbsoluteMonthlyRecurrence>", NO_END);
    assert_eq!(monthly.fields.rrule, "FREQ=MONTHLY;BYMONTHDAY=31", "the 31st is kept after a short month");
    let until = rule(
        "<t:DailyRecurrence><t:Interval>3</t:Interval></t:DailyRecurrence>",
        "<t:EndDateRecurrence><t:StartDate>2026-10-13</t:StartDate><t:EndDate>2026-12-31-08:00</t:EndDate></t:EndDateRecurrence>",
    );
    assert_eq!(until.fields.rrule, "FREQ=DAILY;INTERVAL=3;UNTIL=20261231");

    for (pattern, why) in [
        ("<t:DailyRegeneration><t:Interval>2</t:Interval></t:DailyRegeneration>", "regenerating"),
        ("<t:AbsoluteYearlyRecurrence><t:DayOfMonth>1</t:DayOfMonth><t:Month>March</t:Month></t:AbsoluteYearlyRecurrence>", "another month"),
        ("<t:RelativeMonthlyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Weekday</t:DaysOfWeek><t:DayOfWeekIndex>First</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>", "any weekday"),
    ] {
        let task = rule(pattern, NO_END);
        assert!(task.recurring && task.fields.rrule.is_empty(), "{why}");
    }
    let no_due = parse(&task_xml("R", "ck", "x", &format!("<t:Recurrence><t:DailyRecurrence><t:Interval>1</t:Interval></t:DailyRecurrence>{NO_END}</t:Recurrence>")));
    assert!(no_due.recurring, "a rule with no due date to count from");
}

#[test]
fn ews_task_rules_are_written_back_as_exchange_reads_them() {
    let due = NaiveDate::from_ymd_opt(2026, 10, 13).unwrap();
    for rrule in [
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
        "FREQ=MONTHLY;BYDAY=2TU;COUNT=5",
        "FREQ=MONTHLY;BYMONTHDAY=31",
        "FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=13",
        "FREQ=YEARLY;BYMONTH=10;BYDAY=-1TU",
        "FREQ=DAILY;INTERVAL=3;UNTIL=20261231",
    ] {
        let xml = recurrence_xml(rrule, due).unwrap();
        let back = rule_of(soap::parse(xml.as_bytes()).unwrap().child("Recurrence").unwrap(), due).expect(rrule);
        assert_eq!(recurrence::format(&back, due, true), rrule, "{xml}");
    }
    assert!(recurrence_xml("FREQ=YEARLY;INTERVAL=2;BYMONTH=10;BYMONTHDAY=13", due).unwrap_err().to_string().contains("every 2 years"));
}

#[test]
fn ews_task_writes_send_only_what_changed() {
    let before = Fields { title: "A".into(), due_at: Some(midnight(2026, 10, 13)), ..Default::default() };
    let renamed = Fields { title: "B & C".into(), ..before.clone() };
    let only = changes(&before, &renamed, 0).unwrap();
    assert_eq!(only.matches("<t:SetItemField>").count(), 1, "{only}");
    assert!(only.contains("<t:Subject>B &amp; C</t:Subject>"), "{only}");
    // A due time Exchange does not keep is no change of date.
    let later_same_day = Fields { due_at: Some(midnight(2026, 10, 13) + 9 * 3600), ..before.clone() };
    assert_eq!(changes(&before, &later_same_day, 0).unwrap(), "");
    let done = Fields { completed_at: Some(5_000_000_000), ..before.clone() };
    let completing = changes(&before, &done, 2_000_000_000).unwrap();
    assert!(completing.contains("<t:Status>Completed</t:Status>"), "{completing}");
    assert!(completing.contains("<t:CompleteDate>2033-05-18T03:33:20Z</t:CompleteDate>"), "never in the future: {completing}");
    assert!(changes(&done, &before, 0).unwrap().contains("<t:Status>NotStarted</t:Status>"));
    let cleared = Fields { due_at: None, ..before.clone() };
    assert!(changes(&before, &cleared, 0).unwrap().contains(r#"<t:DeleteItemField><t:FieldURI FieldURI="task:DueDate"/>"#));
    let repeating = Fields { rrule: "FREQ=DAILY".into(), ..before.clone() };
    let rule = changes(&before, &repeating, 0).unwrap();
    assert!(rule.contains("<t:DailyRecurrence>") && rule.contains("<t:StartDate>2026-10-13T00:00:00Z</t:StartDate>"), "{rule}");
    let no_reminder = Fields { reminder_at: Some(1), ..before.clone() };
    assert!(changes(&no_reminder, &before, 0).unwrap().contains("<t:ReminderIsSet>false</t:ReminderIsSet>"));
}
