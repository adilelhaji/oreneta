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
}

pub fn lists(conn: &Connection) -> Result<Vec<TaskList>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.position,
                (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed_at IS NULL)
           FROM task_lists l ORDER BY l.position, l.created_at, l.name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TaskList { id: row.get(0)?, name: row.get(1)?, position: row.get(2)?, open: row.get(3)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn create_list(conn: &Connection, name: &str, now: i64) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a list needs a name");
    }
    let id = format!("list:{}", uuid::Uuid::new_v4());
    let position: i64 = conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM task_lists", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO task_lists(id, name, position, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![id, name, position, now],
    )?;
    Ok(id)
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
}

impl TaskFields {
    fn check(&self, linked: bool) -> Result<()> {
        if !linked && self.title.trim().is_empty() {
            bail!("a task needs a title");
        }
        if !(0..=2).contains(&self.priority) {
            bail!("unknown priority");
        }
        Ok(())
    }
}

fn list_exists(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.prepare("SELECT 1 FROM task_lists WHERE id = ?1")?.exists(params![id])?)
}

/// A standalone task, in the list named.
pub fn create(conn: &Connection, fields: &TaskFields, now: i64) -> Result<i64> {
    fields.check(false)?;
    let list = if fields.list_id.is_empty() { MAIL_LIST } else { fields.list_id.as_str() };
    if !list_exists(conn, list)? {
        bail!("that list no longer exists");
    }
    conn.execute(
        "INSERT INTO tasks(account, thread_key, folder, note, due_at, created_at, list_id, title, priority, reminder_at)
         VALUES('', '', '', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![fields.note.trim(), fields.due_at, now, list, fields.title.trim(), fields.priority, fields.reminder_at],
    )?;
    Ok(conn.last_insert_rowid())
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
            "SELECT list_id, title, note, due_at, reminder_at, priority, revision, thread_key <> ''
               FROM tasks WHERE id = ?1",
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
    tx.execute(
        "UPDATE tasks SET list_id = ?2, title = ?3, note = ?4, due_at = ?5, priority = ?6,
                reminder_at = ?7,
                reminded_at = CASE WHEN reminder_at IS ?7 THEN reminded_at ELSE NULL END,
                revision = revision + 1
          WHERE id = ?1",
        params![id, list, fields.title.trim(), fields.note.trim(), fields.due_at, fields.priority, fields.reminder_at],
    )?;
    tx.commit()?;
    Ok(Edit::Saved { revision: revision + 1 })
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
          WHERE t.completed_at IS NULL AND t.reminder_at IS NOT NULL
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
