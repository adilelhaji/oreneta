//! Task lists kept on a CalDAV server (#103, ADR-0039).
//!
//! A list can be bound to one calendar collection that holds tasks
//! (VTODO). Every change made here is kept locally first and marked as
//! pending; a sync then
//!
//! 1. sends the pending changes of that list one at a time, each against
//!    the version it was made from (`If-Match`, or `If-None-Match: *` for a
//!    new task). A refusal (HTTP 412) marks that task as a conflict and
//!    stops the list's queue; while the list holds a conflict, nothing else
//!    of it is sent. A network or server error stops the sync, and nothing
//!    local is lost;
//! 2. reads every task of the collection. All or nothing: one object that
//!    does not come back, or cannot be read, fails the read and keeps the
//!    local copy as it was;
//! 3. reconciles by object: a server change to a task not changed here is
//!    taken; a task changed on both sides, or changed here and deleted
//!    there, waits for the person to choose. Nothing is merged silently
//!    (ADR-0012).
//!
//! The password goes only where the collection is (`caldav::guard`, #28),
//! and deleting a bound list here never deletes anything on the server.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::calendar::caldav::{self, Object, RemoteCalendar};
use crate::carddav::client::{credentials_may_follow, starting_point_for, Transport, Written};

pub mod vtodo;

/// The keychain entry holding a bound list's password.
pub fn secret_key(list_id: &str) -> String {
    format!("caldav-tasks:{list_id}")
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    let has = |table: &str, column: &str| -> rusqlite::Result<bool> {
        conn.prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}'"))?.exists([])
    };
    for (table, column, ddl) in [
        ("task_lists", "remote_url", "ALTER TABLE task_lists ADD COLUMN remote_url TEXT NOT NULL DEFAULT ''"),
        ("task_lists", "remote_user", "ALTER TABLE task_lists ADD COLUMN remote_user TEXT NOT NULL DEFAULT ''"),
        ("task_lists", "synced_at", "ALTER TABLE task_lists ADD COLUMN synced_at INTEGER"),
        ("task_lists", "last_error", "ALTER TABLE task_lists ADD COLUMN last_error TEXT NOT NULL DEFAULT ''"),
        ("tasks", "remote_href", "ALTER TABLE tasks ADD COLUMN remote_href TEXT NOT NULL DEFAULT ''"),
        ("tasks", "remote_etag", "ALTER TABLE tasks ADD COLUMN remote_etag TEXT NOT NULL DEFAULT ''"),
        ("tasks", "remote_ics", "ALTER TABLE tasks ADD COLUMN remote_ics TEXT NOT NULL DEFAULT ''"),
        ("tasks", "pending", "ALTER TABLE tasks ADD COLUMN pending TEXT NOT NULL DEFAULT ''"),
        ("tasks", "conflict", "ALTER TABLE tasks ADD COLUMN conflict TEXT NOT NULL DEFAULT ''"),
        ("tasks", "recurring", "ALTER TABLE tasks ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0"),
        ("tasks", "sync_seq", "ALTER TABLE tasks ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !has(table, column)? {
            conn.execute_batch(ddl)?;
        }
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_tasks_remote ON tasks(list_id, remote_href) WHERE remote_href <> '';")?;
    Ok(())
}

/// The collections a server offers. Every calendar collection is listed:
/// which ones accept tasks is not asked of the server here, and one that
/// does not is reported by the first sync.
pub fn discover(transport: &dyn Transport, server: &str) -> Result<Vec<RemoteCalendar>> {
    caldav::discover(transport, server)
}

/// Where a bound list is kept and who signs in there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub list_id: String,
    pub url: String,
    pub username: String,
}

/// A new list bound to a collection. `server` is what the person typed to
/// find it; the collection must be somewhere the password may go from
/// there.
pub fn add_list(conn: &Connection, name: &str, url: &str, server: &str, username: &str, now: i64) -> Result<String> {
    let parsed = url::Url::parse(url.trim()).context("that collection address is not a URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("that collection address is not a web address");
    }
    let url = parsed.to_string();
    if !server.trim().is_empty() {
        let start = starting_point_for(server, "/.well-known/caldav")?;
        if !credentials_may_follow(&start, &url) {
            bail!("that collection is somewhere the password must not go; nothing was sent there");
        }
    }
    if conn.prepare("SELECT 1 FROM task_lists WHERE remote_url = ?1")?.exists(params![url])? {
        bail!("that collection is already a task list here");
    }
    let name = if name.trim().is_empty() { crate::carddav::client::name_from_url(&url) } else { name.to_string() };
    let tx = conn.unchecked_transaction()?;
    let id = crate::store::task_lists::create_list(&tx, &name, now)?;
    tx.execute("UPDATE task_lists SET remote_url = ?2, remote_user = ?3 WHERE id = ?1", params![id, url, username])?;
    tx.commit()?;
    Ok(id)
}

pub fn binding(conn: &Connection, list_id: &str) -> Result<Option<Binding>> {
    Ok(conn
        .query_row(
            "SELECT id, remote_url, remote_user FROM task_lists WHERE id = ?1 AND remote_url <> ''",
            params![list_id],
            |row| Ok(Binding { list_id: row.get(0)?, url: row.get(1)?, username: row.get(2)? }),
        )
        .optional()?)
}

/// Every bound list.
pub fn bindings(conn: &Connection) -> Result<Vec<Binding>> {
    let mut stmt = conn.prepare("SELECT id, remote_url, remote_user FROM task_lists WHERE remote_url <> '' ORDER BY position")?;
    let rows = stmt.query_map([], |row| Ok(Binding { list_id: row.get(0)?, url: row.get(1)?, username: row.get(2)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// What a sync did.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Report {
    /// Changes sent.
    pub pushed: usize,
    /// Tasks taken from the server, new or changed there.
    pub pulled: usize,
    /// Tasks removed here because they are gone from the server.
    pub removed: usize,
    /// Tasks that now wait for the person to choose a copy.
    pub conflicts: usize,
    /// The queue stopped on a conflict; the list's other changes wait.
    pub stopped: bool,
}

/// One sync at a time: two at once would send the same change twice.
static SYNCING: Mutex<()> = Mutex::new(());

fn lock(db: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Syncs one bound list. The outcome is recorded on the list (when it last
/// synced, or why it failed) as well as returned.
pub fn sync(db: &Mutex<Connection>, transport: &dyn Transport, list_id: &str, now: i64) -> Result<Report> {
    let _one = SYNCING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let binding = binding(&lock(db), list_id)?.context("this list is not kept on a server")?;
    let result = push(db, transport, &binding, now).and_then(|mut report| {
        let objects = caldav::fetch_todos(transport, &binding.url)?;
        reconcile(&lock(db), &binding, &objects, now, &mut report)?;
        Ok(report)
    });
    let conn = lock(db);
    match &result {
        Ok(_) => conn.execute("UPDATE task_lists SET synced_at = ?2, last_error = '' WHERE id = ?1", params![list_id, now])?,
        Err(error) => conn.execute("UPDATE task_lists SET last_error = ?2 WHERE id = ?1", params![list_id, format!("{error:#}")])?,
    };
    result
}

/// A task with a change waiting to be sent.
struct Pending {
    id: i64,
    fields: vtodo::Fields,
    href: String,
    etag: String,
    ics: String,
    pending: String,
    recurring: bool,
    seq: i64,
}

fn queue(conn: &Connection, list_id: &str) -> Result<Vec<Pending>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, note, due_at, priority, completed_at, reminder_at, remote_href, remote_etag, remote_ics,
                pending, recurring, sync_seq
           FROM tasks WHERE list_id = ?1 AND pending <> '' ORDER BY id",
    )?;
    let rows = stmt.query_map(params![list_id], |row| {
        Ok(Pending {
            id: row.get(0)?,
            fields: vtodo::Fields {
                title: row.get(1)?,
                note: row.get(2)?,
                due_at: row.get(3)?,
                priority: row.get(4)?,
                completed_at: row.get(5)?,
                reminder_at: row.get(6)?,
            },
            href: row.get(7)?,
            etag: row.get(8)?,
            ics: row.get(9)?,
            pending: row.get(10)?,
            recurring: row.get(11)?,
            seq: row.get(12)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn mark_conflict(conn: &Connection, id: i64, reason: &str) -> Result<()> {
    conn.execute("UPDATE tasks SET conflict = ?2 WHERE id = ?1", params![id, reason])?;
    Ok(())
}

/// Sends the list's pending changes, oldest task first.
fn push(db: &Mutex<Connection>, transport: &dyn Transport, binding: &Binding, now: i64) -> Result<Report> {
    let mut report = Report::default();
    let (queue, blocked) = {
        let conn = lock(db);
        let blocked = conn
            .prepare("SELECT 1 FROM tasks WHERE list_id = ?1 AND conflict <> ''")?
            .exists(params![binding.list_id])?;
        (queue(&conn, &binding.list_id)?, blocked)
    };
    if blocked {
        report.stopped = !queue.is_empty();
        return Ok(report);
    }
    for task in queue {
        if task.pending == "delete" {
            if task.etag.is_empty() || task.href.is_empty() {
                lock(db).execute("DELETE FROM tasks WHERE id = ?1", params![task.id])?;
                continue;
            }
            match caldav::delete_object(transport, &binding.url, &task.href, &task.etag)? {
                Written::Saved { .. } => {
                    lock(db).execute("DELETE FROM tasks WHERE id = ?1 AND pending = 'delete'", params![task.id])?;
                    report.pushed += 1;
                }
                Written::Conflict => {
                    mark_conflict(&lock(db), task.id, "changed")?;
                    report.conflicts += 1;
                    report.stopped = true;
                    break;
                }
            }
            continue;
        }
        if task.recurring {
            continue;
        }
        let (href, ics) = if task.href.is_empty() || task.ics.is_empty() {
            // Its place is chosen and kept before it is sent: if the answer
            // is lost, the next attempt goes to the same place and cannot
            // make a second copy.
            let uid = format!("{}@oreneta", uuid::Uuid::new_v4());
            let href = if task.href.is_empty() { caldav::new_href(&binding.url, &uid)? } else { task.href.clone() };
            let ics = vtodo::new_object(&task.fields, &uid, now);
            lock(db).execute(
                "UPDATE tasks SET remote_href = ?2, remote_ics = ?3 WHERE id = ?1",
                params![task.id, href, ics],
            )?;
            (href, ics)
        } else {
            (task.href.clone(), vtodo::patch(&task.ics, &task.fields, now)?)
        };
        let condition = (!task.etag.is_empty()).then_some(task.etag.as_str());
        match caldav::put_object(transport, &binding.url, &href, &ics, condition)? {
            Written::Saved { etag } => {
                // A change made here while it was being sent stays pending.
                lock(db).execute(
                    "UPDATE tasks SET remote_etag = ?2, remote_ics = ?3,
                            pending = CASE WHEN sync_seq = ?4 THEN '' ELSE pending END
                      WHERE id = ?1",
                    params![task.id, etag.unwrap_or_default(), ics, task.seq],
                )?;
                report.pushed += 1;
            }
            Written::Conflict => {
                mark_conflict(&lock(db), task.id, "changed")?;
                report.conflicts += 1;
                report.stopped = true;
                break;
            }
        }
    }
    Ok(report)
}

/// The server's copy over a local task, which then has nothing pending. A
/// reminder already past rings no more: it rang wherever it was set.
fn take_server_copy(conn: &Connection, id: i64, object: &Object, todo: &vtodo::Todo, now: i64) -> Result<()> {
    let f = &todo.fields;
    conn.execute(
        "UPDATE tasks SET title = ?2, note = ?3, due_at = ?4, priority = ?5, completed_at = ?6,
                reminded_at = CASE WHEN reminder_at IS ?7 THEN reminded_at
                                   WHEN ?7 IS NOT NULL AND ?7 <= ?11 THEN ?11 ELSE NULL END,
                reminder_at = ?7, remote_etag = ?8, remote_ics = ?9, recurring = ?10,
                pending = '', conflict = '', revision = revision + 1
          WHERE id = ?1",
        params![id, f.title, f.note, f.due_at, f.priority, f.completed_at, f.reminder_at, object.etag, object.ics, todo.recurring, now],
    )?;
    Ok(())
}

fn insert_server_copy(conn: &Connection, list_id: &str, object: &Object, todo: &vtodo::Todo, now: i64) -> Result<()> {
    let f = &todo.fields;
    let reminded = f.reminder_at.filter(|at| *at <= now).map(|_| now);
    conn.execute(
        "INSERT INTO tasks(account, thread_key, folder, note, due_at, created_at, list_id, title, priority,
                           reminder_at, reminded_at, completed_at, remote_href, remote_etag, remote_ics, recurring)
         VALUES('', '', '', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            f.note,
            f.due_at,
            todo.created_at.unwrap_or(now),
            list_id,
            f.title,
            f.priority,
            f.reminder_at,
            reminded,
            f.completed_at,
            object.href,
            object.etag,
            object.ics,
            todo.recurring
        ],
    )?;
    Ok(())
}

struct Known {
    id: i64,
    etag: String,
    pending: String,
    conflict: String,
}

fn reconcile(conn: &Connection, binding: &Binding, objects: &[Object], now: i64, report: &mut Report) -> Result<()> {
    // Every object is read before anything is written: one that cannot be
    // read fails the whole read, as one that did not come back does.
    let mut parsed = Vec::with_capacity(objects.len());
    for object in objects {
        let todo = vtodo::parse(&object.ics)
            .with_context(|| format!("the task at {} could not be read; the last complete copy is kept", object.href))?;
        parsed.push((object, todo));
    }
    let tx = conn.unchecked_transaction()?;
    let known: HashMap<String, Known> = {
        let mut stmt =
            tx.prepare("SELECT remote_href, id, remote_etag, pending, conflict FROM tasks WHERE list_id = ?1 AND remote_href <> ''")?;
        let rows = stmt.query_map(params![binding.list_id], |row| {
            Ok((row.get(0)?, Known { id: row.get(1)?, etag: row.get(2)?, pending: row.get(3)?, conflict: row.get(4)? }))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut seen: HashSet<&str> = HashSet::new();
    for (object, todo) in &parsed {
        seen.insert(object.href.as_str());
        let Some(local) = known.get(&object.href) else {
            insert_server_copy(&tx, &binding.list_id, object, todo, now)?;
            report.pulled += 1;
            continue;
        };
        if !object.etag.is_empty() && object.etag == local.etag {
            continue;
        }
        if local.pending.is_empty() {
            take_server_copy(&tx, local.id, object, todo, now)?;
            report.pulled += 1;
        } else if local.conflict != "changed" {
            mark_conflict(&tx, local.id, "changed")?;
            report.conflicts += 1;
        }
    }
    for (href, local) in &known {
        if seen.contains(href.as_str()) {
            continue;
        }
        if local.pending.is_empty() || local.pending == "delete" {
            tx.execute("DELETE FROM tasks WHERE id = ?1", params![local.id])?;
            report.removed += 1;
        } else if local.etag.is_empty() && local.conflict.is_empty() {
            // New here and not on the server yet: it is sent next time.
        } else if local.conflict != "deleted" {
            mark_conflict(&tx, local.id, "deleted")?;
            report.conflicts += 1;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Which copy of a task in conflict to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    Mine,
    Server,
}

impl Keep {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "mine" => Some(Keep::Mine),
            "server" => Some(Keep::Server),
            _ => None,
        }
    }
}

/// Settles a conflict. "Server" takes the copy on the server now (or
/// removes the task here if it is gone there). "Mine" re-queues the local
/// copy against the version on the server now, so the next sync writes it
/// over that version (or creates it again). Answers the task's list, to
/// sync next.
pub fn resolve_conflict(db: &Mutex<Connection>, transport: &dyn Transport, id: i64, keep: Keep, now: i64) -> Result<String> {
    let (list_id, href, pending, conflict): (String, String, String, String) = lock(db)
        .query_row(
            "SELECT list_id, remote_href, pending, conflict FROM tasks WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .context("this task no longer exists")?;
    if conflict.is_empty() {
        bail!("this task has no conflict to settle");
    }
    let binding = binding(&lock(db), &list_id)?.context("this list is not kept on a server")?;
    let current = if href.is_empty() { None } else { caldav::get_object(transport, &binding.url, &href)? };
    let conn = lock(db);
    match (keep, current) {
        (Keep::Server, Some((ics, etag))) => {
            let object = Object { href, etag, ics };
            let todo = vtodo::parse(&object.ics)?;
            take_server_copy(&conn, id, &object, &todo, now)?;
        }
        (Keep::Server, None) => {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        }
        (Keep::Mine, Some((ics, etag))) => {
            conn.execute(
                "UPDATE tasks SET remote_ics = ?2, remote_etag = ?3, conflict = '',
                        pending = CASE WHEN pending = '' THEN 'put' ELSE pending END,
                        sync_seq = sync_seq + 1
                  WHERE id = ?1",
                params![id, ics, etag],
            )?;
        }
        (Keep::Mine, None) if pending == "delete" => {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        }
        (Keep::Mine, None) => {
            // Created again where it was, from the last copy read, so what
            // other clients had put there is kept.
            conn.execute(
                "UPDATE tasks SET remote_etag = '', conflict = '', pending = 'put', sync_seq = sync_seq + 1 WHERE id = ?1",
                params![id],
            )?;
        }
    }
    Ok(list_id)
}

#[cfg(test)]
mod tests;
