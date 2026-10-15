//! The mailbox's Tasks folder (ADR-0058): reading its tasks and writing them
//! back, field by field, against the change key each was read at.
//!
//! Fields map onto the task-list model (ADR-0013, ADR-0039) as follows:
//! `Subject` and the text `Body` are the title and the note; `Importance` is
//! the priority; `DueDate` is a date (Exchange keeps no due time), which is
//! midnight here; `Status` `Completed` with `CompleteDate` is completion;
//! `ReminderIsSet` with `ReminderDueBy` is the reminder; and `Recurrence`, in
//! the forms the editor writes (ADR-0053), is the rule. A rule beyond those
//! — a regenerating one, several weekdays a month, a yearly one in another
//! month than the due date — makes the task read only here.
//!
//! A task created here carries a named property with an id of ours, so that
//! a creation whose answer was lost is found again rather than made twice.

use anyhow::{bail, Context as _, Result};
use chrono::{Datelike as _, NaiveDate, TimeZone as _};

use super::book::{written, ListWrite};
use super::soap::{self, escape, Node};
use super::EwsClient;
use crate::calendar::{recurrence, Frequency, Recurrence};
use crate::task_sync::vtodo::Fields;

/// The named property holding our id for a task created here.
const MARKER: &str = r#"<t:ExtendedFieldURI DistinguishedPropertySetId="PublicStrings" PropertyName="OrenetaTaskUid" PropertyType="String"/>"#;

const PAGE: usize = 500;
const BATCH: usize = 100;

/// A task as the server holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTask {
    pub id: String,
    pub change_key: String,
    pub fields: Fields,
    /// It repeats in a way this client does not write (see the module).
    pub recurring: bool,
    pub created_at: Option<i64>,
    /// Our id, when it was created here.
    pub marker: Option<String>,
}

/// A change Exchange cannot take, known before anything is sent: the same
/// change would be refused every time, so it is set aside with its reason
/// rather than holding up the list (ADR-0058).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unwritable(pub String);

impl std::fmt::Display for Unwritable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unwritable {}

fn unwritable(reason: &str) -> anyhow::Error {
    anyhow::Error::new(Unwritable(reason.to_string()))
}

/// Why a write failed, when Exchange could never take it.
pub fn unwritable_reason(error: &anyhow::Error) -> Option<String> {
    error.chain().find_map(|cause| cause.downcast_ref::<Unwritable>()).map(|reason| reason.0.clone())
}

fn instant(text: &str) -> Option<i64> {
    let text = text.trim();
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|at| at.timestamp())
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S").ok().map(|at| at.and_utc().timestamp()))
}

fn wire_time(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0).unwrap_or_default().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn local_midnight(day: NaiveDate) -> Option<i64> {
    crate::calendar::recurrence::resolve(&chrono::Local, day.and_hms_opt(0, 0, 0)?)
}

/// The day a due date names, whichever zone Exchange wrote its midnight in
/// (as for all-day events, `all_day_utc_date`).
fn due_day(text: &str) -> Option<NaiveDate> {
    let at = super::all_day_utc_date(instant(text)?);
    Some(chrono::DateTime::from_timestamp(at, 0)?.date_naive())
}

/// The day a local due instant falls on here.
fn local_day(at: i64) -> Option<NaiveDate> {
    Some(chrono::Local.timestamp_opt(at, 0).earliest()?.date_naive())
}

fn date_of(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.trim().get(..10)?, "%Y-%m-%d").ok()
}

const WEEK_INDEX: [(&str, i8); 5] = [("First", 1), ("Second", 2), ("Third", 3), ("Fourth", 4), ("Last", -1)];

fn weekday(name: &str) -> Option<u8> {
    Recurrence::EWS_DAYS.iter().position(|day| day.eq_ignore_ascii_case(name)).map(|day| day as u8)
}

/// One weekday named alone, as a relative rule needs.
fn one_weekday(node: &Node) -> Option<u8> {
    let days: Vec<&str> = node.text_of("DaysOfWeek")?.split_whitespace().collect();
    match days.as_slice() {
        [day] => weekday(day),
        _ => None,
    }
}

/// A task's rule in the calendar's terms, anchored on its due date; `None`
/// for one this client does not write.
fn rule_of(node: &Node, due: NaiveDate) -> Option<Recurrence> {
    let mut rule = Recurrence { interval: 1, ..Default::default() };
    let pattern = node.children.iter().find(|child| child.name.ends_with("Recurrence") || child.name.ends_with("Regeneration"))?;
    let interval = || pattern.text_of("Interval").and_then(|n| n.parse::<u16>().ok()).filter(|n| *n > 0);
    match pattern.name.as_str() {
        "DailyRecurrence" => {
            rule.freq = Frequency::Daily;
            rule.interval = interval()?;
        }
        "WeeklyRecurrence" => {
            rule.freq = Frequency::Weekly;
            rule.interval = interval()?;
            rule.weekdays = pattern.text_of("DaysOfWeek")?.split_whitespace().map(weekday).collect::<Option<_>>()?;
        }
        "AbsoluteMonthlyRecurrence" => {
            rule.freq = Frequency::Monthly;
            rule.interval = interval()?;
            rule.month_day = Some(pattern.text_of("DayOfMonth")?.parse().ok()?);
        }
        "RelativeMonthlyRecurrence" => {
            rule.freq = Frequency::Monthly;
            rule.interval = interval()?;
            rule.weekdays = vec![one_weekday(pattern)?];
            rule.month_week = WEEK_INDEX.iter().find(|(name, _)| Some(*name) == pattern.text_of("DayOfWeekIndex")).map(|(_, n)| *n);
            rule.month_week?;
        }
        "AbsoluteYearlyRecurrence" | "RelativeYearlyRecurrence" => {
            rule.freq = Frequency::Yearly;
            let month = pattern.text_of("Month")?;
            if !month.eq_ignore_ascii_case(&due.format("%B").to_string()) {
                return None;
            }
            if pattern.name == "AbsoluteYearlyRecurrence" {
                rule.month_day = Some(pattern.text_of("DayOfMonth")?.parse().ok()?);
            } else {
                rule.weekdays = vec![one_weekday(pattern)?];
                rule.month_week = WEEK_INDEX.iter().find(|(name, _)| Some(*name) == pattern.text_of("DayOfWeekIndex")).map(|(_, n)| *n);
                rule.month_week?;
            }
        }
        // Regenerating rules ("N days after it is completed") and anything
        // else are not written here (ADR-0053).
        _ => return None,
    }
    if let Some(range) = node.child("EndDateRecurrence") {
        let end = date_of(range.text_of("EndDate")?)?;
        rule.until = crate::calendar::recurrence::resolve(&chrono::Local, end.and_hms_opt(12, 0, 0)?);
        rule.until?;
    } else if let Some(range) = node.child("NumberedRecurrence") {
        rule.count = Some(range.text_of("NumberOfOccurrences")?.parse().ok().filter(|n: &u16| *n > 0)?);
    } else if node.child("NoEndRecurrence").is_none() {
        return None;
    }
    Some(recurrence::anchored(&rule, due))
}

/// The `<t:Recurrence>` of a rule (an RRULE value) whose current
/// occurrence is due on `due`.
fn recurrence_xml(rrule: &str, due: NaiveDate) -> Result<String> {
    let rule = recurrence::parse(rrule).map_err(|_| unwritable("this task's rule cannot be read"))?;
    let rule = recurrence::anchored(&rule, due);
    let interval = rule.interval.max(1);
    let index = |n: i8| WEEK_INDEX.iter().find(|(_, k)| *k == n).map(|(name, _)| *name).unwrap_or("First");
    let day = |d: u8| Recurrence::EWS_DAYS[d as usize % 7];
    let month = due.format("%B");
    let pattern = match (rule.freq, rule.month_week) {
        (Frequency::Daily, _) => format!("<t:DailyRecurrence><t:Interval>{interval}</t:Interval></t:DailyRecurrence>"),
        (Frequency::Weekly, _) => format!(
            "<t:WeeklyRecurrence><t:Interval>{interval}</t:Interval><t:DaysOfWeek>{}</t:DaysOfWeek></t:WeeklyRecurrence>",
            rule.weekdays.iter().map(|d| day(*d)).collect::<Vec<_>>().join(" ")
        ),
        (Frequency::Monthly, None) => format!(
            "<t:AbsoluteMonthlyRecurrence><t:Interval>{interval}</t:Interval><t:DayOfMonth>{}</t:DayOfMonth></t:AbsoluteMonthlyRecurrence>",
            rule.month_day.unwrap_or(due.day() as u8)
        ),
        (Frequency::Monthly, Some(n)) => format!(
            "<t:RelativeMonthlyRecurrence><t:Interval>{interval}</t:Interval><t:DaysOfWeek>{}</t:DaysOfWeek><t:DayOfWeekIndex>{}</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>",
            day(rule.weekdays.first().copied().unwrap_or(0)),
            index(n)
        ),
        (Frequency::Yearly, _) if interval > 1 => return Err(unwritable(&format!("Exchange cannot repeat a task every {interval} years"))),
        (Frequency::Yearly, None) => format!(
            "<t:AbsoluteYearlyRecurrence><t:DayOfMonth>{}</t:DayOfMonth><t:Month>{month}</t:Month></t:AbsoluteYearlyRecurrence>",
            rule.month_day.unwrap_or(due.day() as u8)
        ),
        (Frequency::Yearly, Some(n)) => format!(
            "<t:RelativeYearlyRecurrence><t:DaysOfWeek>{}</t:DaysOfWeek><t:DayOfWeekIndex>{}</t:DayOfWeekIndex><t:Month>{month}</t:Month></t:RelativeYearlyRecurrence>",
            day(rule.weekdays.first().copied().unwrap_or(0)),
            index(n)
        ),
    };
    let start = due.format("%Y-%m-%d");
    let range = match (rule.until, rule.count) {
        (Some(until), _) => format!(
            "<t:EndDateRecurrence><t:StartDate>{start}</t:StartDate><t:EndDate>{}</t:EndDate></t:EndDateRecurrence>",
            local_day(until).context("the rule's end cannot be read")?.format("%Y-%m-%d")
        ),
        (None, Some(count)) => format!(
            "<t:NumberedRecurrence><t:StartDate>{start}</t:StartDate><t:NumberOfOccurrences>{}</t:NumberOfOccurrences></t:NumberedRecurrence>",
            count.max(1)
        ),
        (None, None) => format!("<t:NoEndRecurrence><t:StartDate>{start}</t:StartDate></t:NoEndRecurrence>"),
    };
    Ok(format!("<t:Recurrence>{pattern}{range}</t:Recurrence>"))
}

/// A task of an answer, in the task-list model's terms.
pub fn parse_task(node: &Node) -> Option<RemoteTask> {
    let id = node.child("ItemId")?;
    let due = node.text_of("DueDate").and_then(due_day);
    let completed = node.text_of("Status") == Some("Completed") || node.text_of("IsComplete") == Some("true");
    // A completed task with no date at all is completed now, not in 1970.
    let completed_at = completed.then(|| {
        [node.text_of("CompleteDate"), node.text_of("LastModifiedTime"), node.text_of("DateTimeCreated")]
            .into_iter()
            .flatten()
            .find_map(instant)
            .unwrap_or_else(|| chrono::Utc::now().timestamp())
    });
    let reminder_at = (node.text_of("ReminderIsSet") == Some("true"))
        .then(|| node.text_of("ReminderDueBy").and_then(instant))
        .flatten();
    let (rrule, recurring) = match (node.child("Recurrence"), due) {
        (None, _) => (String::new(), false),
        (Some(rule), Some(due)) => match rule_of(rule, due) {
            Some(rule) => (recurrence::format(&rule, due, true), false),
            None => (String::new(), true),
        },
        (Some(_), None) => (String::new(), true),
    };
    let marker = node
        .children_named("ExtendedProperty")
        .find(|property| property.path(&["ExtendedFieldURI"]).and_then(|uri| uri.attr("PropertyName")) == Some("OrenetaTaskUid"))
        .and_then(|property| property.text_of("Value"))
        .map(str::to_string);
    Some(RemoteTask {
        id: id.attr("Id")?.to_string(),
        change_key: id.attr("ChangeKey").unwrap_or_default().to_string(),
        fields: Fields {
            title: node.text_of("Subject").unwrap_or_default().to_string(),
            note: node.text_of("Body").unwrap_or_default().to_string(),
            due_at: due.and_then(local_midnight),
            priority: match node.text_of("Importance") {
                Some("Low") => 0,
                Some("High") => 2,
                _ => 1,
            },
            completed_at,
            reminder_at,
            rrule,
        },
        recurring,
        created_at: node.text_of("DateTimeCreated").and_then(instant),
        marker,
    })
}

fn importance(priority: i64) -> &'static str {
    match priority {
        0 => "Low",
        2 => "High",
        _ => "Normal",
    }
}

fn due_xml(at: i64) -> Result<String> {
    Ok(format!("<t:DueDate>{}T00:00:00Z</t:DueDate>", local_day(at).context("the due date cannot be read")?.format("%Y-%m-%d")))
}

fn set(field: &str, kind_body: String) -> String {
    format!(r#"<t:SetItemField><t:FieldURI FieldURI="{field}"/><t:Task>{kind_body}</t:Task></t:SetItemField>"#)
}

fn delete(field: &str) -> String {
    format!(r#"<t:DeleteItemField><t:FieldURI FieldURI="{field}"/></t:DeleteItemField>"#)
}

/// The changes that make `before` into `after`, each property once. Only
/// what differs is sent: what another client set that this one does not
/// show (categories, other people, work) is left as it is.
fn changes(before: &Fields, after: &Fields, now: i64) -> Result<String> {
    let mut out = String::new();
    // Compared as written: a character XML cannot carry is never sent, and
    // must not look like a change on every sync.
    if escape(&before.title) != escape(&after.title) {
        out.push_str(&set("item:Subject", format!("<t:Subject>{}</t:Subject>", escape(&after.title))));
    }
    if escape(&before.note) != escape(&after.note) {
        out.push_str(&set("item:Body", format!(r#"<t:Body BodyType="Text">{}</t:Body>"#, escape(&after.note))));
    }
    if before.priority != after.priority {
        out.push_str(&set("item:Importance", format!("<t:Importance>{}</t:Importance>", importance(after.priority))));
    }
    if before.reminder_at != after.reminder_at {
        match after.reminder_at {
            Some(at) => {
                out.push_str(&set("item:ReminderDueBy", format!("<t:ReminderDueBy>{}</t:ReminderDueBy>", wire_time(at))));
                out.push_str(&set("item:ReminderIsSet", "<t:ReminderIsSet>true</t:ReminderIsSet>".into()));
            }
            None => out.push_str(&set("item:ReminderIsSet", "<t:ReminderIsSet>false</t:ReminderIsSet>".into())),
        }
    }
    let due_changed = before.due_at.and_then(local_day) != after.due_at.and_then(local_day);
    if due_changed {
        match after.due_at {
            Some(at) => out.push_str(&set("task:DueDate", due_xml(at)?)),
            None => out.push_str(&delete("task:DueDate")),
        }
    }
    if before.rrule != after.rrule || (due_changed && !after.rrule.is_empty()) {
        match (after.rrule.is_empty(), after.due_at.and_then(local_day)) {
            (true, _) => out.push_str(&delete("task:Recurrence")),
            (false, Some(due)) => {
                out.push_str(&set("task:Recurrence", recurrence_xml(&after.rrule, due)?));
                out.push_str(&set("task:StartDate", format!("<t:StartDate>{}T00:00:00Z</t:StartDate>", due.format("%Y-%m-%d"))));
            }
            (false, None) => return Err(unwritable("a repeating task needs a due date to repeat from")),
        }
    }
    if before.completed_at.is_some() != after.completed_at.is_some() {
        match after.completed_at {
            Some(at) => {
                // Exchange refuses a completion date in the future.
                out.push_str(&set("task:CompleteDate", format!("<t:CompleteDate>{}</t:CompleteDate>", wire_time(at.min(now)))));
                out.push_str(&set("task:Status", "<t:Status>Completed</t:Status>".into()));
            }
            None => out.push_str(&set("task:Status", "<t:Status>NotStarted</t:Status>".into())),
        }
    }
    Ok(out)
}

impl EwsClient {
    fn tasks_folder(&self) -> String {
        soap::distinguished("tasks", &self.config.target_mailbox)
    }

    fn task_items(&self, ids: &[String]) -> Result<Vec<RemoteTask>> {
        let mut out = Vec::new();
        for batch in ids.chunks(BATCH) {
            let wanted: String = batch.iter().map(|id| soap::item_id(id, None)).collect();
            let document = self.call_raw(&format!(
                "<m:GetItem><m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType><t:AdditionalProperties>{MARKER}</t:AdditionalProperties></m:ItemShape><m:ItemIds>{wanted}</m:ItemIds></m:GetItem>"
            ))?;
            for message in soap::messages(&document, "GetItem")? {
                match message {
                    Ok(message) => out.extend(
                        message.child("Items").into_iter().flat_map(|items| items.children_named("Task")).filter_map(parse_task),
                    ),
                    Err(error) if error.code == "ErrorItemNotFound" => {}
                    Err(error) => return Err(anyhow::Error::new(error).context("GetItem tasks")),
                }
            }
        }
        Ok(out)
    }

    /// Item ids in the Tasks folder matching `restriction` (all of them
    /// when empty), page by page.
    ///
    /// Oldest first, so pages do not shift as tasks are added. The offset
    /// counts every item the server listed — the folder may hold other kinds
    /// — and an id is kept once.
    fn task_ids(&self, restriction: &str) -> Result<Vec<String>> {
        let mut ids: Vec<String> = Vec::new();
        let mut offset = 0usize;
        loop {
            let document = self.call_raw(&format!(
                r#"<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="{PAGE}" Offset="{offset}" BasePoint="Beginning"/>{restriction}<m:SortOrder><t:FieldOrder Order="Ascending"><t:FieldURI FieldURI="item:DateTimeCreated"/></t:FieldOrder></m:SortOrder><m:ParentFolderIds>{}</m:ParentFolderIds></m:FindItem>"#,
                self.tasks_folder()
            ))?;
            let message = soap::single(&document, "FindItem").context("FindItem tasks")?;
            let root = message.child("RootFolder").context("the tasks listing has no root folder")?;
            let listed = root.child("Items").map(|items| items.children.len()).unwrap_or(0);
            for task in root.child("Items").into_iter().flat_map(|items| items.children_named("Task")) {
                if let Some(id) = task.child("ItemId").and_then(|id| id.attr("Id"))
                    && !ids.iter().any(|known| known == id)
                {
                    ids.push(id.to_string());
                }
            }
            if root.attr("IncludesLastItemInRange") != Some("false") {
                break;
            }
            if listed == 0 {
                bail!("the tasks listing stopped giving items before its end");
            }
            offset += listed;
        }
        Ok(ids)
    }

    /// Every task in the folder. All or nothing: a refusal fails the read.
    pub fn read_tasks(&self) -> Result<Vec<RemoteTask>> {
        let ids = self.task_ids("")?;
        self.task_items(&ids)
    }

    /// One task as the server holds it now; `None` when it is gone.
    pub fn read_task(&self, id: &str) -> Result<Option<RemoteTask>> {
        Ok(self.task_items(&[id.to_string()])?.into_iter().next())
    }

    /// The task created here with our id `marker`, if the server has it.
    pub fn find_marked_task(&self, marker: &str) -> Result<Option<RemoteTask>> {
        let ids = self.task_ids(&format!(
            r#"<m:Restriction><t:IsEqualTo>{MARKER}<t:FieldURIOrConstant><t:Constant Value="{}"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>"#,
            escape(marker)
        ))?;
        Ok(self.task_items(&ids)?.into_iter().find(|task| task.marker.as_deref() == Some(marker)))
    }

    /// Creates a task with our id `marker` on it.
    pub fn create_task(&self, fields: &Fields, marker: &str, now: i64) -> Result<(String, String)> {
        let mut task = format!("<t:Subject>{}</t:Subject>", escape(&fields.title));
        if !fields.note.is_empty() {
            task.push_str(&format!(r#"<t:Body BodyType="Text">{}</t:Body>"#, escape(&fields.note)));
        }
        task.push_str(&format!("<t:Importance>{}</t:Importance>", importance(fields.priority)));
        if let Some(at) = fields.reminder_at {
            task.push_str(&format!("<t:ReminderDueBy>{}</t:ReminderDueBy><t:ReminderIsSet>true</t:ReminderIsSet>", wire_time(at)));
        } else {
            task.push_str("<t:ReminderIsSet>false</t:ReminderIsSet>");
        }
        task.push_str(&format!("<t:ExtendedProperty>{MARKER}<t:Value>{}</t:Value></t:ExtendedProperty>", escape(marker)));
        if let Some(at) = fields.completed_at {
            task.push_str(&format!("<t:CompleteDate>{}</t:CompleteDate>", wire_time(at.min(now))));
        }
        let due = fields.due_at.and_then(local_day);
        if let Some(at) = fields.due_at {
            task.push_str(&due_xml(at)?);
        }
        if !fields.rrule.is_empty() {
            let due = due.ok_or_else(|| unwritable("a repeating task needs a due date to repeat from"))?;
            task.push_str(&recurrence_xml(&fields.rrule, due)?);
            task.push_str(&format!("<t:StartDate>{}T00:00:00Z</t:StartDate>", due.format("%Y-%m-%d")));
        }
        task.push_str(if fields.completed_at.is_some() { "<t:Status>Completed</t:Status>" } else { "<t:Status>NotStarted</t:Status>" });
        let document = self.call_raw(&format!(
            r#"<m:CreateItem MessageDisposition="SaveOnly"><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items><t:Task>{task}</t:Task></m:Items></m:CreateItem>"#,
            self.tasks_folder()
        ))?;
        let message = soap::single(&document, "CreateItem").context("CreateItem task")?;
        let id = message.path(&["Items", "Task", "ItemId"]).context("Exchange did not say which task it created")?;
        Ok((
            id.attr("Id").context("Exchange did not say which task it created")?.to_string(),
            id.attr("ChangeKey").unwrap_or_default().to_string(),
        ))
    }

    /// Writes what changed from `before` (the copy read at `read_at`) to
    /// `after`, never over a change made since (`NeverOverwrite`).
    pub fn update_task(&self, id: &str, read_at: &str, before: &Fields, after: &Fields, now: i64) -> Result<ListWrite> {
        // Never written blind: without the version it was read at, a change
        // made since could not be told apart (ADR-0012).
        if read_at.is_empty() {
            return Ok(ListWrite::Conflict);
        }
        let updates = changes(before, after, now)?;
        if updates.is_empty() {
            return Ok(ListWrite::Saved { id: id.to_string(), change_key: read_at.to_string() });
        }
        let document = self.call_raw(&format!(
            r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="NeverOverwrite"><m:ItemChanges><t:ItemChange>{}<t:Updates>{updates}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>"#,
            soap::item_id(id, Some(read_at))
        ))?;
        written(&document, "UpdateItem", "Task", id)
    }

    /// Deletes a task to Deleted Items if it is still as it was read.
    pub fn delete_task(&self, id: &str, read_at: &str) -> Result<ListWrite> {
        if read_at.is_empty() {
            return Ok(ListWrite::Conflict);
        }
        match self.read_task(id)? {
            None => return Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() }),
            Some(current) if current.change_key != read_at => return Ok(ListWrite::Conflict),
            Some(_) => {}
        }
        let document = self.call_raw(&format!(
            r#"<m:DeleteItem DeleteType="MoveToDeletedItems" AffectedTaskOccurrences="AllOccurrences"><m:ItemIds>{}</m:ItemIds></m:DeleteItem>"#,
            soap::item_id(id, Some(read_at))
        ))?;
        match soap::single(&document, "DeleteItem") {
            Ok(_) => Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() }),
            Err(error) if soap::error_code(&error) == Some("ErrorItemNotFound") => {
                Ok(ListWrite::Saved { id: id.to_string(), change_key: String::new() })
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
