//! Folder paths and moves on Exchange (ADR-0058), on recorded SOAP.

use super::super::*;
use super::scripted::{envelope, error_response, serve, Step};
use super::{distinguished_response, test_db};

/// One generic folder of a hierarchy round.
fn folder(id: &str, parent: &str, name: &str, class: Option<&str>) -> String {
    let class = class.map(|class| format!("<t:FolderClass>{class}</t:FolderClass>")).unwrap_or_default();
    format!(
        r#"<t:Create><t:Folder><t:FolderId Id="{id}" ChangeKey="CK-{id}"/><t:ParentFolderId Id="{parent}"/>{class}<t:DisplayName>{name}</t:DisplayName><t:UnreadCount>0</t:UnreadCount></t:Folder></t:Create>"#
    )
}

/// A from-scratch hierarchy round listing `folders`.
fn hierarchy(folders: &[String]) -> String {
    envelope(&format!(
        r#"<m:SyncFolderHierarchyResponse><m:ResponseMessages><m:SyncFolderHierarchyResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:SyncState>c3RhdGU=</m:SyncState><m:IncludesLastFolderInRange>true</m:IncludesLastFolderInRange><m:Changes>{}</m:Changes></m:SyncFolderHierarchyResponseMessage></m:ResponseMessages></m:SyncFolderHierarchyResponse>"#,
        folders.concat()
    ))
}

/// The mailbox of these tests: the inbox with a subfolder, Sent, a project
/// tree two deep, a name with a slash in it, and a housekeeping folder with a
/// mail folder under it.
fn mailbox() -> Vec<String> {
    vec![
        folder("AAMkINBOX=", "ROOT", "Inbox", Some("IPF.Note")),
        folder("AAMkCLIENTS=", "AAMkINBOX=", "Clients", Some("IPF.Note")),
        folder("AAMkSENT=", "ROOT", "Sent Items", Some("IPF.Note")),
        folder("AAMkPROJ=", "ROOT", "Projects", Some("IPF.Note")),
        folder("AAMkWORK=", "ROOT", "Work", Some("IPF.Note")),
        folder("AAMk2026=", "AAMkWORK=", "2026", Some("IPF.Note")),
        folder("AAMkSLASH=", "ROOT", "Q1/Q2", Some("IPF.Note")),
        folder("AAMkSYNC=", "ROOT", "Sync Issues", Some("IPF.Configuration")),
        folder("AAMkCONF=", "AAMkSYNC=", "Conflicts", None),
    ]
}

fn moved_ok() -> String {
    envelope(
        r#"<m:MoveFolderResponse><m:ResponseMessages><m:MoveFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="AAMkWORK=" ChangeKey="CK-NEW"/></t:Folder></m:Folders></m:MoveFolderResponseMessage></m:ResponseMessages></m:MoveFolderResponse>"#,
    )
}

fn session(url: String, db: super::TestDb, account: &str) -> EwsSession {
    EwsSession::new(
        EwsConfig {
            url,
            username: "u".to_string(),
            password: "p".to_string(),
            target_mailbox: String::new(),
            proxy: crate::proxy::ProxyChoice::Direct,
        },
        account,
        db,
    )
}

fn names(folders: &[crate::imap::Folder]) -> Vec<String> {
    let mut names: Vec<String> = folders.iter().map(|folder| folder.name.clone()).collect();
    names.sort();
    names
}

#[tokio::test]
async fn ews_folders_are_named_by_their_path_from_the_top_of_the_mailbox() {
    let (url, server) = serve(vec![Step::Reply(hierarchy(&mailbox())), Step::Reply(distinguished_response())]);
    let mut session = session(url, test_db(), "acct");
    let folders = session.list_folders().await.expect("listing");
    assert_eq!(
        names(&folders),
        vec!["INBOX", "INBOX/Clients", "Projects", "Q1\u{2215}Q2", "Sent Items", "Sync Issues/Conflicts", "Work", "Work/2026"],
        "subfolders sit under their parents; a slash inside a name is not a level; housekeeping parents still place their children"
    );
    let clients = folders.iter().find(|folder| folder.name == "INBOX/Clients").unwrap();
    assert_eq!(clients.display_name, "Inbox/Clients", "the inbox keeps its own name on display");
    assert_eq!(clients.delimiter.as_deref(), Some("/"));
    assert_eq!(session.folders.get("Work/2026").map(|id| id.0.as_str()), Some("AAMk2026="));
    server.join().expect("server");
}

#[test]
fn a_parent_chain_that_loops_is_cut_instead_of_followed() {
    let listed = |id: &str, parent: &str, name: &str| ListedFolder {
        id: ::ews::FolderId { id: id.to_string(), change_key: None },
        parent: Some(parent.to_string()),
        name: name.to_string(),
        mail: true,
        unread: 0,
        role: None,
    };
    let paths = folder_paths(&[listed("A", "B", "a"), listed("B", "A", "b"), listed("C", "ROOT", "c")]);
    assert_eq!(paths["A"].0, "b/a");
    assert_eq!(paths["B"].0, "a/b");
    assert_eq!(paths["C"].0, "c");
}

#[tokio::test]
async fn a_cache_kept_under_a_flat_name_follows_its_folder_to_its_path() {
    let db = test_db();
    {
        let conn = db.lock().unwrap();
        // Before ADR-0058: Inbox/Clients was "Clients", Work/2026 was "2026".
        // Another account has a "Clients" of its own, which must not move.
        for (account, name) in [("acct", "Clients"), ("acct", "2026"), ("acct", "INBOX"), ("other", "Clients")] {
            crate::store::upsert_folders(
                &conn,
                account,
                &[crate::imap::Folder { name: name.to_string(), delimiter: Some("/".into()), ..Default::default() }],
            )
            .unwrap();
            crate::store::set_folder_sync_state(&conn, account, name, &format!("state-{name}")).unwrap();
            crate::store::map_ews_item(&conn, account, name, &format!("item-{name}"), None).unwrap();
            conn.execute(
                "INSERT INTO messages(account, folder, msg_id, uid, seen) VALUES(?1, ?2, ?3, 1, 0)",
                rusqlite::params![account, name, format!("<{name}@x>")],
            )
            .unwrap();
        }
    }
    let (url, server) = serve(vec![Step::Reply(hierarchy(&mailbox())), Step::Reply(distinguished_response())]);
    let mut session = session(url, db.clone(), "acct");
    session.list_folders().await.expect("listing");
    server.join().expect("server");

    let conn = db.lock().unwrap();
    let state = |account: &str, folder: &str| crate::store::get_folder_sync_state(&conn, account, folder).unwrap();
    assert_eq!(state("acct", "INBOX/Clients").as_deref(), Some("state-Clients"), "the sync state follows, so nothing is read again");
    assert_eq!(state("acct", "Work/2026").as_deref(), Some("state-2026"));
    assert_eq!(state("acct", "Clients"), None, "nothing is left under the old name");
    assert_eq!(state("acct", "INBOX").as_deref(), Some("state-INBOX"), "a top-level folder keeps its name and cache");
    assert_eq!(state("other", "Clients").as_deref(), Some("state-Clients"), "another account is not touched");
    assert_eq!(crate::store::ews_item_for_uid(&conn, "acct", "INBOX/Clients", 1).unwrap().map(|item| item.0), Some("item-Clients".to_string()));
    assert_eq!(crate::store::get_folder_unread(&conn, "acct", "INBOX/Clients").unwrap(), 1, "cached messages follow");
    assert!(!crate::store::folder_exists(&conn, "acct", "Clients").unwrap());
    // What else names the folder follows it, and the interface hears of it.
    let mut renames = crate::folder_move::take_renames(&conn, "acct").unwrap();
    renames.sort();
    assert_eq!(
        renames,
        [("2026".to_string(), "Work/2026".to_string()), ("Clients".to_string(), "INBOX/Clients".to_string())]
    );
    assert!(crate::folder_move::take_renames(&conn, "other").unwrap().is_empty());
}

#[tokio::test]
async fn a_flat_name_adopted_takes_tasks_snoozes_and_rules_with_it_and_tells_the_interface() {
    let db = test_db();
    {
        let conn = db.lock().unwrap();
        crate::store::upsert_folders(&conn, "acct", &[crate::imap::Folder { name: "Clients".into(), ..Default::default() }]).unwrap();
        conn.execute("INSERT INTO snoozed_threads(account, thread_key, folder, until) VALUES('acct', 't', 'Clients', 1)", []).unwrap();
        conn.execute("INSERT INTO tasks(account, thread_key, folder, note, created_at) VALUES('acct', 't', 'Clients', '', 1)", []).unwrap();
        let rule = serde_json::json!({ "id": "r", "account": "acct", "name": "r", "enabled": true, "conditions": [],
                                        "actions": [{ "type": "moveTo", "folder": "Clients" }] });
        crate::store::replace_rules(&conn, &[("r".into(), "acct".into(), true, rule.to_string())]).unwrap();
    }
    let (url, server) = serve(vec![Step::Reply(hierarchy(&mailbox())), Step::Reply(distinguished_response())]);
    session(url, db.clone(), "acct").list_folders().await.expect("listing");
    server.join().expect("server");
    let conn = db.lock().unwrap();
    for table in ["snoozed_threads", "tasks"] {
        let folder: String = conn.query_row(&format!("SELECT folder FROM {table}"), [], |row| row.get(0)).unwrap();
        assert_eq!(folder, "INBOX/Clients", "{table}");
    }
    assert!(crate::store::rules(&conn).unwrap()[0].contains("INBOX/Clients"));
    assert_eq!(
        crate::folder_move::take_renames(&conn, "acct").unwrap(),
        [("Clients".to_string(), "INBOX/Clients".to_string())]
    );
}

#[test]
fn a_flat_name_a_top_level_folder_still_has_is_dropped_once_when_another_shared_it() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    crate::store::upsert_folders(&conn, "acct", &[crate::imap::Folder { name: "Archive".into(), ..Default::default() }]).unwrap();
    crate::store::set_folder_sync_state(&conn, "acct", "Archive", "mixed").unwrap();
    let pairs = [("Archive".to_string(), "Archive".to_string()), ("Archive".to_string(), "INBOX/Archive".to_string())];
    adopt_flat_folder_names(&conn, "acct", &pairs).unwrap();
    assert_eq!(crate::store::get_folder_sync_state(&conn, "acct", "Archive").unwrap(), None, "the mixed cache is read again");
    assert!(crate::folder_move::take_renames(&conn, "acct").unwrap().is_empty(), "nothing was renamed");
    // Once both are read under their own names, nothing happens any more.
    crate::store::upsert_folders(
        &conn,
        "acct",
        &[
            crate::imap::Folder { name: "Archive".into(), ..Default::default() },
            crate::imap::Folder { name: "INBOX/Archive".into(), ..Default::default() },
        ],
    )
    .unwrap();
    crate::store::set_folder_sync_state(&conn, "acct", "Archive", "its own").unwrap();
    adopt_flat_folder_names(&conn, "acct", &pairs).unwrap();
    assert_eq!(crate::store::get_folder_sync_state(&conn, "acct", "Archive").unwrap().as_deref(), Some("its own"));
}

#[tokio::test]
async fn a_sync_state_the_server_refuses_starts_the_folder_again_once() {
    let db = test_db();
    crate::store::set_folder_sync_state(&db.lock().unwrap(), "acct", "INBOX", "c3RhbGU=").unwrap();
    let (url, server) = serve(vec![
        Step::Reply(error_response("SyncFolderItems", "ErrorInvalidSyncStateData", "The sync state is invalid.")),
        Step::Reply(super::THREE_ITEM_SYNC_RESPONSE.to_string()),
        Step::Reply(super::ok_response("GetItem", "<m:Items/>")),
    ]);
    let mut session = session(url, db.clone(), "acct");
    session.folders.insert("INBOX".to_string(), ("AAMkINBOX=".to_string(), None));
    session.fetch_recent("INBOX", 5).await.expect("synced again");
    let requests = server.join().expect("server");
    assert!(requests[0].contains("c3RhbGU="), "{}", requests[0]);
    assert!(!requests[1].contains("c3RhbGU="), "started again with no state: {}", requests[1]);
    assert_eq!(crate::store::get_folder_sync_state(&db.lock().unwrap(), "acct", "INBOX").unwrap().as_deref(), Some("c3RhdGU="));
}

#[test]
fn a_flat_name_two_folders_shared_is_dropped_and_read_again() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    crate::store::upsert_folders(&conn, "acct", &[crate::imap::Folder { name: "Old".into(), ..Default::default() }]).unwrap();
    crate::store::set_folder_sync_state(&conn, "acct", "Old", "mixed").unwrap();
    adopt_flat_folder_names(
        &conn,
        "acct",
        &[("Old".to_string(), "A/Old".to_string()), ("Old".to_string(), "B/Old".to_string())],
    )
    .unwrap();
    assert!(!crate::store::folder_exists(&conn, "acct", "Old").unwrap());
    assert_eq!(crate::store::get_folder_sync_state(&conn, "acct", "A/Old").unwrap(), None);
    assert_eq!(crate::store::get_folder_sync_state(&conn, "acct", "B/Old").unwrap(), None);
    // A second listing has nothing left to adopt.
    adopt_flat_folder_names(&conn, "acct", &[("Old".to_string(), "A/Old".to_string())]).unwrap();
}

/// What `folders.move` does for an Exchange account, short of the engine:
/// plan on the cached list, move on the server, reconcile the cache.
async fn move_like_the_engine(
    session: &mut EwsSession,
    db: &super::TestDb,
    source: &str,
    parent: Option<&str>,
) -> anyhow::Result<crate::folder_move::FolderMovePlan> {
    let plan = crate::folder_move::plan_folder_move(&db.lock().unwrap(), "acct", source, parent, None)
        .map_err(anyhow::Error::msg)?;
    session.move_folder(&plan.source, &plan.target, &plan.renames).await?;
    crate::folder_move::reconcile_folder_move(&db.lock().unwrap(), "acct", &plan, parent)?;
    Ok(plan)
}

/// A store holding the cached list of [`mailbox`], as a folder sync leaves it.
async fn synced_store() -> super::TestDb {
    let db = test_db();
    let (url, server) = serve(vec![Step::Reply(hierarchy(&mailbox())), Step::Reply(distinguished_response())]);
    let folders = session(url, db.clone(), "acct").list_folders().await.expect("listing");
    server.join().expect("server");
    crate::store::upsert_folders(&db.lock().unwrap(), "acct", &folders).unwrap();
    db
}

#[tokio::test]
async fn ews_folder_move_success_moves_the_folder_and_its_cache_under_the_new_parent() {
    let db = synced_store().await;
    crate::store::set_folder_sync_state(&db.lock().unwrap(), "acct", "Work/2026", "kept").unwrap();
    let (url, server) = serve(vec![
        Step::Reply(hierarchy(&mailbox())),
        Step::Reply(distinguished_response()),
        Step::Reply(moved_ok()),
    ]);
    let mut session = session(url, db.clone(), "acct");
    let plan = move_like_the_engine(&mut session, &db, "Work", Some("Projects")).await.expect("move");
    assert_eq!(
        plan.renames,
        vec![
            ("Work".to_string(), "Projects/Work".to_string()),
            ("Work/2026".to_string(), "Projects/Work/2026".to_string())
        ]
    );
    let requests = server.join().expect("server");
    assert_eq!(requests.len(), 3, "a fresh listing, then one move");
    let request = &requests[2];
    assert!(request.contains("<MoveFolder"), "{request}");
    assert!(request.contains(r#"<ToFolderId><t:FolderId Id="AAMkPROJ=""#), "under Projects: {request}");
    assert!(request.contains(r#"<FolderIds><t:FolderId Id="AAMkWORK=""#), "Work itself: {request}");
    let conn = db.lock().unwrap();
    assert_eq!(crate::store::get_folder_sync_state(&conn, "acct", "Projects/Work/2026").unwrap().as_deref(), Some("kept"));
    assert!(!crate::store::folder_exists(&conn, "acct", "Work").unwrap());
}

#[tokio::test]
async fn ews_folder_move_to_the_top_level_names_the_mailbox_root() {
    let db = synced_store().await;
    let (url, server) = serve(vec![
        Step::Reply(hierarchy(&mailbox())),
        Step::Reply(distinguished_response()),
        Step::Reply(moved_ok()),
    ]);
    let mut session = session(url, db.clone(), "acct");
    let plan = move_like_the_engine(&mut session, &db, "Work/2026", None).await.expect("move");
    assert_eq!(plan.target, "2026");
    let requests = server.join().expect("server");
    assert!(
        requests[2].contains(r#"<ToFolderId><t:DistinguishedFolderId Id="msgfolderroot""#),
        "{}",
        requests[2]
    );
}

#[tokio::test]
async fn ews_folder_move_refuses_when_the_server_changed_since_the_cache_was_read() {
    let db = synced_store().await;
    // Since the cached list: Work was renamed to "Work old" in another client,
    // and Projects got a folder called Work of its own.
    let mut changed = mailbox();
    changed[4] = folder("AAMkWORK=", "ROOT", "Work old", Some("IPF.Note"));
    let (url, server) = serve(vec![Step::Reply(hierarchy(&changed)), Step::Reply(distinguished_response())]);
    let mut session = session(url, db.clone(), "acct");
    let error = move_like_the_engine(&mut session, &db, "Work", Some("Projects")).await.expect_err("stale");
    assert!(error.to_string().contains("changed on the server"), "{error}");
    assert_eq!(server.join().expect("server").len(), 2, "nothing was moved");

    let mut taken = mailbox();
    taken.push(folder("AAMkOTHER=", "AAMkPROJ=", "Work", Some("IPF.Note")));
    let (url, server) = serve(vec![Step::Reply(hierarchy(&taken)), Step::Reply(distinguished_response())]);
    let mut session = super::folder_moves::session(url, db.clone(), "acct");
    let error = move_like_the_engine(&mut session, &db, "Work", Some("Projects")).await.expect_err("taken");
    assert!(error.to_string().contains("already exists on the server"), "{error}");
    assert_eq!(server.join().expect("server").len(), 2, "nothing was moved");
    let conn = db.lock().unwrap();
    assert!(crate::store::folder_exists(&conn, "acct", "Work").unwrap(), "the cache is as it was");
}

#[tokio::test]
async fn ews_folder_move_refusal_by_the_server_changes_nothing_here() {
    let db = synced_store().await;
    let (url, server) = serve(vec![
        Step::Reply(hierarchy(&mailbox())),
        Step::Reply(distinguished_response()),
        Step::Reply(error_response("MoveFolder", "ErrorMoveCopyFailed", "The move failed.")),
    ]);
    let mut session = session(url, db.clone(), "acct");
    let error = move_like_the_engine(&mut session, &db, "Work", Some("Projects")).await.expect_err("refused");
    assert!(format!("{error:#}").contains("ErrorMoveCopyFailed"), "{error:#}");
    server.join().expect("server");
    let conn = db.lock().unwrap();
    assert!(crate::store::folder_exists(&conn, "acct", "Work").unwrap());
    assert!(!crate::store::folder_exists(&conn, "acct", "Projects/Work").unwrap());
}

#[tokio::test]
async fn ews_folder_move_with_a_lost_answer_is_not_repeated_and_the_next_listing_tells() {
    let db = synced_store().await;
    {
        let conn = db.lock().unwrap();
        crate::store::set_folder_sync_state(&conn, "acct", "Work/2026", "kept").unwrap();
        conn.execute("INSERT INTO snoozed_threads(account, thread_key, folder, until) VALUES('acct', 't', 'Work', 1)", []).unwrap();
    }
    let mut after = mailbox();
    after[4] = folder("AAMkWORK=", "AAMkPROJ=", "Work", Some("IPF.Note"));
    after[5] = folder("AAMk2026=", "AAMkWORK=", "2026", Some("IPF.Note"));
    let (url, server) = serve(vec![
        Step::Reply(hierarchy(&mailbox())),
        Step::Reply(distinguished_response()),
        Step::Drop,
        Step::Reply(hierarchy(&after)),
        Step::Reply(distinguished_response()),
    ]);
    let mut session = session(url, db.clone(), "acct");
    move_like_the_engine(&mut session, &db, "Work", Some("Projects")).await.expect_err("no answer");
    // The session forgot its listing, so the next one asks the server.
    let folders = session.list_folders().await.expect("next listing");
    assert!(names(&folders).contains(&"Projects/Work/2026".to_string()), "{:?}", names(&folders));
    let requests = server.join().expect("server");
    assert_eq!(requests.iter().filter(|request| request.contains("<MoveFolder")).count(), 1, "never sent twice");
    // The folder was found by its id at its new path: what was kept under
    // the old names followed it, as after a move answered.
    let conn = db.lock().unwrap();
    assert!(!crate::store::folder_exists(&conn, "acct", "Work").unwrap(), "no stale row beside the new one");
    assert_eq!(crate::store::get_folder_sync_state(&conn, "acct", "Projects/Work/2026").unwrap().as_deref(), Some("kept"));
    let snoozed: String = conn.query_row("SELECT folder FROM snoozed_threads", [], |row| row.get(0)).unwrap();
    assert_eq!(snoozed, "Projects/Work");
    let mut renames = crate::folder_move::take_renames(&conn, "acct").unwrap();
    renames.sort();
    assert_eq!(
        renames,
        [
            ("Work".to_string(), "Projects/Work".to_string()),
            ("Work/2026".to_string(), "Projects/Work/2026".to_string())
        ],
        "the interface hears of them"
    );
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM ews_uncertain_moves", [], |row| row.get(0)).unwrap();
    assert_eq!(pending, 0, "settled");
}

#[tokio::test]
async fn ews_folder_move_with_a_lost_answer_that_did_nothing_changes_nothing() {
    let db = synced_store().await;
    let (url, server) = serve(vec![
        Step::Reply(hierarchy(&mailbox())),
        Step::Reply(distinguished_response()),
        Step::Drop,
        // The folder is still where it was: the move never happened.
        Step::Reply(hierarchy(&mailbox())),
        Step::Reply(distinguished_response()),
    ]);
    let mut session = session(url, db.clone(), "acct");
    move_like_the_engine(&mut session, &db, "Work", Some("Projects")).await.expect_err("no answer");
    session.list_folders().await.expect("next listing");
    server.join().expect("server");
    let conn = db.lock().unwrap();
    assert!(crate::store::folder_exists(&conn, "acct", "Work").unwrap());
    assert!(crate::folder_move::take_renames(&conn, "acct").unwrap().is_empty());
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM ews_uncertain_moves", [], |row| row.get(0)).unwrap();
    assert_eq!(pending, 0, "settled");
}

#[test]
fn folder_names_with_slashes_and_backslashes_never_come_out_alike() {
    assert_eq!(path_segment("A/B"), "A\u{2215}B", "a slash reads the same");
    let names = ["A/B", "A\u{2215}B", "A\\\u{2215}B", "/\u{2215}", "\u{2215}/", "//", "\u{2215}\u{2215}", "\\/", "/\\", "\\"];
    let segments: std::collections::HashSet<String> = names.iter().map(|name| path_segment(name)).collect();
    assert_eq!(segments.len(), names.len(), "{segments:?}");
    assert!(segments.iter().all(|segment| !segment.contains('/')));
}

#[tokio::test]
async fn ews_special_folders_and_moves_into_a_subtree_are_refused_before_the_server_is_asked() {
    let db = synced_store().await;
    // No server at all: nothing may reach it.
    let mut session = session("http://127.0.0.1:1".to_string(), db.clone(), "acct");
    for (source, parent, why) in [
        ("INBOX", Some("Projects"), "special folder"),
        ("Sent Items", None, "special folder"),
        ("Work", Some("Work/2026"), "into itself"),
        ("Work", None, "already there"),
    ] {
        let error = move_like_the_engine(&mut session, &db, source, parent).await.expect_err(source);
        assert!(error.to_string().contains(why), "{source}: {error}");
    }
}
