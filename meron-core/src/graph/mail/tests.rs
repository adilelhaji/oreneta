use super::*;

const ACCOUNT: &str = "reader@example.test";
struct Fixture {
    tree: Vec<Folder>,
    pages: Mutex<VecDeque<Result<Page<Message>>>>,
    full: Mutex<HashMap<String, Message>>,
    seen: Mutex<Vec<Option<String>>>,
}
impl Source for Fixture {
    fn well_known(&self, alias: &str) -> Result<Folder> {
        match alias {
            "msgfolderroot" => Ok(folder("root", "Root", "", 0)),
            "inbox" => Ok(folder("in", "Inbox", "root", 0)),
            _ => Err(Error::new(ErrorKind::NotFound)),
        }
    }
    fn folders(&self, parent: Option<&ResourceId>, _: Option<&Checkpoint>) -> Result<Page<Folder>> {
        let parent = parent.map(ResourceId::opaque).unwrap_or("root");
        Ok(Page {
            items: self
                .tree
                .iter()
                .filter(|f| f.fields.parent_folder_id.as_deref() == Some(parent))
                .cloned()
                .collect(),
            checkpoint: None,
        })
    }
    fn delta(&self, _: &ResourceId, checkpoint: Option<&Checkpoint>) -> Result<Page<Message>> {
        self.seen
            .lock()
            .unwrap()
            .push(checkpoint.map(|c| c.url.clone()));
        self.pages
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected Graph request")
    }
    fn message(&self, id: &ResourceId) -> Result<Message> {
        self.full
            .lock()
            .unwrap()
            .get(id.opaque())
            .cloned()
            .ok_or_else(|| Error::new(ErrorKind::NotFound))
    }
}
fn folder(id: &str, name: &str, parent: &str, children: u32) -> Folder {
    Folder { id: ResourceId::new(ACCOUNT,ResourceKind::Folder,id).unwrap(), fields:serde_json::from_value(json!({"displayName":name,"parentFolderId":parent,"childFolderCount":children,"unreadItemCount":0,"totalItemCount":0})).unwrap() }
}
fn message(id: &str, patch: Value) -> Message {
    Message {
        id: ResourceId::new(ACCOUNT, ResourceKind::Message, id).unwrap(),
        fields: serde_json::from_value(patch).unwrap(),
    }
}
fn envelope(parent: &str, subject: &str) -> Value {
    json!({"parentFolderId":parent,"conversationId":"opaque/#?A","subject":subject,"receivedDateTime":"2026-09-09T10:00:00Z","isRead":false,"isDraft":false,"hasAttachments":false,"toRecipients":[],"ccRecipients":[],"@odata.etag":"v1"})
}
fn page(folder: &str, token: &str, final_page: bool, items: Vec<Message>) -> Result<Page<Message>> {
    let client = Client::new(
        Grant::new(ACCOUNT, "fixture", "Mail.Read", i64::MAX).unwrap(),
        crate::proxy::ProxyChoice::Direct,
    );
    let mut url = client.route(&["me", "mailFolders", folder, "messages", "delta"]);
    let collection = url.path().to_owned();
    url.query_pairs_mut().append_pair(
        if final_page {
            "$deltatoken"
        } else {
            "$skiptoken"
        },
        token,
    );
    Ok(Page {
        items,
        checkpoint: Some(Checkpoint {
            account: ACCOUNT.into(),
            collection,
            url: url.into(),
            kind: if final_page {
                CheckpointKind::Delta
            } else {
                CheckpointKind::NextPage
            },
        }),
    })
}
fn setup() -> (Db, Lease, Fixture) {
    let db = Arc::new(Mutex::new(crate::store::open_at(":memory:").unwrap()));
    let lease = begin_profile(
        &db.lock().unwrap(),
        ACCOUNT,
        &auth::Principal {
            tenant: "tenant".into(),
            object: "person".into(),
            email: ACCOUNT.into(),
        },
        "Reader",
    )
    .unwrap();
    let source = Fixture {
        tree: vec![folder("in", "Inbox", "root", 0)],
        pages: Mutex::new(VecDeque::new()),
        full: Mutex::new(HashMap::new()),
        seen: Mutex::new(vec![]),
    };
    sync_tree(&source, &db, &lease).unwrap();
    (db, lease, source)
}
fn count(db: &Db, table: &str) -> i64 {
    db.lock()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn enqueue(source: &Fixture, p: Result<Page<Message>>) {
    source.pages.lock().unwrap().push_back(p);
}
fn headers(db: &Db) -> Vec<crate::imap::MessageHeader> {
    crate::store::recent_headers(&db.lock().unwrap(), ACCOUNT, "INBOX", 100).unwrap()
}

#[test]
fn migration_creates_separate_graph_tables() {
    let db = crate::store::open_at(":memory:").unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM graph_profiles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn complete_round_is_atomic_and_sparse_pages_merge_in_order() {
    let (db, lease, source) = setup();
    enqueue(
        &source,
        page(
            "in",
            "first",
            false,
            vec![message("opaque/+==", envelope("in", "original"))],
        ),
    );
    assert!(!sync_page(&source, &db, &lease, "INBOX").unwrap());
    assert_eq!(count(&db, "messages"), 0);
    assert_eq!(count(&db, "graph_delta"), 0);
    enqueue(
        &source,
        page(
            "in",
            "second",
            false,
            vec![message("opaque/+==", json!({"subject":"changed"}))],
        ),
    );
    assert!(!sync_page(&source, &db, &lease, "INBOX").unwrap());
    enqueue(
        &source,
        page(
            "in",
            "done",
            true,
            vec![message("opaque/+==", json!({"isRead":true}))],
        ),
    );
    assert!(sync_page(&source, &db, &lease, "INBOX").unwrap());
    let h = headers(&db);
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].subject, "changed");
    assert!(h[0].seen);
    assert_eq!(
        h[0].thread_key,
        format!("graph:{}", B64.encode("opaque/#?A"))
    );
    assert_eq!(count(&db, "graph_rounds"), 0);
    assert_eq!(count(&db, "graph_staged_items"), 0);
    assert_eq!(count(&db, "graph_delta"), 1);
}

#[test]
fn retry_uses_durable_continuation_and_keeps_visible_cache() {
    let (db, lease, source) = setup();
    enqueue(
        &source,
        page(
            "in",
            "base",
            true,
            vec![message("m", envelope("in", "old"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    enqueue(
        &source,
        page(
            "in",
            "next",
            false,
            vec![message("m", json!({"subject":"new"}))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    enqueue(
        &source,
        Err(Error {
            kind: ErrorKind::Throttled,
            status: Some(429),
            retry_after_seconds: Some(120),
        }),
    );
    let error = sync_page(&source, &db, &lease, "INBOX").unwrap_err();
    assert_eq!(error.kind, ErrorKind::Throttled);
    assert_eq!(error.retry_after_seconds, Some(120));
    assert_eq!(headers(&db)[0].subject, "old");
    assert_eq!(count(&db, "graph_rounds"), 1);
    let resumed = begin_profile(
        &db.lock().unwrap(),
        ACCOUNT,
        &auth::Principal {
            tenant: "tenant".into(),
            object: "person".into(),
            email: ACCOUNT.into(),
        },
        "Reader",
    )
    .unwrap();
    enqueue(
        &source,
        page(
            "in",
            "final",
            true,
            vec![message("m", json!({"isRead":true}))],
        ),
    );
    sync_page(&source, &db, &resumed, "INBOX").unwrap();
    assert_eq!(headers(&db)[0].subject, "new");
    assert!(headers(&db)[0].seen);
    let seen = source.seen.lock().unwrap();
    assert_eq!(seen[2], seen[3]);
}

#[test]
fn expired_delta_retains_cache_until_complete_full_replacement() {
    let (db, lease, source) = setup();
    enqueue(
        &source,
        page(
            "in",
            "base",
            true,
            vec![message("old", envelope("in", "old"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    enqueue(&source, Err(Error::new(ErrorKind::ResyncRequired)));
    assert_eq!(
        sync_page(&source, &db, &lease, "INBOX").unwrap_err().kind,
        ErrorKind::ResyncRequired
    );
    assert_eq!(headers(&db).len(), 1);
    assert_eq!(count(&db, "graph_delta"), 0);
    enqueue(
        &source,
        page(
            "in",
            "new",
            false,
            vec![message("new", envelope("in", "new"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    assert_eq!(headers(&db)[0].subject, "old");
    enqueue(&source, page("in", "complete", true, vec![]));
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    assert_eq!(headers(&db).len(), 1);
    assert_eq!(headers(&db)[0].subject, "new");
    assert_eq!(headers(&db)[0].uid, 2);
    assert_eq!(count(&db, "graph_items"), 2);
}

#[test]
fn cancellation_and_account_deletion_invalidate_late_work() {
    let (db, lease, source) = setup();
    cancel(&db.lock().unwrap(), &lease).unwrap();
    assert_eq!(
        sync_page(&source, &db, &lease, "INBOX").unwrap_err().kind,
        ErrorKind::Cancelled
    );
    assert!(source.seen.lock().unwrap().is_empty());
    crate::store::delete_account(&db.lock().unwrap(), ACCOUNT).unwrap();
    for table in [
        "graph_profiles",
        "graph_folders",
        "graph_items",
        "graph_memberships",
        "graph_delta",
        "graph_rounds",
        "graph_staged_items",
        "graph_round_links",
    ] {
        assert_eq!(count(&db, table), 0);
    }
    assert_eq!(
        sync_tree(&source, &db, &lease).unwrap_err().kind,
        ErrorKind::Cancelled
    );
}

#[test]
fn unknown_sparse_item_is_fetched_and_malformed_final_page_rolls_back() {
    let (db, lease, source) = setup();
    source
        .full
        .lock()
        .unwrap()
        .insert("m".into(), message("m", envelope("in", "full")));
    enqueue(
        &source,
        page(
            "in",
            "next",
            false,
            vec![message("m", json!({"isRead":false}))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    enqueue(
        &source,
        page(
            "in",
            "bad",
            true,
            vec![message("wrong", envelope("different-folder", "bad"))],
        ),
    );
    assert_eq!(
        sync_page(&source, &db, &lease, "INBOX").unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    assert_eq!(count(&db, "messages"), 0);
    assert_eq!(count(&db, "graph_staged_items"), 1);
    assert_eq!(count(&db, "graph_delta"), 0);
}

#[test]
fn duplicate_continuation_and_foreign_scope_are_rejected() {
    let (db, lease, source) = setup();
    enqueue(&source, page("in", "same", false, vec![]));
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    enqueue(&source, page("in", "same", false, vec![]));
    assert_eq!(
        sync_page(&source, &db, &lease, "INBOX").unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    enqueue(&source, page("other", "end", true, vec![]));
    assert_eq!(
        sync_page(&source, &db, &lease, "INBOX").unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    assert_eq!(count(&db, "graph_delta"), 0);
}

#[test]
fn explicit_empty_recipients_clear_index_without_losing_local_json() {
    let (db, lease, source) = setup();
    let mut initial = envelope("in", "one");
    initial["toRecipients"] = json!([{"emailAddress":{"name":"Old","address":"old@example.test"}}]);
    enqueue(
        &source,
        page("in", "base", true, vec![message("m", initial)]),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    db.lock()
        .unwrap()
        .execute(
            "UPDATE messages SET json=json_set(json,'$.local_annotation','keep')",
            [],
        )
        .unwrap();
    enqueue(
        &source,
        page(
            "in",
            "new",
            true,
            vec![message("m", json!({"toRecipients":[]}))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    let (index, local): (String, String) = db
        .lock()
        .unwrap()
        .query_row(
            "SELECT recipients,json_extract(json,'$.local_annotation') FROM messages",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(index.is_empty());
    assert!(headers(&db)[0].to.is_empty());
    assert_eq!(local, "keep");
}

#[test]
fn moving_and_tombstoning_memberships_preserves_surrogate() {
    let (db, lease, mut source) = setup();
    source.tree.push(folder("dest", "Same name", "root", 0));
    sync_tree(&source, &db, &lease).unwrap();
    enqueue(
        &source,
        page(
            "in",
            "base",
            true,
            vec![message("m", envelope("in", "one"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    let uid = headers(&db)[0].uid;
    let dest = local_folder("dest", "folder");
    enqueue(
        &source,
        page(
            "dest",
            "base",
            true,
            vec![message("m", json!({"parentFolderId":"dest"}))],
        ),
    );
    sync_page(&source, &db, &lease, &dest).unwrap();
    enqueue(
        &source,
        page(
            "in",
            "gone",
            true,
            vec![message("m", json!({"@removed":{"reason":"deleted"}}))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    assert!(headers(&db).is_empty());
    let dest_headers =
        crate::store::recent_headers(&db.lock().unwrap(), ACCOUNT, &dest, 100).unwrap();
    assert_eq!(dest_headers[0].uid, uid);
    assert_eq!(count(&db, "graph_items"), 1);
}

#[test]
fn folder_rename_reparent_keeps_locator_and_duplicate_names() {
    let (db, lease, mut source) = setup();
    source.tree.extend([
        folder("p", "Projects", "root", 1),
        folder("a", "Same", "p", 0),
        folder("b", "Same", "root", 0),
    ]);
    sync_tree(&source, &db, &lease).unwrap();
    source.tree[1].fields.child_folder_count = 0;
    source.tree[2].fields.parent_folder_id = Some("root".into());
    source.tree[2].fields.display_name = "Renamed".into();
    sync_tree(&source, &db, &lease).unwrap();
    let fs = crate::store::get_folders(&db.lock().unwrap(), ACCOUNT).unwrap();
    assert_eq!(fs.len(), 4);
    assert!(
        fs.iter()
            .any(|f| f.name == local_folder("a", "folder") && f.display_name == "Renamed")
    );
}

#[test]
fn sql_failure_rolls_back_every_final_projection_table() {
    let (db, lease, source) = setup();
    enqueue(
        &source,
        page(
            "in",
            "next",
            false,
            vec![message("m", envelope("in", "one"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    db.lock().unwrap().execute_batch("CREATE TRIGGER reject_graph BEFORE INSERT ON graph_delta BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    enqueue(&source, page("in", "final", true, vec![]));
    assert_eq!(
        sync_page(&source, &db, &lease, "INBOX").unwrap_err().kind,
        ErrorKind::Storage
    );
    for table in [
        "messages",
        "graph_items",
        "graph_memberships",
        "graph_delta",
        "folder_state",
    ] {
        assert_eq!(count(&db, table), 0);
    }
    assert_eq!(count(&db, "graph_staged_items"), 1);
    assert_eq!(count(&db, "graph_rounds"), 1);
}

#[test]
fn activation_requires_tree_and_complete_inbox_and_never_converts_account() {
    let (db, lease, source) = setup();
    assert_eq!(
        publish(&db.lock().unwrap(), &lease).unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    enqueue(
        &source,
        page(
            "in",
            "next",
            false,
            vec![message("m", envelope("in", "hello"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    assert_eq!(count(&db, "accounts"), 0);
    assert!(publish(&db.lock().unwrap(), &lease).is_err());
    enqueue(&source, page("in", "final", true, vec![]));
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    publish(&db.lock().unwrap(), &lease).unwrap();
    let conn = db.lock().unwrap();
    let creds = crate::store::load_account(&conn, ACCOUNT).unwrap().unwrap();
    assert!(creds.is_graph());
    assert!(creds.password.is_empty());
    assert!(creds.access_token.is_none());
    assert!(creds.refresh_token.is_none());
    assert!(status(&conn, ACCOUNT).unwrap().mail_backend_ready);
    let config: String = conn
        .query_row("SELECT config FROM accounts WHERE id=?1", [ACCOUNT], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!config.contains("token"));
    conn.execute("UPDATE accounts SET config='{}' WHERE id=?1", [ACCOUNT])
        .unwrap();
    assert_eq!(
        publish(&conn, &lease).unwrap_err().kind,
        ErrorKind::AccountConflict
    );
    assert_eq!(
        begin_profile(
            &conn,
            ACCOUNT,
            &auth::Principal {
                tenant: "tenant".into(),
                object: "person".into(),
                email: ACCOUNT.into()
            },
            "Other"
        )
        .err()
        .unwrap()
        .kind,
        ErrorKind::AccountConflict
    );
    assert_eq!(
        conn.query_row("SELECT config FROM accounts WHERE id=?1", [ACCOUNT], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "{}"
    );
}

#[tokio::test]
async fn session_body_reads_cache_without_writes_or_network_on_second_read() {
    let (db, lease, source) = setup();
    let mut item = envelope("in", "HTML");
    item["body"] =
        json!({"contentType":"html","content":"<p>Safe text</p><script>attack()</script>"});
    source
        .full
        .lock()
        .unwrap()
        .insert("m".into(), message("m", item));
    enqueue(
        &source,
        page(
            "in",
            "final",
            true,
            vec![message("m", envelope("in", "HTML"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    publish(&db.lock().unwrap(), &lease).unwrap();
    let source = Arc::new(source);
    let session = Session {
        db: db.clone(),
        lease,
        source: source.clone(),
        lock: Arc::new(Mutex::new(())),
    };
    let body = session.read_message("INBOX", 1, None).await.unwrap();
    assert!(body.body.contains("Safe text"));
    let html = crate::parse::prepare_html(body.body_html.as_deref().unwrap(), false);
    assert!(!html.contains("<script>"));
    assert!(html.contains("Content-Security-Policy"));
    source.full.lock().unwrap().clear();
    assert!(
        session
            .read_message("INBOX", 1, None)
            .await
            .unwrap()
            .body
            .contains("Safe text")
    );
    assert!(!headers(&db)[0].seen);
    let creds = crate::store::load_account(&db.lock().unwrap(), ACCOUNT)
        .unwrap()
        .unwrap();
    assert!(crate::imap::connect(&creds).await.is_err());
    assert!(
        crate::backend::connect(&creds, ACCOUNT, db.clone())
            .await
            .is_err()
    );
    let mut backend = crate::backend::Session::Graph(session);
    assert!(backend.store_seen(&[1], true).await.is_err());
    assert!(backend.create_folder("bad").await.is_err());
    assert!(backend.send_mime(vec![]).await.is_err());
    assert!(
        backend
            .fetch_raw_messages_for_copy("INBOX", &[1])
            .await
            .is_err()
    );
    assert!(!headers(&db)[0].seen);
}

#[test]
fn every_remote_mutation_is_guarded_before_local_side_effects() {
    let (db, lease, source) = setup();
    enqueue(&source, page("in", "final", true, vec![]));
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    publish(&db.lock().unwrap(), &lease).unwrap();
    let conn = db.lock().unwrap();
    for method in [
        "send",
        "save_draft",
        "discard_draft",
        "messages.saveRaw",
        "messages.markRead",
        "messages.markStarred",
        "messages.delete",
        "messages.move",
        "messages.copy",
        "messages.markAllRead",
        "messages.emptyFolder",
        "folders.create",
        "folders.delete",
        "mail.scheduleSend",
        "oof.set",
        "calendar.create",
        "calendar.respond",
    ] {
        assert!(
            guard_command(&conn, method, &json!({"account":ACCOUNT})).is_err(),
            "{method}"
        );
        assert!(
            guard_command(&conn, method, &json!({"account":"legacy"})).is_ok(),
            "{method}"
        );
    }
    assert!(
        guard_command(
            &conn,
            "messages.copy",
            &json!({"account":"legacy","target_account":ACCOUNT})
        )
        .is_err()
    );
    assert!(guard_command(&conn, "messages.markAllReadUnified", &json!({})).is_err());
    for method in [
        "messages.thread",
        "messages.read",
        "labels.assign",
        "mail.snooze",
    ] {
        assert!(guard_command(&conn, method, &json!({"account":ACCOUNT})).is_ok());
    }
}

#[test]
fn cancelled_generation_cannot_publish_or_replace_identity() {
    let (db, lease, source) = setup();
    enqueue(&source, page("in", "complete", true, vec![]));
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    let conn = db.lock().unwrap();
    cancel(&conn, &lease).unwrap();
    assert_eq!(
        publish(&conn, &lease).unwrap_err().kind,
        ErrorKind::Cancelled
    );
    assert_eq!(
        begin_profile(
            &conn,
            ACCOUNT,
            &auth::Principal {
                tenant: "other".into(),
                object: "person".into(),
                email: ACCOUNT.into()
            },
            "Other"
        )
        .err()
        .unwrap()
        .kind,
        ErrorKind::AccountConflict
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM accounts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn hierarchy_failure_does_not_retire_previous_cache() {
    let (db, lease, mut source) = setup();
    enqueue(
        &source,
        page(
            "in",
            "complete",
            true,
            vec![message("m", envelope("in", "keep"))],
        ),
    );
    sync_page(&source, &db, &lease, "INBOX").unwrap();
    source
        .tree
        .push(folder("in", "Duplicate identity", "root", 0));
    assert_eq!(
        sync_tree(&source, &db, &lease).unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    assert_eq!(headers(&db)[0].subject, "keep");
    assert_eq!(count(&db, "graph_folders"), 1);
}

#[test]
fn complete_mailboxes_are_not_truncated_at_a_recent_messages_limit() {
    let (db,lease,source)=setup();
    enqueue(&source,page("in","more",false,(0..1000).map(|n|message(&format!("m{n:04}"),envelope("in","page one"))).collect()));
    sync_page(&source,&db,&lease,"INBOX").unwrap();assert_eq!(count(&db,"messages"),0);
    enqueue(&source,page("in","end",true,(1000..1501).map(|n|message(&format!("m{n:04}"),envelope("in","page two"))).collect()));
    sync_page(&source,&db,&lease,"INBOX").unwrap();assert_eq!(count(&db,"messages"),1501);assert_eq!(count(&db,"graph_memberships"),1501);
}

#[test]
fn page_returning_after_cancellation_cannot_commit() {
    struct Gated { source:Fixture, entered:Arc<std::sync::Barrier>, resume:Arc<std::sync::Barrier> }
    impl Source for Gated {
        fn well_known(&self,a:&str)->Result<Folder>{self.source.well_known(a)}
        fn folders(&self,p:Option<&ResourceId>,c:Option<&Checkpoint>)->Result<Page<Folder>>{self.source.folders(p,c)}
        fn message(&self,id:&ResourceId)->Result<Message>{self.source.message(id)}
        fn delta(&self,f:&ResourceId,c:Option<&Checkpoint>)->Result<Page<Message>> {self.entered.wait();self.resume.wait();self.source.delta(f,c)}
    }
    let (db,lease,source)=setup();enqueue(&source,page("in","complete",true,vec![message("m",envelope("in","late"))]));
    let entered=Arc::new(std::sync::Barrier::new(2));let resume=Arc::new(std::sync::Barrier::new(2));
    let gated=Gated{source,entered:entered.clone(),resume:resume.clone()};let worker_db=db.clone();let worker_lease=lease.clone();
    let worker=std::thread::spawn(move||sync_page(&gated,&worker_db,&worker_lease,"INBOX"));
    entered.wait();cancel(&db.lock().unwrap(),&lease).unwrap();resume.wait();
    assert_eq!(worker.join().unwrap().unwrap_err().kind,ErrorKind::Cancelled);
    for table in ["accounts","messages","graph_items","graph_staged_items","graph_delta"] {assert_eq!(count(&db,table),0);}
}

// ---- #141: writes ----

/// Reads from the scripted fixture; records each write and fails the one at
/// a given position.
struct Writer {
    inner: Fixture,
    writes: Mutex<Vec<String>>,
    fail: Mutex<HashMap<usize, Error>>,
}
impl Writer {
    fn attempt(&self, what: String) -> Result<()> {
        let mut writes = self.writes.lock().unwrap();
        let index = writes.len();
        writes.push(what);
        match self.fail.lock().unwrap().remove(&index) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
impl Source for Writer {
    fn folders(&self, p: Option<&ResourceId>, c: Option<&Checkpoint>) -> Result<Page<Folder>> {
        self.inner.folders(p, c)
    }
    fn well_known(&self, a: &str) -> Result<Folder> {
        self.inner.well_known(a)
    }
    fn delta(&self, f: &ResourceId, c: Option<&Checkpoint>) -> Result<Page<Message>> {
        self.inner.delta(f, c)
    }
    fn message(&self, id: &ResourceId) -> Result<Message> {
        self.inner.message(id)
    }
    fn set_read(&self, id: &ResourceId, read: bool) -> Result<()> {
        self.attempt(format!("read:{}:{read}", id.opaque()))
    }
    fn set_flag(&self, id: &ResourceId, flagged: bool) -> Result<()> {
        self.attempt(format!("flag:{}:{flagged}", id.opaque()))
    }
    fn move_message(&self, id: &ResourceId, to: &ResourceId) -> Result<ResourceId> {
        self.attempt(format!("move:{}:{}", id.opaque(), to.opaque()))?;
        Ok(id.clone())
    }
    fn copy_message(&self, id: &ResourceId, to: &ResourceId) -> Result<ResourceId> {
        self.attempt(format!("copy:{}:{}", id.opaque(), to.opaque()))?;
        Ok(ResourceId::new(ACCOUNT, ResourceKind::Message, "copy")?)
    }
    fn delete_message(&self, id: &ResourceId) -> Result<()> {
        self.attempt(format!("delete:{}", id.opaque()))
    }
}

fn archive() -> String {
    local_folder("arc", "folder")
}
/// Inbox with m1..m3 and an archive folder holding a1, both fully synced.
fn writable_session() -> (Db, Arc<Writer>, Session) {
    let db = Arc::new(Mutex::new(crate::store::open_at(":memory:").unwrap()));
    let lease = begin_profile(
        &db.lock().unwrap(),
        ACCOUNT,
        &auth::Principal { tenant: "tenant".into(), object: "person".into(), email: ACCOUNT.into() },
        "Reader",
    )
    .unwrap();
    let inner = Fixture {
        tree: vec![folder("in", "Inbox", "root", 0), folder("arc", "Archive", "root", 0)],
        pages: Mutex::new(VecDeque::new()),
        full: Mutex::new(HashMap::new()),
        seen: Mutex::new(vec![]),
    };
    sync_tree(&inner, &db, &lease).unwrap();
    enqueue(
        &inner,
        page("in", "base", true, ["m1", "m2", "m3"].iter().map(|id| message(id, envelope("in", id))).collect()),
    );
    sync_page(&inner, &db, &lease, "INBOX").unwrap();
    enqueue(&inner, page("arc", "base", true, vec![message("a1", envelope("arc", "a1"))]));
    sync_page(&inner, &db, &lease, &archive()).unwrap();
    publish(&db.lock().unwrap(), &lease).unwrap();
    let writer = Arc::new(Writer { inner, writes: Mutex::new(vec![]), fail: Mutex::new(HashMap::new()) });
    let session = Session { db: db.clone(), lease, source: writer.clone(), lock: Arc::new(Mutex::new(())) };
    (db, writer, session)
}
fn uids_in(db: &Db, folder: &str) -> Vec<u32> {
    let mut uids: Vec<u32> = crate::store::recent_headers(&db.lock().unwrap(), ACCOUNT, folder, 100)
        .unwrap()
        .into_iter()
        .map(|h| h.uid)
        .collect();
    uids.sort();
    uids
}
fn seen(db: &Db) -> Vec<(u32, bool)> {
    let mut all: Vec<(u32, bool)> = headers(db).into_iter().map(|h| (h.uid, h.seen)).collect();
    all.sort();
    all
}
fn writes(writer: &Writer) -> Vec<String> {
    writer.writes.lock().unwrap().clone()
}
fn throttled(seconds: u64) -> Error {
    Error { kind: ErrorKind::Throttled, status: Some(429), retry_after_seconds: Some(seconds) }
}

#[tokio::test]
async fn read_state_stops_at_the_first_failure_and_keeps_what_was_confirmed() {
    let (db, writer, session) = writable_session();
    writer.fail.lock().unwrap().insert(1, throttled(30));
    let error = session.set_seen(&[1, 2, 3], true).await.unwrap_err();
    let batch = error.downcast_ref::<BatchError>().unwrap();
    assert_eq!((batch.done, batch.total), (1, 3));
    assert!(error.to_string().contains("1 of 3 changed"), "{error}");
    assert!(error.to_string().contains("30s"), "{error}");
    // The throttled server is not asked again for the third.
    assert_eq!(writes(&writer), vec!["read:m1:true", "read:m2:true"]);
    assert_eq!(seen(&db), vec![(1, true), (2, false), (3, false)]);
    // A throttled write is the action's problem, not the account's health.
    let health: Option<String> = db.lock().unwrap().query_row("SELECT error FROM graph_profiles WHERE account=?1", [ACCOUNT], |r| r.get(0)).unwrap();
    assert_eq!(health, None);
}

#[tokio::test]
async fn flags_change_locally_only_once_confirmed() {
    let (db, writer, session) = writable_session();
    session.set_flagged(&[2], true).await.unwrap();
    assert_eq!(writes(&writer), vec!["flag:m2:true"]);
    let starred: Vec<u32> = headers(&db).into_iter().filter(|h| h.starred).map(|h| h.uid).collect();
    assert_eq!(starred, vec![2]);
    writer.fail.lock().unwrap().insert(1, Error { kind: ErrorKind::AccessDenied, status: Some(403), retry_after_seconds: None });
    assert!(session.set_flagged(&[3], true).await.is_err());
    assert!(!headers(&db).into_iter().any(|h| h.uid == 3 && h.starred));
}

#[tokio::test]
async fn the_reviewed_set_is_resolved_before_anything_is_sent() {
    let (_, writer, session) = writable_session();
    // 99 does not exist; nothing is changed, not even the first.
    assert!(session.set_seen(&[1, 99], true).await.is_err());
    // a1 lives in the archive: it cannot be moved "from the inbox".
    let a1 = 4;
    assert!(session.move_uids("INBOX", &archive(), &[a1]).await.is_err());
    // An unknown destination is refused before the first move.
    assert!(session.move_uids("INBOX", "graph.unknown", &[1]).await.is_err());
    assert!(writes(&writer).is_empty());
}

#[tokio::test]
async fn a_move_brings_both_folders_to_what_the_server_holds() {
    let (db, writer, session) = writable_session();
    enqueue(&writer.inner, page("in", "after-move", true, vec![message("m1", json!({"@removed":{"reason":"deleted"}}))]));
    enqueue(&writer.inner, page("arc", "after-move", true, vec![message("m1", envelope("arc", "m1"))]));
    session.move_uids("INBOX", &archive(), &[1]).await.unwrap();
    assert_eq!(writes(&writer), vec!["move:m1:arc"]);
    assert_eq!(uids_in(&db, "INBOX"), vec![2, 3]);
    // Immutable ids: the moved message keeps its local UID.
    assert_eq!(uids_in(&db, &archive()), vec![1, 4]);
}

#[tokio::test]
async fn an_uncertain_move_is_not_repeated_and_the_cache_follows_the_server() {
    let (db, writer, session) = writable_session();
    writer.fail.lock().unwrap().insert(0, Error::new(ErrorKind::Uncertain));
    // The server did apply it; only the answer was lost.
    enqueue(&writer.inner, page("in", "after", true, vec![message("m1", json!({"@removed":{"reason":"deleted"}}))]));
    enqueue(&writer.inner, page("arc", "after", true, vec![message("m1", envelope("arc", "m1"))]));
    let error = session.move_uids("INBOX", &archive(), &[1, 2]).await.unwrap_err();
    assert!(error.to_string().contains("unknown"), "{error}");
    assert_eq!(writes(&writer), vec!["move:m1:arc"]);
    assert_eq!(uids_in(&db, "INBOX"), vec![2, 3]);
    assert_eq!(uids_in(&db, &archive()), vec![1, 4]);
}

#[tokio::test]
async fn a_failed_refresh_after_a_move_does_not_turn_it_into_an_error() {
    let (_, writer, session) = writable_session();
    enqueue(&writer.inner, Err(throttled(5)));
    enqueue(&writer.inner, Err(throttled(5)));
    session.move_uids("INBOX", &archive(), &[1]).await.unwrap();
}

#[tokio::test]
async fn copy_and_delete_go_one_by_one_and_reconcile() {
    let (db, writer, session) = writable_session();
    enqueue(&writer.inner, page("in", "c", true, vec![]));
    enqueue(&writer.inner, page("arc", "c", true, vec![message("copy", envelope("arc", "copy"))]));
    assert_eq!(session.copy_uids("INBOX", &archive(), &[2]).await.unwrap(), 1);
    assert_eq!(uids_in(&db, "INBOX"), vec![1, 2, 3]);
    assert_eq!(uids_in(&db, &archive()).len(), 2);

    enqueue(&writer.inner, page("arc", "d", true, vec![message("a1", json!({"@removed":{"reason":"deleted"}}))]));
    session.delete_uids(&archive(), &[4]).await.unwrap();
    assert_eq!(writes(&writer), vec!["copy:m2:arc", "delete:a1"]);
    assert!(!uids_in(&db, &archive()).contains(&4));
}

#[tokio::test]
async fn a_read_only_grant_changes_nothing_anywhere() {
    let (db, writer, session) = writable_session();
    writer.fail.lock().unwrap().insert(0, Error::new(ErrorKind::ConsentRequired));
    let error = session.set_seen(&[1], true).await.unwrap_err();
    assert!(error.to_string().contains("allow them in its settings"), "{error}");
    assert_eq!(seen(&db)[0], (1, false));
}

// ---- #142: attachments ----

struct Reader {
    inner: Writer,
    mime: Mutex<Option<Result<Vec<u8>>>>,
    listed: Mutex<Vec<AttachmentInfo>>,
    mime_calls: std::sync::atomic::AtomicUsize,
}
impl Source for Reader {
    fn folders(&self, p: Option<&ResourceId>, c: Option<&Checkpoint>) -> Result<Page<Folder>> {
        self.inner.folders(p, c)
    }
    fn well_known(&self, a: &str) -> Result<Folder> {
        self.inner.well_known(a)
    }
    fn delta(&self, f: &ResourceId, c: Option<&Checkpoint>) -> Result<Page<Message>> {
        self.inner.delta(f, c)
    }
    fn message(&self, id: &ResourceId) -> Result<Message> {
        self.inner.message(id)
    }
    fn message_mime(&self, _: &ResourceId) -> Result<Vec<u8>> {
        self.mime_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.mime.lock().unwrap().clone().expect("unexpected MIME request")
    }
    fn attachments(&self, _: &ResourceId) -> Result<Vec<AttachmentInfo>> {
        Ok(self.listed.lock().unwrap().clone())
    }
}

const MIME: &str = "From: a@example.com\r\nTo: b@example.com\r\nSubject: Report\r\nMessage-ID: <m1@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: multipart/related; boundary=\"b2\"\r\n\r\n--b2\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>See <img src=\"cid:logo@example.com\"></p>\r\n--b2\r\nContent-Type: image/png\r\nContent-ID: <logo@example.com>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--b2--\r\n--b1\r\nContent-Type: application/pdf; name=\"q3.pdf\"\r\nContent-Disposition: attachment; filename=\"q3.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--b1--\r\n";

fn reading_session(tag: &str) -> (Db, Arc<Reader>, Session, crate::parse::MediaCtx) {
    let (db, writer, _) = writable_session();
    let writer = Arc::into_inner(writer).unwrap();
    // m1 has attachments.
    db.lock()
        .unwrap()
        .execute("UPDATE graph_items SET fields=json_set(fields,'$.hasAttachments',json('true')) WHERE account=?1 AND uid=1", [ACCOUNT])
        .unwrap();
    let reader = Arc::new(Reader {
        inner: writer,
        mime: Mutex::new(None),
        listed: Mutex::new(vec![]),
        mime_calls: Default::default(),
    });
    let lease = Lease {
        account: ACCOUNT.into(),
        generation: db.lock().unwrap().query_row("SELECT generation FROM graph_profiles WHERE account=?1", [ACCOUNT], |r| r.get(0)).unwrap(),
    };
    let session = Session { db: db.clone(), lease, source: reader.clone(), lock: Arc::new(Mutex::new(())) };
    let root = std::env::temp_dir().join(format!("oreneta-graph-media-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let media = crate::parse::MediaCtx { root, account: ACCOUNT.into(), folder: "INBOX".into(), uid: 1 };
    (db, reader, session, media)
}

#[tokio::test]
async fn attachments_and_inline_images_arrive_through_the_mime_parser() {
    let (_, reader, session, media) = reading_session("parts");
    *reader.mime.lock().unwrap() = Some(Ok(MIME.as_bytes().to_vec()));
    *reader.listed.lock().unwrap() = vec![serde_json::from_value(json!({
        "@odata.type":"#microsoft.graph.referenceAttachment","name":"Plan.xlsx","contentType":"application/vnd.ms-excel","size":0
    })).unwrap()];
    let body = session.read_message("INBOX", 1, Some(media.clone())).await.unwrap();

    let files: Vec<(&str, bool, &str)> = body
        .attachments
        .iter()
        .map(|a| (a.filename.as_str(), a.key.as_deref().is_some_and(|k| media.root.join(k).is_file()), a.unavailable.as_str()))
        .collect();
    assert!(files.contains(&("q3.pdf", true, "")), "{files:?}");
    // The cloud link is named, with no bytes and no link followed.
    assert!(files.contains(&("Plan.xlsx", false, "link")), "{files:?}");
    // The inline image points at the media cache, not at a cid: URL.
    let html = body.body_html.as_deref().unwrap();
    assert!(!html.contains("cid:"), "{html}");
    assert!(html.contains("/media/"), "{html}");

    // Cached with its files: read again without asking the server.
    session.read_message("INBOX", 1, Some(media.clone())).await.unwrap();
    assert_eq!(reader.mime_calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    // A file gone from the media cache is fetched again.
    for a in &body.attachments {
        if let Some(key) = &a.key {
            let _ = std::fs::remove_file(media.root.join(key));
        }
    }
    session.read_message("INBOX", 1, Some(media.clone())).await.unwrap();
    assert_eq!(reader.mime_calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&media.root);
}

#[tokio::test]
async fn a_message_too_large_to_read_shows_its_text_and_says_the_files_are_missing() {
    let (_, reader, session, media) = reading_session("large");
    *reader.mime.lock().unwrap() = Some(Err(Error::new(ErrorKind::TooLarge)));
    reader.inner.inner.full.lock().unwrap().insert(
        "m1".into(),
        message("m1", {
            let mut v = envelope("in", "m1");
            v["body"] = json!({"contentType":"text","content":"The text still shows"});
            v
        }),
    );
    let body = session.read_message("INBOX", 1, Some(media.clone())).await.unwrap();
    assert!(body.body.contains("The text still shows"));
    assert_eq!(body.attachments.len(), 1);
    assert_eq!(body.attachments[0].unavailable, "tooLarge");
}

#[tokio::test]
async fn a_message_without_attachments_does_not_read_mime() {
    let (_, reader, session, mut media) = reading_session("plain");
    reader.inner.inner.full.lock().unwrap().insert(
        "m2".into(),
        message("m2", {
            let mut v = envelope("in", "m2");
            v["body"] = json!({"contentType":"text","content":"Just text"});
            v
        }),
    );
    media.uid = 2;
    let body = session.read_message("INBOX", 2, Some(media)).await.unwrap();
    assert!(body.body.contains("Just text"));
    assert_eq!(reader.mime_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_failed_read_is_an_error_not_an_empty_message() {
    let (_, reader, session, media) = reading_session("fail");
    *reader.mime.lock().unwrap() = Some(Err(Error::new(ErrorKind::NotFound)));
    assert!(session.read_message("INBOX", 1, Some(media)).await.is_err());
}

#[test]
fn a_proxy_refusal_while_refreshing_the_grant_stays_a_proxy_error() {
    // The grant is fine and the refresh never left (#201): not "sign in again".
    assert_eq!(auth_error(auth::Failure::AppProxyUnusable).kind, ErrorKind::AppProxyUnusable);
    assert_eq!(auth_error(auth::Failure::AccountProxyUnusable).kind, ErrorKind::AccountProxyUnusable);
    let batch = BatchError { done: 0, total: 2, error: Error::new(ErrorKind::AccountProxyUnusable) };
    assert_eq!(batch.to_string(), "Microsoft Graph: not changed: proxy setting unusable (account)");
}

// ---- #210: folder moves ----

/// A mailbox whose tree follows the moves made on it. Each move is recorded;
/// `answer` decides what the next one answers and whether the server applied
/// it anyway (a lost answer); `renamed` gives the moved folder a new id.
struct Folders {
    tree: Mutex<Vec<Folder>>,
    moves: Mutex<Vec<String>>,
    answer: Mutex<Option<(Error, bool)>>,
    renamed: Mutex<Option<String>>,
}
impl Source for Folders {
    fn well_known(&self, alias: &str) -> Result<Folder> {
        match alias {
            "msgfolderroot" => Ok(folder("root", "Root", "", 0)),
            "inbox" => Ok(folder("in", "Inbox", "root", 0)),
            "sentitems" => Ok(folder("sent", "Sent Items", "holder", 0)),
            _ => Err(Error::new(ErrorKind::NotFound)),
        }
    }
    fn folders(&self, parent: Option<&ResourceId>, _: Option<&Checkpoint>) -> Result<Page<Folder>> {
        let parent = parent.map(ResourceId::opaque).unwrap_or("root");
        let tree = self.tree.lock().unwrap();
        let children = |id: &str| tree.iter().filter(|f| f.fields.parent_folder_id.as_deref() == Some(id)).count() as u32;
        let items = tree
            .iter()
            .filter(|f| f.fields.parent_folder_id.as_deref() == Some(parent))
            .cloned()
            .map(|mut f| {
                f.fields.child_folder_count = children(f.id.opaque());
                f
            })
            .collect();
        Ok(Page { items, checkpoint: None })
    }
    fn delta(&self, _: &ResourceId, _: Option<&Checkpoint>) -> Result<Page<Message>> {
        Err(Error::new(ErrorKind::NotFound))
    }
    fn message(&self, _: &ResourceId) -> Result<Message> {
        Err(Error::new(ErrorKind::NotFound))
    }
    fn move_folder(&self, id: &ResourceId, to: &ResourceId) -> Result<ResourceId> {
        self.moves.lock().unwrap().push(format!("move:{}:{}", id.opaque(), to.opaque()));
        let answer = self.answer.lock().unwrap().take();
        let applied = answer.as_ref().is_none_or(|(_, applied)| *applied);
        let mut moved = id.clone();
        if applied {
            let mut tree = self.tree.lock().unwrap();
            if let Some(new) = self.renamed.lock().unwrap().take() {
                moved = ResourceId::new(ACCOUNT, ResourceKind::Folder, &new)?;
            }
            for f in tree.iter_mut() {
                if &f.id == id {
                    f.fields.parent_folder_id = Some(to.opaque().to_owned());
                    f.id = moved.clone();
                } else if f.fields.parent_folder_id.as_deref() == Some(id.opaque()) {
                    f.fields.parent_folder_id = Some(moved.opaque().to_owned());
                }
            }
        }
        match answer {
            Some((error, _)) => Err(error),
            None => Ok(moved),
        }
    }
}
fn search_folder(id: &str, name: &str) -> Folder {
    Folder {
        id: ResourceId::new(ACCOUNT, ResourceKind::Folder, id).unwrap(),
        fields: serde_json::from_value(json!({"@odata.type":"#microsoft.graph.mailSearchFolder","displayName":name,"parentFolderId":"root","childFolderCount":0,"unreadItemCount":0,"totalItemCount":0})).unwrap(),
    }
}
/// Inbox; Work holding 2026; Projects holding another 2026; a Holder with
/// Sent Items inside; a search folder.
fn folder_session() -> (Db, Arc<Folders>, Session) {
    let db = Arc::new(Mutex::new(crate::store::open_at(":memory:").unwrap()));
    let lease = begin_profile(
        &db.lock().unwrap(),
        ACCOUNT,
        &auth::Principal { tenant: "tenant".into(), object: "person".into(), email: ACCOUNT.into() },
        "Reader",
    )
    .unwrap();
    let source = Arc::new(Folders {
        tree: Mutex::new(vec![
            folder("in", "Inbox", "root", 0),
            folder("work", "Work", "root", 0),
            folder("w26", "2026", "work", 0),
            folder("projects", "Projects", "root", 0),
            folder("p26", "2026", "projects", 0),
            folder("holder", "Holder", "root", 0),
            folder("sent", "Sent Items", "holder", 0),
            search_folder("unread", "Unread mail"),
        ]),
        moves: Mutex::new(vec![]),
        answer: Mutex::new(None),
        renamed: Mutex::new(None),
    });
    sync_tree(source.as_ref(), &db, &lease).unwrap();
    let session = Session { db: db.clone(), lease, source: source.clone(), lock: Arc::new(Mutex::new(())) };
    (db, source, session)
}
fn local(id: &str) -> String {
    local_folder(id, "folder")
}
fn parent_of(db: &Db, id: &str) -> Option<String> {
    db.lock()
        .unwrap()
        .query_row("SELECT parent_id FROM graph_folders WHERE account=?1 AND remote_id=?2 AND active=1", [ACCOUNT, id], |r| r.get(0))
        .unwrap()
}
fn moves(source: &Folders) -> Vec<String> {
    source.moves.lock().unwrap().clone()
}
async fn refused(session: &Session, source: &str, parent: Option<&str>) -> String {
    session.move_folder(source, parent).await.unwrap_err().to_string()
}

#[tokio::test]
async fn a_folder_move_goes_to_the_server_once_and_the_tree_follows() {
    let (db, source, session) = folder_session();
    let moved = session.move_folder(&local("work"), Some(&local("projects"))).await.unwrap();
    assert_eq!(moves(&source), vec!["move:work:projects"]);
    // Immutable ids: the folder keeps its id and so its local name; its
    // subfolder comes along by itself.
    assert_eq!(moved, FolderMoved { folder: local("work"), renames: vec![] });
    assert_eq!(parent_of(&db, "work").as_deref(), Some("projects"));
    assert_eq!(parent_of(&db, "w26").as_deref(), Some("work"));
    let mut folders = serde_json::to_value(crate::store::get_folders(&db.lock().unwrap(), ACCOUNT).unwrap()).unwrap();
    decorate_folders(&db.lock().unwrap(), ACCOUNT, &mut folders).unwrap();
    let work = folders.as_array().unwrap().iter().find(|f| f["name"] == json!(local("work"))).unwrap().clone();
    assert_eq!(work["parent_id"], json!(local("projects")));
}

#[tokio::test]
async fn a_folder_moved_to_the_top_level_goes_under_the_mailbox_root() {
    let (db, source, session) = folder_session();
    session.move_folder(&local("w26"), None).await.unwrap();
    assert_eq!(moves(&source), vec!["move:w26:root"]);
    assert_eq!(parent_of(&db, "w26").as_deref(), Some("root"));
}

#[tokio::test]
async fn a_folder_move_against_the_rules_is_refused_before_anything_is_sent() {
    let (_, source, session) = folder_session();
    let s = &session;
    assert!(refused(s, &local("sent"), Some(&local("work"))).await.contains("special folder"));
    assert!(refused(s, "INBOX", Some(&local("work"))).await.contains("special folder"));
    assert!(refused(s, &local("holder"), Some(&local("work"))).await.contains("holds Sent Items"));
    assert!(refused(s, &local("work"), Some(&local("w26"))).await.contains("into itself"));
    assert!(refused(s, &local("work"), Some(&local("work"))).await.contains("into itself"));
    assert!(refused(s, &local("w26"), Some(&local("work"))).await.contains("already there"));
    assert!(refused(s, &local("work"), None).await.contains("already there"));
    assert!(refused(s, &local("w26"), Some(&local("projects"))).await.contains("A folder named 2026"));
    assert!(refused(s, &local("unread"), Some(&local("work"))).await.contains("search folder"));
    assert!(refused(s, &local("work"), Some(&local("unread"))).await.contains("search folder"));
    assert!(refused(s, "graph.unknown", Some(&local("work"))).await.contains("synchronized"));
    assert!(refused(s, &local("work"), Some("graph.unknown")).await.contains("synchronized"));
    assert!(moves(&source).is_empty());
}

#[tokio::test]
async fn an_uncertain_folder_move_is_not_repeated_and_a_retry_finds_it_moved() {
    let (db, source, session) = folder_session();
    // The server moved it; only the answer was lost.
    *source.answer.lock().unwrap() = Some((Error::new(ErrorKind::Uncertain), true));
    let error = session.move_folder(&local("work"), Some(&local("projects"))).await.unwrap_err();
    assert!(error.to_string().contains("unknown"), "{error}");
    assert!(error.to_string().contains("not repeated"), "{error}");
    assert_eq!(moves(&source).len(), 1);
    // The tree was read again: it shows where the folder is.
    assert_eq!(parent_of(&db, "work").as_deref(), Some("projects"));
    // Asking again finds it there and sends nothing: no second move.
    let again = refused(&session, &local("work"), Some(&local("projects"))).await;
    assert!(again.contains("already there"), "{again}");
    assert_eq!(moves(&source).len(), 1);
}

#[tokio::test]
async fn a_server_failure_after_a_folder_move_is_not_called_a_refusal() {
    let (db, source, session) = folder_session();
    // A 5xx that came after the server moved it.
    *source.answer.lock().unwrap() =
        Some((Error { kind: ErrorKind::Unavailable, status: Some(503), retry_after_seconds: None }, true));
    let error = refused(&session, &local("work"), Some(&local("projects"))).await;
    assert!(error.contains("unknown") && !error.contains("not moved"), "{error}");
    assert_eq!(parent_of(&db, "work").as_deref(), Some("projects"));
    assert_eq!(moves(&source).len(), 1);
}

#[tokio::test]
async fn a_refused_folder_move_changes_nothing_and_says_why() {
    let (db, source, session) = folder_session();
    *source.answer.lock().unwrap() =
        Some((Error { kind: ErrorKind::AccessDenied, status: Some(403), retry_after_seconds: None }, false));
    let error = refused(&session, &local("work"), Some(&local("projects"))).await;
    assert!(error.contains("was not moved"), "{error}");
    assert_eq!(parent_of(&db, "work").as_deref(), Some("root"));
    // Without changes granted, the source refuses before sending.
    *source.answer.lock().unwrap() = Some((Error::new(ErrorKind::ConsentRequired), false));
    let error = refused(&session, &local("work"), Some(&local("projects"))).await;
    assert!(error.contains("allow them in its settings"), "{error}");
    // A refused move is the action's problem, not the account's health.
    let health: Option<String> = db
        .lock()
        .unwrap()
        .query_row("SELECT error FROM graph_profiles WHERE account=?1", [ACCOUNT], |r| r.get(0))
        .unwrap();
    assert_eq!(health, None);
}

#[tokio::test]
async fn a_folder_whose_id_changed_with_the_move_reports_its_new_name() {
    let (db, source, session) = folder_session();
    *source.renamed.lock().unwrap() = Some("work-moved".into());
    let moved = session.move_folder(&local("work"), Some(&local("projects"))).await.unwrap();
    assert_eq!(moved, FolderMoved { folder: local("work-moved"), renames: vec![(local("work"), local("work-moved"))] });
    assert_eq!(parent_of(&db, "work-moved").as_deref(), Some("projects"));
    assert_eq!(parent_of(&db, "w26").as_deref(), Some("work-moved"));
}

#[tokio::test]
async fn folder_moves_stay_within_their_account() {
    let (db, source, session) = folder_session();
    // Another account's folder, under a local name this account does not have.
    db.lock()
        .unwrap()
        .execute(
            "INSERT INTO graph_folders(account,remote_id,local_name,display_name,parent_id,role) VALUES('other@example.test','x',?1,'Other','root','folder')",
            [local("x")],
        )
        .unwrap();
    let error = refused(&session, &local("work"), Some(&local("x"))).await;
    assert!(error.contains("synchronized"), "{error}");
    assert!(moves(&source).is_empty());
}

// ---- #210: delivery receipts ----

/// Records each sending step and fails the one named.
struct Sender {
    calls: Mutex<Vec<String>>,
    fail: Mutex<HashMap<&'static str, Error>>,
}
impl Sender {
    fn step(&self, name: &'static str, call: String) -> Result<()> {
        self.calls.lock().unwrap().push(call);
        match self.fail.lock().unwrap().remove(name) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
impl Source for Sender {
    fn folders(&self, _: Option<&ResourceId>, _: Option<&Checkpoint>) -> Result<Page<Folder>> {
        Err(Error::new(ErrorKind::NotFound))
    }
    fn well_known(&self, _: &str) -> Result<Folder> {
        Err(Error::new(ErrorKind::NotFound))
    }
    fn delta(&self, _: &ResourceId, _: Option<&Checkpoint>) -> Result<Page<Message>> {
        Err(Error::new(ErrorKind::NotFound))
    }
    fn message(&self, _: &ResourceId) -> Result<Message> {
        Err(Error::new(ErrorKind::NotFound))
    }
    fn send_mime(&self, _: &[u8]) -> Result<()> {
        self.step("sendMail", "sendMail".into())
    }
    fn create_mime_draft(&self, _: &[u8]) -> Result<ResourceId> {
        self.step("draft", "draft".into())?;
        ResourceId::new(ACCOUNT, ResourceKind::Message, "d1")
    }
    fn request_delivery_receipt(&self, draft: &ResourceId) -> Result<()> {
        self.step("receipt", format!("receipt:{}", draft.opaque()))
    }
    fn send_draft(&self, draft: &ResourceId) -> Result<()> {
        self.step("send", format!("send:{}", draft.opaque()))
    }
    fn delete_message(&self, id: &ResourceId) -> Result<()> {
        self.step("delete", format!("delete:{}", id.opaque()))
    }
}
fn sender() -> Sender {
    Sender { calls: Mutex::new(vec![]), fail: Mutex::new(HashMap::new()) }
}
fn calls(sender: &Sender) -> Vec<String> {
    sender.calls.lock().unwrap().clone()
}
fn kind_of(error: &anyhow::Error) -> Option<ErrorKind> {
    error.downcast_ref::<Error>().map(|e| e.kind)
}

#[test]
fn a_delivery_receipt_is_asked_on_a_draft_that_is_then_sent() {
    let source = sender();
    send_requesting_delivery(&source, b"x").unwrap();
    assert_eq!(calls(&source), vec!["draft", "receipt:d1", "send:d1"]);
}

#[test]
fn a_failure_before_sending_sends_nothing_and_removes_the_draft() {
    // The receipt could not be asked: the draft goes, nothing was sent.
    let source = sender();
    source.fail.lock().unwrap().insert("receipt", Error { kind: ErrorKind::Conflict, status: Some(409), retry_after_seconds: None });
    let error = send_requesting_delivery(&source, b"x").unwrap_err();
    let not_sent = error.downcast_ref::<NotSent>().expect("not sent");
    assert_eq!((not_sent.error.kind, not_sent.draft_left), (ErrorKind::Conflict, false));
    assert_eq!(calls(&source), vec!["draft", "receipt:d1", "delete:d1"]);

    // And if removing it fails too, that is said.
    let source = sender();
    source.fail.lock().unwrap().insert("receipt", Error::new(ErrorKind::Uncertain));
    source.fail.lock().unwrap().insert("delete", Error::new(ErrorKind::Throttled));
    let error = send_requesting_delivery(&source, b"x").unwrap_err();
    assert!(error.downcast_ref::<NotSent>().unwrap().draft_left);
    assert!(error.to_string().contains("nothing was sent") && error.to_string().contains("Drafts"), "{error}");

    // The draft itself went unanswered: one may exist; nothing was sent.
    let source = sender();
    source.fail.lock().unwrap().insert("draft", Error::new(ErrorKind::Uncertain));
    let error = send_requesting_delivery(&source, b"x").unwrap_err();
    assert!(error.downcast_ref::<NotSent>().unwrap().draft_left);
    assert_eq!(calls(&source), vec!["draft"]);

    // Failed on the server's side, or answered unreadably: maybe one too.
    for kind in [ErrorKind::Unavailable, ErrorKind::InvalidResponse] {
        let source = sender();
        source.fail.lock().unwrap().insert("draft", Error::new(kind));
        let error = send_requesting_delivery(&source, b"x").unwrap_err();
        assert!(error.downcast_ref::<NotSent>().unwrap().draft_left, "{kind:?}");
    }

    // Refused before anything was made: nothing left anywhere.
    let source = sender();
    source.fail.lock().unwrap().insert("draft", Error::new(ErrorKind::TooLarge));
    let error = send_requesting_delivery(&source, b"x").unwrap_err();
    let not_sent = error.downcast_ref::<NotSent>().unwrap();
    assert_eq!((not_sent.error.kind, not_sent.draft_left), (ErrorKind::TooLarge, false));
}

#[test]
fn an_unanswered_send_is_neither_undone_nor_repeated() {
    for unknown in [Error::new(ErrorKind::Uncertain), Error { kind: ErrorKind::Unavailable, status: Some(504), retry_after_seconds: None }] {
        let source = sender();
        let expected = unknown.kind;
        source.fail.lock().unwrap().insert("send", unknown);
        let error = send_requesting_delivery(&source, b"x").unwrap_err();
        assert!(error.downcast_ref::<NotSent>().is_none());
        assert_eq!(error.chain().find_map(|e| e.downcast_ref::<Error>()).map(|e| e.kind), Some(expected));
        // Microsoft may have it: the draft is not touched and not sent again,
        // and the person is told a copy may remain in Drafts.
        assert!(error.to_string().contains("may remain in Drafts"), "{error}");
        assert_eq!(calls(&source), vec!["draft", "receipt:d1", "send:d1"]);
    }
}

#[test]
fn a_refused_send_removes_the_draft_and_stays_a_refusal() {
    let source = sender();
    source.fail.lock().unwrap().insert("send", Error { kind: ErrorKind::AccessDenied, status: Some(403), retry_after_seconds: None });
    let error = send_requesting_delivery(&source, b"x").unwrap_err();
    assert!(error.downcast_ref::<NotSent>().is_none());
    assert_eq!(kind_of(&error), Some(ErrorKind::AccessDenied));
    assert_eq!(calls(&source), vec!["draft", "receipt:d1", "send:d1", "delete:d1"]);
}

/// The policy (ADR-0048, ADR-0057): the receipt is asked for exactly when
/// the sender wants one and the account allows changes as well as sending;
/// otherwise the message goes by `sendMail` without it, and says so.
#[tokio::test]
async fn a_graph_send_asks_for_a_delivery_receipt_exactly_when_the_policy_says() {
    use crate::smtp::DeliveryReceipt;
    let draft = vec!["draft", "receipt:d1", "send:d1"];
    let plain = vec!["sendMail"];
    // (asked, writes, bcc, protected) → what became of it, why, and how it went.
    let cases = [
        ((true, true, false, false), DeliveryReceipt::Requested, None, draft.clone()),
        ((true, false, false, false), DeliveryReceipt::Unsupported, Some(Withheld::NeedsChanges), plain.clone()),
        // Until a real tenant shows a draft keeps them (ADR-0057).
        ((true, true, true, false), DeliveryReceipt::Unsupported, Some(Withheld::Bcc), plain.clone()),
        ((true, true, false, true), DeliveryReceipt::Unsupported, Some(Withheld::Protected), plain.clone()),
        ((false, true, false, false), DeliveryReceipt::NotAsked, None, plain.clone()),
        ((false, false, true, true), DeliveryReceipt::NotAsked, None, plain.clone()),
    ];
    for ((asked, writes, bcc, protected), expected, why, steps) in cases {
        let (db, _, session) = writable_session();
        crate::store::setting_set(&db.lock().unwrap(), &auth::marker(ACCOUNT), &json!({"writes": writes, "send": true})).unwrap();
        let source = Arc::new(sender());
        let session = Session { source: source.clone(), ..session };
        let case = (asked, writes, bcc, protected);
        let outcome = session.send_mime_with_receipt(b"x".to_vec(), asked, bcc, protected).await.unwrap();
        assert_eq!(outcome, (expected, why), "{case:?}");
        assert_eq!(calls(&source), steps, "{case:?}");
        assert_eq!(delivery_receipt(&db.lock().unwrap(), ACCOUNT, asked, bcc, protected), (expected, why), "{case:?}");
    }
    assert_eq!(Withheld::NeedsChanges.as_str(), "needsChanges");
}

// ---- #210: reports read through Graph ----

const NDR: &str = "From: Microsoft Outlook <postmaster@contoso.example>\r\nTo: reader@example.test\r\nSubject: Undeliverable: Plan\r\nMessage-ID: <ndr1@contoso.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=\"r\"\r\n\r\n--r\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour message to nobody@contoso.example couldn't be delivered.\r\n--r\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns;AM0PR01MB0001.eurprd01.prod.example\r\n\r\nFinal-Recipient: rfc822;nobody@contoso.example\r\nAction: failed\r\nStatus: 5.1.10\r\nDiagnostic-Code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup\r\n\r\n--r\r\nContent-Type: text/rfc822-headers\r\n\r\nFrom: reader@example.test\r\nSubject: Plan\r\nMessage-ID: <plan-1@example.test>\r\n\r\n--r--\r\n";

#[tokio::test]
async fn a_report_without_attachments_is_read_from_its_mime() {
    let (_, reader, session, mut media) = reading_session("report");
    let mut fields = envelope("in", "m2");
    fields["body"] = json!({"contentType":"text","content":"Your message couldn't be delivered."});
    fields["singleValueExtendedProperties"] = json!([{"id":"String 0x1a","value":"REPORT.IPM.Note.NDR"}]);
    reader.inner.inner.full.lock().unwrap().insert("m2".into(), message("m2", fields));
    *reader.mime.lock().unwrap() = Some(Ok(NDR.as_bytes().to_vec()));
    media.uid = 2;
    let body = session.read_message("INBOX", 2, Some(media)).await.unwrap();
    let report = body.report.expect("read as a report");
    assert_eq!(report.original_message_id, "plan-1@example.test");
    assert_eq!(report.recipients[0].status, "5.1.10");
    assert_eq!(reader.mime_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_report_too_large_for_its_mime_still_shows_its_text() {
    let (_, reader, session, mut media) = reading_session("report-large");
    let mut fields = envelope("in", "m2");
    fields["body"] = json!({"contentType":"text","content":"Delivered"});
    fields["singleValueExtendedProperties"] = json!([{"id":"String 0x1a","value":"REPORT.IPM.Note.DR"}]);
    reader.inner.inner.full.lock().unwrap().insert("m2".into(), message("m2", fields));
    *reader.mime.lock().unwrap() = Some(Err(Error::new(ErrorKind::TooLarge)));
    media.uid = 2;
    let body = session.read_message("INBOX", 2, Some(media)).await.unwrap();
    assert!(body.body.contains("Delivered"));
    assert!(body.report.is_none());
}

/// A source that lists the reports in a folder and hands their MIME over.
struct Reports {
    inner: Writer,
    listed: Vec<String>,
    mime: Mutex<HashMap<String, Vec<u8>>>,
    reads: Mutex<Vec<String>>,
}
impl Source for Reports {
    fn folders(&self, p: Option<&ResourceId>, c: Option<&Checkpoint>) -> Result<Page<Folder>> {
        self.inner.folders(p, c)
    }
    fn well_known(&self, a: &str) -> Result<Folder> {
        self.inner.well_known(a)
    }
    fn delta(&self, f: &ResourceId, c: Option<&Checkpoint>) -> Result<Page<Message>> {
        self.inner.delta(f, c)
    }
    fn message(&self, id: &ResourceId) -> Result<Message> {
        self.inner.message(id)
    }
    fn report_ids(&self, folder: &ResourceId, limit: usize) -> Result<Vec<ResourceId>> {
        assert_eq!(folder.opaque(), "in");
        assert!(limit > 0);
        self.listed.iter().map(|id| ResourceId::new(ACCOUNT, ResourceKind::Message, id)).collect()
    }
    fn message_mime(&self, id: &ResourceId) -> Result<Vec<u8>> {
        self.reads.lock().unwrap().push(id.opaque().to_owned());
        self.mime.lock().unwrap().get(id.opaque()).cloned().ok_or_else(|| Error::new(ErrorKind::NotFound))
    }
}

/// #210: a report that arrived is read at sync, so the sent message it
/// names shows what it says before anybody opens it; it is read once.
#[tokio::test]
async fn reports_are_read_at_sync_and_linked_without_being_opened() {
    let (db, writer, session) = writable_session();
    let lease = session.lease.clone();
    drop(session);
    let writer = Arc::into_inner(writer).unwrap();
    // m3 is the message this account sent; m2 is a bounce about it; m1 a
    // report whose MIME says nothing readable.
    let sent = crate::parse::Message { message_id: "plan-1@example.test".into(), ..Default::default() };
    crate::store::save_cached_message(&db.lock().unwrap(), ACCOUNT, "INBOX", 3, &sent).unwrap();
    let source = Arc::new(Reports {
        inner: writer,
        listed: vec!["m2".into(), "m1".into()],
        mime: Mutex::new(HashMap::from([
            ("m2".to_string(), NDR.as_bytes().to_vec()),
            ("m1".to_string(), b"Subject: odd\r\n\r\nnot a report".to_vec()),
        ])),
        reads: Mutex::new(vec![]),
    });
    let session = Session { db: db.clone(), lease, source: source.clone(), lock: Arc::new(Mutex::new(())) };
    enqueue(&source.inner.inner, page("in", "sync-1", true, vec![]));
    session.sync_folder("INBOX", 50).await.unwrap();
    let linked = crate::receipts::report::outcomes(&db.lock().unwrap(), ACCOUNT, "plan-1@example.test").unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].status, "5.1.10");
    assert_eq!(source.reads.lock().unwrap().clone(), vec!["m2", "m1"]);
    // The next sync reads neither again.
    enqueue(&source.inner.inner, page("in", "sync-2", true, vec![]));
    session.sync_folder("INBOX", 50).await.unwrap();
    assert_eq!(source.reads.lock().unwrap().len(), 2);
}
