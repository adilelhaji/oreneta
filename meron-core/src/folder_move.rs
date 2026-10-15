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

/// Bring the local cache in line with a move the server has made: folder rows,
/// cached messages, sync state and Exchange item ids follow their folder, and
/// cached search hits that pointed into the old names are dropped. Message
/// UIDs are kept; if the server changed UIDVALIDITY with the rename, the next
/// sync of the folder notices and refetches, as it does for any other change.
pub fn reconcile_folder_move(conn: &Connection, account: &str, plan: &FolderMovePlan, parent: Option<&str>) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (from, to) in &plan.renames {
        tx.execute(
            "UPDATE folders SET name = ?3, delimiter = COALESCE(NULLIF(delimiter, ''), ?4)
              WHERE account = ?1 AND name = ?2",
            params![account, from, to, plan.delimiter],
        )?;
        for table in ["messages", "folder_state", "ews_item_ids"] {
            tx.execute(
                &format!("UPDATE {table} SET folder = ?3 WHERE account = ?1 AND folder = ?2"),
                params![account, from, to],
            )?;
        }
        tx.execute(
            "DELETE FROM mail_search_hits WHERE account = ?1 AND folder = ?2",
            params![account, from],
        )?;
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
