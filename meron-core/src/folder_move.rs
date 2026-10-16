//! Moving a folder under another folder of the same account (ADR-0050).
//!
//! A move is a rename of the folder's hierarchical name: `Work` dropped on
//! `Projects` becomes `Projects/Work` (with the server's own delimiter), and
//! every subfolder follows. IMAP does that with one RENAME, which takes the
//! inferiors along (RFC 3501 6.3.5); the local store renames its own rows;
//! Exchange Web Services moves the folder by id with `MoveFolder`, its names
//! being paths from the top of the mailbox (ADR-0058). Microsoft Graph does
//! not manage folders in this core yet, so its session refuses it and the UI
//! shows the move disabled.
//!
//! The checks run here, on the cached folder list, whatever the caller says:
//! a special-use folder (or one with a special-use folder inside it) never
//! moves, nor does a folder into itself or its own subtree.

use std::sync::Arc;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::engine::Engine;
use crate::store;

/// What a move will do, worked out before anything reaches the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderMovePlan {
    /// The folder being moved, by its wire name.
    pub source: String,
    /// Its wire name after the move.
    pub target: String,
    /// The hierarchy delimiter the new names were built with.
    pub delimiter: String,
    /// Every name that changes, the source first, then its subfolders.
    pub renames: Vec<(String, String)>,
}

fn folder_delimiter(conn: &Connection, account: &str, name: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT delimiter FROM folders WHERE account = ?1 AND name = ?2",
            params![account, name],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .filter(|delimiter| !delimiter.is_empty()))
}

/// Cached folders whose names sit under `name` with `delimiter`, shallowest first.
fn subtree(conn: &Connection, account: &str, name: &str, delimiter: &str) -> Result<Vec<String>> {
    let prefix = format!("{name}{delimiter}");
    let mut stmt = conn.prepare("SELECT name FROM folders WHERE account = ?1 ORDER BY name")?;
    let rows = stmt.query_map(params![account], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let child = row?;
        if child.starts_with(&prefix) {
            out.push(child);
        }
    }
    out.sort_by_key(|child| child.len());
    Ok(out)
}

/// Work out and check a move of `source` under `parent` (`None` for the top
/// level). `fallback_delimiter` is used when neither the folder nor the account
/// has a server-reported delimiter: the local store passes `/`; an IMAP server
/// that reports none keeps a flat namespace and gets an error instead.
pub fn plan_folder_move(
    conn: &Connection,
    account: &str,
    source: &str,
    parent: Option<&str>,
    fallback_delimiter: Option<&str>,
) -> Result<FolderMovePlan, String> {
    let fail = |err: anyhow::Error| err.to_string();
    let source = source.trim();
    let parent = parent.map(str::trim).filter(|p| !p.is_empty());
    if source.is_empty() {
        return Err("Choose a folder to move".to_string());
    }
    if !store::folder_exists(conn, account, source).map_err(fail)? {
        return Err(format!("{source} is not in the synchronized folder list"));
    }
    if store::folder_role(conn, account, source).map_err(fail)? != "folder" {
        return Err(format!("{source} is a special folder and cannot be moved"));
    }
    let delimiter = match folder_delimiter(conn, account, source).map_err(fail)? {
        Some(delimiter) => delimiter,
        None => match store::account_delimiter(conn, account).map_err(fail)? {
            Some(delimiter) => delimiter,
            None => match fallback_delimiter {
                Some(delimiter) => delimiter.to_string(),
                None => return Err("This server keeps all folders at one level, so folders cannot be nested".to_string()),
            },
        },
    };
    let children = subtree(conn, account, source, &delimiter).map_err(fail)?;
    for child in &children {
        if store::folder_role(conn, account, child).map_err(fail)? != "folder" {
            return Err(format!("{child} is a special folder and cannot be moved"));
        }
    }
    if let Some(parent) = parent {
        if !store::folder_exists(conn, account, parent).map_err(fail)? {
            return Err(format!("{parent} is not in the synchronized folder list"));
        }
        if parent == source || parent.starts_with(&format!("{source}{delimiter}")) {
            return Err(format!("{source} cannot be moved into itself or one of its subfolders"));
        }
    }
    let leaf = source.rsplit(delimiter.as_str()).next().unwrap_or(source);
    let target = match parent {
        Some(parent) => format!("{parent}{delimiter}{leaf}"),
        None => leaf.to_string(),
    };
    if target == source {
        return Err(format!("{source} is already there"));
    }
    if store::folder_exists(conn, account, &target).map_err(fail)? {
        return Err(format!("A folder named {target} already exists"));
    }
    let mut renames = vec![(source.to_string(), target.clone())];
    for child in children {
        let rest = &child[source.len()..];
        renames.push((child.clone(), format!("{target}{rest}")));
    }
    Ok(FolderMovePlan { source: source.to_string(), target, delimiter, renames })
}

/// Every table that names one of an account's mail folders, as
/// `(table, account column, folder column)`: what follows a folder when its
/// name changes (ADR-0050, ADR-0058). Cached search hits are not here: they
/// are dropped instead, as a search over the old names.
pub const FOLDER_REFERENCES: &[(&str, &str, &str)] = &[
    ("messages", "account", "folder"),
    ("folder_state", "account", "folder"),
    ("ews_item_ids", "account", "folder"),
    // A conversation snoozed, or a task made from one, stays with its mail.
    ("snoozed_threads", "account", "folder"),
    ("tasks", "account", "folder"),
    // What a rule did, so the record names where the mail is now.
    ("rule_log", "account", "folder"),
    // Automatic archiving's progress (ADR-0054), so a run resumes.
    ("auto_archive_items", "account", "folder"),
    // The local archive's own folders (ADR-0014), renamed by its session.
    ("archive_messages", "account", "folder"),
];

/// Columns named like a folder that are not an account's mail folder, and
/// why: the test that lists every such column checks each is decided.
pub const NOT_MAIL_FOLDERS: &[(&str, &str)] = &[
    // The folder rows themselves, renamed first.
    ("folders", "name"),
    // A search over the old names: dropped, not renamed.
    ("mail_search_hits", "folder"),
    // Where in the local archive a copy went: the archive's own name, which a
    // later rename of the server folder does not move.
    ("auto_archive_items", "local_folder"),
    // Paths on this computer and on a cloud drive.
    ("backup_schedule", "folder"),
    ("cloud_accounts", "folder"),
    // An Exchange move whose answer was lost, kept by the folder's id; its
    // names are settled by the listing that finds it (ADR-0058).
    ("ews_uncertain_moves", "folder_id"),
    // Microsoft Graph folders are kept by their opaque ids, never by name.
    ("graph_delta", "folder_id"),
    ("graph_folders", "search_folder"),
    ("graph_memberships", "folder_id"),
    ("graph_round_links", "folder_id"),
    ("graph_rounds", "folder_id"),
    ("graph_staged_items", "folder_id"),
];

/// Renames `from` to `to` everywhere the account names it, inside the
/// caller's transaction: the folder row, every table of
/// [`FOLDER_REFERENCES`], the account's own rules that file mail there, and
/// its automatic archiving policy. The policy names the same folders after
/// as before, so one confirmed before stays confirmed (ADR-0054). Rules for
/// every account keep their name: it means a folder of each, and changing
/// it for one would break it for the others.
fn rename_references(conn: &Connection, account: &str, from: &str, to: &str, delimiter: &str) -> Result<()> {
    conn.execute(
        "UPDATE folders SET name = ?3, delimiter = COALESCE(NULLIF(delimiter, ''), ?4)
          WHERE account = ?1 AND name = ?2",
        params![account, from, to, delimiter],
    )?;
    for (table, account_column, folder_column) in FOLDER_REFERENCES {
        conn.execute(
            &format!("UPDATE {table} SET {folder_column} = ?3 WHERE {account_column} = ?1 AND {folder_column} = ?2"),
            params![account, from, to],
        )?;
    }
    conn.execute("DELETE FROM mail_search_hits WHERE account = ?1 AND folder = ?2", params![account, from])?;

    let rules: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, definition FROM rules WHERE account = ?1")?;
        let rows = stmt.query_map(params![account], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, definition) in rules {
        let Ok(mut rule) = serde_json::from_str::<Value>(&definition) else { continue };
        let mut changed = false;
        for action in rule.get_mut("actions").and_then(Value::as_array_mut).into_iter().flatten() {
            if action.get("type").and_then(Value::as_str) == Some("moveTo")
                && action.get("folder").and_then(Value::as_str) == Some(from)
            {
                action["folder"] = Value::String(to.to_string());
                changed = true;
            }
        }
        if changed {
            conn.execute("UPDATE rules SET definition = ?2 WHERE id = ?1", params![id, rule.to_string()])?;
        }
    }

    let stored: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT policy, confirmed FROM auto_archive_policies WHERE account = ?1",
            params![account],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((text, confirmed)) = stored
        && let Ok(mut policy) = serde_json::from_str::<crate::auto_archive::Policy>(&text)
        && policy.folders.iter().any(|choice| choice.name == from)
    {
        let was_confirmed =
            confirmed.as_deref() == Some(crate::auto_archive::fingerprint(account, &policy).as_str());
        for choice in policy.folders.iter_mut().filter(|choice| choice.name == from) {
            choice.name = to.to_string();
        }
        let confirmed = if was_confirmed { Some(crate::auto_archive::fingerprint(account, &policy)) } else { confirmed };
        conn.execute(
            "UPDATE auto_archive_policies SET policy = ?2, confirmed = ?3 WHERE account = ?1",
            params![account, serde_json::to_string(&policy)?, confirmed],
        )?;
    }
    Ok(())
}

/// Schema 65 (ADR-0058): folder renames the interface has not heard of yet —
/// the ones a folder listing made, which no move answered with.
/// Also the Exchange accounts whose cache was brought to path names once.
pub const RENAMES_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folder_renames (
  account   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  to_name   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ews_folder_paths (
  account TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS ews_uncertain_moves (
  account   TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_name   TEXT NOT NULL,
  renames   TEXT NOT NULL,
  PRIMARY KEY (account, folder_id)
);";

/// Keeps renames for the interface to carry its favorites, colors, board
/// columns and saved searches across ([`take_renames`]).
pub fn record_renames(conn: &Connection, account: &str, renames: &[(String, String)]) -> Result<()> {
    for (from, to) in renames {
        conn.execute(
            "INSERT INTO folder_renames(account, position, from_name, to_name)
             VALUES(?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM folder_renames WHERE account = ?1), ?2, ?3)",
            params![account, from, to],
        )?;
    }
    Ok(())
}

/// The renames kept for `account`, oldest first, forgotten once read.
pub fn take_renames(conn: &Connection, account: &str) -> Result<Vec<(String, String)>> {
    let tx = conn.unchecked_transaction()?;
    let renames = {
        let mut stmt =
            tx.prepare("SELECT from_name, to_name FROM folder_renames WHERE account = ?1 ORDER BY position")?;
        let rows = stmt.query_map(params![account], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    tx.execute("DELETE FROM folder_renames WHERE account = ?1", params![account])?;
    tx.commit()?;
    Ok(renames)
}

/// The folder renames of a cache brought to new names without a move
/// (ADR-0058), in the caller's transaction: every reference follows, and
/// the renames are kept for the interface.
pub fn adopt_renames(conn: &Connection, account: &str, renames: &[(String, String)], delimiter: &str) -> Result<()> {
    for (from, to) in renames {
        rename_references(conn, account, from, to, delimiter)?;
    }
    record_renames(conn, account, renames)
}

/// Bring the local cache in line with a move the server has made: folder rows,
/// cached messages, sync state, Exchange item ids and everything else that
/// names the folder follow it ([`rename_references`]), and cached search hits
/// that pointed into the old names are dropped. Message UIDs are kept; if the
/// server changed UIDVALIDITY with the rename, the next sync of the folder
/// notices and refetches, as it does for any other change.
pub fn reconcile_folder_move(conn: &Connection, account: &str, plan: &FolderMovePlan, parent: Option<&str>) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (from, to) in &plan.renames {
        rename_references(&tx, account, from, to, &plan.delimiter)?;
    }
    // A local-store parent may have been stored without a delimiter; it has
    // children now, and the tree needs to know how to split them.
    if let Some(parent) = parent.map(str::trim).filter(|p| !p.is_empty()) {
        tx.execute(
            "UPDATE folders SET delimiter = ?3 WHERE account = ?1 AND name = ?2
               AND (delimiter IS NULL OR delimiter = '')",
            params![account, parent, plan.delimiter],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// `folders.move`: check, rename on the server, reconcile the cache, and
/// answer with the new folder list and every rename, so the caller can carry
/// favorites, colors and open views across to the new names.
pub async fn move_folder(engine: &Arc<Engine>, params: &Value) -> Result<Value> {
    let account = params
        .get("account")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow::anyhow!("account is required"))?
        .to_string();
    let source = params
        .get("folder")
        .and_then(Value::as_str)
        .map(crate::mail_model::canon_folder)
        .ok_or_else(|| anyhow::anyhow!("folder is required"))?;
    let parent = params
        .get("parent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(crate::mail_model::canon_folder);

    let creds = engine.ensure_valid_creds(&account).await?;
    if creds.is_graph() {
        anyhow::bail!("Moving folders is not supported on this account yet");
    }
    let fallback = creds.is_local_store().then_some("/");
    let plan = plan_folder_move(&engine.db.lock().unwrap(), &account, &source, parent.as_deref(), fallback)
        .map_err(anyhow::Error::msg)?;

    engine
        .with_preflighted_write_session(
            &account,
            |session| Box::pin(session.prepare_folder_delete()),
            |session| {
                let plan = plan.clone();
                Box::pin(async move { session.rename_folder(&plan.source, &plan.target, &plan.renames).await })
            },
        )
        .await?;

    let folders = {
        let db = engine.db.lock().unwrap();
        reconcile_folder_move(&db, &account, &plan, parent.as_deref())?;
        store::get_folders(&db, &account)?
    };
    Ok(json!({
        "ok": true,
        "folder": plan.target,
        "renames": plan.renames.iter().map(|(from, to)| json!({ "from": from, "to": to })).collect::<Vec<_>>(),
        "folders": serde_json::to_value(folders)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::Folder;

    const ACCOUNT: &str = "me@example.com";

    fn folder(name: &str, delimiter: Option<&str>, special_use: Option<&str>) -> Folder {
        Folder {
            name: name.to_string(),
            delimiter: delimiter.map(str::to_string),
            special_use: special_use.map(str::to_string),
            ..Default::default()
        }
    }

    fn db(folders: &[Folder]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::run_migrations(&conn).unwrap();
        store::upsert_folders(&conn, ACCOUNT, folders).unwrap();
        conn
    }

    fn tree() -> Connection {
        db(&[
            folder("INBOX", Some("/"), None),
            folder("Sent", Some("/"), Some("sent")),
            folder("Work", Some("/"), None),
            folder("Work/2026", Some("/"), None),
            folder("Work/2026/Q1", Some("/"), None),
            folder("Workshop", Some("/"), None),
            folder("Projects", Some("/"), None),
            folder("Mail", Some("/"), None),
            folder("Mail/Archive", Some("/"), Some("archive")),
        ])
    }

    #[test]
    fn a_move_renames_the_folder_and_its_whole_subtree() {
        let conn = tree();
        let plan = plan_folder_move(&conn, ACCOUNT, "Work", Some("Projects"), None).unwrap();
        assert_eq!(plan.target, "Projects/Work");
        assert_eq!(
            plan.renames,
            vec![
                ("Work".to_string(), "Projects/Work".to_string()),
                ("Work/2026".to_string(), "Projects/Work/2026".to_string()),
                ("Work/2026/Q1".to_string(), "Projects/Work/2026/Q1".to_string()),
            ],
            "a sibling that only shares the prefix (Workshop) stays put"
        );
        // Back to the top level keeps only the last segment.
        let up = plan_folder_move(&conn, ACCOUNT, "Work/2026", None, None).unwrap();
        assert_eq!(up.target, "2026");
        assert_eq!(up.renames[1], ("Work/2026/Q1".to_string(), "2026/Q1".to_string()));
    }

    #[test]
    fn special_use_folders_never_move_nor_folders_holding_one() {
        let conn = tree();
        for source in ["INBOX", "Sent"] {
            let err = plan_folder_move(&conn, ACCOUNT, source, Some("Projects"), None).unwrap_err();
            assert!(err.contains("special folder"), "{source}: {err}");
        }
        let err = plan_folder_move(&conn, ACCOUNT, "Mail", Some("Projects"), None).unwrap_err();
        assert!(err.contains("Mail/Archive is a special folder"), "{err}");
    }

    #[test]
    fn a_folder_cannot_go_into_itself_or_its_subtree() {
        let conn = tree();
        for parent in ["Work", "Work/2026", "Work/2026/Q1"] {
            let err = plan_folder_move(&conn, ACCOUNT, "Work", Some(parent), None).unwrap_err();
            assert!(err.contains("into itself"), "{parent}: {err}");
        }
        // A name that merely starts the same is not inside it.
        assert!(plan_folder_move(&conn, ACCOUNT, "Work", Some("Workshop"), None).is_ok());
    }

    #[test]
    fn unknown_names_collisions_and_no_ops_are_refused() {
        let conn = tree();
        assert!(plan_folder_move(&conn, ACCOUNT, "Nope", None, None).unwrap_err().contains("synchronized"));
        assert!(plan_folder_move(&conn, ACCOUNT, "Work", Some("Nope"), None).unwrap_err().contains("synchronized"));
        assert!(plan_folder_move(&conn, ACCOUNT, "Work", None, None).unwrap_err().contains("already there"));
        store::upsert_folders(&conn, ACCOUNT, &[folder("Projects/Work", Some("/"), None)]).unwrap();
        assert!(plan_folder_move(&conn, ACCOUNT, "Work", Some("Projects"), None).unwrap_err().contains("already exists"));
    }

    #[test]
    fn the_server_delimiter_builds_the_new_names() {
        let conn = db(&[
            folder("INBOX", Some("."), None),
            folder("INBOX.Work", Some("."), None),
            folder("INBOX.Work.Old", Some("."), None),
            folder("INBOX.Clients", Some("."), None),
        ]);
        let plan = plan_folder_move(&conn, ACCOUNT, "INBOX.Work", Some("INBOX.Clients"), None).unwrap();
        assert_eq!(plan.target, "INBOX.Clients.Work");
        assert_eq!(plan.renames[1].1, "INBOX.Clients.Work.Old");
        // A flat server has nowhere to nest; the local store nests with "/".
        let flat = db(&[folder("A", None, None), folder("B", None, None)]);
        assert!(plan_folder_move(&flat, ACCOUNT, "A", Some("B"), None).unwrap_err().contains("one level"));
        assert_eq!(plan_folder_move(&flat, ACCOUNT, "A", Some("B"), Some("/")).unwrap().target, "B/A");
    }

    #[test]
    fn the_cache_follows_the_move() {
        let conn = tree();
        conn.execute(
            "INSERT INTO messages(account, folder, msg_id, uid, seen) VALUES(?1, 'Work/2026', '7', 7, 0)",
            params![ACCOUNT],
        )
        .unwrap();
        store::set_folder_state(&conn, ACCOUNT, "Work", 42, 9).unwrap();
        conn.execute(
            "INSERT INTO mail_search_hits(token, account, query, scope, position, folder, uid, created_at)
             VALUES('t', ?1, 'q', 's', 0, 'Work', 1, 0)",
            params![ACCOUNT],
        )
        .unwrap();
        let plan = plan_folder_move(&conn, ACCOUNT, "Work", Some("Projects"), None).unwrap();
        reconcile_folder_move(&conn, ACCOUNT, &plan, Some("Projects")).unwrap();

        let names: Vec<String> = store::get_folders(&conn, ACCOUNT).unwrap().into_iter().map(|f| f.name).collect();
        assert!(names.contains(&"Projects/Work/2026/Q1".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n == "Work" || n.starts_with("Work/")), "{names:?}");
        let unread = store::get_folder_unread(&conn, ACCOUNT, "Projects/Work/2026").unwrap();
        assert_eq!(unread, 1, "cached messages follow their folder");
        let state: i64 = conn
            .query_row(
                "SELECT uidvalidity FROM folder_state WHERE account = ?1 AND folder = 'Projects/Work'",
                params![ACCOUNT],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, 42);
        let hits: i64 = conn.query_row("SELECT COUNT(*) FROM mail_search_hits", [], |row| row.get(0)).unwrap();
        assert_eq!(hits, 0, "search hits into the old names are dropped");
    }

    #[test]
    fn every_column_naming_a_folder_follows_a_rename_or_is_decided_otherwise() {
        let conn = db(&[]);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut undecided = Vec::new();
        for table in tables {
            let columns: Vec<String> = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get(1))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            for column in columns.iter().filter(|column| column.contains("folder") || (table == "folders" && *column == "name")) {
                let decided = FOLDER_REFERENCES.iter().any(|(t, _, c)| *t == table && c == column)
                    || NOT_MAIL_FOLDERS.iter().any(|(t, c)| *t == table && c == column);
                if !decided {
                    undecided.push(format!("{table}.{column}"));
                }
            }
        }
        assert!(undecided.is_empty(), "decide whether these follow a renamed folder (ADR-0058): {undecided:?}");
    }

    #[test]
    fn everything_naming_a_folder_follows_it_and_nothing_of_another_account() {
        use crate::auto_archive::{fingerprint, FolderChoice, Policy};
        let conn = tree();
        let policy = Policy { folders: vec![FolderChoice { name: "Work".into(), older_than: None }], ..Default::default() };
        for account in [ACCOUNT, "other@example.com"] {
            conn.execute("INSERT INTO snoozed_threads(account, thread_key, folder, until) VALUES(?1, 't', 'Work', 1)", params![account]).unwrap();
            conn.execute(
                "INSERT INTO tasks(account, thread_key, folder, note, created_at) VALUES(?1, 't', 'Work', '', 1)",
                params![account],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rule_log(at, account, rule_id, rule_name, folder, uid, subject, from_addr, action, outcome)
                 VALUES(1, ?1, 'r', 'R', 'Work', 1, '', '', 'markRead', 'ok')",
                params![account],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO auto_archive_items(account, folder, uid, message_id, local_folder, local_uid, state, updated_at)
                 VALUES(?1, 'Work', 1, '<m>', 'Archived/x/Work', 0, 'copied', 1)",
                params![account],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO auto_archive_policies(account, policy, confirmed) VALUES(?1, ?2, ?3)",
                params![account, serde_json::to_string(&policy).unwrap(), fingerprint(account, &policy)],
            )
            .unwrap();
        }
        let rule = |id: &str, account: &str| {
            json!({ "id": id, "account": account, "name": id, "enabled": true, "conditions": [],
                    "actions": [{ "type": "moveTo", "folder": "Work" }, { "type": "markRead" }] })
            .to_string()
        };
        crate::store::replace_rules(
            &conn,
            &[
                ("mine".into(), ACCOUNT.into(), true, rule("mine", ACCOUNT)),
                ("every".into(), String::new(), true, rule("every", "")),
            ],
        )
        .unwrap();

        let plan = plan_folder_move(&conn, ACCOUNT, "Work", Some("Projects"), None).unwrap();
        reconcile_folder_move(&conn, ACCOUNT, &plan, Some("Projects")).unwrap();

        let folder_of = |table: &str, account: &str| -> String {
            conn.query_row(&format!("SELECT folder FROM {table} WHERE account = ?1"), params![account], |row| row.get(0))
                .unwrap()
        };
        for table in ["snoozed_threads", "tasks", "rule_log", "auto_archive_items"] {
            assert_eq!(folder_of(table, ACCOUNT), "Projects/Work", "{table}");
            assert_eq!(folder_of(table, "other@example.com"), "Work", "{table} of another account");
        }
        let local: String = conn.query_row("SELECT local_folder FROM auto_archive_items WHERE account = ?1", params![ACCOUNT], |row| row.get(0)).unwrap();
        assert_eq!(local, "Archived/x/Work", "the archive's own copy stays where it went");
        let rules = crate::store::rules(&conn).unwrap();
        assert!(rules[0].contains("\"folder\":\"Projects/Work\""), "{}", rules[0]);
        assert!(rules[1].contains("\"folder\":\"Work\""), "a rule for every account keeps its name: {}", rules[1]);
        let stored = crate::auto_archive::load(&conn, ACCOUNT).unwrap();
        assert_eq!(stored.policy.folders[0].name, "Projects/Work");
        assert!(crate::auto_archive::is_confirmed(ACCOUNT, &stored), "the same policy stays confirmed");
        let other = crate::auto_archive::load(&conn, "other@example.com").unwrap();
        assert_eq!(other.policy.folders[0].name, "Work");
    }

    #[test]
    fn renames_kept_for_the_interface_are_read_once_per_account() {
        let conn = tree();
        let tx = conn.unchecked_transaction().unwrap();
        adopt_renames(&tx, ACCOUNT, &[("Work".into(), "Projects/Work".into())], "/").unwrap();
        record_renames(&tx, "other@example.com", &[("A".into(), "B/A".into())]).unwrap();
        tx.commit().unwrap();
        assert!(store::folder_exists(&conn, ACCOUNT, "Projects/Work").unwrap());
        assert_eq!(take_renames(&conn, ACCOUNT).unwrap(), [("Work".to_string(), "Projects/Work".to_string())]);
        assert!(take_renames(&conn, ACCOUNT).unwrap().is_empty(), "read once");
        assert_eq!(take_renames(&conn, "other@example.com").unwrap().len(), 1);
    }

    #[test]
    fn a_local_parent_without_a_delimiter_learns_one() {
        let conn = db(&[folder("A", None, None), folder("B", None, None)]);
        let plan = plan_folder_move(&conn, ACCOUNT, "A", Some("B"), Some("/")).unwrap();
        reconcile_folder_move(&conn, ACCOUNT, &plan, Some("B")).unwrap();
        let folders = store::get_folders(&conn, ACCOUNT).unwrap();
        for folder in &folders {
            assert_eq!(folder.delimiter.as_deref(), Some("/"), "{}", folder.name);
        }
        assert_eq!(folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["B", "B/A"]);
    }
}
