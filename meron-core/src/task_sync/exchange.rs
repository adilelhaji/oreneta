//! Task lists kept in an Exchange account's Tasks folder (ADR-0058).
//!
//! The same model as a CalDAV list (ADR-0039), with the account's own
//! sign-in instead of a collection and a password of its own:
//!
//! 1. changes made here are kept first and marked pending, then sent one at
//!    a time against the change key each task was read at
//!    (`ConflictResolution="NeverOverwrite"`). A refusal marks that task as
//!    a conflict and stops the list's queue; a network or server error stops
//!    the sync and loses nothing here;
//! 2. the folder is read in full: all or nothing;
//! 3. each task is reconciled by item id. A change on both sides waits for
//!    the person to choose; nothing is merged silently (ADR-0012).
//!
//! A new task gets an id of ours, kept here before it is sent and written on
//! the task as a named property. If the answer to its creation is lost, the
//! next attempt looks for that id first and takes the task it finds, so a
//! retry never makes a second copy.
//!
//! The server's copy as last read is kept (`remote_ics`, as JSON) so a write
//! sends only the properties that changed here.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{bail, Context as _, Result};
use rusqlite::{params, Connection, OptionalExtension as _};
use serde_json::{json, Value};

use super::account_lists;
use super::vtodo::Fields;
use super::{lock, mark_conflict, Keep, Report};
use crate::exchange::book::ListWrite;
use crate::exchange::tasks::RemoteTask;
use crate::exchange::EwsClient;

/// Where a new task's id of ours is kept until the server names it.
const NEW: &str = "new:";

/// Schema 64: the account whose Tasks folder a list is.
pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    let has = conn.prepare("SELECT 1 FROM pragma_table_info('task_lists') WHERE name = 'ews_account'")?.exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE task_lists ADD COLUMN ews_account TEXT NOT NULL DEFAULT ''")?;
    }
    Ok(())
}

/// A new list bound to `account`'s Tasks folder. One list per account.
pub fn add_list(conn: &Connection, account: &str, name: &str, now: i64) -> Result<String> {
    if account.trim().is_empty() {
        bail!("choose the Exchange account whose tasks to read");
    }
    if conn.prepare("SELECT 1 FROM task_lists WHERE ews_account = ?1")?.exists(params![account])? {
        bail!("the tasks of that account are already a list here");
    }
    let name = if name.trim().is_empty() { account } else { name };
    let tx = conn.unchecked_transaction()?;
    let id = crate::store::task_lists::create_list(&tx, name, now)?;
    tx.execute("UPDATE task_lists SET ews_account = ?2 WHERE id = ?1", params![id, account])?;
    tx.commit()?;
    Ok(id)
}

/// The account whose Tasks folder the list is, if it is one.
pub fn binding(conn: &Connection, list_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT ews_account FROM task_lists WHERE id = ?1 AND ews_account <> ''",
            params![list_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Every list kept in an Exchange account, as `(list, account)`.
pub fn bindings(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, ews_account FROM task_lists WHERE ews_account <> '' ORDER BY position")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The first read of an account's Tasks folder (ADR-0070, §3): read whole,
/// and only then, in one transaction, the list made with its tasks and the
/// account's entry linked. A read that fails makes nothing: a waiting entry
/// keeps waiting, with the reason; one declined stays declined. A read that
/// ends after the person declined the list, or removed the account, writes
/// nothing.
pub fn link_account(
    db: &Mutex<Connection>,
    client: &EwsClient,
    account: &str,
    mode: account_lists::Mode,
    now: i64,
) -> Result<account_lists::Linked> {
    use account_lists::{Linked, Mode, EWS};
    {
        let conn = lock(db);
        if !account_lists::may_write(&conn, account, EWS, mode)? {
            return Ok(Linked::Discarded);
        }
        if mode == Mode::ByHand && conn.prepare("SELECT 1 FROM task_lists WHERE ews_account = ?1")?.exists(params![account])? {
            bail!("the tasks of that account are already a list here");
        }
    }
    let tasks = match client.read_tasks() {
        Ok(tasks) => tasks,
        Err(error) => {
            if mode == Mode::Retry {
                account_lists::record_failure(&lock(db), account, EWS, &format!("{error:#}"))?;
            }
            return Err(error);
        }
    };
    let conn = lock(db);
    let written = (|| -> Result<Linked> {
        let tx = conn.unchecked_transaction()?;
        if !account_lists::may_write(&tx, account, EWS, mode)? {
            return Ok(Linked::Discarded);
        }
        // A list of the account made meanwhile is its list: taken, not doubled.
        let existing: Option<String> = tx
            .query_row("SELECT id FROM task_lists WHERE ews_account = ?1 ORDER BY position LIMIT 1", params![account], |row| {
                row.get(0)
            })
            .optional()?;
        let list_id = match existing {
            Some(id) => id,
            None => {
                let name = crate::store::account_email(&tx, account)?.filter(|email| !email.trim().is_empty());
                let id = crate::store::task_lists::create_list(&tx, name.as_deref().unwrap_or(account), now)?;
                tx.execute("UPDATE task_lists SET ews_account = ?2 WHERE id = ?1", params![id, account])?;
                id
            }
        };
        reconcile_in(&tx, &list_id, &tasks, now, &mut Report::default())?;
        tx.execute("UPDATE task_lists SET synced_at = ?2, last_error = '' WHERE id = ?1", params![list_id, now])?;
        account_lists::mark_linked(&tx, account, EWS, &list_id, false, now)?;
        tx.commit()?;
        Ok(Linked::Made(list_id))
    })();
    if let (Err(error), Mode::Retry) = (&written, mode) {
        account_lists::record_failure(&conn, account, EWS, &format!("{error:#}"))?;
    }
    written
}

/// Drops the lists kept in `account` and their tasks, as the account goes
/// (ADR-0011): they were a copy of its folder.
pub fn forget_account(conn: &Connection, account: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM tasks WHERE list_id IN (SELECT id FROM task_lists WHERE ews_account = ?1)",
        params![account],
    )?;
    conn.execute("DELETE FROM task_lists WHERE ews_account = ?1", params![account])?;
    Ok(())
}

fn snapshot(fields: &Fields) -> String {
    json!({
        "title": fields.title,
        "note": fields.note,
        "due_at": fields.due_at,
        "priority": fields.priority,
        "completed_at": fields.completed_at,
        "reminder_at": fields.reminder_at,
        "rrule": fields.rrule,
    })
    .to_string()
}

fn from_snapshot(text: &str) -> Option<Fields> {
    let value: Value = serde_json::from_str(text).ok()?;
    Some(Fields {
        title: value["title"].as_str()?.to_string(),
        note: value["note"].as_str().unwrap_or_default().to_string(),
        due_at: value["due_at"].as_i64(),
        priority: value["priority"].as_i64().unwrap_or(1),
        completed_at: value["completed_at"].as_i64(),
        reminder_at: value["reminder_at"].as_i64(),
        rrule: value["rrule"].as_str().unwrap_or_default().to_string(),
    })
}

/// One sync of a list at a time: two at once would send the same change
/// twice. Lists apart do not wait for each other.
fn list_lock(list_id: &str) -> std::sync::Arc<Mutex<()>> {
    static LOCKS: std::sync::OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>> = std::sync::OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(list_id.to_string()).or_default().clone()
}

/// The conflict mark of a change Exchange can never take, with its reason.
/// It holds up nothing else: the list goes on, and the task is tried again
/// once it is changed (ADR-0058).
const REJECTED: &str = "rejected: ";

fn mark_rejected(conn: &Connection, id: i64, reason: &str) -> Result<()> {
    mark_conflict(conn, id, &format!("{REJECTED}{reason}"))
}

/// Syncs one list kept in an Exchange account. The outcome is recorded on
/// the list as well as returned.
pub fn sync(db: &Mutex<Connection>, client: &EwsClient, list_id: &str, now: i64) -> Result<Report> {
    let lock_of_list = list_lock(list_id);
    let _one = lock_of_list.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    binding(&lock(db), list_id)?.context("this list is not kept in an Exchange account")?;
    let result = push(db, client, list_id, now).and_then(|mut report| {
        let mut tasks = client.read_tasks()?;
        // Pages by offset can skip a task when another goes meanwhile; a
        // task known here that the listing left out is asked for by its id
        // before it counts as gone.
        let missing: Vec<String> = {
            let listed: HashSet<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
            let conn = lock(db);
            let mut stmt = conn.prepare(
                "SELECT remote_href FROM tasks WHERE list_id = ?1 AND remote_href <> '' AND remote_href NOT LIKE 'new:%'",
            )?;
            let known = stmt.query_map(params![list_id], |row| row.get::<_, String>(0))?;
            known.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().filter(|href| !listed.contains(href.as_str())).collect()
        };
        if !missing.is_empty() {
            tasks.extend(client.tasks_by_id(&missing)?);
        }
        reconcile(&lock(db), list_id, &tasks, now, &mut report)?;
        Ok(report)
    });
    let conn = lock(db);
    match &result {
        Ok(_) => conn.execute("UPDATE task_lists SET synced_at = ?2, last_error = '' WHERE id = ?1", params![list_id, now])?,
        Err(error) => conn.execute("UPDATE task_lists SET last_error = ?2 WHERE id = ?1", params![list_id, format!("{error:#}")])?,
    };
    result
}

struct Pending {
    id: i64,
    fields: Fields,
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
                pending, recurring, sync_seq, rrule
           FROM tasks WHERE list_id = ?1 AND pending <> '' ORDER BY id",
    )?;
    let rows = stmt.query_map(params![list_id], |row| {
        Ok(Pending {
            id: row.get(0)?,
            fields: Fields {
                title: row.get(1)?,
                note: row.get(2)?,
                due_at: row.get(3)?,
                priority: row.get(4)?,
                completed_at: row.get(5)?,
                reminder_at: row.get(6)?,
                rrule: row.get(13)?,
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

/// Keeps the server's copy of a task just written as the version read. A
/// change made here while it was being sent stays pending; one set aside as
/// unwritable before is not any more.
fn written_here(conn: &Connection, id: i64, remote: &RemoteTask, seq: i64) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET remote_href = ?2, remote_etag = ?3, remote_ics = ?4,
                pending = CASE WHEN sync_seq = ?5 THEN '' ELSE pending END,
                conflict = CASE WHEN conflict LIKE 'rejected: %' THEN '' ELSE conflict END
          WHERE id = ?1",
        params![id, remote.id, remote.change_key, snapshot(&remote.fields), seq],
    )?;
    Ok(())
}

fn take_fields(conn: &Connection, id: i64, remote: &RemoteTask, now: i64) -> Result<()> {
    let f = &remote.fields;
    conn.execute(
        "UPDATE tasks SET title = ?2, note = ?3, due_at = ?4, priority = ?5, completed_at = ?6,
                reminded_at = CASE WHEN reminder_at IS ?7 THEN reminded_at
                                   WHEN ?7 IS NOT NULL AND ?7 <= ?8 THEN ?8 ELSE NULL END,
                reminder_at = ?7, recurring = ?9, rrule = ?10
          WHERE id = ?1",
        params![id, f.title, f.note, f.due_at, f.priority, f.completed_at, f.reminder_at, now, remote.recurring, f.rrule],
    )?;
    Ok(())
}

/// The server's copy over a local task, which then has nothing pending.
fn take_server_copy(conn: &Connection, id: i64, remote: &RemoteTask, now: i64) -> Result<()> {
    take_fields(conn, id, remote, now)?;
    conn.execute(
        "UPDATE tasks SET remote_href = ?2, remote_etag = ?3, remote_ics = ?4, pending = '', conflict = '',
                revision = revision + 1
          WHERE id = ?1",
        params![id, remote.id, remote.change_key, snapshot(&remote.fields)],
    )?;
    Ok(())
}

fn insert_server_copy(conn: &Connection, list_id: &str, remote: &RemoteTask, now: i64) -> Result<()> {
    let f = &remote.fields;
    let reminded = f.reminder_at.filter(|at| *at <= now).map(|_| now);
    conn.execute(
        "INSERT INTO tasks(account, thread_key, folder, note, due_at, created_at, list_id, title, priority,
                           reminder_at, reminded_at, completed_at, remote_href, remote_etag, remote_ics, recurring, rrule)
         VALUES('', '', '', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            f.note,
            f.due_at,
            remote.created_at.unwrap_or(now),
            list_id,
            f.title,
            f.priority,
            f.reminder_at,
            reminded,
            f.completed_at,
            remote.id,
            remote.change_key,
            snapshot(f),
            remote.recurring,
            f.rrule
        ],
    )?;
    Ok(())
}

/// Sends the list's pending changes, oldest task first.
fn push(db: &Mutex<Connection>, client: &EwsClient, list_id: &str, now: i64) -> Result<Report> {
    let mut report = Report::default();
    let (queue, blocked) = {
        let conn = lock(db);
        let blocked = conn
            .prepare("SELECT 1 FROM tasks WHERE list_id = ?1 AND conflict <> '' AND conflict NOT LIKE 'rejected: %'")?
            .exists(params![list_id])?;
        (queue(&conn, list_id)?, blocked)
    };
    if blocked {
        report.stopped = !queue.is_empty();
        return Ok(report);
    }
    for mut task in queue {
        // A creation whose answer was lost: the task may be there already.
        if let Some(marker) = task.href.strip_prefix(NEW) {
            if let Some(found) = client.find_marked_task(marker)? {
                lock(db).execute(
                    "UPDATE tasks SET remote_href = ?2, remote_etag = ?3, remote_ics = ?4 WHERE id = ?1",
                    params![task.id, found.id, found.change_key, snapshot(&found.fields)],
                )?;
                task.href = found.id.clone();
                task.etag = found.change_key.clone();
                task.ics = snapshot(&found.fields);
            }
        }
        let on_server = !task.href.is_empty() && !task.href.starts_with(NEW);
        if task.pending == "delete" {
            if !on_server {
                lock(db).execute("DELETE FROM tasks WHERE id = ?1", params![task.id])?;
                continue;
            }
            match client.delete_task(&task.href, &task.etag)? {
                ListWrite::Saved { .. } => {
                    lock(db).execute("DELETE FROM tasks WHERE id = ?1 AND pending = 'delete'", params![task.id])?;
                    report.pushed += 1;
                }
                ListWrite::Conflict => {
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
        if !on_server {
            // Our id is kept before anything is sent: if the answer is lost,
            // the next attempt finds the task by it instead of making another.
            let marker = match task.href.strip_prefix(NEW) {
                Some(marker) => marker.to_string(),
                None => {
                    let marker = uuid::Uuid::new_v4().to_string();
                    lock(db).execute("UPDATE tasks SET remote_href = ?2 WHERE id = ?1", params![task.id, format!("{NEW}{marker}")])?;
                    marker
                }
            };
            let (id, _) = match client.create_task(&task.fields, &marker, now) {
                Ok(created) => created,
                Err(error) => match crate::exchange::tasks::unwritable_reason(&error) {
                    // Nothing was sent: no id to look for next time.
                    Some(reason) => {
                        let conn = lock(db);
                        conn.execute("UPDATE tasks SET remote_href = '' WHERE id = ?1", params![task.id])?;
                        mark_rejected(&conn, task.id, &reason)?;
                        report.rejected += 1;
                        continue;
                    }
                    None => return Err(error),
                },
            };
            let remote = client.read_task(&id)?.context("Exchange did not keep the task it created")?;
            written_here(&lock(db), task.id, &remote, task.seq)?;
            report.pushed += 1;
            continue;
        }
        let before = from_snapshot(&task.ics).unwrap_or_default();
        let written = match client.update_task(&task.href, &task.etag, &before, &task.fields, now) {
            Ok(written) => written,
            Err(error) => match crate::exchange::tasks::unwritable_reason(&error) {
                Some(reason) => {
                    mark_rejected(&lock(db), task.id, &reason)?;
                    report.rejected += 1;
                    continue;
                }
                None => return Err(error),
            },
        };
        match written {
            ListWrite::Saved { .. } => {
                let remote = client.read_task(&task.href)?.context("the task is gone from the server")?;
                written_here(&lock(db), task.id, &remote, task.seq)?;
                report.pushed += 1;
            }
            ListWrite::Conflict => {
                mark_conflict(&lock(db), task.id, "changed")?;
                report.conflicts += 1;
                report.stopped = true;
                break;
            }
        }
    }
    Ok(report)
}

struct Known {
    id: i64,
    etag: String,
    pending: String,
    conflict: String,
}

fn reconcile(conn: &Connection, list_id: &str, tasks: &[RemoteTask], now: i64, report: &mut Report) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    reconcile_in(&tx, list_id, tasks, now, report)?;
    tx.commit()?;
    Ok(())
}

/// [`reconcile`] inside the caller's transaction: the first read of an
/// account's list creates the list and its tasks in one (ADR-0070, §3).
fn reconcile_in(tx: &Connection, list_id: &str, tasks: &[RemoteTask], now: i64, report: &mut Report) -> Result<()> {
    let (known, new_here): (HashMap<String, Known>, HashMap<String, i64>) = {
        let mut stmt =
            tx.prepare("SELECT remote_href, id, remote_etag, pending, conflict FROM tasks WHERE list_id = ?1 AND remote_href <> ''")?;
        let rows = stmt.query_map(params![list_id], |row| {
            Ok((row.get::<_, String>(0)?, Known { id: row.get(1)?, etag: row.get(2)?, pending: row.get(3)?, conflict: row.get(4)? }))
        })?;
        let mut known = HashMap::new();
        let mut new_here = HashMap::new();
        for row in rows {
            let (href, local) = row?;
            match href.strip_prefix(NEW) {
                Some(marker) => {
                    new_here.insert(marker.to_string(), local.id);
                }
                None => {
                    known.insert(href, local);
                }
            }
        }
        (known, new_here)
    };
    let mut seen: HashSet<&str> = HashSet::new();
    for remote in tasks {
        // A task listed twice (pages that shifted under the read) is one task.
        if !seen.insert(remote.id.as_str()) {
            continue;
        }
        let Some(local) = known.get(&remote.id) else {
            // Made here, with its answer lost: it is ours, not a new one.
            if let Some(id) = remote.marker.as_deref().and_then(|marker| new_here.get(marker)) {
                tx.execute(
                    "UPDATE tasks SET remote_href = ?2, remote_etag = ?3, remote_ics = ?4 WHERE id = ?1",
                    params![id, remote.id, remote.change_key, snapshot(&remote.fields)],
                )?;
                continue;
            }
            insert_server_copy(tx, list_id, remote, now)?;
            report.pulled += 1;
            continue;
        };
        if !remote.change_key.is_empty() && remote.change_key == local.etag {
            continue;
        }
        if local.pending.is_empty() {
            take_server_copy(tx, local.id, remote, now)?;
            report.pulled += 1;
        } else if local.conflict != "changed" {
            mark_conflict(tx, local.id, "changed")?;
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
        } else if local.conflict != "deleted" {
            mark_conflict(tx, local.id, "deleted")?;
            report.conflicts += 1;
        }
    }
    Ok(())
}

/// Settles a conflict on a task of an Exchange list, as for CalDAV
/// (ADR-0039): "server" takes the copy there now (or removes the task here
/// if it is gone); "mine" queues the local copy against the version there
/// now, or to be made again if it is gone. Answers the task's list.
pub fn resolve_conflict(db: &Mutex<Connection>, client: &EwsClient, id: i64, keep: Keep, now: i64) -> Result<String> {
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
    binding(&lock(db), &list_id)?.context("this list is not kept in an Exchange account")?;
    let current = if href.is_empty() || href.starts_with(NEW) { None } else { client.read_task(&href)? };
    let conn = lock(db);
    match (keep, current) {
        (Keep::Server, Some(remote)) => take_server_copy(&conn, id, &remote, now)?,
        (Keep::Server, None) => {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        }
        (Keep::Mine, Some(remote)) => {
            conn.execute(
                "UPDATE tasks SET remote_ics = ?2, remote_etag = ?3, conflict = '',
                        pending = CASE WHEN pending = '' THEN 'put' ELSE pending END,
                        sync_seq = sync_seq + 1
                  WHERE id = ?1",
                params![id, snapshot(&remote.fields), remote.change_key],
            )?;
        }
        (Keep::Mine, None) if pending == "delete" => {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        }
        (Keep::Mine, None) => {
            // Made again: a new task on the server, with a new id of ours.
            conn.execute(
                "UPDATE tasks SET remote_href = '', remote_etag = '', remote_ics = '', conflict = '', pending = 'put',
                        sync_seq = sync_seq + 1
                  WHERE id = ?1",
                params![id],
            )?;
        }
    }
    Ok(list_id)
}

#[cfg(test)]
mod tests;
