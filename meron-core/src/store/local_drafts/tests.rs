use super::*;

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::run_migrations(&conn).unwrap();
    conn
}

fn document() -> Value {
    json!({"version":1,"context":{"kind":"compose"},"compose":{
        "accountId":"account-a","fromEmail":"alias@example.test","to":"\"García, Ana\" <ana@example.test>",
        "cc":"cc@example.test","bcc":"hidden@example.test","replyTo":"reply@example.test",
        "subject":"Borrador 日本語","rich":true,"html":"<p>Hola</p>","text":"Hola",
        "showCcBcc":true,"inReplyTo":"parent@example.test","references":"root@example.test",
        "draftMessageId":"local-draft-old","pgpSign":false,"pgpEncrypt":false,
        "attachments":[{"id":"file-1","filename":"foto.png","mime":"image/png","size":3,"data":"AAH/","inlineId":"image@example.test"}],
        "signature":null,"futureOptionalField":{"kept":true}
    }})
}

fn save(conn: &Connection, id: &str, revision: i64, document: &Value) -> Result<Value> {
    dispatch(conn, "localDrafts.save", &json!({"id":id,"expected_revision":revision,"document":document}))
}
fn get(conn: &Connection, id: &str) -> Value {
    dispatch(conn, "localDrafts.get", &json!({"id":id})).unwrap()["draft"].clone()
}
fn delete(conn: &Connection, id: &str, revision: i64) -> Value {
    dispatch(conn, "localDrafts.delete", &json!({"id":id,"expected_revision":revision})).unwrap()
}

struct Profile(std::path::PathBuf);
impl Profile {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("oreneta-local-drafts-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn db(&self) -> std::path::PathBuf { self.0.join("profile.db") }
}
impl Drop for Profile {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[test]
fn complete_document_survives_encrypted_reopen_and_preserves_unknown_fields() {
    let profile = Profile::new();
    let key = "ab".repeat(32);
    let doc = document();
    {
        let conn = crate::store::open_at_keyed(profile.db(), &key).unwrap();
        assert_eq!(save(&conn, "draft-1", 0, &doc).unwrap(), json!({"applied":true,"revision":1,"deleted":false}));
        assert_eq!(get(&conn, "draft-1")["document"], doc);
    }
    let conn = crate::store::open_at_keyed(profile.db(), &key).unwrap();
    assert_eq!(get(&conn, "draft-1")["document"], doc);
    assert!(crate::store::open_at_keyed(profile.db(), &"cd".repeat(32)).is_err());
}

#[test]
fn migration_preserves_legacy_state_and_is_idempotent() {
    let conn = conn();
    conn.execute_batch("DROP TABLE local_drafts; PRAGMA user_version=34; INSERT INTO settings(key,value) VALUES('keep','42')").unwrap();
    crate::store::run_migrations(&conn).unwrap();
    save(&conn, "draft", 0, &document()).unwrap();
    crate::store::run_migrations(&conn).unwrap();
    assert_eq!(get(&conn, "draft")["revision"], 1);
    assert_eq!(crate::store::settings_get(&conn, &["keep".into()]).unwrap()["keep"], 42);
    assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(),35);
}

#[test]
fn independent_documents_account_move_and_removed_account_remain_recoverable() {
    let conn = conn();
    let a = document();
    let mut b = document(); b["compose"]["accountId"] = json!("account-b");
    save(&conn,"first",0,&a).unwrap();
    save(&conn,"second",0,&b).unwrap();
    let list = dispatch(&conn,"localDrafts.list",&json!({"account_id":"account-a"})).unwrap();
    assert_eq!(list["drafts"].as_array().unwrap().len(),1);
    assert_eq!(list["drafts"][0]["id"],"first");
    assert!(list["drafts"][0].get("document").is_none());
    assert_eq!(save(&conn,"first",1,&b).unwrap()["revision"],2);
    assert!(dispatch(&conn,"localDrafts.list",&json!({"account_id":"account-a"})).unwrap()["drafts"].as_array().unwrap().is_empty());
    conn.execute("DELETE FROM accounts", []).unwrap();
    assert_eq!(get(&conn,"first")["document"],b);
    assert_eq!(get(&conn,"second")["revision"],1);
}

#[test]
fn two_connections_cannot_silently_overwrite_the_same_revision() {
    let profile = Profile::new();
    let conn = crate::store::open_at(profile.db()).unwrap();
    save(&conn,"draft",0,&document()).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2).map(|n| {
        let path = profile.db(); let barrier = barrier.clone();
        std::thread::spawn(move || {
            let conn = crate::store::open_at(path).unwrap();
            let mut doc = document(); doc["compose"]["subject"] = json!(format!("writer-{n}"));
            barrier.wait();
            (save(&conn,"draft",1,&doc).unwrap(),doc)
        })
    }).collect();
    let results: Vec<_> = handles.into_iter().map(|h|h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|(r,_)|r["applied"]==true).count(),1);
    assert_eq!(results.iter().filter(|(r,_)|r["applied"]==false).count(),1);
    assert_eq!(get(&conn,"draft")["document"],results.iter().find(|(r,_)|r["applied"]==true).unwrap().1);
}

#[test]
fn tombstones_block_first_save_stale_updates_and_explicit_id_reuse() {
    let conn = conn();
    assert_eq!(delete(&conn,"never-saved",0)["revision"],1);
    for expected in [0,1] { assert_eq!(save(&conn,"never-saved",expected,&document()).unwrap()["applied"],false); }
    save(&conn,"draft",0,&document()).unwrap();
    assert_eq!(delete(&conn,"draft",0)["applied"],false);
    assert_eq!(delete(&conn,"draft",1)["revision"],2);
    for expected in [0,1,2] { assert_eq!(save(&conn,"draft",expected,&document()).unwrap()["applied"],false); }
    assert_eq!(get(&conn,"draft")["document"],Value::Null);
    assert_eq!(get(&conn,"draft")["deleted"],true);
    assert!(dispatch(&conn,"localDrafts.list",&json!({})).unwrap()["drafts"].as_array().unwrap().is_empty());
    assert!(get(&conn,"missing").is_null());
}

#[test]
fn rejected_inputs_leave_previous_revision_and_bytes_intact() {
    let conn = conn(); let original = document(); save(&conn,"draft",0,&original).unwrap();
    let mut cases = vec![];
    let mut doc = original.clone(); doc["version"]=json!(2); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["to"]=Value::Null; cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["rich"]=json!("yes"); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["attachments"][0]["data"]=json!("!!!!"); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["attachments"][0]["size"]=json!(2); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["attachments"][0]["size"]=json!(-1); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["attachments"].as_array_mut().unwrap().push(original["compose"]["attachments"][0].clone()); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["text"]=json!("x".repeat(MAX_BODY+1)); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["subject"]=json!("x".repeat(64*1024+1)); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["attachments"]=json!(vec![original["compose"]["attachments"][0].clone();65]); cases.push(doc);
    let mut doc = original.clone(); doc["compose"]["attachments"][0]["size"]=json!(MAX_ATTACHMENT_BYTES+1); cases.push(doc);
    for doc in cases {
        let error = save(&conn,"draft",1,&doc).unwrap_err().to_string();
        assert!(!error.contains("example.test"));
        assert_eq!(get(&conn,"draft")["document"],original);
        assert_eq!(get(&conn,"draft")["revision"],1);
    }
    for id in ["", "../escape", "space here", "í", &"x".repeat(129)] { assert!(save(&conn,id,0,&original).is_err()); }
    for expected in [json!(-1),json!(1.5),Value::Null,json!(MAX_REVISION+1)] {
        assert!(dispatch(&conn,"localDrafts.delete",&json!({"id":"draft","expected_revision":expected})).is_err());
    }
    assert!(dispatch(&conn,"localDrafts.save",&json!({"id":"draft","expected_revision":1})).is_err());
    assert!(dispatch(&conn,"localDrafts.list",&json!({"account_id":true})).is_err());
}

#[test]
fn exact_limits_work_and_aggregate_attachment_and_document_limits_are_enforced() {
    let mut doc = document();
    doc["compose"]["text"]=json!("x".repeat(MAX_BODY));
    doc["compose"]["subject"]=json!("x".repeat(64*1024));
    doc["compose"]["attachments"]=json!((0..64).map(|n|json!({"id":format!("file-{n}"),"filename":"empty","mime":"text/plain","size":0,"data":""})).collect::<Vec<_>>());
    assert!(validate(&doc).is_ok());
    doc["extra"]=json!("x".repeat(MAX_DOCUMENT));
    assert!(validate(&doc).unwrap_err().to_string().contains("document exceeds"));
    drop(doc);
    let mut doc = document();
    let bytes = vec![7u8; MAX_ATTACHMENT_BYTES];
    doc["compose"]["attachments"][0]["data"] = json!(STANDARD.encode(&bytes));
    doc["compose"]["attachments"][0]["size"] = json!(MAX_ATTACHMENT_BYTES);
    assert!(validate(&doc).is_ok());
    doc["compose"]["attachments"].as_array_mut().unwrap().push(json!({"id":"more","filename":"more","mime":"text/plain","size":1,"data":"AA=="}));
    assert!(validate(&doc).unwrap_err().to_string().contains("attachments exceed"));
}

#[test]
fn active_limit_allows_updates_and_discard_but_never_purges_tombstones() {
    let conn = conn(); let doc=document();
    for n in 0..MAX_ACTIVE { save(&conn,&format!("draft-{n}"),0,&doc).unwrap(); }
    assert!(save(&conn,"extra",0,&doc).is_err());
    assert_eq!(save(&conn,"draft-0",1,&doc).unwrap()["applied"],true);
    delete(&conn,"draft-0",2);
    assert_eq!(save(&conn,"extra",0,&doc).unwrap()["applied"],true);
    assert_eq!(get(&conn,"draft-0")["deleted"],true);
}

#[test]
fn write_failure_rolls_back_and_restores_connection_sync_mode() {
    let conn=conn(); let doc=document(); save(&conn,"draft",0,&doc).unwrap();
    conn.pragma_update(None,"synchronous",1).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_draft BEFORE UPDATE ON local_drafts BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;").unwrap();
    let mut changed=doc.clone(); changed["compose"]["subject"]=json!("new");
    assert!(save(&conn,"draft",1,&changed).is_err());
    assert!(dispatch(&conn,"localDrafts.delete",&json!({"id":"draft","expected_revision":1})).is_err());
    assert_eq!(get(&conn,"draft")["document"],doc);
    assert_eq!(get(&conn,"draft")["revision"],1);
    assert_eq!(conn.pragma_query_value(None,"synchronous",|r|r.get::<_,i64>(0)).unwrap(),1);
    conn.execute_batch("DROP TRIGGER fail_draft; PRAGMA query_only=ON;").unwrap();
    assert!(save(&conn,"draft",1,&changed).is_err());
    assert_eq!(get(&conn,"draft")["document"],doc);
}

#[test]
fn corrupt_or_future_stored_documents_are_not_silently_recovered_as_empty() {
    let conn=conn(); save(&conn,"draft",0,&document()).unwrap();
    for corrupt in ["{broken".to_string(),json!({"version":2}).to_string()] {
        conn.execute("UPDATE local_drafts SET document=?1 WHERE id='draft'",[&corrupt]).unwrap();
        assert!(dispatch(&conn,"localDrafts.get",&json!({"id":"draft"})).is_err());
        assert_eq!(conn.query_row("SELECT document FROM local_drafts WHERE id='draft'",[],|r|r.get::<_,String>(0)).unwrap(),corrupt);
    }
}
