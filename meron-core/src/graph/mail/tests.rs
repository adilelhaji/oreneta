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
    let body = session.read_message("INBOX", 1).await.unwrap();
    assert!(body.body.contains("Safe text"));
    let html = crate::parse::prepare_html(body.body_html.as_deref().unwrap(), false);
    assert!(!html.contains("<script>"));
    assert!(html.contains("Content-Security-Policy"));
    source.full.lock().unwrap().clear();
    assert!(
        session
            .read_message("INBOX", 1)
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
