//! Task lists and tasks that stand on their own (ADR-0013).
//!
//! Tasks used to hang off a conversation only. They now belong to a list;
//! the ones tied to mail live in the fixed "mail follow-up" list and keep
//! their rule of one open task per conversation. A standalone task has no
//! conversation, so that rule does not apply to it.
//!
//! Edits name the revision they were made from, as everywhere else that
//! writes (ADR-0012): a task changed in another window meanwhile is not
//! overwritten.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::calendar::{recurrence, Recurrence};

/// The list every mail-linked task lives in. It cannot be deleted.
pub const MAIL_LIST: &str = "mail";

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_lists (
           id         TEXT PRIMARY KEY,
           name       TEXT NOT NULL,
           position   INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO task_lists(id, name, position) VALUES('mail', '', 0);",
    )?;
    let has = |column: &str| -> rusqlite::Result<bool> {
        conn.prepare(&format!("SELECT 1 FROM pragma_table_info('tasks') WHERE name = '{column}'"))?
            .exists([])
    };
    for (column, ddl) in [
        ("list_id", "ALTER TABLE tasks ADD COLUMN list_id TEXT NOT NULL DEFAULT 'mail'"),
        ("title", "ALTER TABLE tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''"),
        ("priority", "ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 1"),
        ("reminder_at", "ALTER TABLE tasks ADD COLUMN reminder_at INTEGER"),
        ("reminded_at", "ALTER TABLE tasks ADD COLUMN reminded_at INTEGER"),
        ("revision", "ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"),
    ] {
        if !has(column)? {
            conn.execute_batch(ddl)?;
        }
    }
    // One open task per conversation, for tasks that have one.
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_tasks_open_thread;
         CREATE UNIQUE INDEX idx_tasks_open_thread
           ON tasks(account, thread_key) WHERE completed_at IS NULL AND thread_key <> '';
         CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);",
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TaskList {
    pub id: String,
    /// Empty for the mail list, whose name the interface translates.
    pub name: String,
    pub position: i64,
    pub open: i64,
    /// ADR-0039: the CalDAV collection the list is kept in, empty for a
    /// list kept only here; who signs in there; when it was last read in
    /// full; why the last sync failed, if it did; and how many of its tasks
    /// wait for the person to choose between two copies.
    pub remote_url: String,
    pub remote_user: String,
    pub synced_at: Option<i64>,
    pub last_error: String,
    pub conflicts: i64,
    /// ADR-0058: the Exchange account whose Tasks folder the list is, empty
    /// for any other list.
    pub ews_account: String,
}

pub fn lists(conn: &Connection) -> Result<Vec<TaskList>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.position,
                (SELECT COUNT(*) FROM tasks t
                  WHERE t.list_id = l.id AND t.completed_at IS NULL AND t.pending <> 'delete'),
                l.remote_url, l.remote_user, l.synced_at, l.last_error,
                (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.conflict <> ''),
                l.ews_account
           FROM task_lists l ORDER BY l.position, l.created_at, l.name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TaskList {
            id: row.get(0)?,
            name: row.get(1)?,
            position: row.get(2)?,
            open: row.get(3)?,
            remote_url: row.get(4)?,
            remote_user: row.get(5)?,
            synced_at: row.get(6)?,
            last_error: row.get(7)?,
            conflicts: row.get(8)?,
            ews_account: row.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn create_list(conn: &Connection, name: &str, now: i64) -> Result<String> {
    let id = new_list_id();
    create_list_with_id(conn, &id, name, now)?;
    Ok(id)
}

/// The id a new list gets.
pub fn new_list_id() -> String {
    format!("list:{}", uuid::Uuid::new_v4())
}

/// A new list under an id chosen before: an account's CalDAV list has its
/// password kept under its id before the list exists (ADR-0070, §3).
pub fn create_list_with_id(conn: &Connection, id: &str, name: &str, now: i64) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a list needs a name");
    }
    let position: i64 = conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM task_lists", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO task_lists(id, name, position, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![id, name, position, now],
    )?;
    Ok(())
}

pub fn rename_list(conn: &Connection, id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a list needs a name");
    }
    if conn.execute("UPDATE task_lists SET name = ?2 WHERE id = ?1", params![id, name])? == 0 {
        bail!("that list no longer exists");
    }
    Ok(())
}

/// Deletes a list and every task in it. The mail list stays: it is where
/// tasks made from conversations go.
pub fn delete_list(conn: &Connection, id: &str) -> Result<()> {
    if id == MAIL_LIST {
        bail!("the mail follow-up list cannot be deleted");
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM tasks WHERE list_id = ?1", params![id])?;
    tx.execute("DELETE FROM task_lists WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// A task's own fields, as the editor writes them.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct TaskFields {
    pub list_id: String,
    pub title: String,
    pub note: String,
    pub due_at: Option<i64>,
    pub reminder_at: Option<i64>,
    /// 0 low, 1 normal, 2 high.
    pub priority: i64,
    /// How it repeats (ADR-0053), in the calendar's own terms; `None` when
    /// it does not.
    pub recurrence: Option<Recurrence>,
}

impl TaskFields {
    fn check(&self, linked: bool) -> Result<()> {
        if !linked && self.title.trim().is_empty() {
            bail!("a task needs a title");
        }
        if !(0..=2).contains(&self.priority) {
            bail!("unknown priority");
        }
        if self.recurrence.is_some() {
            if linked {
                bail!("a task tied to a conversation does not repeat");
            }
            if self.due_at.is_none() {
                bail!("a repeating task needs a due date to repeat from");
            }
        }
        Ok(())
    }

    /// The rule as stored: an RRULE value spelled out from the due date.
    fn rrule(&self) -> String {
        match (&self.recurrence, self.due_at.and_then(due_day)) {
            (Some(rule), Some((day, all_day))) => recurrence::format(&recurrence::anchored(rule, day), day, all_day),
            _ => String::new(),
        }
    }
}

/// A due instant as the date it falls on here, and whether it is a date
/// rather than a time (midnight here).
fn due_day(instant: i64) -> Option<(chrono::NaiveDate, bool)> {
    use chrono::{TimeZone as _, Timelike as _};
    let local = chrono::Local.timestamp_opt(instant, 0).earliest()?;
    Some((local.date_naive(), local.num_seconds_from_midnight() == 0))
}

/// A stored rule in the calendar's terms. One that cannot be read is no
/// rule: it was written here, so that would be a bug, not a server's whim.
pub fn recurrence_of(rrule: &str) -> Option<Recurrence> {
    (!rrule.is_empty()).then(|| recurrence::parse(rrule).ok()).flatten()
}

fn list_exists(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.prepare("SELECT 1 FROM task_lists WHERE id = ?1")?.exists(params![id])?)
}

/// Where a list is kept: its CalDAV collection, `ews:` and the account for
/// an Exchange account's Tasks folder (ADR-0058), or empty for a local list.
pub fn remote_of_list(conn: &Connection, id: &str) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT CASE WHEN ews_account <> '' THEN 'ews:' || ews_account ELSE remote_url END
               FROM task_lists WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_default())
}

/// The list a task is in, whether that list is on a server, and whether the
/// task repeats (ADR-0039).
fn sync_state(conn: &Connection, id: i64) -> Result<Option<(String, bool, bool)>> {
    Ok(conn
        .query_row(
            "SELECT t.list_id, COALESCE(l.remote_url, '') <> '' OR COALESCE(l.ews_account, '') <> '', t.recurring
               FROM tasks t LEFT JOIN task_lists l ON l.id = t.list_id
              WHERE t.id = ?1 AND t.pending <> 'delete'",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

/// Refuses a change this client does not write to a server yet: a task
/// that repeats, in a list kept on a server.
pub fn check_editable(conn: &Connection, id: i64) -> Result<()> {
    if let Some((_, true, true)) = sync_state(conn, id)? {
        bail!("this task repeats in a way Oreneta does not change; change it in the app that made it");
    }
    Ok(())
}

/// Marks a task in a list kept on a server as changed here, so the next
/// sync sends it. A task in a local list is left as it is.
pub fn touched(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET pending = 'put', sync_seq = sync_seq + 1
          WHERE id = ?1 AND pending <> 'delete'
            AND list_id IN (SELECT id FROM task_lists WHERE remote_url <> '' OR ews_account <> '')",
        params![id],
    )?;
    Ok(())
}

const MOVE_REFUSED: &str =
    "moving a task between a list kept on a server and another list is not supported yet; nothing was changed";

/// A standalone task, in the list named.
pub fn create(conn: &Connection, fields: &TaskFields, now: i64) -> Result<i64> {
    fields.check(false)?;
    let list = if fields.list_id.is_empty() { MAIL_LIST } else { fields.list_id.as_str() };
    if !list_exists(conn, list)? {
        bail!("that list no longer exists");
    }
    conn.execute(
        "INSERT INTO tasks(account, thread_key, folder, note, due_at, created_at, list_id, title, priority, reminder_at, rrule)
         VALUES('', '', '', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            fields.note.trim(),
            fields.due_at,
            now,
            list,
            fields.title.trim(),
            fields.priority,
            fields.reminder_at,
            fields.rrule()
        ],
    )?;
    let id = conn.last_insert_rowid();
    touched(conn, id)?;
    Ok(id)
}

/// The result of an edit.
#[derive(Debug, PartialEq, Eq)]
pub enum Edit {
    Saved { revision: i64 },
    /// Changed elsewhere since it was read (or deleted, `None`): nothing was
    /// written.
    Conflict { current: Option<TaskFields>, revision: i64 },
}

/// A task's fields and revision.
pub fn get(conn: &Connection, id: i64) -> Result<Option<(TaskFields, i64, bool)>> {
    Ok(conn
        .query_row(
            "SELECT list_id, title, note, due_at, reminder_at, priority, revision, thread_key <> '', rrule
               FROM tasks WHERE id = ?1 AND pending <> 'delete'",
            params![id],
            |row| {
                Ok((
                    TaskFields {
                        list_id: row.get(0)?,
                        title: row.get(1)?,
                        note: row.get(2)?,
                        due_at: row.get(3)?,
                        reminder_at: row.get(4)?,
                        priority: row.get(5)?,
                        recurrence: recurrence_of(&row.get::<_, String>(8)?),
                    },
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()?)
}

/// Edits a task from the revision it was read at. A new reminder time is a
/// new reminder: it rings again even if the old one already had.
pub fn update(conn: &Connection, id: i64, read_at: i64, fields: &TaskFields) -> Result<Edit> {
    let tx = conn.unchecked_transaction()?;
    let Some((current, revision, linked)) = get(&tx, id)? else {
        return Ok(Edit::Conflict { current: None, revision: 0 });
    };
    if revision != read_at {
        return Ok(Edit::Conflict { current: Some(current), revision });
    }
    fields.check(linked)?;
    let list = if fields.list_id.is_empty() { current.list_id.as_str() } else { fields.list_id.as_str() };
    if !list_exists(&tx, list)? {
        bail!("that list no longer exists");
    }
    if list != current.list_id
        && (!remote_of_list(&tx, list)?.is_empty() || !remote_of_list(&tx, &current.list_id)?.is_empty())
    {
        bail!(MOVE_REFUSED);
    }
    check_editable(&tx, id)?;
    // A new due date is a new anchor: a monthly rule kept on the 31st after
    // a short month comes back to the day now chosen.
    let mut fields = fields.clone();
    if fields.due_at != current.due_at {
        if let Some(rule) = fields.recurrence.as_mut() {
            rule.month_day = None;
        }
    }
    tx.execute(
        "UPDATE tasks SET list_id = ?2, title = ?3, note = ?4, due_at = ?5, priority = ?6,
                reminder_at = ?7,
                reminded_at = CASE WHEN reminder_at IS ?7 THEN reminded_at ELSE NULL END,
                rrule = ?8,
                revision = revision + 1
          WHERE id = ?1",
        params![
            id,
            list,
            fields.title.trim(),
            fields.note.trim(),
            fields.due_at,
            fields.priority,
            fields.reminder_at,
            fields.rrule()
        ],
    )?;
    touched(&tx, id)?;
    tx.commit()?;
    Ok(Edit::Saved { revision: revision + 1 })
}

/// What completing a task did (ADR-0053).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Completed {
    /// The task's next due date, when it repeats and the series goes on: it
    /// stays open, due then. `None` when the task is now done.
    pub next_due: Option<i64>,
    /// The completed copy kept as the record of the occurrence done.
    pub record: Option<i64>,
}

/// Completes one occurrence of a repeating task (ADR-0053).
///
/// The occurrence is kept as a completed copy of the task — no rule, due
/// when the occurrence was — and the task itself moves on to the next
/// occurrence, its reminder the same time ahead of it. In a list kept on a
/// server both go there: the copy as a new task, the task as its DUE,
/// DTSTART and RRULE (a count is what is left). When the series is over,
/// the task is simply completed. `None` for a task that does not repeat:
/// the caller completes it as any other.
pub fn complete_occurrence(conn: &Connection, id: i64, now: i64) -> Result<Option<Completed>> {
    let row: Option<(String, Option<i64>, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT rrule, due_at, reminder_at, completed_at FROM tasks
              WHERE id = ?1 AND pending <> 'delete' AND thread_key = ''",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((rrule, Some(due), reminder, None)) = row else { return Ok(None) };
    let Some(rule) = recurrence_of(&rrule) else { return Ok(None) };
    check_editable(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    let Some(next) = recurrence::next_local(&rule, due) else {
        // The last occurrence: the series is done, and so is the task.
        tx.execute("UPDATE tasks SET completed_at = ?2, revision = revision + 1 WHERE id = ?1", params![id, now])?;
        touched(&tx, id)?;
        tx.commit()?;
        return Ok(Some(Completed { next_due: None, record: None }));
    };
    tx.execute(
        "INSERT INTO tasks(account, thread_key, folder, note, due_at, created_at, list_id, title, priority,
                           reminder_at, reminded_at, completed_at)
         SELECT '', '', '', note, due_at, ?2, list_id, title, priority, reminder_at, COALESCE(reminded_at, ?2), ?2
           FROM tasks WHERE id = ?1",
        params![id, now],
    )?;
    let record = tx.last_insert_rowid();
    touched(&tx, record)?;
    let (day, all_day) = due_day(next).unwrap_or_default();
    let rule = recurrence::advanced(&rule);
    let rrule = recurrence::format(&recurrence::anchored(&rule, day), day, all_day);
    tx.execute(
        "UPDATE tasks SET due_at = ?2, reminder_at = ?3, reminded_at = NULL, rrule = ?4, revision = revision + 1
          WHERE id = ?1",
        params![id, next, reminder.map(|at| at + (next - due)), rrule],
    )?;
    touched(&tx, id)?;
    tx.commit()?;
    Ok(Some(Completed { next_due: Some(next), record: Some(record) }))
}

/// Ends a task's repetition and completes it: "stop repeating" (ADR-0053).
/// The occurrences already done keep their records; the task becomes an
/// ordinary completed task, which reopened does not repeat.
pub fn stop_repeating(conn: &Connection, id: i64, now: i64) -> Result<()> {
    check_editable(conn, id)?;
    let changed = conn.execute(
        "UPDATE tasks SET rrule = '', completed_at = COALESCE(completed_at, ?2), revision = revision + 1
          WHERE id = ?1 AND pending <> 'delete'",
        params![id, now],
    )?;
    if changed == 0 {
        bail!("this task no longer exists");
    }
    touched(conn, id)?;
    Ok(())
}

/// Completes a task, or reopens it (`tasks.setCompleted`). A repeating task
/// completes its present occurrence and moves on, unless `stop` asks to end
/// its repetition and complete it for good (ADR-0053).
pub fn set_completed(conn: &Connection, id: i64, completed: bool, stop: bool, now: i64) -> Result<Completed> {
    let done = Completed { next_due: None, record: None };
    if completed && stop {
        stop_repeating(conn, id, now)?;
        return Ok(done);
    }
    if completed {
        if let Some(outcome) = complete_occurrence(conn, id, now)? {
            return Ok(outcome);
        }
    }
    crate::store::set_task_completed(conn, id, completed, now)?;
    Ok(done)
}

/// Open tasks whose reminder time has come and which have not rung yet.
pub fn due_reminders(conn: &Connection, now: i64) -> Result<Vec<(i64, String, Option<i64>)>> {
    let mut stmt = conn.prepare(
        "SELECT t.id,
                CASE WHEN t.title <> '' THEN t.title ELSE COALESCE(
                  (SELECT m.subject FROM messages m WHERE m.account = t.account AND m.thread_key = t.thread_key
                    ORDER BY m.date DESC LIMIT 1), '') END,
                t.due_at
           FROM tasks t
          WHERE t.completed_at IS NULL AND t.reminder_at IS NOT NULL AND t.pending <> 'delete'
            AND t.reminder_at <= ?1 AND t.reminded_at IS NULL",
    )?;
    let rows = stmt.query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Recorded before it is announced, like calendar reminders: twice is worse
/// than once lost to a crash in between.
pub fn mark_reminded(conn: &Connection, id: i64, now: i64) -> Result<()> {
    conn.execute("UPDATE tasks SET reminded_at = ?2 WHERE id = ?1", params![id, now])?;
    Ok(())
}

#[cfg(test)]
mod tests;
