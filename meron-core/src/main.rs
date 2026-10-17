//! meron-core: the Meron core engine sidecar (mail, RSS, storage).
//!
//! Speaks a line-delimited JSON protocol over stdio so the desktop bridge can drive
//! it as a single long-lived process. Three message shapes, one JSON object per line:
//!
//!   request   (bridge -> sidecar):  {"id":<u64>,"method":<str>,"params":<json>}
//!   response  (sidecar -> bridge):  {"id":<u64>,"result":<json>}
//!                              or:  {"id":<u64>,"error":{"message":<str>}}
//!   event     (sidecar -> bridge):  {"event":<str>,"detail":<json>}   (no id)
//!
//! Events carry IMAP IDLE notifications to the UI (the bridge distinguishes them
//! by the absent `id`). The request path reuses warm IMAP sessions via a
//! per-account connection pool (see `Engine::with_session`); IDLE watchers hold
//! their own dedicated long-lived connections.

use anyhow::Context as _;
use serde_json::{Value, json};
use std::future::Future;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};
use tokio::sync::Mutex;

// The binary shares the library crate's modules (rather than recompiling its own
// copies) so the desktop Engine and the mobile FFI operate on identical types.
use meron_core::engine::*;
use meron_core::engine::{Engine, EngineHost};
use meron_core::pim;
use meron_core::pim::calendar::{caldav_target, caldav_write, local_calendar_write, CALDAV_CONFLICT};
use meron_core::pim::people::carddav_create;
use meron_core::protocol::{Request, ping_response, ready_event};
use meron_core::store::outgoing;
use meron_core::sweep_review;
use meron_core::{
    assistant, backup, cached_conversations, calendar, changelog, exchange, imap, mail_model, parse, priority, proxy, rss, rules,
    search, secrets, smtp, spam, store, thread_list, thread_read, unified,
};

/// Shared, serialized writer so responses and events never interleave on stdout.
type Writer = Arc<Mutex<Stdout>>;

const BACKGROUND_SYNC_RETRY_DELAY: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    Duration::from_secs(2)
};

/// The shared retry ([`retry_background_sync_after`]) with this process's
/// delay, which tests shorten to nothing.
async fn retry_background_sync<T, C, F, Fut>(label: &str, can_attempt: C, operation: F) -> anyhow::Result<T>
where
    C: FnMut() -> bool,
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    retry_background_sync_after(label, BACKGROUND_SYNC_RETRY_DELAY, can_attempt, operation).await
}

#[cfg(test)]
mod tests {
    use super::{BackgroundSyncCancelled, is_transient_sync_error, retry_background_sync};
    use super::{merge_outcome, scheduled_outcome_of, scheduled_send_precheck, sent_late, strip_send_secrets, ScheduledOutcome};
    use meron_core::store::outgoing::{AttemptKind, AttemptState, OutgoingAttempt};

    fn earlier(state: AttemptState, error: &str) -> OutgoingAttempt {
        OutgoingAttempt {
            id: "s-1".to_string(),
            account: "acct".to_string(),
            kind: AttemptKind::Scheduled,
            message_id: String::new(),
            subject: "Later".to_string(),
            recipients: "bob@example.com".to_string(),
            payload: "{}".to_string(),
            state,
            error: error.to_string(),
            archive_error: String::new(),
            created_at: 1,
            updated_at: 2,
        }
    }

    /// H03 from #29: a scheduled row still present after the server accepted
    /// its message is a crash between sending and forgetting, and must be
    /// reported as sent — never sent again. An unanswered try stays
    /// unanswered. Only a refusal, or nothing at all, is tried.
    #[test]
    fn a_scheduled_row_whose_attempt_already_went_is_not_sent_twice() {
        assert!(scheduled_send_precheck(None).is_none(), "never tried: send it");
        assert!(scheduled_send_precheck(Some(&earlier(AttemptState::Rejected, "550 no"))).is_none());
        assert!(scheduled_send_precheck(Some(&earlier(AttemptState::Resolved, ""))).is_none());

        assert!(matches!(
            scheduled_send_precheck(Some(&earlier(AttemptState::Accepted, ""))),
            Some(ScheduledOutcome::Sent)
        ));
        assert!(matches!(
            scheduled_send_precheck(Some(&earlier(AttemptState::Archived, ""))),
            Some(ScheduledOutcome::Sent)
        ));
        match scheduled_send_precheck(Some(&earlier(AttemptState::Uncertain, "connection reset"))) {
            Some(ScheduledOutcome::Uncertain(reason)) => assert_eq!(reason, "connection reset"),
            other => panic!("an unanswered try stays unanswered, got {}", describe(other)),
        }
        // The reason is supplied when the record has none.
        match scheduled_send_precheck(Some(&earlier(AttemptState::Uncertain, ""))) {
            Some(ScheduledOutcome::Uncertain(reason)) => assert!(reason.contains("stopped"), "{reason}"),
            other => panic!("got {}", describe(other)),
        }
        // #89: still sending means sending now, in this process (startup
        // turned a dead process's rows uncertain before the watch began).
        // The second caller leaves the row to the first.
        assert!(matches!(
            scheduled_send_precheck(Some(&earlier(AttemptState::Sending, ""))),
            Some(ScheduledOutcome::InFlight)
        ));
    }

    /// #89: the watch and "send now" (or a held reply let go) reaching the
    /// same message at once. The one that finds it already attempted must
    /// not report it sent and drop its row: the first may still be refused.
    #[test]
    fn an_already_attempted_answer_is_not_taken_for_a_sent_message() {
        let answer = |state: &str| {
            serde_json::json!({ "ok": false, "outcome": "already_attempted", "state": state, "error": "" })
        };
        assert!(matches!(scheduled_outcome_of(&answer("sending")), ScheduledOutcome::InFlight));
        assert!(matches!(scheduled_outcome_of(&answer("accepted")), ScheduledOutcome::Sent));
        assert!(matches!(scheduled_outcome_of(&answer("archived")), ScheduledOutcome::Sent));
        assert!(matches!(scheduled_outcome_of(&answer("uncertain")), ScheduledOutcome::Uncertain(_)));
        assert!(matches!(
            scheduled_outcome_of(&serde_json::json!({ "ok": true, "outcome": "accepted" })),
            ScheduledOutcome::Sent
        ));
        assert!(matches!(
            scheduled_outcome_of(&serde_json::json!({ "ok": false, "outcome": "uncertain", "error": "reset" })),
            ScheduledOutcome::Uncertain(reason) if reason == "reset"
        ));
    }

    /// #90: a mailing's message is accepted, refused, deferred (the batch
    /// waits) or uncertain (never sent again on its own) by its answer.
    #[test]
    fn a_mailing_message_settles_from_its_send_answer() {
        use meron_core::merge::Outcome;
        let ok = |v: serde_json::Value| merge_outcome(Ok(v));
        assert!(matches!(ok(serde_json::json!({ "ok": true, "outcome": "archived" })), Outcome::Accepted));
        assert!(matches!(ok(serde_json::json!({ "ok": false, "outcome": "uncertain", "error": "reset" })), Outcome::Uncertain(_)));
        assert!(matches!(
            ok(serde_json::json!({ "ok": false, "outcome": "already_attempted", "state": "sending" })),
            Outcome::Uncertain(_)
        ));
        assert!(matches!(merge_outcome(Err(anyhow::anyhow!("451 4.7.1 try again later"))), Outcome::Deferred(_)));
        assert!(matches!(merge_outcome(Err(anyhow::anyhow!("550 no such user"))), Outcome::Rejected(_)));
    }

    #[test]
    fn a_scheduled_message_is_stored_without_a_passphrase_and_late_is_said() {
        let mut message = serde_json::json!({ "to": "bob@example.com", "passphrase": "secret", "sign": true });
        strip_send_secrets(&mut message);
        assert_eq!(message, serde_json::json!({ "to": "bob@example.com", "sign": true }));
        assert!(!sent_late(1_000, 1_000 + 60), "the watch ticks every minute: that is on time");
        assert!(sent_late(1_000, 1_000 + 3_600));
    }

    fn describe(outcome: Option<ScheduledOutcome>) -> String {
        match outcome {
            None => "None".to_string(),
            Some(ScheduledOutcome::Sent) => "Sent".to_string(),
            Some(ScheduledOutcome::Uncertain(reason)) => format!("Uncertain({reason})"),
            Some(ScheduledOutcome::InFlight) => "InFlight".to_string(),
        }
    }
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct GraphTestHost;
    impl meron_core::engine::EngineHost for GraphTestHost {
        fn open_db(&self) -> anyhow::Result<rusqlite::Connection> { meron_core::store::open_at(":memory:") }
        fn apply_secret(&self, _: &rusqlite::Connection, _: &str, _: &mut meron_core::imap::Creds) {}
        fn store_secret(&self, _: &rusqlite::Connection, _: &str, _: &meron_core::secrets::Secrets) -> anyhow::Result<()> { Ok(()) }
    }
    #[tokio::test]
    async fn automatic_archiving_is_off_until_its_preview_is_confirmed() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        {
            let db = engine.db.lock().unwrap();
            db.execute(
                "INSERT INTO accounts(id, email, display_name, config) VALUES('ana', 'ana@x.cat', 'Ana',
                   '{\"auth_type\":\"password\",\"host\":\"imap.x.cat\",\"tls\":true}')",
                [],
            )
            .unwrap();
            let folder = |name: &str, role: Option<&str>| meron_core::imap::Folder {
                name: name.into(),
                display_name: name.into(),
                special_use: role.map(str::to_string),
                ..Default::default()
            };
            store::upsert_folders(&db, "ana", &[folder("INBOX", None), folder("Drafts", Some("drafts")), folder("Archive", Some("archive"))])
                .unwrap();
        }
        let status = call("autoArchive.status", json!({"account": "ana"})).await.unwrap();
        assert_eq!(status["policy"]["enabled"], false);
        assert_eq!(status["policy"]["folders"][0]["name"], "INBOX");
        assert_eq!(status["confirmed"], false);
        assert_eq!(status["next_run"], Value::Null);
        assert_eq!(status["local_supported"], true);
        assert_eq!(status["folders"][1]["refused"], "drafts");

        let mut policy = status["policy"].clone();
        policy["enabled"] = json!(true);
        let refused = call("autoArchive.save", json!({"account": "ana", "policy": policy})).await.unwrap_err();
        assert!(refused.to_string().contains("confirm"), "{refused}");
        let mut drafts = policy.clone();
        drafts["enabled"] = json!(false);
        drafts["folders"] = json!([{ "name": "Drafts" }]);
        assert!(call("autoArchive.save", json!({"account": "ana", "policy": drafts})).await.is_err());
        let ran = call("autoArchive.runNow", json!({"account": "ana"})).await.unwrap_err();
        assert!(ran.to_string().contains("confirm"), "{ran}");

        let print = meron_core::auto_archive::fingerprint("ana", &serde_json::from_value(policy.clone()).unwrap());
        let saved = call("autoArchive.save", json!({"account": "ana", "policy": policy, "confirm": print})).await.unwrap();
        assert_eq!((saved["policy"]["enabled"].clone(), saved["confirmed"].clone()), (json!(true), json!(true)));
        assert_eq!(saved["next_run"], 0);
        assert!(call("autoArchive.status", json!({"account": "nobody"})).await.is_err());
    }

    #[tokio::test]
    async fn an_mbox_is_imported_into_the_local_archive_and_read_with_the_ordinary_mail_commands() {
        use super::*;
        let dir = std::env::temp_dir().join(format!("oreneta-archive-dispatch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: tests in this binary that touch the media root use their own directory.
        unsafe { std::env::set_var("MERON_MEDIA_DIR", dir.join("media")) };
        let mbox = dir.join("old.mbox");
        std::fs::write(
            &mbox,
            "From ana@x.cat Mon Oct  5 09:00:00 2026\nFrom: Ana <ana@x.cat>\nSubject: Budget\nDate: Mon, 5 Oct 2026 09:00:00 +0000\nMessage-ID: <a@x>\n\nNumbers attached.\n\n\
             From bo@x.cat Mon Oct  5 10:00:00 2026\nFrom: Bo <bo@x.cat>\nSubject: Re: Budget\nDate: Mon, 5 Oct 2026 10:00:00 +0000\nMessage-ID: <b@x>\nIn-Reply-To: <a@x>\nReferences: <a@x>\n\nThanks.\n",
        )
        .unwrap();
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let paths = json!([mbox.to_string_lossy()]);

        let preview = call("archive.preview", json!({"paths": paths})).await.unwrap();
        assert_eq!(preview["summary"]["imported"], 2);
        assert!(store::load_account(&engine.db.lock().unwrap(), meron_core::archive::ACCOUNT).unwrap().is_none(), "a preview creates nothing");

        let imported = call("archive.import", json!({"paths": paths})).await.unwrap();
        assert_eq!((imported["summary"]["imported"].clone(), imported["created"].clone()), (json!(2), json!(true)));
        let again = call("archive.import", json!({"paths": paths})).await.unwrap();
        assert_eq!(again["summary"]["duplicates"], 2, "a second import adds nothing");

        let account = meron_core::archive::ACCOUNT;
        let listed = call("account.list", json!({})).await.unwrap();
        let archive = listed["accounts"].as_array().unwrap().iter().find(|a| a["id"] == account).cloned().unwrap();
        assert_eq!(archive["needs_reconnect"], false);
        let folders = call("folders.list", json!({"account": account})).await.unwrap();
        let text = folders.to_string();
        assert!(text.contains("INBOX") && text.contains("Trash"), "{text}");

        let thread_key = store::recent_headers(&engine.db.lock().unwrap(), account, "INBOX", 10).unwrap()[0].thread_key.clone();
        let thread = call("messages.thread", json!({"account": account, "folder": "INBOX", "thread_key": thread_key, "limit": 20})).await.unwrap();
        let rendered = thread.to_string();
        assert!(rendered.contains("Numbers attached") && rendered.contains("Thanks"), "both messages read, no server: {rendered}");

        // Exporting the folder writes the same messages back out as mboxrd.
        let out = dir.join("export.mbox");
        let exported = call("messages.exportMbox", json!({"account": account, "folder": "INBOX", "path": out.to_string_lossy()})).await.unwrap();
        assert_eq!(exported["exported"], 2);
        let back = meron_core::archive::split_mbox(&std::fs::read(&out).unwrap());
        assert_eq!(back.len(), 2);
        assert!(String::from_utf8_lossy(&back[1]).contains("Message-ID: <b@x>"));
        assert!(!dir.join("export.mbox.part").exists());
        let first_uid = store::recent_headers(&engine.db.lock().unwrap(), account, "INBOX", 10).unwrap().iter().map(|h| h.uid).min().unwrap();
        let one = call("messages.exportMbox", json!({"account": account, "folder": "INBOX", "path": out.to_string_lossy(), "uids": [first_uid]})).await.unwrap();
        assert_eq!(one["exported"], 1);
        let nowhere = dir.join("missing").join("x.mbox");
        assert!(call("messages.exportMbox", json!({"account": account, "folder": "INBOX", "path": nowhere.to_string_lossy()})).await.is_err());

        // Deleting moves to the archive's Trash, like any account.
        call("messages.delete", json!({"account": account, "folder": "INBOX", "thread_key": thread_key})).await.unwrap();
        let db = engine.db.lock().unwrap();
        assert!(store::recent_headers(&db, account, "INBOX", 10).unwrap().is_empty());
        assert_eq!(store::recent_headers(&db, account, "Trash", 10).unwrap().len(), 2);
        drop(db);

        // Thunderbird (ADR-0041): a profile's folders go to the archive under
        // Thunderbird/<account>/<folders>; deleted-but-not-compacted mail stays out.
        let tb = dir.join("tb-profile");
        let local = tb.join("Mail/Local Folders");
        std::fs::create_dir_all(local.join("Work.sbd")).unwrap();
        let message = |id: &str, status: &str| {
            format!("From - Mon Oct 05 09:00:00 2026\nX-Mozilla-Status: {status}\nFrom: Ana <ana@x.cat>\nSubject: {id}\nMessage-ID: <{id}@tb>\nDate: Mon, 5 Oct 2026 09:00:00 +0000\n\nBody {id}\n\n")
        };
        std::fs::write(local.join("Inbox"), message("kept", "0001") + &message("deleted", "0009")).unwrap();
        std::fs::write(local.join("Inbox.msf"), "").unwrap();
        std::fs::write(local.join("Work.sbd/Projects"), message("project", "0001")).unwrap();
        std::fs::write(local.join("Work.sbd/Projects.msf"), "").unwrap();
        let scanned = call("thunderbird.scan", json!({"path": tb.to_string_lossy()})).await.unwrap();
        let ids: Vec<String> = scanned["folders"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["Mail/Local Folders/Inbox", "Mail/Local Folders/Work.sbd/Projects"]);
        let preview = call("thunderbird.preview", json!({"path": tb.to_string_lossy(), "folders": ids})).await.unwrap();
        assert_eq!(preview["folders"][0]["target"], "Thunderbird/Local Folders/Inbox");
        assert_eq!((preview["folders"][0]["summary"]["imported"].clone(), preview["folders"][0]["deleted"].clone()), (json!(1), json!(1)));
        assert!(store::recent_headers(&engine.db.lock().unwrap(), account, "Thunderbird/Local Folders/Inbox", 10).unwrap().is_empty(), "a preview stores nothing");
        call("thunderbird.import", json!({"path": tb.to_string_lossy(), "folders": ids})).await.unwrap();
        let again = call("thunderbird.import", json!({"path": tb.to_string_lossy(), "folders": ids})).await.unwrap();
        assert_eq!(again["folders"][1]["summary"]["duplicates"], 1, "importing twice adds nothing");
        let kept = store::recent_headers(&engine.db.lock().unwrap(), account, "Thunderbird/Local Folders/Inbox", 10).unwrap();
        assert_eq!(kept.iter().map(|h| h.subject.as_str()).collect::<Vec<_>>(), ["kept"]);
        assert_eq!(store::recent_headers(&engine.db.lock().unwrap(), account, "Thunderbird/Local Folders/Work/Projects", 10).unwrap().len(), 1);
        assert!(call("thunderbird.import", json!({"path": tb.to_string_lossy(), "folders": ["../../etc/passwd"]})).await.is_err(), "only folders the scan found are read");
    }

    #[tokio::test]
    async fn a_vcard_file_is_previewed_imported_once_and_exported_with_its_origin() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana Prat\r\nEMAIL:ana@x.cat\r\nEND:VCARD\r\n\
                   BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bo Ray\r\nEND:VCARD\r\n\
                   BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:nobody\r\nEND:VCARD\r\n";
        let preview = call("people.importPreview", json!({"vcf": vcf})).await.unwrap();
        assert_eq!((preview["people"].as_array().unwrap().len(), preview["skipped"].clone()), (2, json!(1)));
        assert!(call("people.list", json!({"query": ""})).await.unwrap()["people"].as_array().unwrap().is_empty(), "a preview stores nothing");

        let first = call("people.import", json!({"vcf": vcf})).await.unwrap();
        assert_eq!((first["imported"].clone(), first["duplicates"].clone()), (json!(2), json!(0)));
        let again = call("people.import", json!({"vcf": vcf})).await.unwrap();
        assert_eq!((again["imported"].clone(), again["duplicates"].clone()), (json!(0), json!(2)), "importing twice does not double the book");

        let exported = call("people.exportVcf", json!({})).await.unwrap();
        assert_eq!(exported["count"], 2);
        let text = exported["vcf"].as_str().unwrap();
        assert!(text.contains("FN:Ana Prat") && text.contains("X-ORENETA-SOURCE:local"));
    }

    #[tokio::test]
    async fn task_lists_hold_standalone_tasks_beside_mail_ones() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let home = call("tasks.createList", json!({"name": "Home"})).await.unwrap()["id"].as_str().unwrap().to_owned();
        let task = json!({"list_id": home, "title": "Fix the tap", "priority": 2, "due_at": 100});
        let id = call("tasks.create", json!({"task": task})).await.unwrap()["id"].as_i64().unwrap();
        call("tasks.save", json!({"thread_id": "acct#INBOX#7", "note": "reply"})).await.unwrap();

        let listed = call("tasks.list", json!({})).await.unwrap();
        let rows = listed["tasks"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let standalone = rows.iter().find(|row| row["id"] == id).unwrap();
        assert_eq!((standalone["linked"].clone(), standalone["thread_id"].clone()), (json!(false), json!("")));
        assert_eq!(standalone["title"], "Fix the tap");
        assert!(rows.iter().any(|row| row["linked"] == true && row["list_id"] == "mail"));

        let lists = call("tasks.lists", json!({})).await.unwrap();
        assert_eq!(lists["lists"].as_array().unwrap().len(), 2);

        let edited = json!({"list_id": home, "title": "Fix the kitchen tap", "priority": 1});
        assert_eq!(call("tasks.update", json!({"id": id, "revision": 1, "task": edited})).await.unwrap()["revision"], 2);
        let stale = call("tasks.update", json!({"id": id, "revision": 1, "task": edited})).await.unwrap();
        assert_eq!(stale["conflict"], true);
        assert_eq!(stale["current"]["title"], "Fix the kitchen tap");

        assert!(call("tasks.deleteList", json!({"id": "mail"})).await.is_err());
        call("tasks.deleteList", json!({"id": home})).await.unwrap();
        assert_eq!(call("tasks.list", json!({})).await.unwrap()["tasks"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_task_list_on_a_server_that_cannot_be_reached_keeps_its_tasks_and_says_why() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        // Nothing listens on port 9: the first read fails, so nothing is added.
        let url = "http://127.0.0.1:9/ana/tasks/";
        let added = call("tasks.caldavAdd", json!({"url": url, "name": "Dav", "server": "http://127.0.0.1:9/", "username": "ana", "password": "pw"})).await;
        assert!(added.is_err());
        assert_eq!(call("tasks.lists", json!({})).await.unwrap()["lists"].as_array().unwrap().len(), 1);

        let id = meron_core::task_sync::add_list(&engine.db.lock().unwrap(), "Dav", url, "", "ana", 1).unwrap();
        let task = json!({"list_id": id, "title": "Kept here"});
        let task_id = call("tasks.create", json!({"task": task})).await.unwrap()["id"].as_i64().unwrap();
        let synced = call("tasks.sync", json!({})).await.unwrap();
        assert_eq!(synced["lists"][0]["ok"], false);
        let lists = call("tasks.lists", json!({})).await.unwrap();
        let bound = lists["lists"].as_array().unwrap().iter().find(|l| l["id"] == id.as_str()).unwrap().clone();
        assert_eq!(bound["remote_url"], url);
        assert!(!bound["last_error"].as_str().unwrap().is_empty());
        let listed = call("tasks.list", json!({})).await.unwrap();
        let row = listed["tasks"].as_array().unwrap().iter().find(|t| t["id"] == task_id).unwrap().clone();
        assert_eq!((row["pending"].clone(), row["conflict"].clone()), (json!("put"), json!("")));
        assert!(call("tasks.resolveConflict", json!({"id": task_id, "keep": "mine"})).await.is_err(), "no conflict to settle");
        call("tasks.deleteList", json!({"id": id})).await.unwrap();
        assert!(call("tasks.list", json!({})).await.unwrap()["tasks"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_profile_archive_is_written_and_inspected_without_touching_the_store_in_use() {
        use super::*;
        let dir = std::env::temp_dir().join(format!("oreneta-profile-dispatch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        call("notes.create", json!({"note": {"title": "In the archive", "html": "<p>x</p>"}})).await.unwrap();
        let path = dir.join("p.oreneta-profile");
        let written = call("profileArchive.export", json!({"path": path.to_string_lossy(), "passphrase": "long enough pass", "app_version": "9.9.9"})).await.unwrap();
        assert_eq!(written["summary"]["app_version"], "9.9.9");
        assert!(written["summary"].get("db_key").is_none());

        let inspected = call("profileArchive.inspect", json!({"path": path.to_string_lossy(), "passphrase": "long enough pass"})).await.unwrap();
        assert_eq!(inspected["summary"]["schema_version"], store::SCHEMA_VERSION);
        assert!(inspected.to_string().find("db_key").is_none(), "the store key never leaves the core");
        assert!(call("profileArchive.inspect", json!({"path": path.to_string_lossy(), "passphrase": "wrong one!"})).await.is_err());
        let titles = call("notes.list", json!({})).await.unwrap();
        assert_eq!(titles["notes"][0]["title"], "In the archive");

        // Scheduled backups (#173), in this test so that no other archive is
        // written at the same moment.
        let status = call("backupSchedule.status", json!({})).await.unwrap();
        assert_eq!(status["schedule"]["enabled"], false);
        let folder = dir.join("scheduled");
        std::fs::create_dir_all(&folder).unwrap();
        let schedule = json!({"enabled": true, "folder": folder.to_string_lossy(), "every_hours": 24, "keep": 3, "max_bytes": null});
        let _ = secrets::delete(meron_core::backup_schedule::SECRET_KEY);
        assert!(call("backupSchedule.save", json!({"schedule": schedule})).await.is_err(), "no password, not on");
        assert!(call("backupSchedule.save", json!({"schedule": schedule, "password": "short"})).await.is_err());
        let saved = call("backupSchedule.save", json!({"schedule": schedule, "password": "long enough pass"})).await.unwrap();
        assert_eq!(saved["password_saved"], true);
        assert!(saved.to_string().find("long enough pass").is_none(), "the password never comes back");
        let ran = call("backupSchedule.runNow", json!({})).await.unwrap();
        assert_eq!(ran["backups"].as_array().unwrap().len(), 1);
        assert_eq!(ran["backups"][0]["verified"], true);
        // A manual backup waits for a scheduled one, and the other way round.
        let held = meron_core::backup_schedule::capture_lock().unwrap();
        let busy = call("profileArchive.export", json!({"path": dir.join("q.oreneta-profile").to_string_lossy(), "passphrase": "long enough pass"})).await;
        assert!(busy.unwrap_err().to_string().contains("another backup"));
        assert!(call("backupSchedule.runNow", json!({})).await.is_err());
        drop(held);
        let _ = secrets::delete(meron_core::backup_schedule::SECRET_KEY);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_ics_file_is_previewed_imported_once_and_exported_from_a_local_calendar() {
        use super::*;
        let dir = std::env::temp_dir().join(format!("oreneta-ics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let account = "acct@example.test";
        let home = call("calendar.createLocal", json!({"account": account, "name": "Home"})).await.unwrap()["id"].as_str().unwrap().to_owned();
        let file = dir.join("in.ics");
        std::fs::write(&file, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
BEGIN:VEVENT\r\nUID:a@x\r\nDTSTART:20300110T090000Z\r\nDTEND:20300110T100000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:b@x\r\nDTSTART:20300111T090000Z\r\nDTEND:20300111T100000Z\r\nSUMMARY:Plumber\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n").unwrap();
        let params = json!({"account": account, "calendar": home, "path": file.to_string_lossy()});

        let preview = call("calendar.importIcs", params.clone()).await.unwrap();
        assert_eq!((preview["summary"]["added"].clone(), preview["imported"].clone()), (json!(2), json!(false)));
        assert!(calendar::events_of_calendar(&engine.db.lock().unwrap(), account, &home).unwrap().is_empty(), "a preview stores nothing");

        let mut confirm = params.clone();
        confirm["confirm"] = json!(true);
        assert_eq!(call("calendar.importIcs", confirm.clone()).await.unwrap()["summary"]["added"], 2);
        let again = call("calendar.importIcs", confirm).await.unwrap();
        assert_eq!((again["summary"]["added"].clone(), again["summary"]["duplicates"].clone()), (json!(0), json!(2)));

        let out = dir.join("out.ics");
        let exported = call("calendar.exportIcs", json!({"account": account, "calendar": home, "path": out.to_string_lossy()})).await.unwrap();
        assert_eq!(exported["events"], 2);
        let written = std::fs::read_to_string(&out).unwrap();
        assert!(written.contains("SUMMARY:Dentist") && written.contains("SUMMARY:Plumber"));
        assert!(!dir.join("out.ics.part").exists());

        // A subscription cannot take imported events.
        let refused = call("calendar.importIcs", json!({"account": account, "calendar": "missing", "path": file.to_string_lossy()})).await;
        assert!(refused.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_invitation_is_answered_kept_in_a_calendar_and_removed_when_cancelled() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let account = "bo@example.com";
        let home = call("calendar.createLocal", json!({"account": account, "name": "Home"})).await.unwrap()["id"].as_str().unwrap().to_owned();
        let request = |sequence: i64, method: &str| format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:{method}\r\nBEGIN:VEVENT\r\nUID:meet@example.com\r\nSEQUENCE:{sequence}\r\n\
DTSTART:20300110T090000Z\r\nDTEND:20300110T100000Z\r\nSUMMARY:Planning\r\nORGANIZER;CN=Ana:mailto:ana@example.com\r\n\
ATTENDEE;RSVP=TRUE:mailto:bo@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");

        let answered = call("invite.respond", json!({
            "account": account, "ics": request(2, "REQUEST"), "response": "accept",
            "me_name": "Bo", "me_addr": "Bo@Example.com", "calendar": home,
        })).await.unwrap();
        assert_eq!(answered["reply"]["to"], "ana@example.com");
        assert_eq!(answered["reply"]["subject"], "Accepted: Planning");
        assert!(answered["reply"]["ics"].as_str().unwrap().contains("ATTENDEE;PARTSTAT=ACCEPTED;CN=Bo:mailto:bo@example.com"));
        let kept = calendar::events_of_calendar(&engine.db.lock().unwrap(), account, &home).unwrap();
        assert_eq!((kept.len(), kept[0].subject.as_str()), (1, "Planning"));

        let status = call("invite.status", json!({"account": account, "uid": "meet@example.com"})).await.unwrap();
        assert_eq!((status["answer"]["response"].clone(), status["calendars"].clone()), (json!("accept"), json!([home.clone()])));

        let old = call("invite.respond", json!({
            "account": account, "ics": request(1, "REQUEST"), "response": "decline", "me_addr": "bo@example.com", "calendar": home,
        })).await;
        assert!(old.unwrap_err().to_string().contains("newer version"), "an older invitation sends nothing");
        assert_eq!(calendar::events_of_calendar(&engine.db.lock().unwrap(), account, &home).unwrap().len(), 1);

        // The kept event is in the person's schedule, except for itself (ADR-0043).
        let (nine, ten) = (1_894_266_000i64, 1_894_269_600i64);
        let busy = call("calendar.conflicts", json!({"start": nine, "end": ten})).await.unwrap();
        assert!(busy["conflicts"].as_array().unwrap().iter().any(|c| c["account"] == account && c["subject"] == "Planning"));
        let itself = call("calendar.conflicts", json!({"start": nine, "end": ten, "exclude": ["meet@example.com"]})).await.unwrap();
        assert!(!itself["conflicts"].as_array().unwrap().iter().any(|c| c["account"] == account && c["subject"] == "Planning"));

        // Proposing another time: to the organizer, only for the current version.
        let proposed = call("invite.counter", json!({
            "account": account, "ics": request(2, "REQUEST"), "me_name": "Bo", "me_addr": "bo@example.com",
            "start": nine + 4 * 3600, "end": ten + 4 * 3600, "comment": "After lunch?",
        })).await.unwrap();
        assert_eq!((proposed["proposal"]["to"].clone(), proposed["proposal"]["subject"].clone()), (json!("ana@example.com"), json!("New time proposed: Planning")));
        let counter_ics = proposed["proposal"]["ics"].as_str().unwrap().to_owned();
        assert!(counter_ics.contains("METHOD:COUNTER") && counter_ics.contains("SEQUENCE:2") && counter_ics.contains("DTSTART:20300110T130000Z"));
        let stale = call("invite.counter", json!({
            "account": account, "ics": request(1, "REQUEST"), "me_addr": "bo@example.com", "start": nine, "end": ten,
        })).await;
        assert!(stale.unwrap_err().to_string().contains("newer version"));

        // The organizer's side: information only until the event is theirs here.
        let ana = "ana@example.com";
        let status = call("invite.counterStatus", json!({"account": ana, "me_addr": ana, "ics": counter_ics})).await.unwrap();
        assert_eq!((status["organizer"].clone(), status["outdated"].clone()), (json!(false), json!(false)));
        assert!(call("invite.declineCounter", json!({"account": ana, "me_addr": ana, "ics": counter_ics})).await.is_err(), "nothing is sent for a meeting not kept here");
        let ana_home = call("calendar.createLocal", json!({"account": ana, "name": "Ana"})).await.unwrap()["id"].as_str().unwrap().to_owned();
        calendar::put_local_event(&engine.db.lock().unwrap(), ana, &calendar::Event {
            id: format!("local:import:meet@example.com@{nine}"),
            calendar_id: ana_home.clone(),
            subject: "Planning".into(),
            start: nine,
            end: ten,
            organizer: Some(calendar::Participant { name: "Ana".into(), addr: ana.into(), response: String::new() }),
            ..Default::default()
        }).unwrap();
        let status = call("invite.counterStatus", json!({"account": ana, "me_addr": ana, "ics": counter_ics})).await.unwrap();
        assert_eq!((status["organizer"].clone(), status["event"]["calendar_id"].clone(), status["outdated"].clone()), (json!(true), json!(ana_home), json!(false)));
        let declined = call("invite.declineCounter", json!({
            "account": ana, "me_name": "Ana", "me_addr": ana, "ics": counter_ics, "comment": "The room is taken",
        })).await.unwrap();
        assert_eq!(declined["reply"]["to"], "bo@example.com");
        let refusal = declined["reply"]["ics"].as_str().unwrap();
        assert!(refusal.contains("METHOD:DECLINECOUNTER") && refusal.contains("SEQUENCE:2") && refusal.contains("COMMENT:The room is taken"));

        assert!(call("invite.cancel", json!({"account": account, "ics": request(3, "REQUEST")})).await.is_err(), "only a cancellation removes");
        let cancelled = call("invite.cancel", json!({"account": account, "ics": request(3, "CANCEL")})).await.unwrap();
        assert_eq!(cancelled["removed"], 1);
        assert!(calendar::events_of_calendar(&engine.db.lock().unwrap(), account, &home).unwrap().is_empty());
        let status = call("invite.status", json!({"account": account, "uid": "meet@example.com"})).await.unwrap();
        assert_eq!(status["answer"]["response"], "cancelled");
        let after = call("invite.counter", json!({
            "account": account, "ics": request(3, "REQUEST"), "me_addr": "bo@example.com", "start": nine, "end": ten,
        })).await;
        assert!(after.unwrap_err().to_string().contains("cancelled"), "a cancelled meeting takes no proposal");
    }

    #[tokio::test]
    async fn notes_are_written_searched_and_trashed_through_the_dispatcher() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let created = call("notes.create", json!({"note": {"title": "Ideas", "html": "<p>Ship <b>notes</b></p><script>x</script>", "tags": ["work"]}})).await.unwrap();
        let id = created["note"]["id"].as_str().unwrap().to_owned();
        assert_eq!(created["note"]["html"], "<p>Ship <b>notes</b></p>");

        let listed = call("notes.list", json!({"search": "ship"})).await.unwrap();
        assert_eq!(listed["notes"][0]["preview"], "Ship notes");
        assert_eq!(listed["tags"], json!([{"tag": "work", "count": 1}]));

        let saved = call("notes.update", json!({"id": id, "revision": 1, "note": {"title": "Ideas", "html": "<p>v2</p>"}})).await.unwrap();
        assert_eq!((saved["status"].clone(), saved["note"]["revision"].clone()), (json!("saved"), json!(2)));
        let stale = call("notes.update", json!({"id": id, "revision": 1, "note": {"title": "Ideas", "html": "<p>v1 again</p>"}})).await.unwrap();
        assert_eq!((stale["status"].clone(), stale["stored"]["text"].clone()), (json!("conflict"), json!("v2")));

        call("notes.trash", json!({"id": id})).await.unwrap();
        assert!(call("notes.list", json!({})).await.unwrap()["notes"].as_array().unwrap().is_empty());
        assert_eq!(call("notes.list", json!({"trash": true})).await.unwrap()["notes"].as_array().unwrap().len(), 1);
        call("notes.restore", json!({"id": id})).await.unwrap();
        call("notes.trash", json!({"id": id})).await.unwrap();
        call("notes.purge", json!({"id": id})).await.unwrap();
        assert!(call("notes.get", json!({"id": id})).await.unwrap()["note"].is_null());
    }

    /// The desktop's reminder watch asks the shared `pim::reminders` (the
    /// phone's `pim.refresh` asks the same): the accounts the core has open,
    /// once each, in the `calendar.reminder` shape it always sent.
    #[tokio::test]
    async fn the_reminder_watch_uses_the_shared_reminders() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        // Any stored account will do; the local archive needs no server.
        let account = meron_core::archive::ACCOUNT;
        meron_core::archive::ensure_account(&engine.db.lock().unwrap(), now_seconds()).unwrap();
        let home = call("calendar.createLocal", json!({"account": account, "name": "Home"})).await.unwrap()["id"].as_str().unwrap().to_owned();
        let now = now_seconds();
        let start = now + 600;
        let created = call("calendar.create", json!({"account": account, "notify": false, "event": {
            "id": "", "calendar_id": home, "subject": "Standup", "start": start, "end": start + 900,
            "all_day": false, "location": "Room 2", "reminder_minutes": 10,
        }}))
        .await
        .unwrap();
        let event = created["event"]["id"].as_str().unwrap().to_owned();
        assert!(look_for_reminders(&engine, now).await.reminders.is_empty(), "an account the core has not opened is not watched");
        let creds = store::load_account(&engine.db.lock().unwrap(), account).unwrap().unwrap();
        engine.accounts.lock().await.insert(account.to_string(), creds);
        let due = look_for_reminders(&engine, now).await;
        let (local_time, local_date) = {
            use chrono::TimeZone as _;
            let at = |instant: i64| chrono::Local.timestamp_opt(instant, 0).earliest().unwrap();
            let date = at(start).date_naive();
            let other_day = (date != at(now).date_naive()).then(|| date.format("%Y-%m-%d").to_string());
            (at(start).format("%H:%M").to_string(), other_day)
        };
        assert_eq!(
            due.reminders,
            vec![json!({
                "account": account, "event": event, "subject": "Standup", "location": "Room 2",
                "start": start, "all_day": false, "minutes": 10, "local_time": local_time,
                "started": false, "local_date": local_date,
            })],
        );
        assert!(look_for_reminders(&engine, now + 60).await.reminders.is_empty(), "given once");
        assert!(
            pim::reminders::take_due(&engine, &[account.to_string()], now + 120).is_empty(),
            "recorded where the phone's refresh looks too",
        );
    }

    /// After a change of zone, the watch's look starts reading again the
    /// calendars of an open account that can hold floating times (#209).
    #[tokio::test]
    async fn a_zone_change_makes_the_reminder_watch_read_floating_calendars_again() {
        use super::*;
        use chrono::Offset as _;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let account = meron_core::archive::ACCOUNT;
        let now = now_seconds();
        {
            let db = engine.db.lock().unwrap();
            meron_core::archive::ensure_account(&db, now).unwrap();
            calendar::upsert_calendars(&db, account, &[calendar::Calendar {
                id: "sub:holidays".into(),
                name: "Holidays".into(),
                kind: calendar::CalendarKind::Subscribed,
                enabled: true,
                ..Default::default()
            }])
            .unwrap();
            // The previous look was a minute ago, an hour away from here.
            let here = chrono::Local::now().offset().fix().local_minus_utc();
            let elsewhere = chrono::FixedOffset::east_opt(here + 3_600).unwrap();
            meron_core::calendar::reminders::record_look(&db, account, now - 60, &elsewhere).unwrap();
        }
        let creds = store::load_account(&engine.db.lock().unwrap(), account).unwrap().unwrap();
        engine.accounts.lock().await.insert(account.to_string(), creds);

        give_calendar_reminders(&engine, &writer, now).await;
        let window = format!("calendar:{account}:{}:{}", now - 86_400 * 31, now + 86_400 * 366);
        assert!(engine.syncing.lock().unwrap().contains(&window), "the floating calendars are being read again");
    }

    /// The watch's tick runs on a clock that can stand still in a sleep, so
    /// `system.resumed` wakes it at once rather than at its next tick (#209).
    #[tokio::test]
    async fn system_resumed_wakes_the_reminder_watch_before_its_tick() {
        use super::*;
        use futures::FutureExt as _;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let mut ticker = tokio::time::interval(Duration::from_secs(3_600));
        ticker.tick().await; // The first tick is at once; the next an hour off.
        let mut resumed = Box::pin(engine.resume_signal.notified());
        resumed.as_mut().enable();
        assert!(next_reminder_look(&mut ticker, resumed.as_mut()).now_or_never().is_none(), "nothing to wake it yet");

        let request = Request { id: 1, method: "system.resumed".into(), params: json!({}) };
        dispatch(&engine, &request, &writer).await.unwrap();
        assert_eq!(
            next_reminder_look(&mut ticker, resumed.as_mut()).now_or_never(),
            Some(ReminderWake::Resumed),
            "woken by the resume, not an hour later by the tick",
        );
    }

    /// A meeting that came and went while the machine slept: the watch's
    /// look on waking gathers its reminder into the one missed-reminders
    /// notice, not a reminder of its own, and gives it once (#225).
    #[tokio::test]
    async fn the_reminder_watch_gathers_missed_reminders_into_one_notice() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let account = meron_core::archive::ACCOUNT;
        // A fixed clock (2027-01-15 08:00 UTC); the zone is this machine's,
        // as the watch's is, and nothing below depends on it.
        let now = 1_800_000_000;
        let start = now - 3 * 3_600;
        {
            let db = engine.db.lock().unwrap();
            meron_core::archive::ensure_account(&db, now).unwrap();
            calendar::upsert_calendars(&db, account, &[calendar::Calendar {
                id: "local:home".into(),
                name: "Home".into(),
                enabled: true,
                ..Default::default()
            }])
            .unwrap();
            let meeting = calendar::Event {
                id: "standup".into(),
                calendar_id: "local:home".into(),
                subject: "Standup".into(),
                start,
                end: start + 1_800,
                reminder_minutes: Some(15),
                ..Default::default()
            };
            calendar::replace_window(&db, account, "local:home", (now - 86_400, now + 86_400), &[meeting]).unwrap();
            // Last looked at before the reminder rang; asleep since.
            meron_core::calendar::reminders::record_look(&db, account, start - 3_600, &chrono::Local).unwrap();
        }
        let creds = store::load_account(&engine.db.lock().unwrap(), account).unwrap().unwrap();
        engine.accounts.lock().await.insert(account.to_string(), creds);

        let woke = look_for_reminders(&engine, now).await;
        assert!(woke.reminders.is_empty(), "over: not a reminder of its own");
        let missed = woke.missed.expect("one notice");
        assert_eq!(missed["count"], 1);
        assert_eq!(missed["reminders"][0]["event"], "standup");
        assert_eq!(missed["reminders"][0]["started"], true);
        let next = look_for_reminders(&engine, now + 60).await;
        assert_eq!((next.reminders.len(), next.missed), (0, None), "given once");

        // Not yet shown: a restart of the core says it again; once the host
        // says it showed it (with the keys it held), no more.
        let again = pim::reminders::pending_missed_notice(&engine, now + 120, &chrono::Local).expect("said again");
        assert_eq!(again["keys"], missed["keys"]);
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let request = Request { id: 1, method: "reminders.missedShown".into(), params: json!({ "keys": missed["keys"] }) };
        dispatch(&engine, &request, &writer).await.unwrap();
        assert_eq!(pim::reminders::pending_missed_notice(&engine, now + 180, &chrono::Local), None);
    }

    #[tokio::test]
    async fn the_local_address_book_saves_and_refuses_a_stale_edit() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let request = |method: &str, params: Value| Request { id: 1, method: method.into(), params };
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &request(method, params), &writer).await }
        };

        let created = call("people.save", json!({"person": {"name": "Ann", "emails": [{"addr": "ann@example.com"}]}}))
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["version"], "1");
        let listed = call("people.list", json!({"query": "ann"})).await.unwrap();
        assert_eq!(listed["people"][0]["editable"], true);
        assert_eq!(listed["people"][0]["version"], "1");

        // Two windows opened at version 1; the first one saves.
        call("people.save", json!({"id": id, "version": "1", "person": {"name": "Ann Lee"}})).await.unwrap();
        let stale = call("people.save", json!({"id": id, "version": "1", "person": {"name": "Annie"}}))
            .await
            .unwrap();
        assert_eq!(stale["conflict"], true);
        assert_eq!(stale["current"]["name"], "Ann Lee", "the reader is shown what is there now");

        // An edit that does not say which version it was made from is refused.
        assert!(call("people.save", json!({"id": id, "person": {"name": "X"}})).await.is_err());

        let gone = call("people.delete", json!({"id": id, "version": "2"})).await.unwrap();
        assert_eq!(gone["ok"], true);
        let listed = call("people.list", json!({"query": ""})).await.unwrap();
        assert!(listed["people"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn local_contact_groups_and_name_parts_go_through_the_commands() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let request = |method: &str, params: Value| Request { id: 1, method: method.into(), params };
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &request(method, params), &writer).await }
        };
        let ann = call(
            "people.save",
            json!({"person": {"name": "Ann Lee", "given": "Ann", "family": "Lee", "emails": [{"addr": "ann@example.com"}]}}),
        )
        .await
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        // An editor that sends no name parts keeps the stored ones.
        call("people.save", json!({"id": ann, "version": "1", "person": {"name": "Ann Lee", "note": "x", "emails": [{"addr": "ann@example.com"}]}}))
            .await
            .unwrap();
        let listed = call("people.list", json!({"query": ""})).await.unwrap();
        assert_eq!(listed["people"][0]["family"], "Lee");
        let names = call("people.names", json!({"addrs": ["ANN@example.com", "x@example.com"]})).await.unwrap();
        assert_eq!(names["names"]["ann@example.com"]["given"], "Ann");
        assert!(names["names"].get("x@example.com").is_none());

        let group = call("people.groupSave", json!({"name": "Climbing", "members": [ann]})).await.unwrap();
        let id = group["id"].as_str().unwrap().to_owned();
        let listed = call("people.groups", json!({})).await.unwrap();
        assert_eq!(listed["groups"][0]["name"], "Climbing");
        assert_eq!(listed["groups"][0]["editable"], true);
        assert_eq!(listed["groups"][0]["members"][0]["addr"], "ann@example.com");
        let renamed = call("people.groupSave", json!({"id": id, "version": "1", "name": "Climbing club", "members": []}))
            .await
            .unwrap();
        assert_eq!(renamed["version"], "2");
        let stale = call("people.groupSave", json!({"id": id, "version": "1", "name": "Other", "members": []}))
            .await
            .unwrap();
        assert_eq!(stale["conflict"], true);
        assert_eq!(stale["current"]["name"], "Climbing club");
        assert!(call("people.groupSave", json!({"name": " "})).await.is_err());
        call("people.groupDelete", json!({"id": id, "version": "2"})).await.unwrap();
        assert!(call("people.groups", json!({})).await.unwrap()["groups"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_local_calendar_keeps_its_events_without_a_server() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let request = |method: &str, params: Value| Request { id: 1, method: method.into(), params };
        let account = "imap@example.test";
        // No calendar route at all: anything that reached a server would fail.
        let local = dispatch(&engine, &request("calendar.createLocal", json!({"account": account, "name": "Home"})), &writer)
            .await.unwrap()["id"].as_str().unwrap().to_owned();
        let event = |id: &str, subject: &str| json!({
            "id": id, "calendar_id": local, "subject": subject, "start": 1_791_799_200i64, "end": 1_791_802_800i64,
            "all_day": false, "is_recurring": false, "is_cancelled": false, "free_busy": "", "my_response": "",
            "description": "", "attendees": [],
        });

        let created = dispatch(&engine, &request("calendar.create", json!({"account": account, "event": event("", "Dentist")})), &writer)
            .await.expect("a local event is saved");
        let id = created["event"]["id"].as_str().unwrap().to_owned();
        assert!(id.starts_with("local:"));
        let stored = || calendar::events_in_window(&engine.db.lock().unwrap(), account, (0, i64::MAX)).unwrap();
        assert_eq!(stored().iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), vec!["Dentist"]);

        dispatch(&engine, &request("calendar.update", json!({"account": account, "event": event(&id, "Dentist (moved)")})), &writer)
            .await.expect("a local event is edited");
        assert_eq!(stored()[0].subject, "Dentist (moved)");
        assert_eq!(stored().len(), 1, "edited in place, not added");

        let mut repeating = event("", "Gym");
        repeating["recurrence"] = json!({"freq": "weekly", "interval": 1, "weekdays": [], "until": null, "count": null});
        let refused = dispatch(&engine, &request("calendar.create", json!({"account": account, "event": repeating})), &writer).await;
        assert!(refused.is_err_and(|e| e.to_string().contains("single events")));

        dispatch(&engine, &request("calendar.delete", json!({"account": account, "event": id, "calendar": local})), &writer)
            .await.expect("a local event is deleted");
        assert!(stored().is_empty());

        // A subscription is the publisher's: writing to it is refused by name.
        calendar::upsert_calendars(&engine.db.lock().unwrap(), account, &[calendar::Calendar {
            id: "sub:1".into(), name: "Holidays".into(), kind: calendar::CalendarKind::Subscribed, enabled: true,
            ..Default::default()
        }]).unwrap();
        let mut published = event("", "Party");
        published["calendar_id"] = json!("sub:1");
        let refused = dispatch(&engine, &request("calendar.create", json!({"account": account, "event": published})), &writer).await;
        assert!(refused.is_err_and(|e| e.to_string().contains("Holidays is a subscribed calendar")));
    }
    #[tokio::test]
    async fn the_organizer_of_a_local_event_builds_an_invitation_and_a_cancellation() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let call = |method: &'static str, params: Value| {
            let engine = engine.clone();
            let writer = writer.clone();
            async move { dispatch(&engine, &Request { id: 1, method: method.into(), params }, &writer).await }
        };
        let account = "ana@example.com";
        let home = call("calendar.createLocal", json!({"account": account, "name": "Home"})).await.unwrap()["id"].as_str().unwrap().to_owned();
        let event = |id: &str, subject: &str, change_key: Option<&str>| json!({
            "id": id, "calendar_id": home, "subject": subject, "start": 1_894_269_600i64, "end": 1_894_273_200i64,
            "all_day": false, "is_recurring": false, "is_cancelled": false, "free_busy": "", "my_response": "",
            "description": "", "change_key": change_key,
            "organizer": {"name": "Ana", "addr": "ana@example.com", "response": ""},
            "attendees": [
                {"name": "Bo", "addr": "bo@example.com", "response": ""},
                {"name": "Cy", "addr": "cy@example.com", "response": "accept"},
            ],
        });
        let notify = |id: String, method: &'static str, me: &'static str, people: Value| {
            let home = home.clone();
            async move {
                call("invite.notify", json!({
                    "account": account, "calendar": home, "event": id, "scope": "occurrence", "method": method,
                    "me_name": "Ana", "me_addr": me, "people": people,
                }))
                .await
            }
        };
        let both = json!(["bo@example.com", "CY@example.com"]);

        let id = call("calendar.create", json!({"account": account, "event": event("", "Planning", None)})).await.unwrap()["event"]["id"]
            .as_str().unwrap().to_owned();
        let first = notify(id.clone(), "request", "Ana@Example.com", both.clone()).await.unwrap();
        assert_eq!(first["notice"]["to"], json!(["bo@example.com", "cy@example.com"]), "everyone on it but the organizer");
        assert_eq!(first["notice"]["subject"], "Invitation: Planning");
        assert_eq!(first["notice"]["method"], "REQUEST");
        let ics = first["notice"]["ics"].as_str().unwrap();
        assert!(ics.contains("METHOD:REQUEST\r\n") && ics.contains(&format!("UID:{id}\r\n")) && ics.contains("SEQUENCE:0\r\n"), "{ics}");
        assert!(ics.contains("ORGANIZER;CN=Ana:mailto:ana@example.com"));

        // Each save is a newer version, counted from what is stored even when
        // the editor still holds an older one.
        call("calendar.update", json!({"account": account, "event": event(&id, "Planning (moved)", Some("0"))})).await.unwrap();
        call("calendar.update", json!({"account": account, "event": event(&id, "Planning (moved again)", Some("0"))})).await.unwrap();
        let updated = notify(id.clone(), "request", "ana@example.com", both.clone()).await.unwrap();
        assert_eq!(updated["notice"]["sequence"], 2);
        assert_eq!(updated["notice"]["subject"], "Updated invitation: Planning (moved again)");
        let read = calendar::itip::parse(updated["notice"]["ics"].as_str().unwrap()).unwrap();
        assert_eq!((read.uid.as_str(), read.sequence), (id.as_str(), 2));
        // What an answer to it comes back with finds the event again.
        let organized = calendar::itip::organized_event(&engine.db.lock().unwrap(), account, account, &read.uid, None).unwrap();
        assert_eq!(organized.map(|e| e.id), Some(id.clone()));

        // Nobody is mailed who was not named in the question.
        let unseen = notify(id.clone(), "request", "ana@example.com", json!(["bo@example.com"])).await.unwrap_err();
        assert!(unseen.to_string().contains("cy@example.com, who was not shown"), "{unseen}");
        // Only the organizer tells.
        let other = notify(id.clone(), "request", "bo@example.com", both.clone()).await.unwrap_err();
        assert!(other.to_string().contains("ana@example.com organizes this meeting"), "{other}");

        // The cancellation is built before the event goes, one version on.
        let cancel = notify(id.clone(), "cancel", "ana@example.com", both.clone()).await.unwrap();
        assert_eq!(cancel["notice"]["subject"], "Cancelled: Planning (moved again)");
        let ics = cancel["notice"]["ics"].as_str().unwrap();
        assert!(ics.contains("METHOD:CANCEL\r\n") && ics.contains("SEQUENCE:3\r\n") && ics.contains("STATUS:CANCELLED\r\n"), "{ics}");
        call("calendar.delete", json!({"account": account, "event": id, "calendar": home})).await.unwrap();
        assert!(notify(id.clone(), "cancel", "ana@example.com", both.clone()).await.unwrap_err().to_string().contains("no longer"));

        // A calendar that tells people itself is not one this builds for.
        let refused = call("invite.notify", json!({
            "account": account, "calendar": "primary", "event": "x", "method": "request", "me_addr": "ana@example.com",
        })).await.unwrap_err();
        assert!(refused.to_string().contains("own server tells"), "{refused}");
        assert!(call("invite.notify", json!({
            "account": account, "calendar": home, "event": "x", "method": "reply", "me_addr": "ana@example.com",
        })).await.is_err(), "only an update or a cancellation");
    }

    #[tokio::test]
    async fn local_draft_rpc_is_local_and_preserves_conflicts() {
        use super::*;
        let engine = Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer = Arc::new(Mutex::new(tokio::io::stdout()));
        let request = |method: &str, params: Value| Request { id: 1, method: method.into(), params };
        let mut compose = json!({"attachments": []});
        for field in ["accountId", "fromEmail", "to", "cc", "bcc", "replyTo", "subject", "html", "text", "inReplyTo", "references", "draftMessageId"] {
            compose[field] = json!("");
        }
        for field in ["rich", "showCcBcc", "pgpSign", "pgpEncrypt"] { compose[field] = json!(false); }
        compose["accountId"] = json!("removed-or-offline-account");
        let doc = json!({"version": 1, "compose": compose});
        let save = request("localDrafts.save", json!({"id":"draft-1", "expected_revision":0, "document":doc}));
        assert_eq!(dispatch(&engine, &save, &writer).await.unwrap()["applied"], true);
        assert_eq!(dispatch(&engine, &save, &writer).await.unwrap()["applied"], false);
        let read = dispatch(&engine, &request("localDrafts.get", json!({"id":"draft-1"})), &writer).await.unwrap();
        assert_eq!(read["draft"]["document"], doc);
        let list = dispatch(&engine, &request("localDrafts.list", json!({})), &writer).await.unwrap();
        assert_eq!(list["drafts"].as_array().unwrap().len(), 1);
        assert_eq!(dispatch(&engine, &request("localDrafts.delete", json!({"id":"draft-1","expected_revision":1})), &writer).await.unwrap()["deleted"], true);
        assert!(engine.accounts.lock().await.is_empty());
    }
    #[tokio::test]
    async fn graph_activation_rpc_rejects_unauthorized_and_remote_mutations() {
        use super::*;
        let engine=Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer=Arc::new(Mutex::new(tokio::io::stdout()));
        let request=|method:&str,params:Value|Request{id:1,method:method.into(),params};
        assert!(dispatch(&engine,&request("graph.activationBegin",json!({"attempt":"unknown"})),&writer).await.is_err());
        let account="graph@example.test";
        engine.db.lock().unwrap().execute("INSERT INTO accounts(id,engine,provider,email,display_name,config,created_at,updated_at) VALUES(?1,'mail','outlook',?1,'Graph','{\"auth_type\":\"graph_oauth\"}',0,0)",[account]).unwrap();
        for method in ["send","save_draft","discard_draft","messages.markRead","messages.markStarred","messages.delete","messages.move","messages.copy","messages.markAllRead","messages.emptyFolder","folders.create","folders.delete","folders.move","mail.scheduleSend"] {
            let error=dispatch(&engine,&request(method,json!({"account":account})),&writer).await.unwrap_err();
            assert!(error.to_string().contains("read-only"),"{method}: {error}");
        }
        assert!(dispatch(&engine,&request("account.connect",json!({"account":account,"host":"should-not-dial"})),&writer).await.is_err());
        let list=dispatch(&engine,&request("account.list",json!({})),&writer).await.unwrap();
        assert_eq!(list["accounts"][0]["needs_reconnect"],true);
        assert!(!list.to_string().contains("access_token"));
    }
    /// ADR-0050: `folders.move` end to end on the local archive, which is its
    /// own server, and refused on Exchange, which does not manage folders here.
    #[tokio::test]
    async fn folders_move_nests_a_local_folder_and_reports_every_rename() {
        use super::*;
        let engine=Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer=Arc::new(Mutex::new(tokio::io::stdout()));
        let request=|method:&str,params:Value|Request{id:1,method:method.into(),params};
        meron_core::archive::ensure_account(&engine.db.lock().unwrap(),0).unwrap();
        let account=meron_core::archive::ACCOUNT;
        for name in ["Years","2025","2025/Q1"] {
            dispatch(&engine,&request("folders.create",json!({"account":account,"name":name})),&writer).await.unwrap();
        }
        let moved=dispatch(&engine,&request("folders.move",json!({"account":account,"folder":"2025","parent":"Years"})),&writer).await.unwrap();
        assert_eq!(moved["folder"],"Years/2025");
        assert_eq!(moved["renames"],json!([{"from":"2025","to":"Years/2025"},{"from":"2025/Q1","to":"Years/2025/Q1"}]));
        let names:Vec<&str>=moved["folders"].as_array().unwrap().iter().filter_map(|f|f["name"].as_str()).collect();
        assert!(names.contains(&"Years/2025/Q1") && !names.contains(&"2025"),"{names:?}");
        let into_itself=dispatch(&engine,&request("folders.move",json!({"account":account,"folder":"Years","parent":"Years/2025"})),&writer).await.unwrap_err();
        assert!(into_itself.to_string().contains("into itself"),"{into_itself}");
        let trash=dispatch(&engine,&request("folders.move",json!({"account":account,"folder":meron_core::archive::TRASH,"parent":"Years"})),&writer).await.unwrap_err();
        assert!(trash.to_string().contains("special folder"),"{trash}");

        let ews="ews@example.test";
        engine.db.lock().unwrap().execute("INSERT INTO accounts(id,engine,provider,email,display_name,config,created_at,updated_at) VALUES(?1,'mail','exchange',?1,'EWS','{\"auth_type\":\"password\",\"ews_url\":\"https://ews.example.test/EWS/Exchange.asmx\"}',0,0)",[ews]).unwrap();
        let refused=dispatch(&engine,&request("folders.move",json!({"account":ews,"folder":"Work","parent":"Projects"})),&writer).await;
        assert!(refused.is_err());
    }
    #[tokio::test]
    async fn graph_writes_pass_the_guard_only_where_granted_and_supported() {
        use super::*;
        let engine=Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer=Arc::new(Mutex::new(tokio::io::stdout()));
        let request=|method:&str,params:Value|Request{id:1,method:method.into(),params};
        let (account,other)=("graph@example.test","other@example.test");
        for id in [account,other] {
            engine.db.lock().unwrap().execute("INSERT INTO accounts(id,engine,provider,email,display_name,config,created_at,updated_at) VALUES(?1,'mail','outlook',?1,'Graph','{\"auth_type\":\"graph_oauth\"}',0,0)",[id]).unwrap();
        }
        store::setting_set(&engine.db.lock().unwrap(),&meron_core::graph::auth::marker(account),&json!({"writes":true})).unwrap();
        // Supported and granted: past the guard (they fail later, with no
        // Graph profile in this test, but not as "read-only"). Moving a
        // folder is one of them since #210.
        for method in ["messages.markRead","messages.markStarred","messages.delete","messages.move","folders.move"] {
            let error=dispatch(&engine,&request(method,json!({"account":account,"uid":1,"target_folder":"INBOX.x"})),&writer).await.unwrap_err();
            assert!(!error.to_string().contains("read-only"),"{method}: {error}");
        }
        let copy=dispatch(&engine,&request("messages.copy",json!({"account":account,"target_account":account,"target_folder":"x","uid":1})),&writer).await;
        assert!(copy.is_err_and(|e|!e.to_string().contains("read-only")));
        // Still unsupported, granted or not.
        for method in ["send","save_draft","messages.markAllRead","messages.emptyFolder","folders.create","folders.delete","mail.scheduleSend"] {
            let error=dispatch(&engine,&request(method,json!({"account":account})),&writer).await.unwrap_err();
            assert!(error.to_string().contains("read-only"),"{method}: {error}");
        }
        // Not to another account, and not for an account without the grant.
        let error=dispatch(&engine,&request("messages.copy",json!({"account":account,"target_account":other,"target_folder":"x","uid":1})),&writer).await.unwrap_err();
        assert!(error.to_string().contains("read-only"));
        let error=dispatch(&engine,&request("messages.markRead",json!({"account":other,"uid":1})),&writer).await.unwrap_err();
        assert!(error.to_string().contains("read-only"));
        let list=dispatch(&engine,&request("account.list",json!({})),&writer).await.unwrap();
        let writes:Vec<(String,bool)>=list["accounts"].as_array().unwrap().iter().map(|a|(a["id"].as_str().unwrap().to_owned(),a["graph_writes"].as_bool().unwrap())).collect();
        assert!(writes.contains(&(account.to_owned(),true)) && writes.contains(&(other.to_owned(),false)));
    }
    #[test]
    fn graph_send_failures_are_uncertain_only_when_microsoft_may_have_accepted() {
        use super::{classify_graph_send_error, smtp};
        use meron_core::graph::{Error, ErrorKind};
        let classify = |kind, status| {
            classify_graph_send_error(anyhow::Error::new(Error { kind, status, retry_after_seconds: None }))
        };
        for (kind, status) in [(ErrorKind::Uncertain, None), (ErrorKind::Unavailable, Some(504)), (ErrorKind::Unavailable, Some(500))] {
            assert!(smtp::is_uncertain(&classify(kind, status)), "{kind:?}");
        }
        for (kind, status) in [
            (ErrorKind::AccessDenied, Some(403)),
            (ErrorKind::Throttled, Some(429)),
            (ErrorKind::Reauthenticate, Some(401)),
            (ErrorKind::InvalidResponse, Some(400)),
            (ErrorKind::TooLarge, None),
            (ErrorKind::ConsentRequired, None),
        ] {
            assert!(!smtp::is_uncertain(&classify(kind, status)), "{kind:?}");
        }
        assert!(classify(ErrorKind::TooLarge, None).to_string().contains("too large to send through Microsoft Graph"));
        assert!(classify(ErrorKind::ConsentRequired, None).to_string().contains("allow it in the account settings"));
    }
    /// #210: a send asking for a delivery receipt that stopped before
    /// Microsoft was asked to send (the draft could not be made or marked)
    /// is a refusal, even when the draft step itself went unanswered.
    #[test]
    fn graph_send_stopped_before_sending_is_a_refusal_not_uncertain() {
        use super::{classify_graph_send_error, smtp};
        use meron_core::graph::{Error, ErrorKind, NotSent};
        let classify = |kind, draft_left| {
            let error = Error { kind, status: None, retry_after_seconds: None };
            classify_graph_send_error(anyhow::Error::new(NotSent { error, draft_left }))
        };
        for kind in [ErrorKind::Uncertain, ErrorKind::Unavailable, ErrorKind::Conflict, ErrorKind::Throttled] {
            assert!(!smtp::is_uncertain(&classify(kind, false)), "{kind:?}");
        }
        let left = classify(ErrorKind::Uncertain, true).to_string();
        assert!(left.contains("nothing was sent") && left.contains("Drafts"), "{left}");
        assert!(classify(ErrorKind::ConsentRequired, false).to_string().contains("allow changes"));
        assert!(classify(ErrorKind::TooLarge, false).to_string().contains("too large to send"));
        // The draft step done, the send itself unanswered: that may have gone.
        let sent = Error { kind: ErrorKind::Uncertain, status: None, retry_after_seconds: None };
        assert!(smtp::is_uncertain(&classify_graph_send_error(anyhow::Error::new(sent))));
    }
    #[tokio::test]
    async fn graph_send_passes_the_guard_only_with_the_send_grant() {
        use super::*;
        let engine=Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer=Arc::new(Mutex::new(tokio::io::stdout()));
        let request=|method:&str,params:Value|Request{id:1,method:method.into(),params};
        let account="graph@example.test";
        engine.db.lock().unwrap().execute("INSERT INTO accounts(id,engine,provider,email,display_name,config,created_at,updated_at) VALUES(?1,'mail','outlook',?1,'Graph','{\"auth_type\":\"graph_oauth\"}',0,0)",[account]).unwrap();
        let send=json!({"account":account,"to":"b@example.test","subject":"Hi","body":"x","message_id":"m-graph@example.test"});
        let error=dispatch(&engine,&request("send",send.clone()),&writer).await.unwrap_err();
        assert!(error.to_string().contains("read-only"),"{error}");
        // Changes alone do not allow sending.
        store::setting_set(&engine.db.lock().unwrap(),&meron_core::graph::auth::marker(account),&json!({"writes":true,"send":false})).unwrap();
        assert!(dispatch(&engine,&request("send",send.clone()),&writer).await.unwrap_err().to_string().contains("read-only"));
        store::setting_set(&engine.db.lock().unwrap(),&meron_core::graph::auth::marker(account),&json!({"writes":false,"send":true})).unwrap();
        let error=dispatch(&engine,&request("send",send),&writer).await.unwrap_err();
        assert!(!error.to_string().contains("read-only"),"{error}");
        // Scheduling is still not offered for Graph.
        assert!(dispatch(&engine,&request("mail.scheduleSend",json!({"account":account})),&writer).await.unwrap_err().to_string().contains("read-only"));
        let list=dispatch(&engine,&request("account.list",json!({})),&writer).await.unwrap();
        assert_eq!(list["accounts"][0]["graph_send"],true);
    }
    #[test]
    fn graph_failures_do_not_enter_imap_retry_policy() {
        for kind in [meron_core::graph::ErrorKind::Throttled,meron_core::graph::ErrorKind::Transport,meron_core::graph::ErrorKind::Unavailable,meron_core::graph::ErrorKind::Reauthenticate,meron_core::graph::ErrorKind::AppProxyUnusable,meron_core::graph::ErrorKind::AccountProxyUnusable] {
            let error=meron_core::graph::Error{kind,status:None,retry_after_seconds:Some(30)};
            assert!(!is_transient_sync_error(&anyhow::Error::new(error).context("timeout must not override Graph retry policy")));
        }
    }
    #[tokio::test]
    async fn graph_rpc_begin_poll_cancel_and_legacy_removal_are_secret_free() {
        use super::*;
        let engine=Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let writer=Arc::new(Mutex::new(tokio::io::stdout()));
        let request=|method:&str,params:Value| Request{id:1,method:method.into(),params};
        let params=json!({"client_id":"11111111-1111-4111-8111-111111111111","redirect_uri":"http://127.0.0.1:2345/"});
        let begin=dispatch(&engine,&request("graph.authBegin",params.clone()),&writer).await.unwrap();
        let attempt=begin["attempt"].as_str().unwrap();
        let poll=dispatch(&engine,&request("graph.authPoll",json!({"attempt":attempt})),&writer).await.unwrap();
        assert_eq!(poll["state"],"pending"); assert_eq!(poll["mail_backend_ready"],false);
        assert!(!poll.to_string().contains("token"));
        dispatch(&engine,&request("graph.authCancel",json!({"attempt":attempt})),&writer).await.unwrap();
        assert_eq!(engine.graph_auth.poll(attempt).state,"cancelled");
        let mut unknown=params; unknown["account"]=json!("missing@example.test");
        assert!(dispatch(&engine,&request("graph.authBegin",unknown),&writer).await.is_err());
        assert!(dispatch(&engine,&request("graph.authComplete",json!({"attempt":attempt,"state":attempt,"code":"secret"})),&writer).await.is_err());
        assert!(dispatch(&engine,&request("app.prefsSet",json!({"key":"graph.grant.reserved","value":false})),&writer).await.is_err());
        // No association marker: no OS vault read/write is needed for Graph cleanup.
        engine.graph_auth.forget_account("legacy@example.test").unwrap();
    }

    #[tokio::test]
    async fn graph_begin_waits_for_removal_then_rechecks_selected_account() {
        use super::*;
        let engine=Arc::new(Engine::new(Box::new(GraphTestHost)).unwrap());
        let account="removing@example.test";
        engine.db.lock().unwrap().execute("INSERT INTO accounts(id,email) VALUES(?1,?1)",[account]).unwrap();
        // The same guard spans account.remove's cleanup and SQLite deletion.
        let lifecycle=engine.graph_lifecycle.lock().await;
        let worker=engine.clone();
        let begun=Arc::new(tokio::sync::Notify::new());
        let starting=begun.clone();
        let handle=tokio::spawn(async move {
            starting.notify_one();
            dispatch(&worker,&Request{id:1,method:"graph.authBegin".into(),params:json!({"account":account,"client_id":"11111111-1111-4111-8111-111111111111","redirect_uri":"http://127.0.0.1:2345/"})},&Arc::new(Mutex::new(tokio::io::stdout()))).await
        });
        begun.notified().await;
        tokio::task::yield_now().await;
        assert!(!handle.is_finished(), "authorization bypassed account lifecycle lock");
        engine.graph_auth.forget_account(account).unwrap();
        store::delete_account(&engine.db.lock().unwrap(),account).unwrap();
        drop(lifecycle);
        let result=handle.await.unwrap();
        assert!(result.unwrap_err().to_string().contains("unknown account"));
        assert!(store::load_account(&engine.db.lock().unwrap(),account).unwrap().is_none());
    }

    #[test]
    fn imap_disconnect_errors_are_transient() {
        let lost = anyhow::Error::new(async_imap::error::Error::ConnectionLost);
        assert!(is_transient_sync_error(&lost));

        let buffered_eof = anyhow::Error::new(async_imap::error::Error::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "bytes remaining in stream",
        )));
        assert!(is_transient_sync_error(&buffered_eof));

        let rejected = anyhow::Error::new(async_imap::error::Error::No(
            "[AUTHENTICATIONFAILED] invalid credentials".to_string(),
        ));
        assert!(!is_transient_sync_error(&rejected));
    }

    #[test]
    fn socks_host_unreachable_is_transient() {
        let error = anyhow::anyhow!("SOCKS5 connect failed: host unreachable");
        assert!(is_transient_sync_error(&error));
    }

    #[test]
    fn an_unusable_proxy_setting_is_not_retried_as_a_passing_failure() {
        // Even under words the retry would otherwise take for a network
        // failure: only fixing the setting helps (#201).
        let refused = meron_core::proxy::ProxyChoice::from_json(&serde_json::json!({ "mode": "http", "port": 3128 }))
            .resolve()
            .unwrap_err()
            .context("connect timed out");
        assert!(!is_transient_sync_error(&refused), "{refused:#}");
    }

    #[tokio::test]
    async fn background_sync_recovers_from_one_transient_failure() {
        let attempts = AtomicUsize::new(0);

        let result = retry_background_sync(
            "test sync",
            || true,
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        anyhow::bail!("network is unreachable")
                    }
                    Ok("synced")
                }
            },
        )
        .await;

        assert_eq!(result.unwrap(), "synced");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn background_sync_reports_failure_after_retry() {
        let attempts = AtomicUsize::new(0);

        let error = retry_background_sync::<(), _, _, _>(
            "test sync",
            || true,
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        anyhow::bail!("connection reset by peer")
                    }
                    anyhow::bail!("network is unreachable")
                }
            },
        )
        .await
        .unwrap_err();

        // Callers report it with `{:#}`: the retry's error stays the typed
        // source under the note about the first attempt (#244).
        let message = format!("{error:#}");
        assert!(message.contains("network is unreachable"));
        assert!(message.contains("connection reset by peer"));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn background_sync_does_not_retry_permanent_failure() {
        let attempts = AtomicUsize::new(0);

        let error = retry_background_sync(
            "test sync",
            || true,
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async {
                    anyhow::Result::<()>::Err(anyhow::anyhow!(
                        "login failed: authentication failed"
                    ))
                }
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.to_string(), "login failed: authentication failed");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn background_sync_does_not_retry_after_pause() {
        let paused = AtomicBool::new(false);
        let attempts = AtomicUsize::new(0);

        let error = retry_background_sync::<(), _, _, _>(
            "test sync",
            || !paused.load(Ordering::SeqCst),
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                paused.store(true, Ordering::SeqCst);
                async { anyhow::Result::<()>::Err(anyhow::anyhow!("connection lost")) }
            },
        )
        .await
        .unwrap_err();

        assert!(error.is::<BackgroundSyncCancelled>());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}

/// Desktop host integration for the shared [`Engine`]: the default on-disk store
/// plus OS-keychain secret storage (with one-time migration of any legacy
/// secrets that older builds wrote into SQLite).
struct DesktopHost;

impl EngineHost for DesktopHost {
    fn open_db(&self) -> anyhow::Result<rusqlite::Connection> {
        store::open()
    }

    fn apply_secret(&self, conn: &rusqlite::Connection, account: &str, creds: &mut imap::Creds) {
        let stored = match secrets::load(account) {
            Ok(stored) => stored,
            Err(err) => {
                eprintln!("meron-core: could not load keychain secret for {account}: {err:#}");
                secrets::Secrets::default()
            }
        };
        if stored.is_empty() {
            // Legacy row from a build that stored secrets in SQLite: migrate
            // whatever's there into the keychain, then scrub the plaintext. The
            // in-memory `creds` already carry the DB-loaded secret, so they stay
            // usable after the scrub.
            let from_db = secrets::Secrets::from_creds(creds);
            if !from_db.is_empty() {
                let _ = secrets::store(account, &from_db);
                let _ = store::scrub_account_secrets(conn, account);
            }
        } else {
            stored.apply_to(creds);
        }
    }

    fn store_secret(
        &self,
        _conn: &rusqlite::Connection,
        account: &str,
        secrets: &secrets::Secrets,
    ) -> anyhow::Result<()> {
        secrets::store(account, secrets)
    }
}

/// Decide whether a thread has *new* ancestor gaps worth fetching, and if so
/// run [`fill_thread_gaps`] in the background so the read it was called from
/// returns immediately. Two guards keep this cheap:
///   - the gap set is computed from the local DB (no network) before spawning;
///   - a per-thread negative cache (`Engine::gap_attempts`) drops ids we've
///     already tried this session, so re-opening a thread whose ancestors will
///     never arrive (the common case) does no network work at all.
/// When the fill actually stores something, it emits `mail.synced` so the open
/// thread re-reads; the re-read sees no new gaps and won't reconnect.
fn maybe_spawn_fill_thread_gaps(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    thread_key: &str,
) {
    // Synthetic `uid:` keys (drafts / headerless messages) have no References to
    // chase.
    if thread_key.starts_with("uid:") {
        return;
    }

    let gaps = {
        let db = engine.db.lock().unwrap();
        match store::get_thread_reference_gaps(&db, account, thread_key) {
            Ok(gaps) => gaps,
            Err(err) => {
                eprintln!("meron-core: thread reference gaps thread_key={thread_key}: {err:#}");
                return;
            }
        }
    };
    if gaps.is_empty() {
        return;
    }

    // Keep only ids not tried yet this session; record them as tried up front so
    // a second open (or a concurrent one) before this finishes won't re-spawn.
    let cache_key = format!("{account}|{thread_key}");
    let has_new = {
        let mut attempts = engine.gap_attempts.lock().unwrap();
        let tried = attempts.entry(cache_key).or_default();
        let mut has_new = false;
        for id in &gaps {
            if tried.insert(id.clone()) {
                has_new = true;
            }
        }
        has_new
    };
    if !has_new {
        return;
    }

    let engine = engine.clone();
    let out = out.clone();
    let account = account.to_string();
    let thread_key = thread_key.to_string();
    tokio::spawn(async move {
        match fill_thread_gaps(&engine, &account, &thread_key).await {
            Ok(true) => {
                emit(
                    &out,
                    "mail.synced",
                    json!({ "account": account, "folder": "inbox", "synced": 0 }),
                )
                .await;
            }
            Ok(false) => {}
            Err(err) => {
                eprintln!("meron-core: fill thread gaps thread_key={thread_key}: {err:#}");
            }
        }
    });
}

/// Refresh a folder's messages from IMAP in the background (deduped), then emit
/// `mail.synced` so the UI re-reads the now-fresh store. Keeps network I/O off
/// the bridge's synchronous request path (which runs on the app's UI thread).
fn spawn_message_sync(
    engine: Arc<Engine>,
    out: Writer,
    account: String,
    folder: String,
    limit: u32,
) {
    if engine.is_paused(&account) {
        return;
    }
    let key = format!("msg:{account}/{folder}");
    if !engine.syncing.lock().unwrap().insert(key.clone()) {
        return;
    }
    tokio::spawn(async move {
        let uid_next_before = if folder.eq_ignore_ascii_case("INBOX") {
            inbox_uid_next(&engine, &account)
        } else {
            0
        };
        let result = retry_background_sync(
            &format!("sync {folder} for {account}"),
            || !engine.is_paused(&account),
            || sync_messages(&engine, &account, &folder, limit),
        )
        .await;
        engine.syncing.lock().unwrap().remove(&key);
        match result {
            Ok(synced) => {
                // Warm full bodies for the unread/recent set now that envelopes
                // are fresh. Deduped, and a no-op once everything is cached.
                spawn_body_prefetch(engine.clone(), account.clone(), folder.clone());
                // Piggyback Sent and Drafts syncs so replies sent or drafted
                // from another client thread into conversations straight from
                // the local store (no per-thread network check on read). Runs
                // before the emit so the re-read it triggers already sees them.
                for sync in sync_companion_folders(&engine, &account, &folder, limit).await {
                    if let Err(err) = sync.result {
                        eprintln!("meron-core: sync {} {account}: {err:#}", sync.role);
                    }
                }
                let uid_next_after = if folder.eq_ignore_ascii_case("INBOX") {
                    inbox_uid_next(&engine, &account)
                } else {
                    0
                };
                let new_inbox = new_unread_inbox_messages(
                    &engine,
                    &account,
                    uid_next_before,
                    uid_next_after,
                    &synced.messages,
                );
                if let Some(headers) = new_inbox
                    && let Some(detail) = new_messages_detail(&engine, &account, &headers).await
                {
                    emit(&out, "mail.newMessages", detail).await;
                    return;
                }
                emit(
                    &out,
                    "mail.synced",
                    json!({ "account": account, "folder": folder, "synced": synced.count }),
                )
                .await
            }
            Err(e) if e.is::<BackgroundSyncCancelled>() => {}
            Err(e) => {
                emit(
                    &out,
                    "mail.syncError",
                    json!({ "account": account, "message": format!("sync {folder}: {e:#}") }),
                )
                .await
            }
        }
    });
}

/// Re-fetch an RSS account's feeds in the background (deduped, blocking pool),
/// then emit `mail.synced` so the UI re-reads the refreshed store.
fn spawn_rss_sync(engine: Arc<Engine>, out: Writer, account: String) {
    if engine.is_paused(&account) {
        return;
    }
    let key = format!("rss:{account}");
    if !engine.syncing.lock().unwrap().insert(key.clone()) {
        return;
    }
    tokio::spawn(async move {
        let blocking = {
            let engine = engine.clone();
            let account = account.clone();
            tokio::task::spawn_blocking(move || rss::sync_account(&engine.db, &account))
        };
        let result = tokio::time::timeout(Duration::from_secs(120), blocking).await;
        engine.syncing.lock().unwrap().remove(&key);
        match result {
            Ok(Ok(Ok(new_items))) => {
                if new_items > 0 {
                    // New feed entries: notify like fresh mail (toast + reload + OS
                    // notification) instead of a silent refresh.
                    let (from, subject, thread_key) = latest_rss_header(&engine, &account)
                        .unwrap_or_else(|| {
                            (
                                "RSS Feed".to_string(),
                                "New feed entry".to_string(),
                                String::new(),
                            )
                        });
                    emit(
                        &out,
                        "mail.newMessages",
                        json!({
                            "account": account,
                            "accountName": account_label(&engine, &account),
                            "folder": "inbox",
                            "count": new_items,
                            "muted": engine.is_muted(&account),
                            "from": from,
                            "subject": subject,
                            "threadKey": thread_key,
                        }),
                    )
                    .await
                } else {
                    emit(
                        &out,
                        "mail.synced",
                        json!({ "account": account, "folder": "inbox" }),
                    )
                    .await
                }
            }
            Ok(Ok(Err(e))) => {
                emit(
                    &out,
                    "error",
                    json!({ "message": format!("rss sync: {e:#}") }),
                )
                .await
            }
            Ok(Err(e)) => {
                emit(
                    &out,
                    "error",
                    json!({ "message": format!("rss sync task: {e}") }),
                )
                .await
            }
            Err(_) => emit(&out, "error", json!({ "message": "rss sync timed out" })).await,
        }
    });
}

/// Refreshes an account's calendars and the occurrences in one window.
///
/// Deduped per account *and window*: a client scrolling through months would
/// otherwise stack a sync per view, while two different windows are genuinely
/// different work.
/// How often reminders are checked. A minute is finer than any reminder is
/// set to, and coarse enough to cost nothing.
const REMINDER_TICK: Duration = Duration::from_secs(60);

/// Brings back threads whose time has come, and sends messages that are due.
///
/// Shares the reminder watch's shape — a query on a tick, not a timer per item
/// — and for the same reason: what is due is a question the store can answer,
/// so nothing has to be kept in sync with it. Both survive restarts, because
/// both were promises made for a time, not for a session.
fn spawn_deferred_watch(engine: Arc<Engine>, out: Writer) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(REMINDER_TICK);
        loop {
            ticker.tick().await;
            let now = now_seconds();

            let due = {
                let db = engine.db.lock().unwrap();
                store::due_snoozes(&db, now).unwrap_or_default()
            };
            for (account, thread_key, folder) in due {
                {
                    let db = engine.db.lock().unwrap();
                    // Cleared before it is announced: a thread brought back
                    // twice is noise, and the second one has nothing to add.
                    if store::unsnooze_thread(&db, &account, &thread_key).is_err() {
                        continue;
                    }
                }
                emit(
                    &out,
                    "mail.unsnoozed",
                    json!({ "account": account, "threadKey": thread_key, "folder": folder }),
                )
                .await;
            }

            // A reply waited for that has not come by the time asked: a
            // notice here, never a message to anyone (#45).
            let due = {
                let db = engine.db.lock().unwrap();
                meron_core::awaiting::due_reminders(&db, now).unwrap_or_default()
            };
            for item in due {
                emit(&out, "mail.awaitingDue", json!({ "item": item })).await;
            }

            // And the other half of the same promise: messages written to go
            // later. The row is only dropped once the message has actually
            // gone, so a crash between sending and forgetting costs a repeat
            // rather than a message that silently never left.
            let due = {
                let db = engine.db.lock().unwrap();
                store::due_scheduled_sends(&db, now).unwrap_or_default()
            };
            // A message whose account the core has not opened yet is not a
            // message that failed: at launch nothing is connected, and letting
            // those minutes count as refusals would use up a message's tries
            // before anything had actually been tried.
            let known: std::collections::HashSet<String> =
                engine.accounts.lock().await.keys().cloned().collect();
            for row in due {
                if !known.contains(&row.account) {
                    continue;
                }
                let message: Value = match serde_json::from_str(&row.payload) {
                    Ok(message) => message,
                    Err(err) => {
                        // Unreadable: trying again cannot help, so it is
                        // failed outright rather than retried, and left where
                        // its writer will see it.
                        let reason = format!("this message can no longer be read: {err}");
                        {
                            let db = engine.db.lock().unwrap();
                            let _ = store::give_up_on_send(&db, &row.id, &reason, now);
                        }
                        emit(&out, "mail.scheduledSendFailed", failed_send_json(&row, &reason))
                            .await;
                        continue;
                    }
                };
                match send_scheduled(&engine, &row, &message, false).await {
                    Ok(ScheduledOutcome::Sent) => {
                        {
                            let db = engine.db.lock().unwrap();
                            let _ = store::cancel_scheduled_send(&db, &row.id);
                        }
                        emit(
                            &out,
                            "mail.scheduledSent",
                            json!({
                                "id": row.id,
                                "account": row.account,
                                "subject": row.subject,
                                // Gone later than asked, because the app was
                                // not running at the hour: said, not hidden.
                                "late": sent_late(row.due_at, now),
                            }),
                        )
                        .await;
                    }
                    Ok(ScheduledOutcome::InFlight) => {}
                    Ok(ScheduledOutcome::Uncertain(reason)) => {
                        // Not a refusal and not a success: nobody knows. It
                        // is not tried again, which could deliver it twice,
                        // and it is not dropped, which could lose it. It
                        // stays in the list for a person, marked as unknown.
                        {
                            let db = engine.db.lock().unwrap();
                            let _ = store::give_up_on_send(&db, &row.id, &reason, now);
                        }
                        emit(&out, "mail.scheduledSendFailed", uncertain_send_json(&row, &reason)).await;
                    }
                    Err(err) => {
                        let reason = format!("{err:#}");
                        let attempts = {
                            let db = engine.db.lock().unwrap();
                            store::record_send_failure(&db, &row.id, &reason, now).unwrap_or_default()
                        };
                        // Told once, when there is nothing left to wait for.
                        // A message that will be tried again in a minute is
                        // not yet news.
                        if attempts >= store::MAX_SEND_ATTEMPTS {
                            emit(&out, "mail.scheduledSendFailed", failed_send_json(&row, &reason))
                                .await;
                        }
                    }
                }
            }
        }
    });
}

/// Raises calendar reminders as they come due, for as long as the core runs.
///
/// The work is a query, not a timer per event: reminders are found by asking
/// the store what is due, so an event created, moved or deleted while the core
/// is running is accounted for on the next tick without anything to keep in
/// sync. Each is recorded as raised, so it is given once however many times
/// its window is resynced.
///
/// It looks at its minute tick and as soon as the host says the machine woke
/// (`system.resumed`). Time is always the wall clock: the tick runs on the
/// monotonic clock, which stands still while some systems sleep, so what came
/// due during a sleep is found by the gap since the last look (ADR-0056).
fn spawn_reminder_watch(engine: Arc<Engine>, out: Writer) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(pim::reminders::TICK);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut resumed = Box::pin(engine.resume_signal.notified());
        resumed.as_mut().enable();
        // Missed reminders the host had not shown when it last quit (held at
        // start or through quiet hours): said again, until it says it showed
        // them (`reminders.missedShown`, #225).
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|epoch| epoch.as_secs() as i64)
            .unwrap_or_default();
        if let Some(missed) = pim::reminders::pending_missed_notice(&engine, now, &chrono::Local) {
            emit(&out, "calendar.missedReminders", missed).await;
        }
        loop {
            if next_reminder_look(&mut ticker, resumed.as_mut()).await == ReminderWake::Resumed {
                // Listening again before this look, so a resume that lands
                // during it is not lost.
                resumed = Box::pin(engine.resume_signal.notified());
                resumed.as_mut().enable();
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|epoch| epoch.as_secs() as i64)
                .unwrap_or_default();

            give_calendar_reminders(&engine, &out, now).await;
            // Task reminders (ADR-0013): local, so not tied to an account.
            let due = store::task_lists::due_reminders(&engine.db.lock().unwrap(), now).unwrap_or_default();
            for (id, title, due_at) in due {
                if store::task_lists::mark_reminded(&engine.db.lock().unwrap(), id, now).is_err() {
                    continue;
                }
                emit(&out, "tasks.reminder", json!({ "id": id, "title": title, "due_at": due_at })).await;
            }
            pim::reminders::forget_old(&engine, now);
        }
    });
}

/// What woke the reminder watch.
#[derive(Debug, PartialEq, Eq)]
enum ReminderWake {
    Tick,
    Resumed,
}

/// Waits for the reminder watch's next look: its tick, or the machine waking
/// (`resumed`, enabled before the look it follows), whichever comes first.
async fn next_reminder_look(
    ticker: &mut tokio::time::Interval,
    resumed: std::pin::Pin<&mut tokio::sync::futures::Notified<'_>>,
) -> ReminderWake {
    tokio::select! {
        _ = ticker.tick() => ReminderWake::Tick,
        _ = resumed => ReminderWake::Resumed,
    }
}

/// One look of the reminder watch at `now`: the calendar reminders due,
/// announced, and the floating calendars a change of zone left to read again.
async fn give_calendar_reminders(engine: &Arc<Engine>, out: &Writer, now: i64) {
    // Shared with the phone (`pim::reminders`): which are due, and recorded
    // as raised before they are announced.
    let look = look_for_reminders(engine, now).await;
    for detail in look.reminders {
        emit(out, "calendar.reminder", detail).await;
    }
    // What came due while nobody looked and is over: one notice (#225).
    if let Some(missed) = look.missed {
        emit(out, "calendar.missedReminders", missed).await;
    }
    // A floating time is read in the zone the machine is in when its calendar
    // is read: after a change of zone, read those again so their times, and
    // reminders, follow. Asked again at later looks until done (ADR-0056).
    for reread in look.reread {
        spawn_calendar_sync(engine.clone(), out.clone(), reread.account, reread.from, reread.to);
    }
}

/// The calendar reminders due now on the accounts the core has open, each
/// recorded as raised, in this machine's zone as it is now
/// (`pim::reminders::look`).
async fn look_for_reminders(engine: &Arc<Engine>, now: i64) -> pim::reminders::Look {
    let accounts: Vec<String> = engine.accounts.lock().await.keys().cloned().collect();
    pim::reminders::look(engine, &accounts, now, &chrono::Local)
}

/// The calendars of an account that hold an invitation's event: CalDAV ones
/// by where the UID lives, local ones by the ids imported events take.
fn invitation_calendars(db: &rusqlite::Connection, account: &str, uid: &str) -> anyhow::Result<Vec<String>> {
    let mut found: Vec<String> = db
        .prepare("SELECT calendar_id FROM caldav_objects WHERE account = ?1 AND uid = ?2")?
        .query_map(rusqlite::params![account, uid], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let local: Vec<String> = db
        .prepare(
            "SELECT DISTINCT calendar_id FROM calendar_events WHERE account = ?1 AND event_id LIKE ?2 ESCAPE '\\'",
        )?
        .query_map(rusqlite::params![account, local_import_pattern(uid)], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    found.extend(local);
    found.sort();
    found.dedup();
    Ok(found)
}

fn local_import_pattern(uid: &str) -> String {
    format!("local:import:{}@%", like_escaped(uid))
}

/// Text matched literally by a LIKE with `ESCAPE '\\'`.
fn like_escaped(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Where a proposal of another time stands for this account: the event it
/// is about when this account organizes it in a calendar kept here, the
/// event's current SEQUENCE when it can be read, and whether the proposal
/// was made against an older version.
struct CounterStanding {
    event: Option<calendar::Event>,
    sequence: Option<i64>,
    outdated: bool,
}

async fn counter_standing(
    engine: &Arc<Engine>,
    account: &str,
    me: &str,
    proposal: &calendar::itip::Invitation,
) -> anyhow::Result<CounterStanding> {
    let event = calendar::itip::organized_event(
        &engine.db.lock().unwrap(),
        account,
        me,
        &proposal.uid,
        proposal.recurrence_id,
    )?;
    let Some(event) = event else {
        return Ok(CounterStanding { event: None, sequence: None, outdated: false });
    };
    // Occurrences keep no SEQUENCE. A CalDAV calendar has the object on its
    // server, which is read; a local event made here keeps it in its change
    // key; a server that cannot be reached leaves it unknown rather than
    // guessed.
    let mut sequence = None;
    let kind = calendar::calendar_of(&engine.db.lock().unwrap(), account, &event.calendar_id)?.map(|found| found.kind);
    if kind == Some(calendar::CalendarKind::Local) && !event.id.starts_with("local:import:") && event.change_key.is_some() {
        sequence = Some(calendar::local_sequence(&event));
    }
    let is_caldav = kind == Some(calendar::CalendarKind::CalDav);
    if is_caldav {
        if let Ok((target, transport)) = caldav_target(engine, account, &event.calendar_id) {
            let located = calendar::caldav::locate(&engine.db.lock().unwrap(), account, &target.id, &proposal.uid)?;
            if let Some(located) = located {
                let url = target.id.clone();
                sequence = tokio::task::spawn_blocking(move || {
                    calendar::caldav::get_object(&transport, &url, &located.href)
                        .ok()
                        .flatten()
                        .and_then(|(object, _)| calendar::itip::sequence_of(&object))
                })
                .await
                .unwrap_or(None);
            }
        }
    }
    let outdated = calendar::itip::is_outdated(proposal, sequence);
    Ok(CounterStanding { event: Some(event), sequence, outdated })
}

/// Puts an answered invitation in a calendar, or brings the copy there up
/// to this version. A copy at a later version is left alone.
async fn keep_invitation(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    calendar_id: &str,
    invitation: &calendar::itip::Invitation,
    me: &str,
    response: calendar::Response,
) -> anyhow::Result<()> {
    let object = calendar::itip::as_event(invitation, me, response);
    let found = calendar::calendar_of(&engine.db.lock().unwrap(), account, calendar_id)?
        .context("that calendar is no longer here")?;
    match found.kind {
        calendar::CalendarKind::Local => {
            let item = calendar::import::Item { uid: invitation.uid.clone(), object, repeats: invitation.repeats };
            let (events, _) = calendar::import::local_events(&item, calendar_id, now_seconds())?;
            let db = engine.db.lock().unwrap();
            db.execute(
                "DELETE FROM calendar_events WHERE account = ?1 AND calendar_id = ?2 AND event_id LIKE ?3 ESCAPE '\\'",
                rusqlite::params![account, calendar_id, local_import_pattern(&invitation.uid)],
            )?;
            for event in &events {
                calendar::put_local_event(&db, account, event)?;
            }
            Ok(())
        }
        calendar::CalendarKind::CalDav => {
            let (target, transport) = caldav_write(engine, account, calendar_id)?.context("that calendar is no longer here")?;
            let located = calendar::caldav::locate(&engine.db.lock().unwrap(), account, &target.id, &invitation.uid)?;
            let uid = invitation.uid.clone();
            let sequence = invitation.sequence;
            let url = target.id.clone();
            let saved = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<calendar::caldav::Located>> {
                use meron_core::carddav::client::Written;
                let href = match located {
                    Some(found) => found.href,
                    None => calendar::caldav::new_href(&url, &uid)?,
                };
                // Whatever is there now decides: nothing, the same or an older
                // version (replaced), or a newer one (kept).
                let written = match calendar::caldav::get_object(&transport, &url, &href)? {
                    None => calendar::caldav::put_object(&transport, &url, &href, &object, None)?,
                    Some((current, etag)) => {
                        if calendar::itip::sequence_of(&current).unwrap_or(0) > sequence {
                            return Ok(None);
                        }
                        calendar::caldav::put_object(&transport, &url, &href, &object, Some(&etag))?
                    }
                };
                match written {
                    Written::Saved { etag } => Ok(Some(calendar::caldav::Located { uid, href, etag: etag.unwrap_or_default() })),
                    Written::Conflict => anyhow::bail!(CALDAV_CONFLICT),
                }
            })
            .await??;
            if let Some(located) = saved {
                calendar::caldav::remember(&engine.db.lock().unwrap(), account, &target.id, &[located])?;
            }
            spawn_calendar_sync(engine.clone(), out.clone(), account.to_string(), invitation.start, invitation.end.max(invitation.start + 1));
            Ok(())
        }
        _ => anyhow::bail!("{} cannot take events from invitations; choose a local or CalDAV calendar", found.name),
    }
}

/// Takes an invitation's event out of the calendars holding it (or of the
/// one named). Returns how many calendars it was removed from.
async fn remove_invitation(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    uid: &str,
    only: Option<&str>,
) -> anyhow::Result<usize> {
    let holding: Vec<String> = invitation_calendars(&engine.db.lock().unwrap(), account, uid)?
        .into_iter()
        .filter(|id| only.is_none_or(|only| only == id))
        .collect();
    for calendar_id in &holding {
        let kind = calendar::calendar_of(&engine.db.lock().unwrap(), account, calendar_id)?.map(|found| found.kind);
        match kind {
            Some(calendar::CalendarKind::Local) => {
                engine.db.lock().unwrap().execute(
                    "DELETE FROM calendar_events WHERE account = ?1 AND calendar_id = ?2 AND event_id LIKE ?3 ESCAPE '\\'",
                    rusqlite::params![account, calendar_id, local_import_pattern(uid)],
                )?;
            }
            Some(calendar::CalendarKind::CalDav) => {
                let (target, transport) = caldav_write(engine, account, calendar_id)?.context("that calendar is no longer here")?;
                let Some(located) = calendar::caldav::locate(&engine.db.lock().unwrap(), account, &target.id, uid)? else { continue };
                let url = target.id.clone();
                let href = located.href.clone();
                tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                    use meron_core::carddav::client::Written;
                    let Some((_, etag)) = calendar::caldav::get_object(&transport, &url, &href)? else { return Ok(()) };
                    match calendar::caldav::delete_object(&transport, &url, &href, &etag)? {
                        Written::Saved { .. } => Ok(()),
                        Written::Conflict => anyhow::bail!(CALDAV_CONFLICT),
                    }
                })
                .await??;
                let db = engine.db.lock().unwrap();
                calendar::caldav::forget(&db, account, &target.id, uid)?;
                calendar::forget_series(&db, account, uid)?;
                db.execute(
                    "DELETE FROM calendar_events WHERE account = ?1 AND calendar_id = ?2 AND event_id LIKE ?3 ESCAPE '\\'",
                    rusqlite::params![account, target.id, format!("{}@%", like_escaped(uid))],
                )?;
            }
            _ => {}
        }
    }
    if !holding.is_empty() {
        let now = now_seconds();
        spawn_calendar_sync(engine.clone(), out.clone(), account.to_string(), now - 86_400 * 31, now + 86_400 * 366);
    }
    Ok(holding.len())
}

/// The route for a server that is looked up before it is kept (#193): that of
/// the account it will be kept under, when the request names one; otherwise
/// the app-wide proxy.
fn lookup_route(engine: &Engine, p: &Value) -> anyhow::Result<meron_core::proxy::ProxyChoice> {
    let account = p.get("account").and_then(Value::as_str).unwrap_or_default();
    meron_core::store::account_proxy(&engine.db.lock().unwrap(), account)
}

/// The transport a bound task list signs in with: its user name, and the
/// password kept in the keychain for it (ADR-0039).
fn task_transport(
    binding: &meron_core::task_sync::Binding,
) -> anyhow::Result<meron_core::carddav::http::UreqTransport> {
    let secrets = meron_core::secrets::load(&meron_core::task_sync::secret_key(&binding.list_id))?;
    Ok(meron_core::carddav::http::UreqTransport {
        username: binding.username.clone(),
        password: secrets.password,
        // A task list is kept under no mail account, so it has no route of its own.
        proxy: meron_core::proxy::ProxyChoice::Global,
    })
}

/// Syncs one bound task list, answering what happened rather than failing:
/// the reason is also kept on the list for the Tasks view to show.
async fn sync_task_list(engine: &Arc<Engine>, binding: meron_core::task_sync::Binding) -> Value {
    let id = binding.list_id.clone();
    let outcome = match task_transport(&binding) {
        Err(error) => Err(error),
        Ok(transport) => {
            let db = engine.db.clone();
            tokio::task::spawn_blocking(move || {
                meron_core::task_sync::sync(&db, &transport, &binding.list_id, now_seconds())
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(|result| result)
        }
    };
    match outcome {
        Ok(report) => json!({ "id": id, "ok": true, "report": report }),
        Err(error) => json!({ "id": id, "ok": false, "error": format!("{error:#}") }),
    }
}

/// The client for a task list kept in an Exchange account (ADR-0058): the
/// account's own sign-in.
async fn exchange_task_client(engine: &Arc<Engine>, account: &str) -> anyhow::Result<meron_core::exchange::EwsClient> {
    meron_core::pim::exchange_book::client(engine, account).await
}

/// Syncs one task list kept in an Exchange account, answering what happened
/// as [`sync_task_list`] does.
async fn sync_exchange_task_list(engine: &Arc<Engine>, list_id: String, account: String) -> Value {
    let outcome = match exchange_task_client(engine, &account).await {
        Err(error) => Err(error),
        Ok(client) => {
            let db = engine.db.clone();
            let list = list_id.clone();
            tokio::task::spawn_blocking(move || {
                meron_core::task_sync::exchange::sync(&db, &client, &list, now_seconds())
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(|result| result)
        }
    };
    match outcome {
        Ok(report) => json!({ "id": list_id, "ok": true, "report": report }),
        Err(error) => {
            // A sign-in that failed never reached the sync, which records its
            // own failures: the list still says why.
            let _ = engine.db.lock().unwrap().execute(
                "UPDATE task_lists SET last_error = ?2 WHERE id = ?1",
                rusqlite::params![list_id, format!("{error:#}")],
            );
            json!({ "id": list_id, "ok": false, "error": format!("{error:#}") })
        }
    }
}

/// Now, as epoch seconds. A clock that cannot be read is treated as the epoch,
/// which shows as "never synced" rather than as a plausible wrong time.
/// Sweeps previewed and not yet confirmed. Process-wide: a review is a thing
/// the interface was shown, not a thing the store knows.
fn sweep_reviews() -> &'static sweep_review::Registry {
    static REVIEWS: std::sync::OnceLock<sweep_review::Registry> = std::sync::OnceLock::new();
    REVIEWS.get_or_init(sweep_review::Registry::new)
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|epoch| epoch.as_secs() as i64)
        .unwrap_or_default()
}

fn spawn_folder_sync(engine: Arc<Engine>, out: Writer, account: String) {
    if engine.is_paused(&account) {
        return;
    }
    let key = format!("folders:{account}");
    if !engine.syncing.lock().unwrap().insert(key.clone()) {
        return;
    }
    tokio::spawn(async move {
        let result = retry_background_sync(
            &format!("folders sync for {account}"),
            || !engine.is_paused(&account),
            || sync_folders(&engine, &account),
        )
        .await;
        engine.syncing.lock().unwrap().remove(&key);
        match result {
            Ok(_) => {
                emit(
                    &out,
                    "mail.synced",
                    json!({ "account": account, "folders": true }),
                )
                .await
            }
            Err(e) if e.is::<BackgroundSyncCancelled>() => {}
            Err(e) => {
                emit(
                    &out,
                    "mail.syncError",
                    json!({ "account": account, "message": format!("folders sync: {e:#}") }),
                )
                .await
            }
        }
    });
}

const IDLE_LIMIT: u32 = 50;

/// Unread messages in the UID range that appeared during the last sync.
/// Startup syncs can advance UIDNEXT for messages that were already read on the
/// server; those should refresh the UI without raising a desktop notification.
fn new_unread_inbox_messages(
    engine: &Arc<Engine>,
    account: &str,
    uid_next_before: u32,
    uid_next_after: u32,
    synced_messages: &[imap::MessageHeader],
) -> Option<Vec<imap::MessageHeader>> {
    let db = engine.db.lock().unwrap();
    store::new_unread_inbox_messages(
        &db,
        account,
        uid_next_before,
        uid_next_after,
        synced_messages,
    )
    .ok()
    .flatten()
}

/// Longest a notification waits on the body fetch its snippets need. Past this
/// the event goes out with whatever bodies are cached: a late notification is
/// worse than one showing subjects alone, and the general prefetch fills the
/// rest in anyway.
const NOTIFY_PREVIEW_TIMEOUT: Duration = Duration::from_secs(8);

/// `mail.newMessages` detail for a batch of arrivals, with the arrivals' bodies
/// fetched first so the notification can show the mail itself.
async fn new_messages_detail(
    engine: &Arc<Engine>,
    account: &str,
    headers: &[imap::MessageHeader],
) -> Option<Value> {
    let uids: Vec<u32> = headers
        .iter()
        .take(mail_model::NEW_MESSAGES_DETAIL_MAX)
        .map(|header| header.uid)
        .collect();
    let fetch = fetch_bodies_for_uids(engine, account, "INBOX", &uids, parse::media_root());
    match tokio::time::timeout(NOTIFY_PREVIEW_TIMEOUT, fetch).await {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => eprintln!("meron-core: notification bodies for {account}: {err:#}"),
        Err(_) => eprintln!("meron-core: notification bodies for {account}: timed out"),
    }
    let account_name = account_label(engine, account);
    let muted = engine.is_muted(account);
    let db = engine.db.lock().unwrap();
    mail_model::new_messages_detail(&db, account, &account_name, muted, headers)
}

/// Newest stored RSS item for an account, or None if the store is empty
/// or the query fails. Used to enrich `mail.newMessages` with the latest
/// sender/subject so OS notifications can show something more useful than a
/// bare count.
fn latest_rss_header(engine: &Arc<Engine>, account: &str) -> Option<(String, String, String)> {
    let db = engine.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT
                COALESCE(m.subject, '(no subject)'),
                COALESCE(NULLIF(s.title, ''), NULLIF(m.from_name, ''), 'RSS Feed') AS feed_title,
                COALESCE(m.folder, '')
             FROM messages m
             LEFT JOIN subscriptions s ON m.account = s.account AND m.folder = s.id
             WHERE m.account = ?1
             ORDER BY m.date DESC, m.id DESC
             LIMIT 1",
        )
        .ok()?;
    stmt.query_row(rusqlite::params![account], |row| {
        Ok((
            row.get::<_, String>(1)?, // from (feed_title)
            row.get::<_, String>(0)?, // subject
            row.get::<_, String>(2)?, // thread_key (folder / subscription_id)
        ))
    })
    .ok()
}

/// Friendly display name or email address of an account for user-facing notifications.
fn account_label(engine: &Arc<Engine>, account: &str) -> String {
    let db = engine.db.lock().unwrap();
    let stmt = db
        .prepare("SELECT display_name, email FROM accounts WHERE id = ?1")
        .ok();
    if let Some(mut s) = stmt
        && let Ok((display_name, email)) = s.query_row(rusqlite::params![account], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
    {
        let mail = email.trim();
        if !mail.is_empty() {
            return mail.to_string();
        }
        let label = display_name.trim();
        if !label.is_empty() {
            return label.to_string();
        }
    }
    account.to_string()
}

/// Cached UIDNEXT for an account's INBOX (0 if unknown). Used to detect whether
/// an IDLE wake brought new mail (UIDNEXT advanced) or only a flag change.
fn inbox_uid_next(engine: &Arc<Engine>, account: &str) -> u32 {
    let db = engine.db.lock().unwrap();
    store::get_folder_state(&db, account, "INBOX")
        .ok()
        .flatten()
        .map(|(_, uid_next)| uid_next)
        .unwrap_or(0)
}

fn watch_key(account: &str, folder: &str) -> String {
    format!("{account}\n{folder}")
}

fn start_idle_watch(engine: Arc<Engine>, out: Writer, account: String, folder: String) -> bool {
    let key = watch_key(&account, &folder);
    {
        let mut watched = engine.watched.lock().unwrap();
        if watched.contains(&key) {
            return false;
        }
        watched.insert(key);
    }
    tokio::spawn(idle_watch(engine, out, account, folder));
    true
}

/// Long-lived per-account/folder IDLE watcher. Reconnects with backoff on error
/// so a dropped connection or server timeout resumes pushing updates.
async fn idle_watch(engine: Arc<Engine>, out: Writer, account: String, folder: String) {
    let key = watch_key(&account, &folder);
    loop {
        // Stop cleanly once the account has been removed (account.remove).
        // IDLE is an IMAP command; Exchange pushes through streaming
        // subscriptions, which this backend does not implement yet, so an
        // Exchange account has no watcher and relies on periodic sync.
        // Without this the watcher would dial its empty IMAP host and log a
        // failed DNS lookup on every retry.
        match engine.accounts.lock().await.get(&account) {
            None => {
                engine.watched.lock().unwrap().remove(&key);
                break;
            }
            Some(creds) if creds.is_ews() || creds.is_graph() || creds.is_local_store() => {
                engine.watched.lock().unwrap().remove(&key);
                break;
            }
            Some(_) => {}
        }
        // Stop checking while paused; account.setPaused respawns us on resume.
        if engine.is_paused(&account) {
            engine.watched.lock().unwrap().remove(&key);
            break;
        }
        if !engine.watched.lock().unwrap().contains(&key) {
            break;
        }
        if let Err(e) = idle_once(&engine, &out, &account, &folder).await {
            emit(
                &out,
                "error",
                json!({ "message": format!("idle {account}/{folder}: {e:#}") }),
            )
            .await;
            // Back off before reconnecting on error, but wake immediately on a
            // pause toggle so a just-paused account stops promptly (next
            // iteration sees is_paused). A clean return (pause or OS resume)
            // skips the backoff: pause exits at the top, resume reconnects now.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(15)) => {}
                _ = engine.pause_signal.notified() => {}
            }
        }
    }
    emit(
        &out,
        "watch.stopped",
        json!({ "account": account, "folder": folder }),
    )
    .await;
}

/// Sync `folder` and surface the result to the UI: a "new mail" toast when
/// INBOX's UIDNEXT advanced (genuine arrivals), otherwise a silent refresh.
/// Shared by the IDLE wake path and the post-connect catch-up so both behave
/// identically.
async fn sync_and_notify(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    folder: &str,
) -> anyhow::Result<()> {
    // An IDLE wake can mean new mail *or* just a flag change (e.g. a message
    // read on another device). UIDNEXT only advances for new arrivals, so
    // compare it across the refresh to tell them apart.
    let is_inbox = folder.eq_ignore_ascii_case("INBOX");
    let uid_next_before = if is_inbox {
        inbox_uid_next(engine, account)
    } else {
        0
    };
    // Refresh on a separate connection (the IDLE one stays dedicated to IDLE).
    let synced = sync_messages(engine, account, folder, IDLE_LIMIT).await?;
    let uid_next_after = if is_inbox {
        inbox_uid_next(engine, account)
    } else {
        0
    };

    let new_inbox = if is_inbox {
        new_unread_inbox_messages(
            engine,
            account,
            uid_next_before,
            uid_next_after,
            &synced.messages,
        )
    } else {
        None
    };

    // Rules run before anything is announced. Mail a rule files away is mail
    // the reader has already said they do not want interrupting them, and a
    // notification for a message that is no longer in the inbox sends them
    // looking for something that is not there.
    let handled = if let Some(headers) = new_inbox.as_deref() {
        apply_rules_to_arrivals(engine, out, account, folder, headers).await
    } else {
        std::collections::HashSet::new()
    };
    // Independent of what rules did with an arrival: an out-of-office reply
    // answers the person who wrote in, which still makes sense even for a
    // message a rule went on to file away.
    if let Some(headers) = new_inbox.as_deref() {
        apply_oof_to_arrivals(engine, account, headers).await;
    }
    let new_inbox = new_inbox.map(|headers| {
        headers
            .into_iter()
            .filter(|header| !handled.contains(&header.uid))
            .collect::<Vec<_>>()
    });

    if let Some(headers) = new_inbox.filter(|headers| !headers.is_empty()) {
        // Building the detail fetches the arrivals' own bodies (the notification
        // shows a snippet of each); warm the rest of the backlog behind it so the
        // first open of anything else is instant too.
        let detail = new_messages_detail(engine, account, &headers).await;
        spawn_body_prefetch(engine.clone(), account.to_string(), "INBOX".to_string());
        if let Some(detail) = detail {
            emit(out, "mail.newMessages", detail).await;
        }
    } else {
        if !is_inbox {
            spawn_body_prefetch(engine.clone(), account.to_string(), folder.to_string());
        }
        // Flag-only change: refresh the UI silently, no "new mail" toast.
        emit(
            out,
            "mail.synced",
            json!({ "account": account, "folder": folder, "synced": synced.count }),
        )
        .await;
    }
    Ok(())
}

/// One IDLE connection lifecycle: hold a dedicated session on one mailbox, and
/// on each server notification refresh that folder in the store.
async fn idle_once(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    folder: &str,
) -> anyhow::Result<()> {
    let creds = engine.ensure_valid_creds(account).await?;
    let mut session = imap::connect(&creds).await?;
    session
        .select(folder)
        .await
        .with_context(|| format!("SELECT {folder}"))?;

    // Catch up before parking in IDLE: the server only pushes notifications for
    // mail that arrives *after* IDLE begins, so anything delivered while we were
    // disconnected (startup, error reconnect, or resume from suspend) would
    // otherwise stay invisible until the next push. Cheap because idle_once is
    // only (re)entered on a fresh connection, not on each 15-min IDLE timeout.
    sync_and_notify(engine, out, account, folder).await?;

    loop {
        let mut handle = session.idle();
        handle.init().await.context("IDLE init")?;
        enum Wake<R> {
            /// The IDLE wait completed: new data, a timeout, or an error.
            Data(R),
            /// The account was paused: return so idle_watch sees is_paused.
            Pause,
            /// The system resumed from suspend: the socket is probably dead.
            Resume,
        }
        let wake = {
            let (idle_fut, _stop) = handle.wait_with_timeout(Duration::from_secs(15 * 60));
            // Cancel the wait early on a pause (so idle_watch shuts the watcher
            // down) or an OS resume (so we drop a likely-dead socket and
            // reconnect) instead of blocking up to the IDLE timeout.
            tokio::select! {
                r = idle_fut => Wake::Data(r),
                _ = engine.pause_signal.notified() => Wake::Pause,
                _ = engine.resume_signal.notified() => Wake::Resume,
            }
        };

        // On resume the connection likely died during suspend, and a graceful
        // DONE could block on it until TCP keepalive times out. Drop the handle
        // (closing the socket) without DONE; idle_watch reconnects immediately.
        if let Wake::Resume = wake {
            drop(handle);
            return Ok(());
        }

        session = handle.done().await.context("IDLE done")?;
        let response = match wake {
            Wake::Data(r) => r,
            Wake::Pause => return Ok(()),
            Wake::Resume => unreachable!("handled above"),
        };

        if let async_imap::extensions::idle::IdleResponse::NewData(_) = response.context("IDLE")? {
            sync_and_notify(engine, out, account, folder).await?;
        }
    }
}

/// Read one book into the address book and record how it went
/// (`pim::people::sync_source`, shared with the phone).
async fn sync_contact_source(engine: &Arc<Engine>, id: &str) -> anyhow::Result<()> {
    pim::people::sync_source(engine, id).await
}

/// Moves the keychain entries this profile names from the inherited `meron`
/// service to `oreneta` in the background, so entries no request reads still
/// move (ADR-0063). Each entry read before the sweep reaches it is moved on
/// that read instead; failures are logged and tried again on the next start.
fn spawn_keychain_migration(engine: &Arc<Engine>) {
    if secrets::keyring_off() {
        return;
    }
    let names = meron_core::profile_purge::keychain_names(&engine.db.lock().unwrap());
    match names {
        Ok(names) => {
            tokio::task::spawn_blocking(move || secrets::migrate_legacy(&names));
        }
        Err(err) => meron_core::mlog!(
            meron_core::log::Level::Warn,
            "keyring",
            "could not list the keychain entries to move; each is moved on its first read: {err:#}"
        ),
    }
}

#[tokio::main]
async fn main() {
    // Tag panics consistently on stderr, which the desktop bridge copies into
    // meron.log; a panic in a worker task would otherwise be easy to miss.
    meron_core::log::install_panic_hook();
    // Deleting another profile (ADR-0038): run once inside it, remove every
    // keychain entry its store names, and exit. Never the default profile.
    if std::env::args().any(|arg| arg == "--purge-profile") {
        let profile = std::env::var("MERON_PROFILE").unwrap_or_default();
        let result = if profile.trim().is_empty() || profile == "default" {
            Err(anyhow::anyhow!("only another, named profile can be purged"))
        } else {
            store::open().and_then(|conn| meron_core::profile_purge::purge(&conn))
        };
        match result {
            Ok(purged) => {
                println!("{}", json!({ "purged": purged }));
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!("meron-core: could not purge profile {profile}: {err:#}");
                std::process::exit(1);
            }
        }
    }
    let out: Writer = Arc::new(Mutex::new(tokio::io::stdout()));
    let engine = match Engine::new(Box::new(DesktopHost)) {
        Ok(engine) => Arc::new(engine),
        Err(e) => {
            // Storage is unusable (an unreachable keychain, a store encrypted
            // with a key we no longer hold). Keep serving stdin anyway: exiting
            // here left the bridge writing into a dead pipe, so every request
            // died of its own timeout and the UI could only report the engine
            // as generically unavailable. Answering each one with the real
            // reason is what makes the failure diagnosable.
            let message = format!("store init: {e:#}");
            emit(&out, "core.fatal", json!({ "message": message })).await;
            run_degraded(&out, &message).await;
            return;
        }
    };

    spawn_keychain_migration(&engine);

    // Resume IDLE for accounts whose credentials persisted across restarts.
    let known: Vec<String> = engine.accounts.lock().await.keys().cloned().collect();
    for account in known {
        // Paused accounts skip auto-resume; account.setPaused starts them on resume.
        if engine.is_paused(&account) {
            continue;
        }
        // Warm the INBOX backlog (unread + recent) so it's readable offline and
        // opens instantly, without waiting for the UI to request the folder.
        spawn_body_prefetch(engine.clone(), account.clone(), "INBOX".to_string());
        start_idle_watch(engine.clone(), out.clone(), account, "INBOX".to_string());
    }

    // Reminders are watched for as long as the core runs, not per account:
    // the query already knows which accounts have anything due.
    // Before anything can be sent: a send the last process died in the
    // middle of has an outcome nobody knows, and must be marked as such
    // before the scheduled watch could mistake its row for one never tried.
    {
        let db = engine.db.lock().unwrap();
        let now = now_seconds();
        match outgoing::mark_interrupted_uncertain(&db, now) {
            Ok(0) => {}
            Ok(n) => eprintln!("meron-core: {n} send(s) interrupted by the last shutdown are marked as uncertain"),
            Err(err) => eprintln!("meron-core: could not reconcile interrupted sends: {err:#}"),
        }
        let _ = outgoing::prune_settled(&db, now - OUTGOING_HISTORY_SECONDS);
        // A mailing that was sending is paused, and its message on the way
        // settled from its attempt (#90): carrying on is the person's call.
        if let Err(err) = meron_core::merge::recover(&db, now) {
            eprintln!("meron-core: could not reconcile mailings: {err:#}");
        }
    }

    // Chat accounts connect at startup (#111).
    let chat_ids: Vec<String> = meron_core::chat::accounts(&engine.db.lock().unwrap())
        .map(|accounts| accounts.into_iter().map(|a| a.id).collect())
        .unwrap_or_default();
    for id in chat_ids {
        if let Err(err) = start_chat(&engine, out.clone(), &id) {
            eprintln!("meron-core: chat account {id}: {err:#}");
        }
    }

    // A model download the last run did not finish leaves nothing usable.
    meron_core::translation::clean_partial(&meron_core::translation::models_dir());

    spawn_reminder_watch(engine.clone(), out.clone());
    spawn_deferred_watch(engine.clone(), out.clone());
    spawn_backup_schedule(engine.clone(), out.clone());
    spawn_auto_archive(engine.clone(), out.clone());

    emit(&out, "ready", ready_event()).await;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) | Err(_) => break, // stdin closed: bridge is gone, exit.
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(line) {
            // Handle each request on its own task so a slow IMAP call (sync,
            // thread read) can't block the read loop and stall unrelated
            // requests like account.connect behind it.
            Ok(req) => {
                let engine = engine.clone();
                let out = out.clone();
                tokio::spawn(async move { handle(engine, req, &out).await });
            }
            Err(e) => {
                emit(
                    &out,
                    "error",
                    json!({ "message": format!("bad request: {e}") }),
                )
                .await
            }
        }
    }
}

/// Serve stdin without an engine: answer `ping` (so the bridge can still tell a
/// live process from a dead one) and fail everything else with `reason`. Runs
/// until the bridge closes stdin.
async fn run_degraded(out: &Writer, reason: &str) {
    eprintln!("meron-core: running degraded, storage unavailable: {reason}");
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Request>(line) else {
            continue;
        };
        if req.method == "ping" {
            respond(out, req.id, ping_response()).await;
        } else {
            respond_error(out, req.id, reason).await;
        }
    }
}

async fn handle(engine: Arc<Engine>, req: Request, out: &Writer) {
    match dispatch(&engine, &req, out).await {
        Ok(value) => respond(out, req.id, value).await,
        Err(e) => {
            // Surface failures on stderr (inherited by the app) so swallowed
            // RPC errors are diagnosable.
            eprintln!("meron-core: {} failed: {e:#}", req.method);
            respond_error(out, req.id, &format!("{e:#}")).await;
        }
    }
}

async fn prepare_recent_cache(
    engine: &Arc<Engine>, account: &str, folder: &str, request: &thread_list::ThreadListQuery,
) {
    let Some(filter) = cached_conversations::recent_filter(request) else { return };
    // Preserve the existing attachment/priority backfill before answering facets.
    if filter.with_attachments { fill_in_attachment_flags(engine, account, folder).await; }
    if filter.priority_only {
        if let Err(err) = store::rejudge_priority(&engine.db.lock().unwrap(), account, true) {
            eprintln!("meron-core: judging {account}: {err:#}");
        }
    }
    if filter.category.is_some() {
        if let Err(err) = meron_core::categories::rejudge(&engine.db.lock().unwrap(), account, true) {
            eprintln!("meron-core: placing {account}: {err:#}");
        }
    }
}

async fn dispatch(engine: &Arc<Engine>, req: &Request, out: &Writer) -> anyhow::Result<Value> {
    let p = &req.params;
    // A proxy setting that could not be read at start is read again before
    // each command, so a passing failure does not hold connections (#192).
    proxy::reload_if_unreadable(&engine.db.lock().unwrap());
    meron_core::graph::mail::guard_command(&engine.db.lock().unwrap(),&req.method,p)?;
    match req.method.as_str() {
        "ping" => Ok(ping_response()),

        "graph.authBegin" => {
            let _lifecycle = engine.graph_lifecycle.lock().await;
            let selected = p.get("account").and_then(Value::as_str)
                .filter(|s| !s.is_empty()).map(str::to_owned);
            let route = if let Some(account) = &selected {
                let conn = engine.db.lock().unwrap();
                let creds = store::load_account(&conn, account)?
                    .context("Graph authorization: unknown account")?;
                anyhow::ensure!(creds.delegate_account_id.is_empty() && creds.target_mailbox.is_empty(),
                    "Graph authorization: shared mailbox unsupported");
                creds.proxy
            } else { proxy::ProxyChoice::Global };
            let manager = engine.graph_auth.clone();
            let client = req_str(p, "client_id")?;
            let redirect = req_str(p, "redirect_uri")?;
            // `writes` asks for message changes on an existing account (#141).
            // and `send` asks for sending (#143).
            let level = meron_core::graph::auth::Level {
                writes: p.get("writes").and_then(Value::as_bool).unwrap_or(false),
                send: p.get("send").and_then(Value::as_bool).unwrap_or(false),
            };
            let begin = tokio::task::spawn_blocking(move || manager.begin_level(selected, &client, &redirect, route, level)).await??;
            Ok(serde_json::to_value(begin)?)
        }
        "graph.authPoll" => {
            let manager = engine.graph_auth.clone();
            let attempt = req_str(p, "attempt")?;
            Ok(serde_json::to_value(tokio::task::spawn_blocking(move || manager.poll(&attempt)).await?)?)
        }
        "graph.activationBegin" => {
            let _lifecycle=engine.graph_lifecycle.lock().await;
            let lease=engine.graph_mail.activate(&req_str(p,"attempt")?,p.get("display_name").and_then(Value::as_str).unwrap_or("Microsoft Graph"))?;
            Ok(serde_json::to_value(lease)?)
        }
        "graph.activationPoll" => {
            let account=req_str(p,"account")?;
            let generation=req_str(p,"generation")?;
            let status={
                let conn=engine.db.lock().unwrap();
                let current:String=conn.query_row("SELECT generation FROM graph_profiles WHERE account=?1",[&account],|r|r.get(0))?;
                anyhow::ensure!(generation==current,"Microsoft Graph: Cancelled");
                meron_core::graph::mail::status(&conn,&account)?
            };
            if status.mail_backend_ready {
                let mut accounts=engine.accounts.lock().await;
                if let Some(creds)=store::load_account(&engine.db.lock().unwrap(),&account)? {accounts.insert(account,creds);}
            }
            Ok(serde_json::to_value(status)?)
        }
        "graph.activationCancel" => {
            let _lifecycle=engine.graph_lifecycle.lock().await;
            let lease=meron_core::graph::mail::Lease{account:req_str(p,"account")?,generation:req_str(p,"generation")?};
            meron_core::graph::mail::cancel(&engine.db.lock().unwrap(),&lease)?;
            Ok(json!({"ok":true}))
        }
        "graph.authCancel" => {
            let manager = engine.graph_auth.clone();
            let attempt = req_str(p, "attempt")?;
            tokio::task::spawn_blocking(move || manager.cancel(&attempt)).await?;
            Ok(json!({"ok":true}))
        }
        "graph.authComplete" => {
            let manager = engine.graph_auth.clone();
            let attempt = req_str(p, "attempt")?;
            let state = req_str(p, "state")?;
            let code = p.get("code").and_then(Value::as_str).unwrap_or("").to_owned();
            let denied = p.get("denied").and_then(Value::as_bool).unwrap_or(false);
            let result = tokio::task::spawn_blocking(move ||
                manager.complete(&attempt, &state, &code, denied)).await??;
            Ok(serde_json::to_value(result)?)
        }
        "graph.disconnect" => {
            let _lifecycle=engine.graph_lifecycle.lock().await;
            let manager = engine.graph_auth.clone();
            let account = req_str(p, "account")?;
            {
                let conn=engine.db.lock().unwrap();
                if let Ok(generation)=conn.query_row("SELECT generation FROM graph_profiles WHERE account=?1",[&account],|r|r.get::<_,String>(0)) {
                    meron_core::graph::mail::cancel(&conn,&meron_core::graph::mail::Lease{account:account.clone(),generation})?;
                }
            }
            tokio::task::spawn_blocking(move || manager.disconnect(&account)).await??;
            Ok(json!({"ok":true}))
        }

        // Fetch the in-app changelog from the GitHub releases atom feed. The
        // network call runs on the blocking pool.
        "changelog.fetch" => {
            let variant = changelog::Variant::parse(
                p.get("variant")
                    .and_then(Value::as_str)
                    .unwrap_or("desktop"),
            );
            let releases = tokio::task::spawn_blocking(move || changelog::fetch(variant)).await??;
            Ok(releases)
        }

        "localDrafts.save" | "localDrafts.delete" | "localDrafts.get" | "localDrafts.list" => {
            store::local_drafts::dispatch(&engine.db.lock().unwrap(), &req.method, p)
        }
        "app.prefsGet" => {
            let keys = p
                .get("keys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let prefs = store::settings_get(&engine.db.lock().unwrap(), &keys)?;
            Ok(json!({ "prefs": prefs }))
        }

        "app.prefsSet" => {
            let key = req_str(p, "key")?;
            anyhow::ensure!(!key.starts_with("graph.grant."), "reserved Graph association setting");
            let value = p.get("value").cloned().unwrap_or(Value::Null);
            store::setting_set(&engine.db.lock().unwrap(), &key, &value)?;
            // The proxy lives in a process-global slot that socket code reads
            // without a DB handle, so republish it as soon as it changes.
            if key == proxy::SETTING_KEY {
                proxy::publish_global(&value);
            }
            Ok(json!({ "ok": true }))
        }

        // The proxy one outbound HTTP request from the Go bridge must use
        // (autodiscovery, OAuth sign-in, avatars, update check and download).
        // Errors when a proxy is set but unusable, so the caller never falls
        // back to a direct connection.
        "proxy.route" => {
            let account = p.get("account").and_then(Value::as_str).filter(|s| !s.is_empty());
            proxy::route_json(&engine.db.lock().unwrap(), account)
        }

        "assistant.preview" => {
            let provider: assistant::ProviderConfig = serde_json::from_value(
                p.get("provider").cloned().context("missing assistant provider")?,
            )?;
            let action = req_str(p, "action")?;
            let instruction = p.get("instruction").and_then(Value::as_str).unwrap_or("").to_string();
            let context: Vec<assistant::ContextItem> = serde_json::from_value(
                p.get("context").cloned().context("missing assistant context")?,
            )?;
            Ok(serde_json::to_value(assistant::prepare(provider, &action, &instruction, &context)?)?)
        }

        "assistant.execute" => {
            let request: assistant::ExecuteRequest = serde_json::from_value(p.clone())?;
            assistant::execute_cancellable(assistant::agent(&request.provider)?, request).await
        }

        "assistant.cancel" => assistant::cancel(&req_str(p, "execution_id")?),

        // Puts a thread aside until a time, and takes it out of the list until
        // then. Its folder travels with it: coming back means coming back
        // where it was.
        "mail.snooze" => {
            // Addressed by the thread id the interface already holds; the key
            // and folder inside it are what the store needs, and deriving them
            // here keeps that encoding in one place.
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let account = parsed.account.clone();
            let thread_key = parsed.thread_key.clone();
            let folder = parsed.folder.clone();
            let until = p.get("until").and_then(Value::as_i64).context("missing param: until")?;
            if until <= now_seconds() {
                anyhow::bail!("a thread cannot be put aside until a moment already past");
            }
            store::snooze_thread(
                &engine.db.lock().unwrap(),
                &account,
                &thread_key,
                &folder,
                until,
            )?;
            Ok(json!({ "ok": true }))
        }

        "mail.unsnooze" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let (account, thread_key) = (parsed.account.clone(), parsed.thread_key.clone());
            store::unsnooze_thread(&engine.db.lock().unwrap(), &account, &thread_key)?;
            Ok(json!({ "ok": true }))
        }

        // What has been put aside, so it can be found again: a thread that
        // vanishes with no way to look it up is lost, not postponed.
        "mail.snoozed" => {
            let account = req_str(p, "account")?;
            let rows = store::snoozed_threads(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({
                "threads": rows
                    .into_iter()
                    .map(|(thread_key, folder, until)| json!({
                        "threadKey": thread_key,
                        "folder": folder,
                        "until": until,
                    }))
                    .collect::<Vec<_>>()
            }))
        }

        // What a sweep would move, moving nothing.
        //
        // Asked before it is done, always. A sweep is the one action here that
        // reaches messages the reader is not looking at, and an action like
        // that has to show its work first — the same rule the rules follow.
        "mail.sweepPreview" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let from_addr = req_str(p, "from")?;
            let keep = p.get("keep_newest").and_then(Value::as_u64).unwrap_or(1) as u32;
            let (candidates, uidvalidity) = {
                let db = engine.db.lock().unwrap();
                (
                    store::sweep_candidates(&db, &account, &folder, &from_addr, keep)?,
                    store::get_folder_state(&db, &account, &folder)?.map(|(validity, _)| validity).unwrap_or(0),
                )
            };
            // The list is what gets confirmed, not the question that produced
            // it: the review names these messages, in this folder as it is now,
            // and confirming it later acts on them and nothing that arrived since.
            let review_id = sweep_reviews().issue(
                &account,
                &folder,
                uidvalidity,
                candidates.iter().map(|candidate| candidate.uid).collect(),
                now_seconds(),
            );
            Ok(json!({
                "from": from_addr,
                "folder": folder,
                "keepNewest": keep,
                "reviewId": review_id,
                "uidvalidity": uidvalidity,
                "messages": candidates
                    .iter()
                    .map(|candidate| json!({
                        "uid": candidate.uid,
                        "subject": candidate.subject,
                        "date": candidate.date,
                    }))
                    .collect::<Vec<_>>(),
            }))
        }

        // Does the sweep that was previewed: those messages, once, and only
        // while the folder is still the folder they were previewed in.
        //
        // The answer is item by item. A move that fails part-way, or a
        // message another client took first, leaves reviewed messages behind,
        // and the reader is told which rather than shown a count that says
        // everything went.
        "mail.sweepExecute" => {
            let account = req_str(p, "account")?;
            let review_id = req_str(p, "review_id")?;
            let review = sweep_reviews().take(&review_id, &account, now_seconds())?;
            {
                let db = engine.db.lock().unwrap();
                let current = store::get_folder_state(&db, &account, &review.folder)?.map(|(validity, _)| validity);
                sweep_review::check_folder_unchanged(&review, current)?;
            }
            if review.uids.is_empty() {
                return Ok(json!({
                    "ok": true,
                    "swept": 0,
                    "unresolved": [],
                    "folder": review.folder,
                    "complete": true,
                }));
            }
            // The trash as the cache knows it, or as the server names it when
            // the folder list has not been read yet — the same lookup a
            // delete makes, so a sweep never goes to a different place.
            let cached_trash = store::folder_for_role(&engine.db.lock().unwrap(), &account, "trash")?;
            let target = match cached_trash {
                Some(trash) => trash,
                None => engine
                    .with_write_session(&account, |session| {
                        Box::pin(async move {
                            let trash = session.find_trash_folder().await?;
                            anyhow::Ok(trash)
                        })
                    })
                    .await?
                    .context("this account has no trash folder")?,
            };
            // The move itself is the ordinary one, with the reviewed UIDs and
            // nothing recomputed; its own failure is reported after the
            // per-item check below, which is what the reader needs to see.
            let move_request = Request {
                id: req.id,
                method: "messages.move".to_string(),
                params: json!({
                    "account": account,
                    "folder": review.folder,
                    "target_folder": target,
                    "uids": review.uids,
                }),
            };
            let moved = Box::pin(dispatch(engine, &move_request, out)).await;
            let remaining = {
                let db = engine.db.lock().unwrap();
                store::existing_message_uids(&db, &account, &review.folder, &review.uids)?
            };
            let outcome = sweep_review::SweepOutcome::from_remaining(&review.uids, &remaining);
            let error = moved.err().map(|err| format!("{err:#}"));
            Ok(json!({
                "ok": error.is_none(),
                "swept": outcome.swept.len(),
                "sweptUids": outcome.swept,
                "unresolved": outcome.unresolved,
                "folder": target,
                "complete": outcome.complete() && error.is_none(),
                "error": error,
            }))
        }

        // Why a conversation is where it is, and what the reader has said about
        // its sender.
        //
        // Asked for one conversation at a time rather than carried on every
        // card: a reason is only wanted when someone wonders, and computing
        // fifty of them to show none would be work nobody asked for.
        "mail.priorityReason" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let db = engine.db.lock().unwrap();
            // The newest message of the conversation: the one whose sender the
            // reader is looking at, and whose arrival decided where the
            // conversation sits.
            let (sender, signals) = store::thread_priority_signals(
                &db,
                &parsed.account,
                &parsed.folder,
                &parsed.thread_key,
            )?
            .context("no such conversation")?;
            let verdict = priority::verdict(signals);
            Ok(json!({
                "priority": verdict.priority,
                "reasons": verdict.reasons,
                "sender": sender,
                "override": signals.sender_override,
            }))
        }

        // Records what the reader decided about a sender, and re-judges the
        // account so every conversation from them moves at once — a decision
        // that only applied to the message it was made on would be a decision
        // the reader has to keep making.
        "mail.setSenderPriority" => {
            let account = req_str(p, "account")?;
            let addr = req_str(p, "addr")?;
            let choice = p.get("priority").and_then(Value::as_bool);
            let db = engine.db.lock().unwrap();
            store::set_sender_priority(&db, &account, &addr, choice)?;
            let judged = store::rejudge_priority(&db, &account, false)?;
            Ok(json!({ "ok": true, "judged": judged }))
        }

        // The reader's rules on the account's server (#94, ADR-0027), through
        // ManageSieve. Nothing goes to the server until the person pushes.
        "rules.serverStatus" => {
            let account = req_str(p, "account")?;
            let creds = engine.ensure_valid_creds(&account).await?;
            if let Some(reason) = sieve_unavailable(&creds) {
                return Ok(json!({ "available": false, "reason": reason }));
            }
            let last = rules::server::state(&engine.db.lock().unwrap(), &account)?;
            let (mut session, caps) = match rules::managesieve::connect(&creds).await {
                Ok(open) => open,
                Err(err) => return Ok(json!({ "available": false, "reason": format!("{err:#}") })),
            };
            let status = rules::managesieve::status(&mut session, caps.clone(), last.as_ref().map(|s| s.script_hash.as_str())).await?;
            session.logout().await?;
            let plan = server_rule_plan(engine, &account, &caps.sieve);
            Ok(json!({ "available": true, "status": status, "plan": plan, "state": last }))
        }
        "rules.serverPush" => {
            let account = req_str(p, "account")?;
            let overwrite = p.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
            let creds = engine.ensure_valid_creds(&account).await?;
            if let Some(reason) = sieve_unavailable(&creds) {
                anyhow::bail!(reason);
            }
            let last = rules::server::state(&engine.db.lock().unwrap(), &account)?;
            let (mut session, caps) = rules::managesieve::connect(&creds).await?;
            let plan = server_rule_plan(engine, &account, &caps.sieve);
            let pushed = rules::managesieve::push(
                &mut session,
                &plan.script,
                last.as_ref().map(|s| s.script_hash.as_str()),
                overwrite,
            )
            .await?;
            session.logout().await?;
            if let rules::managesieve::Pushed::Stored { hash, active, .. } = &pushed {
                rules::server::save(
                    &engine.db.lock().unwrap(),
                    &account,
                    &rules::server::State {
                        script_hash: hash.clone(),
                        included: plan.included.clone(),
                        active: *active,
                        pushed_at: now_seconds(),
                    },
                )?;
            }
            Ok(json!({ "pushed": pushed, "plan": plan }))
        }
        "rules.serverRemove" => {
            let account = req_str(p, "account")?;
            let creds = engine.ensure_valid_creds(&account).await?;
            if let Some(reason) = sieve_unavailable(&creds) {
                anyhow::bail!(reason);
            }
            let (mut session, _) = rules::managesieve::connect(&creds).await?;
            let removed = rules::managesieve::remove(&mut session).await?;
            session.logout().await?;
            // Only once it is off the server do the rules run here again.
            rules::server::clear(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({ "removed": removed }))
        }

        // Tracking protection (#107, ADR-0029). The list is replaced only
        // when the person asks, from the one fixed source, after it checks out.
        "privacy.info" => Ok(serde_json::to_value(meron_core::privacy::info())?),
        "privacy.update" => {
            let text = tokio::task::spawn_blocking(|| -> anyhow::Result<String> {
                let agent = meron_core::proxy::agent()?;
                let mut response = agent
                    .get(meron_core::privacy::UPDATE_URL)
                    .call()
                    .context("the list could not be fetched")?;
                let text = response
                    .body_mut()
                    .with_config()
                    .limit(meron_core::privacy::MAX_LIST_BYTES as u64)
                    .read_to_string()
                    .context("the list could not be read")?;
                Ok(text)
            })
            .await??;
            let info = meron_core::privacy::install(&text, &meron_core::privacy::filters_dir()?)?;
            Ok(serde_json::to_value(info)?)
        }
        "privacy.reset" => {
            meron_core::privacy::reset(&meron_core::privacy::filters_dir()?)?;
            Ok(serde_json::to_value(meron_core::privacy::info())?)
        }
        // Read receipts (ADR-0048). Status may send one, but only under the
        // person's own "always" and only where that is safe; answer is the
        // person's click in the reader bar.
        "receipts.status" | "receipts.answer" => {
            let parsed = meron_core::protocol::mail::parse_thread_id(&req_str(p, "id")?)
                .context("invalid message id")?;
            let uid = parsed.uid.context("not a single message")?;
            let account = parsed.account;
            let folder = canon_folder(&req_str(p, "folder").unwrap_or(parsed.folder));
            let status = if req.method == "receipts.status" {
                meron_core::receipts::status(engine, &account, &folder, uid, now_seconds()).await?
            } else {
                let send = p.get("send").and_then(Value::as_bool).context("missing bool param: send")?;
                meron_core::receipts::answer(engine, &account, &folder, uid, send, now_seconds()).await?
            };
            Ok(serde_json::to_value(status)?)
        }
        "privacy.allowMessage" => {
            let allow = p.get("allow").and_then(Value::as_bool).unwrap_or(true);
            meron_core::privacy::set_exception(
                &engine.db.lock().unwrap(),
                &req_str(p, "account")?,
                &req_str(p, "message_id")?,
                allow,
            )?;
            Ok(json!({ "ok": true }))
        }

        // Chat over XMPP (#111, ADR-0036). Messages are sent only when the
        // person sends them; one whose fate is unknown is never resent alone.
        "chat.accounts" => Ok(serde_json::to_value(meron_core::chat::accounts(&engine.db.lock().unwrap())?)?),
        "chat.status" => Ok(json!(chat_status().lock().unwrap().clone())),
        "chat.save" => {
            let account: meron_core::chat::ChatAccount =
                serde_json::from_value(p.get("account").cloned().context("missing account")?)?;
            meron_core::chat::save_account(&engine.db.lock().unwrap(), &account, now_seconds())?;
            if let Some(password) = p.get("password").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                secrets::store(
                    &meron_core::chat::secret_key(&account.id),
                    &secrets::Secrets { password: password.to_string(), ..Default::default() },
                )?;
            }
            start_chat(&engine, out.clone(), &account.id)?;
            Ok(json!({ "ok": true }))
        }
        "chat.remove" => {
            let id = req_str(p, "id")?;
            stop_chat(&id);
            let room_keys = meron_core::chat::room_secret_keys(&engine.db.lock().unwrap(), &id)?;
            for key in room_keys {
                let _ = secrets::delete(&key);
            }
            meron_core::chat::remove_account(&engine.db.lock().unwrap(), &id)?;
            let _ = secrets::delete(&meron_core::chat::secret_key(&id));
            chat_status().lock().unwrap().remove(&id);
            chat_live().lock().unwrap().remove(&id);
            Ok(json!({ "ok": true }))
        }
        "chat.conversations" => Ok(serde_json::to_value(meron_core::chat::conversations(
            &engine.db.lock().unwrap(),
            &req_str(p, "account")?,
        )?)?),
        "chat.history" => Ok(serde_json::to_value(meron_core::chat::history(
            &engine.db.lock().unwrap(),
            &req_str(p, "account")?,
            &req_str(p, "conversation")?,
            p.get("limit").and_then(Value::as_i64).unwrap_or(200),
        )?)?),
        "chat.markRead" => {
            meron_core::chat::mark_read(
                &engine.db.lock().unwrap(),
                &req_str(p, "account")?,
                &req_str(p, "conversation")?,
                now_seconds(),
            )?;
            Ok(json!({ "ok": true }))
        }
        "chat.send" => {
            let account = req_str(p, "account")?;
            let conversation = meron_core::chat::normalize_conversation(&req_str(p, "conversation")?);
            let body = req_str(p, "body")?;
            // Nicknames picked from the suggestions, sent as references (ADR-0055).
            let mentions: Vec<String> = p
                .get("mentions")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).take(50).map(str::to_string).collect())
                .unwrap_or_default();
            let me = meron_core::chat::account(&engine.db.lock().unwrap(), &account)?;
            let id = uuid::Uuid::new_v4().to_string();
            // To a room, it goes as a group message under the person's nickname
            // there; privately to someone in a room (`room/nick`), under it too.
            let (kind, sender) = {
                let db = engine.db.lock().unwrap();
                match meron_core::chat::split_private(&conversation) {
                    Some((room, _)) => (
                        meron_core::chat::KIND_PRIVATE,
                        meron_core::chat::room_nick(&db, &account, room)?
                            .context("write privately only to someone in a group you are in")?,
                    ),
                    None => match meron_core::chat::room_nick(&db, &account, &conversation)? {
                        Some(nick) => (meron_core::chat::KIND_GROUP, nick),
                        None => (meron_core::chat::KIND_CHAT, me.jid.clone()),
                    },
                }
            };
            let mut message = meron_core::chat::ChatMessage::chat(
                &account,
                &conversation,
                &id,
                "out",
                &sender,
                &body,
                now_seconds(),
                "sending",
            );
            message.kind = kind.into();
            meron_core::chat::queue_message(&engine.db.lock().unwrap(), &message)?;
            chat_dispatch(&engine, &message, mentions);
            Ok(json!({ "id": id }))
        }
        "chat.retry" => {
            // Only by the person's choice, with the same id, so a copy that did
            // arrive is recognised as the same message.
            let account = req_str(p, "account")?;
            let id = req_str(p, "id")?;
            let message = meron_core::chat::outgoing(&engine.db.lock().unwrap(), &account, &id)?;
            anyhow::ensure!(
                matches!(message.state.as_str(), "uncertain" | "failed"),
                "only a message whose sending failed or is uncertain can be sent again"
            );
            meron_core::chat::set_state(&engine.db.lock().unwrap(), &account, &id, "sending")?;
            // In a room, the people it names (`@nick`, among those there now)
            // go again as references: the picks themselves are not kept.
            let mentions = if message.kind == meron_core::chat::KIND_GROUP {
                let nicks: Vec<String> = chat_live()
                    .lock()
                    .unwrap()
                    .get(&account)
                    .map(|live| live.lock().unwrap().occupants.list(&message.conversation).into_iter().map(|o| o.nick).collect())
                    .unwrap_or_default();
                meron_core::chat::mentions::written_mentions(&message.body, &nicks)
            } else {
                Vec::new()
            };
            chat_dispatch(&engine, &message, mentions);
            Ok(json!({ "ok": true }))
        }
        // Presence (ADR-0055): the person's own status, what the session
        // knows of others, and asking or answering to see a status, only on
        // the person's click.
        "chat.presence" => {
            let account = req_str(p, "account")?;
            let live = chat_live().lock().unwrap().get(&account).cloned();
            meron_core::chat::presence::snapshot(&engine.db.lock().unwrap(), &account, live.as_ref())
        }
        "chat.setPresence" => {
            let account = req_str(p, "account")?;
            let show = req_str(p, "show")?;
            let status = p.get("status").and_then(Value::as_str).unwrap_or_default().to_string();
            meron_core::chat::account(&engine.db.lock().unwrap(), &account)?;
            if show == "invisible" {
                // Only where the server said it can hide the person (XEP-0186).
                let supported = chat_live()
                    .lock()
                    .unwrap()
                    .get(&account)
                    .and_then(|live| live.lock().unwrap().invisible_supported);
                anyhow::ensure!(
                    supported.is_some(),
                    "connect to check whether this chat server can hide you; nothing was changed"
                );
                anyhow::ensure!(supported == Some(true), "this chat server cannot hide you; nothing was changed");
            }
            let own = meron_core::chat::presence::save_own(&engine.db.lock().unwrap(), &account, &show, &status)?;
            if let Some(tx) = chat_sessions().lock().unwrap().get(&account) {
                let _ = tx.send(meron_core::chat::xmpp::Command::Presence);
            }
            Ok(json!({ "show": own.show, "status": own.status }))
        }
        "chat.subscribe" | "chat.answerSubscription" => {
            let account = req_str(p, "account")?;
            let jid = req_str(p, "jid")?.trim().to_lowercase();
            // Denying, or no longer letting someone see the status, goes to any
            // address the roster may hold (a gateway, a server without dots,
            // ADR-0064); asking and allowing need a person's address.
            let denying = req.method == "chat.answerSubscription" && p.get("allow").and_then(Value::as_bool) == Some(false);
            if denying {
                anyhow::ensure!(
                    !jid.is_empty() && jid.parse::<tokio_xmpp::parsers::jid::BareJid>().is_ok(),
                    "this is not a chat address"
                );
            } else {
                anyhow::ensure!(
                    jid.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.contains('/')),
                    "an address looks like name@server.example"
                );
            }
            // Asked only on a live connection: nothing waits to go out later.
            let online = chat_status().lock().unwrap().get(&account).is_some_and(|s| s["state"] == "online");
            anyhow::ensure!(online, "this chat account is not connected; nothing was sent");
            let command = if req.method == "chat.subscribe" {
                meron_core::chat::xmpp::Command::Subscribe { jid }
            } else {
                let allow = p.get("allow").and_then(Value::as_bool).context("missing allow")?;
                // Letting someone see the status only answers someone who asked.
                if allow {
                    let asked = chat_live()
                        .lock()
                        .unwrap()
                        .get(&account)
                        .is_some_and(|live| live.lock().unwrap().requests.contains(&jid));
                    anyhow::ensure!(asked, "{jid} has not asked to see your status; nothing was sent");
                }
                meron_core::chat::xmpp::Command::AnswerSubscription { jid, allow }
            };
            let sent = chat_sessions().lock().unwrap().get(&account).is_some_and(|tx| tx.send(command).is_ok());
            anyhow::ensure!(sent, "this chat account is not connected; nothing was sent");
            Ok(json!({ "ok": true }))
        }
        "chat.occupants" => {
            let account = req_str(p, "account")?;
            let room = req_str(p, "room")?.trim().to_lowercase();
            let live = chat_live().lock().unwrap().get(&account).cloned();
            let list = live.map(|live| live.lock().unwrap().occupants.list(&room)).unwrap_or_default();
            Ok(serde_json::to_value(list)?)
        }
        // Muting one conversation (ADR-0064): no system notification from
        // it, while it still counts as unread. Who may see the person's
        // status comes with `chat.presence` (`allowed`), and withdrawing a
        // permission is `chat.answerSubscription` with `allow: false`.
        "chat.muted" => {
            let account = req_str(p, "account")?;
            Ok(json!({ "muted": meron_core::chat::mute::muted(&engine.db.lock().unwrap(), &account)? }))
        }
        "chat.mute" => {
            let account = req_str(p, "account")?;
            let conversation = req_str(p, "conversation")?;
            let muted = p.get("muted").and_then(Value::as_bool).context("missing muted")?;
            meron_core::chat::account(&engine.db.lock().unwrap(), &account)?;
            let list = meron_core::chat::mute::set_muted(&engine.db.lock().unwrap(), &account, &conversation, muted)?;
            Ok(json!({ "muted": list }))
        }
        // Group chats (ADR-0044): joined by the person, joined again on each
        // connection, left by the person.
        "chat.rooms" => {
            let account = req_str(p, "account")?;
            let rooms = meron_core::chat::rooms(&engine.db.lock().unwrap(), &account)?;
            let states = chat_room_status().lock().unwrap().clone();
            let rooms: Vec<Value> = rooms
                .into_iter()
                .map(|room| {
                    let mut value = serde_json::to_value(&room).unwrap_or(Value::Null);
                    let state = states.get(&(account.clone(), room.room.clone())).cloned().unwrap_or(json!({ "state": "offline" }));
                    value["state"] = state["state"].clone();
                    value["detail"] = state["detail"].clone();
                    value
                })
                .collect();
            Ok(json!(rooms))
        }
        "chat.join" => {
            let account = req_str(p, "account")?;
            let room = meron_core::chat::check_room(&req_str(p, "room")?)?;
            let nick = meron_core::chat::check_nick(&req_str(p, "nick")?)?;
            meron_core::chat::account(&engine.db.lock().unwrap(), &account)?;
            let key = meron_core::chat::room_secret_key(&account, &room);
            // A password typed now, or the one an invitation brought.
            let password = match p.get("password").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(typed) => {
                    store_room_password(&account, &room, typed)?;
                    Some(typed.to_string())
                }
                None => secrets::load(&key).ok().map(|s| s.password).filter(|s| !s.is_empty()),
            };
            meron_core::chat::save_room(&engine.db.lock().unwrap(), &account, &room, &nick, password.is_some(), now_seconds())?;
            let sent = chat_sessions().lock().unwrap().get(&account).is_some_and(|tx| {
                tx.send(meron_core::chat::xmpp::Command::Join { room: room.clone(), nick, password }).is_ok()
            });
            Ok(json!({ "room": room, "connected": sent }))
        }
        "chat.leave" => {
            let account = req_str(p, "account")?;
            let room = req_str(p, "room")?;
            // The nickname alone: listing the rooms also counts their mentions.
            if let Some(nick) = meron_core::chat::room_nick(&engine.db.lock().unwrap(), &account, &room)? {
                if let Some(tx) = chat_sessions().lock().unwrap().get(&account) {
                    let _ = tx.send(meron_core::chat::xmpp::Command::Leave { room: room.clone(), nick });
                }
            }
            meron_core::chat::leave_room(&engine.db.lock().unwrap(), &account, &room)?;
            let _ = secrets::delete(&meron_core::chat::room_secret_key(&account, &room));
            chat_room_status().lock().unwrap().remove(&(account, room));
            Ok(json!({ "ok": true }))
        }
        "chat.invitations" => Ok(serde_json::to_value(meron_core::chat::invitations(
            &engine.db.lock().unwrap(),
            &req_str(p, "account")?,
        )?)?),
        "chat.dismissInvitation" => {
            let account = req_str(p, "account")?;
            let room = req_str(p, "room")?;
            let db = engine.db.lock().unwrap();
            meron_core::chat::dismiss_invitation(&db, &account, &room)?;
            if meron_core::chat::room_nick(&db, &account, &room)?.is_none() {
                let _ = secrets::delete(&meron_core::chat::room_secret_key(&account, &room));
            }
            Ok(json!({ "ok": true }))
        }
        // Files (ADR-0044): put on the server's upload service and sent as a
        // link; saved from a link only when the person asks, over HTTPS.
        "chat.sendFile" => {
            let account = req_str(p, "account")?;
            let conversation = meron_core::chat::normalize_conversation(&req_str(p, "conversation")?);
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let upload_id = req_str(p, "upload_id")?;
            // Asked only on a live connection: a question queued on a dead
            // stream might go out later, when nobody is watching.
            let online = chat_status().lock().unwrap().get(&account).is_some_and(|s| s["state"] == "online");
            anyhow::ensure!(online, "this chat account is not connected; nothing was sent");
            let meta = std::fs::metadata(&path).context("the file cannot be read")?;
            anyhow::ensure!(meta.is_file(), "only a file can be sent");
            let name = path.file_name().and_then(|n| n.to_str()).context("the file has no name")?.to_string();
            let group = meron_core::chat::room_nick(&engine.db.lock().unwrap(), &account, &conversation)?.is_some();
            let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let upload = meron_core::chat::xmpp::Upload {
                id: upload_id.clone(),
                conversation,
                group,
                path,
                name,
                size: meta.len(),
                cancel: cancel.clone(),
            };
            chat_uploads().lock().unwrap().insert(upload_id.clone(), cancel);
            let sent = chat_sessions()
                .lock()
                .unwrap()
                .get(&account)
                .is_some_and(|tx| tx.send(meron_core::chat::xmpp::Command::Upload(upload)).is_ok());
            if !sent {
                chat_uploads().lock().unwrap().remove(&upload_id);
                anyhow::bail!("this chat account is not connected; nothing was sent");
            }
            Ok(json!({ "started": upload_id }))
        }
        "chat.cancelUpload" => {
            if let Some(flag) = chat_uploads().lock().unwrap().get(&req_str(p, "upload_id")?) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(json!({ "ok": true }))
        }
        "chat.download" => {
            let link = req_str(p, "url")?;
            let dest = std::path::PathBuf::from(req_str(p, "path")?);
            meron_core::chat::files::https_only(&link)?;
            let result = tokio::task::spawn_blocking(move || {
                let agent = meron_core::chat::files::agent(&[])?;
                meron_core::chat::files::download(&agent, &link, &dest).map_err(anyhow::Error::from)
            })
            .await??;
            Ok(json!({ "saved": true, "bytes": result }))
        }

        // When a POP3 account deletes from its server (#97, ADR-0035).
        "pop3.retention" => {
            let account = req_str(p, "account")?;
            let db = engine.db.lock().unwrap();
            if let Some(value) = p.get("retention") {
                let wanted: meron_core::pop3::Retention = serde_json::from_value(value.clone())?;
                meron_core::pop3::set_retention(&db, &account, wanted)?;
            }
            Ok(serde_json::to_value(meron_core::pop3::retention(&db, &account)?)?)
        }

        // Sharing files by link from cloud storage (#108, ADR-0033). Every
        // upload and link is the person's own action.
        // Scheduled profile backups (#173, ADR-0037): off by default; the
        // password stays in the keychain and never comes back out.
        "backupSchedule.status" => backup_schedule_status(engine),
        "backupSchedule.save" => {
            let schedule: meron_core::backup_schedule::Schedule = serde_json::from_value(
                p.get("schedule").cloned().ok_or_else(|| anyhow::anyhow!("missing schedule"))?,
            )?;
            if let Some(password) = p.get("password").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                anyhow::ensure!(password.chars().count() >= 8, "the backup password needs at least 8 characters");
                secrets::store(
                    meron_core::backup_schedule::SECRET_KEY,
                    &secrets::Secrets { password: password.to_string(), ..Default::default() },
                )?;
            }
            if schedule.enabled {
                anyhow::ensure!(
                    backup_password()?.is_some(),
                    "set a password for the backups before turning them on"
                );
            }
            meron_core::backup_schedule::save(&engine.db.lock().unwrap(), &schedule, &store::app_dir())?;
            backup_schedule_status(engine)
        }
        "backupSchedule.runNow" => {
            run_scheduled_backup(engine).await?;
            backup_schedule_status(engine)
        }
        // Automatic archiving by age (#112, ADR-0054): off by default, and
        // turned on only with the preview of what it moves confirmed.
        "autoArchive.status" => auto_archive_status(engine, &req_str(p, "account")?),
        "autoArchive.preview" => {
            let account = req_str(p, "account")?;
            let policy: meron_core::auto_archive::Policy =
                serde_json::from_value(p.get("policy").cloned().context("missing policy")?)?;
            let (kind, folders, label) = auto_archive_context(engine, &account)?;
            meron_core::auto_archive::validate(&policy, kind, &folders)?;
            let mut steps = meron_core::auto_archive::EngineSteps {
                engine: engine.clone(),
                account: account.clone(),
                media_root: parse::media_root(),
            };
            let cutoffs = meron_core::auto_archive::cutoffs(&policy, &chrono::Local::now());
            let plan =
                meron_core::auto_archive::plan(&mut steps, &engine.db, &account, &label, &policy, &cutoffs).await?;
            Ok(serde_json::to_value(plan)?)
        }
        "autoArchive.save" => {
            let account = req_str(p, "account")?;
            let policy: meron_core::auto_archive::Policy =
                serde_json::from_value(p.get("policy").cloned().context("missing policy")?)?;
            let confirm = p.get("confirm").and_then(Value::as_str);
            let (kind, folders, _) = auto_archive_context(engine, &account)?;
            meron_core::auto_archive::save(&engine.db.lock().unwrap(), &account, &policy, confirm, kind, &folders)?;
            auto_archive_status(engine, &account)
        }
        "autoArchive.runNow" => {
            let account = req_str(p, "account")?;
            let (log, archive_created) = run_auto_archive(engine, out, &account, "manual").await?;
            Ok(json!({ "run": log, "archive_created": archive_created, "status": auto_archive_status(engine, &account)? }))
        }
        "cloud.providers" => Ok(json!(meron_core::cloud::PROVIDERS
            .iter()
            .map(|(id, name, usable)| json!({ "id": id, "name": name, "usable": usable }))
            .collect::<Vec<_>>())),
        "cloud.list" => Ok(serde_json::to_value(meron_core::cloud::list(&engine.db.lock().unwrap())?)?),
        "cloud.save" => {
            let account: meron_core::cloud::CloudAccount =
                serde_json::from_value(p.get("account").cloned().context("missing account")?)?;
            meron_core::cloud::save(&engine.db.lock().unwrap(), &account, now_seconds())?;
            if let Some(password) = p.get("password").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                meron_core::secrets::store(
                    &meron_core::cloud::secret_key(&account.id),
                    &meron_core::secrets::Secrets { password: password.to_string(), ..Default::default() },
                )?;
            }
            Ok(json!({ "ok": true }))
        }
        "cloud.check" => {
            let (account, password) = cloud_account(&engine, p)?;
            let caps = tokio::task::spawn_blocking(move || meron_core::cloud::capabilities(&account, &password)).await?;
            Ok(match caps {
                Ok(caps) => json!({ "capabilities": caps }),
                Err(err) => json!({ "error": { "message": err.to_string(), "detail": err } }),
            })
        }
        "cloud.remove" => {
            let id = req_str(p, "id")?;
            meron_core::cloud::remove(&engine.db.lock().unwrap(), &id)?;
            let _ = meron_core::secrets::delete(&meron_core::cloud::secret_key(&id));
            Ok(json!({ "ok": true }))
        }
        "cloud.upload" => {
            let (account, password) = cloud_account(&engine, p)?;
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let upload_id = req_str(p, "upload_id")?;
            spawn_cloud_upload(out.clone(), account, password, path, upload_id.clone());
            Ok(json!({ "started": upload_id }))
        }
        "cloud.cancel" => {
            if let Some(flag) = cloud_uploads().lock().unwrap().get(&req_str(p, "upload_id")?) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(json!({ "ok": true }))
        }
        "cloud.share" => {
            let (account, password) = cloud_account(&engine, p)?;
            let path = req_str(p, "path")?;
            let want: meron_core::cloud::LinkRequest =
                serde_json::from_value(p.get("link").cloned().unwrap_or(json!({})))?;
            let result = tokio::task::spawn_blocking(move || {
                let caps = meron_core::cloud::capabilities(&account, &password)?;
                meron_core::cloud::share(&account, &password, &path, &want, &caps)
            })
            .await?;
            Ok(match result {
                Ok(link) => json!({ "link": link }),
                Err(err) => json!({ "error": { "message": err.to_string(), "detail": err } }),
            })
        }
        "cloud.revoke" => {
            let (account, password) = cloud_account(&engine, p)?;
            let share_id = req_str(p, "share_id")?;
            tokio::task::spawn_blocking(move || meron_core::cloud::revoke(&account, &password, &share_id)).await??;
            Ok(json!({ "ok": true }))
        }

        // Translation models (#106, ADR-0031). Fetched only when asked, from
        // the one source in the bundled registry, and checked before use.
        "translation.status" => {
            let mut status = serde_json::to_value(meron_core::translation::status(
                &meron_core::translation::models_dir(),
                meron_core::translation::DEFAULT_QUOTA_BYTES,
            ))?;
            status["downloading"] = json!(translation_downloads()
                .lock()
                .unwrap()
                .iter()
                .map(|(key, d)| (key.clone(), json!({ "done": d.done.load(std::sync::atomic::Ordering::Relaxed), "total": d.total })))
                .collect::<serde_json::Map<_, _>>());
            Ok(status)
        }
        "translation.download" => {
            let pair = translation_pair(p)?;
            spawn_translation_download(out.clone(), pair);
            Ok(json!({ "started": pair.key() }))
        }
        "translation.cancel" => {
            let pair = translation_pair(p)?;
            if let Some(d) = translation_downloads().lock().unwrap().get(&pair.key()) {
                d.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(json!({ "ok": true }))
        }
        "translation.remove" => {
            let pair = translation_pair(p)?;
            anyhow::ensure!(
                !translation_downloads().lock().unwrap().contains_key(&pair.key()),
                "that model is still downloading"
            );
            meron_core::translation::remove(&meron_core::translation::models_dir(), pair)?;
            Ok(json!({ "ok": true }))
        }

        // Personalized mass mail (#90, ADR-0026). The preview and the batch
        // are rendered by the same function from the same inputs.
        "merge.preview" => {
            let me = meron_core::merge::Sender {
                name: req_str(p, "me_name").unwrap_or_default(),
                email: req_str(p, "from").unwrap_or_default(),
            };
            let preview = meron_core::merge::preview(
                &req_str(p, "recipients").unwrap_or_default(),
                &req_str(p, "subject").unwrap_or_default(),
                &req_str(p, "body").unwrap_or_default(),
                &me,
            );
            Ok(serde_json::to_value(preview)?)
        }
        "merge.start" => {
            let account = req_str(p, "account")?;
            let from = req_str(p, "from")?;
            let subject = req_str(p, "subject").unwrap_or_default();
            let me = meron_core::merge::Sender { name: req_str(p, "me_name").unwrap_or_default(), email: from.clone() };
            let preview = meron_core::merge::preview(
                &req_str(p, "recipients").unwrap_or_default(),
                &subject,
                &req_str(p, "body").unwrap_or_default(),
                &me,
            );
            let reviewed = p.get("reviewed").and_then(Value::as_u64).context("missing param: reviewed")? as usize;
            let spacing = p.get("spacing").and_then(Value::as_i64).unwrap_or(meron_core::merge::DEFAULT_SPACING);
            let id = uuid::Uuid::new_v4().simple().to_string();
            meron_core::merge::create(
                &engine.db.lock().unwrap(),
                &id,
                &account,
                &from,
                &subject,
                &preview,
                reviewed,
                spacing,
                now_seconds(),
            )?;
            spawn_merge(engine.clone(), out.clone(), id.clone());
            Ok(json!({ "id": id }))
        }
        "merge.list" => Ok(json!({ "batches": meron_core::merge::batches(&engine.db.lock().unwrap())? })),
        "merge.cancel" => {
            meron_core::merge::cancel(&engine.db.lock().unwrap(), &req_str(p, "id")?, now_seconds())?;
            Ok(json!({ "ok": true }))
        }
        "merge.resume" => {
            let id = req_str(p, "id")?;
            let retry = p.get("retry_rejected").and_then(Value::as_bool).unwrap_or(false);
            meron_core::merge::resume(&engine.db.lock().unwrap(), &id, retry)?;
            spawn_merge(engine.clone(), out.clone(), id);
            Ok(json!({ "ok": true }))
        }

        // Waiting for a reply (#45, ADR-0025). Answers are read from the mail
        // each time; nothing is ever sent on the person's behalf.
        "awaiting.add" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id).context("invalid thread_id")?;
            let remind_at = p.get("remind_at").and_then(Value::as_i64);
            let db = engine.db.lock().unwrap();
            let item = meron_core::awaiting::add(&db, &parsed.account, &parsed.thread_key, remind_at, now_seconds())?;
            Ok(json!({ "item": item }))
        }
        "awaiting.list" => {
            let account = req_str(p, "account").ok().filter(|a| !a.is_empty());
            let settled = p.get("include_settled").and_then(Value::as_bool).unwrap_or(false);
            let db = engine.db.lock().unwrap();
            Ok(json!({ "items": meron_core::awaiting::list(&db, account.as_deref(), settled, now_seconds())? }))
        }
        "awaiting.setState" => {
            let db = engine.db.lock().unwrap();
            meron_core::awaiting::set_state(&db, &req_str(p, "account")?, &req_str(p, "message_id")?, &req_str(p, "state")?)?;
            Ok(json!({ "ok": true }))
        }
        "awaiting.ruleOn" => {
            let is_answer = p.get("is_answer").and_then(Value::as_bool).context("missing param: is_answer")?;
            let db = engine.db.lock().unwrap();
            meron_core::awaiting::rule_on(
                &db,
                &req_str(p, "account")?,
                &req_str(p, "message_id")?,
                &req_str(p, "candidate")?,
                is_answer,
            )?;
            Ok(json!({ "ok": true }))
        }
        "awaiting.remove" => {
            let db = engine.db.lock().unwrap();
            meron_core::awaiting::remove(&db, &req_str(p, "account")?, &req_str(p, "message_id")?)?;
            Ok(json!({ "ok": true }))
        }

        // Inbox categories (#91, ADR-0023): the reader's tabs, where each
        // conversation is and why, and the reader's corrections. All local.
        "categories.list" => {
            let db = engine.db.lock().unwrap();
            Ok(json!({ "categories": meron_core::categories::list(&db)? }))
        }
        "categories.save" => {
            let categories: Vec<meron_core::categories::Category> =
                serde_json::from_value(p.get("categories").cloned().unwrap_or(Value::Null))
                    .context("categories are not in the expected shape")?;
            let db = engine.db.lock().unwrap();
            meron_core::categories::save(&db, &categories)?;
            Ok(json!({ "categories": meron_core::categories::list(&db)? }))
        }
        "categories.counts" => {
            let account = req_str(p, "account")?;
            let folder = req_str(p, "folder")?;
            let db = engine.db.lock().unwrap();
            Ok(serde_json::to_value(meron_core::categories::counts(&db, &account, &folder)?)?)
        }
        "categories.reason" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id).context("invalid thread_id")?;
            let db = engine.db.lock().unwrap();
            let verdict = meron_core::categories::reason(&db, &parsed.account, &parsed.folder, &parsed.thread_key)?
                .context("no such conversation")?;
            let sender = store::thread_priority_signals(&db, &parsed.account, &parsed.folder, &parsed.thread_key)?
                .map(|(sender, _)| sender)
                .unwrap_or_default();
            Ok(json!({ "category": verdict.category, "reason": verdict.reason, "sender": sender }))
        }
        // `category` is an id, '' for Other, or null to hand it back to the
        // rules; `scope` is "conversation" or "sender".
        "categories.assign" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id).context("invalid thread_id")?;
            let category = p.get("category").and_then(Value::as_str);
            let db = engine.db.lock().unwrap();
            match p.get("scope").and_then(Value::as_str).unwrap_or("conversation") {
                "conversation" => meron_core::categories::correct_conversation(
                    &db, &parsed.account, &parsed.thread_key, category,
                )?,
                "sender" => {
                    let (sender, _) =
                        store::thread_priority_signals(&db, &parsed.account, &parsed.folder, &parsed.thread_key)?
                            .context("no such conversation")?;
                    meron_core::categories::correct_sender(&db, &parsed.account, &sender, category)?
                }
                other => anyhow::bail!("unknown scope {other}"),
            }
            meron_core::categories::rejudge(&db, &parsed.account, true)?;
            let verdict = meron_core::categories::reason(&db, &parsed.account, &parsed.folder, &parsed.thread_key)?;
            Ok(json!({ "ok": true, "verdict": verdict }))
        }

        // Why a conversation looks like spam by what the reader has taught
        // this account, and what it would take to say otherwise. Same
        // "only when asked" shape as `mail.priorityReason` — computing this
        // for every row to show none of it would be work nobody asked for.
        "mail.spamReason" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let db = engine.db.lock().unwrap();
            let (sender, signals) = store::thread_spam_signals(
                &db,
                &parsed.account,
                &parsed.folder,
                &parsed.thread_key,
            )?
            .context("no such conversation")?;
            let verdict = spam::verdict(&signals);
            Ok(json!({
                "spam": verdict.spam,
                "reasons": verdict.reasons,
                "sender": sender,
            }))
        }

        // Senders and domains the reader blocked or allowed (#50). A block
        // makes the suggestion certain; it still moves nothing by itself.
        "spam.lists" => {
            let account = req_str(p, "account")?;
            let lists = store::sender_lists(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({ "entries": lists.into_iter().map(|(pattern, allow)| json!({ "pattern": pattern, "allow": allow })).collect::<Vec<_>>() }))
        }
        "spam.setListed" => {
            let account = req_str(p, "account")?;
            let allow = p.get("allow").and_then(Value::as_bool);
            let pattern = store::set_sender_listed(&engine.db.lock().unwrap(), &account, &req_str(p, "pattern")?, allow)?;
            Ok(json!({ "ok": true, "pattern": pattern }))
        }

        // Records what the reader decided about one conversation: spam
        // confirmed, or said not spam. Never moves anything itself — the
        // reader's own action (marking junk, or dismissing the notice) does
        // that separately — and re-judges the account so already-cached mail
        // from the same sender reflects the correction at once.
        "mail.recordSpamJudgment" => {
            let thread_id = req_str(p, "thread_id")?;
            let is_spam = p
                .get("spam")
                .and_then(Value::as_bool)
                .context("missing spam")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let db = engine.db.lock().unwrap();
            let sender = store::record_spam_judgment(
                &db,
                &parsed.account,
                &parsed.folder,
                &parsed.thread_key,
                is_spam,
            )?;
            Ok(json!({ "ok": true, "sender": sender }))
        }

        // Every local to-do, across every account and folder — message-tied
        // only, so each one carries the conversation it hangs off.
        "tasks.list" => {
            let include_completed = p
                .get("include_completed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let db = engine.db.lock().unwrap();
            let tasks = store::list_tasks(&db, include_completed)?;
            Ok(json!({
                "tasks": tasks
                    .iter()
                    .map(|task| json!({
                        "id": task.id,
                        "thread_id": if task.thread_key.is_empty() {
                            String::new()
                        } else {
                            mail_model::format_thread_id(&task.account, &task.folder, &task.thread_key)
                        },
                        "account_id": task.account,
                        "folder_id": task.folder,
                        "note": task.note,
                        "due_at": task.due_at,
                        "completed_at": task.completed_at,
                        "created_at": task.created_at,
                        "subject": task.subject,
                        "from_name": task.from_name,
                        "from_addr": task.from_addr,
                        "located": task.located,
                        "linked": !task.thread_key.is_empty(),
                        "list_id": task.list_id,
                        "title": task.title,
                        "priority": task.priority,
                        "reminder_at": task.reminder_at,
                        "revision": task.revision,
                        "pending": task.pending,
                        "conflict": task.conflict,
                        "recurring": task.recurring,
                        "recurrence": store::task_lists::recurrence_of(&task.rrule),
                    }))
                    .collect::<Vec<_>>(),
            }))
        }

        // Creates a task on a conversation, or edits the one already open on
        // it (a second "convert to task" on the same thread is a save, not a
        // duplicate — see `store::save_task`).
        "tasks.save" => {
            let thread_id = req_str(p, "thread_id")?;
            let due_at = p.get("due_at").and_then(Value::as_i64);
            let note = p
                .get("note")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let db = engine.db.lock().unwrap();
            let id = store::save_task(
                &db,
                &parsed.account,
                &parsed.thread_key,
                &parsed.folder,
                due_at,
                &note,
                now_seconds(),
            )?;
            Ok(json!({ "ok": true, "id": id }))
        }

        // One task's own due date and note — the embedded card field only
        // ever carries `id`/`due_at`, so the editor asks for the rest before
        // opening on an existing task, rather than starting from a blank
        // note that would overwrite the real one on save.
        "tasks.get" => {
            let id = req_i64(p, "id")?;
            let db = engine.db.lock().unwrap();
            Ok(match store::task_lists::get(&db, id)? {
                Some((task, revision, linked)) => json!({
                    "due_at": task.due_at, "note": task.note, "list_id": task.list_id, "title": task.title,
                    "reminder_at": task.reminder_at, "priority": task.priority, "revision": revision,
                    "linked": linked, "recurrence": task.recurrence,
                }),
                None => Value::Null,
            })
        }

        // Importing .eml/.mbox files into the local archive (ADR-0014). The
        // paths come from the reader's file picker; the files are read here,
        // never sent through the bridge. A preview first, then the import.
        // Thunderbird (ADR-0041): its profiles, the folders in one, and what
        // importing the chosen ones into the local archive does or did.
        "thunderbird.profiles" => {
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from).unwrap_or_default();
            let appdata = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
            Ok(json!({ "profiles": meron_core::thunderbird::profiles(&meron_core::thunderbird::profile_roots(&home, appdata.as_deref())) }))
        }
        "thunderbird.scan" => {
            let root = std::path::PathBuf::from(req_str(p, "path")?);
            let folders = tokio::task::spawn_blocking(move || meron_core::thunderbird::scan(&root)).await??;
            Ok(json!({ "folders": folders }))
        }
        "thunderbird.preview" | "thunderbird.import" => {
            let root = std::path::PathBuf::from(req_str(p, "path")?);
            let wanted: Vec<String> = serde_json::from_value(p.get("folders").cloned().unwrap_or_default()).context("folders")?;
            anyhow::ensure!(!wanted.is_empty(), "choose at least one folder");
            let under = p.get("root").and_then(Value::as_str).map(str::trim).filter(|r| !r.is_empty()).unwrap_or("Thunderbird").to_string();
            let importing = req.method == "thunderbird.import";
            if importing {
                let created = meron_core::archive::ensure_account(&engine.db.lock().unwrap(), now_seconds())?;
                if created {
                    let creds = store::load_account(&engine.db.lock().unwrap(), meron_core::archive::ACCOUNT)?;
                    if let Some(creds) = creds {
                        engine.accounts.lock().await.insert(meron_core::archive::ACCOUNT.to_string(), creds);
                    }
                }
            }
            let db = engine.db.clone();
            let results = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<Value>> {
                // Only folders this scan finds are read, by the id it gave them.
                let folders = meron_core::thunderbird::scan(&root)?;
                let media_root = parse::media_root();
                let mut results = Vec::new();
                for id in &wanted {
                    let folder = folders.iter().find(|f| &f.id == id).with_context(|| format!("{id} is no longer in that folder"))?;
                    let target = meron_core::thunderbird::target_folder(&under, folder);
                    let (messages, deleted) = meron_core::thunderbird::read_folder(&root.join(&folder.id))?;
                    let summary = if importing {
                        let conn = db.lock().unwrap();
                        store::ensure_folder(&conn, meron_core::archive::ACCOUNT, &target)?;
                        meron_core::archive::import(&conn, &target, messages, &media_root)?
                    } else {
                        meron_core::archive::preview(&db.lock().unwrap(), &target, &[messages])?
                    };
                    results.push(json!({ "id": id, "target": target, "summary": summary, "deleted": deleted }));
                }
                Ok(results)
            })
            .await??;
            if importing {
                emit(out, "mail.synced", json!({ "account": meron_core::archive::ACCOUNT, "folders": true })).await;
            }
            Ok(json!({ "folders": results, "account": meron_core::archive::ACCOUNT }))
        }
        "archive.preview" | "archive.import" => {
            let paths: Vec<String> = serde_json::from_value(p.get("paths").cloned().unwrap_or_default()).context("paths")?;
            if paths.is_empty() {
                anyhow::bail!("no files to import");
            }
            let folder = p
                .get("folder")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .unwrap_or(meron_core::archive::DEFAULT_FOLDER)
                .to_string();
            let files = {
                let paths = paths.clone();
                tokio::task::spawn_blocking(move || {
                    paths
                        .iter()
                        .map(|path| meron_core::archive::read_file(std::path::Path::new(path)))
                        .collect::<anyhow::Result<Vec<_>>>()
                })
                .await??
            };
            if req.method == "archive.preview" {
                let summary = meron_core::archive::preview(&engine.db.lock().unwrap(), &folder, &files)?;
                return Ok(json!({ "summary": summary, "folder": folder }));
            }
            let created = meron_core::archive::ensure_account(&engine.db.lock().unwrap(), now_seconds())?;
            if created {
                let creds = store::load_account(&engine.db.lock().unwrap(), meron_core::archive::ACCOUNT)?;
                if let Some(creds) = creds {
                    engine.accounts.lock().await.insert(meron_core::archive::ACCOUNT.to_string(), creds);
                }
            }
            let media_root = parse::media_root();
            let summary = {
                let engine = engine.clone();
                let folder = folder.clone();
                tokio::task::spawn_blocking(move || {
                    let db = engine.db.lock().unwrap();
                    meron_core::archive::import(&db, &folder, files.into_iter().flatten().collect(), &media_root)
                })
                .await??
            };
            emit(out, "mail.synced", json!({ "account": meron_core::archive::ACCOUNT, "folder": folder, "synced": summary.imported })).await;
            Ok(json!({ "summary": summary, "folder": folder, "account": meron_core::archive::ACCOUNT, "created": created }))
        }

        // Lists and standalone tasks (ADR-0013).
        "tasks.lists" => {
            let lists = store::task_lists::lists(&engine.db.lock().unwrap())?;
            Ok(json!({ "lists": lists }))
        }
        // Standalone notes (#104, ADR-0015): local only, no account.
        "notes.list" => {
            let query: store::notes::Query = serde_json::from_value(p.clone()).unwrap_or_default();
            let db = engine.db.lock().unwrap();
            store::notes::tidy_trash(&db, now_seconds())?;
            let notes = store::notes::list(&db, &query)?;
            let tags: Vec<Value> = store::notes::tags(&db)?
                .into_iter()
                .map(|(tag, count)| json!({ "tag": tag, "count": count }))
                .collect();
            Ok(json!({ "notes": notes, "tags": tags }))
        }
        "notes.get" => {
            let note = store::notes::get(&engine.db.lock().unwrap(), &req_str(p, "id")?)?;
            Ok(json!({ "note": note }))
        }
        "notes.create" => {
            let fields: store::notes::NoteFields =
                serde_json::from_value(p.get("note").cloned().unwrap_or_default())?;
            let note = store::notes::create(&engine.db.lock().unwrap(), &fields, now_seconds())?;
            Ok(json!({ "note": note }))
        }
        "notes.update" => {
            let fields: store::notes::NoteFields =
                serde_json::from_value(p.get("note").cloned().unwrap_or_default())?;
            let written = store::notes::update(
                &engine.db.lock().unwrap(),
                &req_str(p, "id")?,
                req_i64(p, "revision")?,
                &fields,
                now_seconds(),
            )?;
            Ok(serde_json::to_value(written)?)
        }
        "notes.pin" => {
            let pinned = p.get("pinned").and_then(Value::as_bool).unwrap_or(false);
            store::notes::set_pinned(&engine.db.lock().unwrap(), &req_str(p, "id")?, pinned, now_seconds())?;
            Ok(json!({ "ok": true }))
        }
        "notes.trash" => {
            store::notes::trash(&engine.db.lock().unwrap(), &req_str(p, "id")?, now_seconds())?;
            Ok(json!({ "ok": true }))
        }
        "notes.restore" => {
            store::notes::restore(&engine.db.lock().unwrap(), &req_str(p, "id")?)?;
            Ok(json!({ "ok": true }))
        }
        "notes.purge" => {
            store::notes::purge(&engine.db.lock().unwrap(), &req_str(p, "id")?)?;
            Ok(json!({ "ok": true }))
        }
        // Files attached to notes (ADR-0042), kept in the store.
        "notes.attachments" => {
            Ok(json!({ "attachments": store::note_attachments::list(&engine.db.lock().unwrap(), &req_str(p, "note_id")?)? }))
        }
        "notes.attach" => {
            let note = req_str(p, "note_id")?;
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let db = engine.db.clone();
            let attached = tokio::task::spawn_blocking(move || {
                store::note_attachments::attach(&db.lock().unwrap(), &note, &path, now_seconds())
            })
            .await??;
            Ok(json!({ "attachment": attached }))
        }
        "notes.removeAttachment" => {
            store::note_attachments::remove(&engine.db.lock().unwrap(), &req_str(p, "id")?)?;
            Ok(json!({ "ok": true }))
        }
        "notes.saveAttachment" => {
            let id = req_str(p, "id")?;
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let db = engine.db.clone();
            let bytes = tokio::task::spawn_blocking(move || store::note_attachments::save(&db.lock().unwrap(), &id, &path)).await??;
            Ok(json!({ "saved": true, "bytes": bytes }))
        }
        "tasks.createList" => {
            let id = store::task_lists::create_list(&engine.db.lock().unwrap(), &req_str(p, "name")?, now_seconds())?;
            Ok(json!({ "ok": true, "id": id }))
        }
        "tasks.renameList" => {
            store::task_lists::rename_list(&engine.db.lock().unwrap(), &req_str(p, "id")?, &req_str(p, "name")?)?;
            Ok(json!({ "ok": true }))
        }
        // Deleting a list kept on a server deletes it here only: its tasks,
        // and its password. Nothing on the server is touched (ADR-0039).
        "tasks.deleteList" => {
            let id = req_str(p, "id")?;
            let bound = {
                let db = engine.db.lock().unwrap();
                let bound = meron_core::task_sync::binding(&db, &id)?.is_some();
                store::task_lists::delete_list(&db, &id)?;
                bound
            };
            if bound {
                meron_core::secrets::delete(&meron_core::task_sync::secret_key(&id))?;
            }
            Ok(json!({ "ok": true }))
        }
        // Task lists kept on a CalDAV server (ADR-0039): find the
        // collections, bind a new list to one, sync, settle a conflict.
        "tasks.caldavDiscover" => {
            let server = req_str(p, "server")?;
            let transport = meron_core::carddav::http::UreqTransport {
                username: req_str(p, "username").unwrap_or_default(),
                password: req_str(p, "password").unwrap_or_default(),
                proxy: meron_core::proxy::ProxyChoice::Global,
            };
            let found =
                tokio::task::spawn_blocking(move || meron_core::task_sync::discover(&transport, &server)).await??;
            Ok(json!({ "calendars": found }))
        }
        "tasks.caldavAdd" => {
            let username = req_str(p, "username").unwrap_or_default();
            let password = req_str(p, "password").unwrap_or_default();
            let id = meron_core::task_sync::add_list(
                &engine.db.lock().unwrap(),
                p.get("name").and_then(Value::as_str).unwrap_or_default(),
                &req_str(p, "url")?,
                p.get("server").and_then(Value::as_str).unwrap_or_default(),
                &username,
                now_seconds(),
            )?;
            let key = meron_core::task_sync::secret_key(&id);
            meron_core::secrets::store(&key, &meron_core::secrets::Secrets { password: password.clone(), ..Default::default() })?;
            let transport = meron_core::carddav::http::UreqTransport {
                username,
                password,
                proxy: meron_core::proxy::ProxyChoice::Global,
            };
            let db = engine.db.clone();
            let list = id.clone();
            let first = tokio::task::spawn_blocking(move || {
                meron_core::task_sync::sync(&db, &transport, &list, now_seconds())
            })
            .await?;
            match first {
                Ok(report) => Ok(json!({ "ok": true, "id": id, "report": report })),
                // A list that could not be read once is not added: the
                // dialog stays open with the reason.
                Err(error) => {
                    store::task_lists::delete_list(&engine.db.lock().unwrap(), &id)?;
                    meron_core::secrets::delete(&key)?;
                    Err(error)
                }
            }
        }
        // Syncs one bound list, or every one. A list that fails keeps what
        // it had and records why; the others go on.
        "tasks.sync" => {
            let wanted = p.get("list_id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string);
            let bindings = meron_core::task_sync::bindings(&engine.db.lock().unwrap())?;
            let exchange = meron_core::task_sync::exchange::bindings(&engine.db.lock().unwrap())?;
            let mut results = Vec::new();
            for binding in bindings.into_iter().filter(|b| wanted.as_ref().is_none_or(|id| *id == b.list_id)) {
                results.push(sync_task_list(engine, binding).await);
            }
            for (list, account) in exchange.into_iter().filter(|(list, _)| wanted.as_ref().is_none_or(|id| id == list)) {
                results.push(sync_exchange_task_list(engine, list, account).await);
            }
            Ok(json!({ "lists": results }))
        }
        // A list kept in an Exchange account's Tasks folder (ADR-0058),
        // read once before it is added, like a CalDAV one.
        "tasks.exchangeAdd" => {
            let account = req_str(p, "account")?;
            let client = exchange_task_client(engine, &account).await?;
            let id = meron_core::task_sync::exchange::add_list(
                &engine.db.lock().unwrap(),
                &account,
                p.get("name").and_then(Value::as_str).unwrap_or_default(),
                now_seconds(),
            )?;
            let db = engine.db.clone();
            let list = id.clone();
            let first = tokio::task::spawn_blocking(move || {
                meron_core::task_sync::exchange::sync(&db, &client, &list, now_seconds())
            })
            .await?;
            match first {
                Ok(report) => Ok(json!({ "ok": true, "id": id, "report": report })),
                Err(error) => {
                    store::task_lists::delete_list(&engine.db.lock().unwrap(), &id)?;
                    Err(error)
                }
            }
        }
        "tasks.resolveConflict" => {
            let id = req_i64(p, "id")?;
            let keep = meron_core::task_sync::Keep::parse(&req_str(p, "keep")?)
                .context("keep must be mine or server")?;
            let list_id: String = engine
                .db
                .lock()
                .unwrap()
                .query_row("SELECT list_id FROM tasks WHERE id = ?1", rusqlite::params![id], |row| row.get(0))
                .map(Some)
                .or_else(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    error => Err(error),
                })?
                .context("this task no longer exists")?;
            let exchange = meron_core::task_sync::exchange::binding(&engine.db.lock().unwrap(), &list_id)?;
            if let Some(account) = exchange {
                let client = exchange_task_client(engine, &account).await?;
                let db = engine.db.clone();
                tokio::task::spawn_blocking(move || {
                    meron_core::task_sync::exchange::resolve_conflict(&db, &client, id, keep, now_seconds())
                })
                .await??;
                let synced = sync_exchange_task_list(engine, list_id, account).await;
                return Ok(json!({ "ok": true, "sync": synced }));
            }
            let binding = meron_core::task_sync::binding(&engine.db.lock().unwrap(), &list_id)?
                .context("this list is not kept on a server")?;
            let transport = task_transport(&binding)?;
            let db = engine.db.clone();
            tokio::task::spawn_blocking(move || {
                meron_core::task_sync::resolve_conflict(&db, &transport, id, keep, now_seconds())
            })
            .await??;
            let synced = sync_task_list(engine, binding).await;
            Ok(json!({ "ok": true, "sync": synced }))
        }
        "tasks.create" => {
            let fields: store::task_lists::TaskFields =
                serde_json::from_value(p.get("task").cloned().context("missing param: task")?).context("task")?;
            let id = store::task_lists::create(&engine.db.lock().unwrap(), &fields, now_seconds())?;
            Ok(json!({ "ok": true, "id": id, "revision": 1 }))
        }
        // An edit names the revision it was made from; a different one saves
        // nothing and answers with what is there now (ADR-0012).
        "tasks.update" => {
            let id = req_i64(p, "id")?;
            let revision = req_i64(p, "revision")?;
            let fields: store::task_lists::TaskFields =
                serde_json::from_value(p.get("task").cloned().context("missing param: task")?).context("task")?;
            Ok(match store::task_lists::update(&engine.db.lock().unwrap(), id, revision, &fields)? {
                store::task_lists::Edit::Saved { revision } => json!({ "ok": true, "revision": revision }),
                store::task_lists::Edit::Conflict { current, revision } => json!({
                    "ok": false,
                    "conflict": true,
                    "current": current.map(|task| json!({
                        "list_id": task.list_id, "title": task.title, "note": task.note,
                        "due_at": task.due_at, "reminder_at": task.reminder_at, "priority": task.priority,
                        "recurrence": task.recurrence, "revision": revision,
                    })),
                }),
            })
        }

        // A repeating task completes one occurrence and moves on to the
        // next; `stop` ends the repetition instead (ADR-0053).
        "tasks.setCompleted" => {
            let id = req_i64(p, "id")?;
            let completed = req_bool(p, "completed")?;
            let stop = p.get("stop_repeating").and_then(Value::as_bool).unwrap_or(false);
            let db = engine.db.lock().unwrap();
            let done = store::task_lists::set_completed(&db, id, completed, stop, now_seconds())?;
            Ok(json!({ "ok": true, "next_due": done.next_due }))
        }

        // "Never mind, this was not one" — removes the task outright.
        "tasks.delete" => {
            let id = req_i64(p, "id")?;
            let db = engine.db.lock().unwrap();
            store::delete_task(&db, id)?;
            Ok(json!({ "ok": true }))
        }

        // Address books on a CardDAV server, found from what somebody typed:
        // an email address, a host, or a URL. Nothing is stored by this; it
        // is the question asked before deciding which book to keep.
        "carddav.discover" => {
            let server = req_str(p, "server")?;
            let transport = meron_core::carddav::http::UreqTransport {
                username: req_str(p, "username").unwrap_or_default(),
                password: req_str(p, "password").unwrap_or_default(),
                proxy: lookup_route(&engine, p)?,
            };
            let books = tokio::task::spawn_blocking(move || {
                meron_core::carddav::client::discover(&transport, &server)
            })
            .await??;
            Ok(json!({
                "books": books.iter().map(|book| json!({
                    "url": book.url, "name": book.name,
                })).collect::<Vec<_>>()
            }))
        }

        // Keep one book: remember where it is, put the password in the
        // keyring, and read it for the first time. If that first read fails
        // the source is kept anyway with the error on it, so the reader sees
        // what went wrong rather than an add button that did nothing.
        "carddav.add" => {
            let url = req_str(p, "url")?;
            let name = req_str(p, "name").unwrap_or_default();
            let username = req_str(p, "username").unwrap_or_default();
            let password = req_str(p, "password").unwrap_or_default();
            let account = req_str(p, "account").unwrap_or_default();
            let id = format!("carddav-{}", uuid::Uuid::new_v4());
            let source = store::ContactSource {
                writable: None,
                id: id.clone(),
                kind: "carddav".into(),
                account,
                url,
                username,
                name,
                enabled: true,
                ctag: String::new(),
                last_sync_at: 0,
                last_error: String::new(),
            };
            meron_core::secrets::store(
                &id,
                &meron_core::secrets::Secrets {
                    password,
                    ..Default::default()
                },
            )?;
            store::upsert_contact_source(
                &engine.db.lock().unwrap(),
                &source,
                chrono::Utc::now().timestamp(),
            )?;
            let outcome = sync_contact_source(engine, &id).await;
            Ok(json!({ "id": id, "synced": outcome.is_ok(), "error": outcome.err().map(|e| format!("{e:#}")) }))
        }

        // The organisation's directory, asked by name as the reader types.
        // Not copied: an address list runs to tens of thousands of entries and
        // changes under the reader's feet. An account without a directory —
        // anything that is not Exchange — answers with nobody, not an error.
        "directory.search" => {
            let account = req_str(p, "account")?;
            let query = req_str(p, "query").unwrap_or_default();
            let found = calendar::route::resolve_names(engine, &account, query.trim()).await?;
            Ok(json!({ "people": meron_core::contacts::exchange::people_from_participants(found) }))
        }

        // A Google account's contacts, read with the token the account already
        // holds. One source per account, so asking twice re-reads rather than
        // doubling everybody.
        "google.contacts.sync" => pim::people::google_sync(engine, p).await,

        // An Exchange account's Contacts folder and its distribution lists
        // (ADR-0058), read with the account's own sign-in. One book per
        // account, like Google's.
        "exchange.contacts.sync" => pim::exchange_book::sync(engine, p).await,

        "carddav.sync" => pim::people::source_sync(engine, p).await,

        "carddav.list" => pim::people::sources(engine),

        // Removing a source takes its people with it: they were a copy of
        // somebody else's book, and a copy with no origin can never be
        // refreshed or told apart from a contact the reader typed.
        "carddav.remove" => {
            let id = req_str(p, "id")?;
            store::delete_contact_source(&engine.db.lock().unwrap(), &id)?;
            let _ = meron_core::secrets::delete(&id);
            Ok(json!({ "ok": true }))
        }

        // OpenPGP certificates the reader has imported. Public certificates
        // only: what verifying a signature needs. A secret key wants a
        // passphrase and must not sit in a database somebody could copy, so it
        // gets its own handling when decryption arrives.
        "pgp.certs" => {
            let certs = store::pgp_certs(&engine.db.lock().unwrap())?;
            Ok(json!({ "certs": certs }))
        }

        "pgp.import" => {
            let armoured = req_str(p, "armoured")?;
            let (_, info) = meron_core::crypto::pgp::read_cert(&armoured)?;
            let stored = store::StoredCert {
                fingerprint: info.fingerprint.clone(),
                user_ids: info.user_ids,
                addresses: info.addresses,
                armoured,
                added_at: 0,
            };
            store::upsert_pgp_cert(
                &engine.db.lock().unwrap(),
                &stored,
                chrono::Utc::now().timestamp(),
            )?;
            Ok(json!({ "fingerprint": info.fingerprint }))
        }

        "pgp.remove" => {
            let fingerprint = req_str(p, "fingerprint")?;
            store::delete_pgp_cert(&engine.db.lock().unwrap(), &fingerprint)?;
            Ok(json!({ "ok": true }))
        }

        // Check one message's signature, when a reader is looking at it.
        //
        // On demand rather than on sync: verification needs the message as it
        // stood on the wire, which means fetching it, and doing that for every
        // message in a mailbox to answer a question nobody asked would be a
        // download per message.
        "pgp.verify" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let uid = req_u32(p, "uid")?;

            let armoured: Vec<String> = store::pgp_certs(&engine.db.lock().unwrap())?
                .into_iter()
                .map(|cert| cert.armoured)
                .collect();

            let raw_messages = engine
                .with_read_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move {
                        session.fetch_raw_messages_for_copy(&folder, &[uid]).await
                    })
                })
                .await?;
            let raw = raw_messages
                .into_iter()
                .next()
                .with_context(|| format!("message {uid} not found in {folder}"))?;

            let certs = meron_core::crypto::pgp::certs_from_armoured(&armoured);
            match meron_core::crypto::pgp::verify_message(&raw.raw, &certs) {
                Some(signature) => Ok(serde_json::to_value(signature)?),
                // Nothing to check. Said as such rather than as a failure: a
                // message with no signature is not a message whose signature
                // is bad.
                None => Ok(json!({ "verdict": "none" })),
            }
        }

        // The reader's own keys. The key material goes to the OS keyring
        // under `pgp-secret-<fingerprint>`, never to the database: a secret
        // key in a database is a secret key in every backup of it.
        "pgp.secretKeys" => {
            let keys = store::pgp_secret_keys(&engine.db.lock().unwrap())?;
            Ok(json!({ "keys": keys }))
        }

        "pgp.importSecret" => {
            let armoured = req_str(p, "armoured")?;
            let (_, info) = meron_core::crypto::pgp::read_secret_key(&armoured)?;
            meron_core::secrets::store(
                &format!("pgp-secret-{}", info.fingerprint),
                &meron_core::secrets::Secrets {
                    // The generic secret slot; the id says what it holds.
                    password: armoured,
                    ..Default::default()
                },
            )?;
            store::upsert_pgp_secret_key(
                &engine.db.lock().unwrap(),
                &store::StoredSecretKey {
                    fingerprint: info.fingerprint.clone(),
                    user_ids: info.user_ids,
                    addresses: info.addresses,
                    protected: info.protected,
                    added_at: 0,
                },
                chrono::Utc::now().timestamp(),
            )?;
            Ok(json!({ "fingerprint": info.fingerprint, "protected": info.protected }))
        }

        "pgp.removeSecret" => {
            let fingerprint = req_str(p, "fingerprint")?;
            store::delete_pgp_secret_key(&engine.db.lock().unwrap(), &fingerprint)?;
            let _ = meron_core::secrets::delete(&format!("pgp-secret-{fingerprint}"));
            Ok(json!({ "ok": true }))
        }

        // Open one encrypted message, when a reader asks for it.
        //
        // The passphrase arrives with the request and is not kept: it is used
        // for this one message and dropped. A reader who does not want to type
        // it again should have a key that is not passphrase-protected, which
        // is their decision to make and not this app's to make quietly for
        // them by holding on to it.
        "pgp.decrypt" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let uid = req_u32(p, "uid")?;
            let passphrase = req_str(p, "passphrase").ok();

            let fingerprints: Vec<String> = store::pgp_secret_keys(&engine.db.lock().unwrap())?
                .into_iter()
                .map(|key| key.fingerprint)
                .collect();
            let armoured: Vec<String> = fingerprints
                .iter()
                .filter_map(|fingerprint| {
                    meron_core::secrets::load(&format!("pgp-secret-{fingerprint}"))
                        .ok()
                        .map(|secrets| secrets.password)
                        .filter(|text| !text.is_empty())
                })
                .collect();

            let raw_messages = engine
                .with_read_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move {
                        session.fetch_raw_messages_for_copy(&folder, &[uid]).await
                    })
                })
                .await?;
            let raw = raw_messages
                .into_iter()
                .next()
                .with_context(|| format!("message {uid} not found in {folder}"))?;

            let keys = meron_core::crypto::pgp::certs_from_armoured(&armoured);
            match meron_core::crypto::pgp::decrypt_message(
                &raw.raw,
                &keys,
                passphrase.as_deref(),
            ) {
                Ok(opened) => Ok(json!({
                    "ok": true,
                    "body": opened.body,
                    "bodyHtml": opened.body_html,
                    "signature": opened.signature,
                })),
                Err(failure) => Ok(json!({ "ok": false, "failure": failure })),
            }
        }

        // S/MIME certificates the reader has imported. The same trust model
        // as OpenPGP's: held, or not — no chain to a root CA. See
        // `crypto::smime` for why, and `pgp.certs` for the parallel.
        "smime.certs" => {
            let certs = store::smime_certs(&engine.db.lock().unwrap())?;
            Ok(json!({ "certs": certs }))
        }

        "smime.import" => {
            let armoured = req_str(p, "der")?;
            let der = {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.decode(armoured.trim())
            }
            .context("that is not base64")?;
            let (_, info) = meron_core::crypto::smime::read_cert(&der)?;
            let stored = store::StoredSmimeCert {
                fingerprint: info.fingerprint.clone(),
                subject: info.subject,
                addresses: info.addresses,
                der,
                added_at: 0,
            };
            store::upsert_smime_cert(
                &engine.db.lock().unwrap(),
                &stored,
                chrono::Utc::now().timestamp(),
            )?;
            Ok(json!({ "fingerprint": info.fingerprint }))
        }

        "smime.remove" => {
            let fingerprint = req_str(p, "fingerprint")?;
            store::delete_smime_cert(&engine.db.lock().unwrap(), &fingerprint)?;
            Ok(json!({ "ok": true }))
        }

        // Check one message's S/MIME signature, on demand — same reasoning
        // as `pgp.verify`: it needs the message as it stood on the wire.
        "smime.verify" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let uid = req_u32(p, "uid")?;

            let held_der: Vec<Vec<u8>> = store::smime_certs(&engine.db.lock().unwrap())?
                .into_iter()
                .map(|cert| cert.der)
                .collect();

            let raw_messages = engine
                .with_read_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move {
                        session.fetch_raw_messages_for_copy(&folder, &[uid]).await
                    })
                })
                .await?;
            let raw = raw_messages
                .into_iter()
                .next()
                .with_context(|| format!("message {uid} not found in {folder}"))?;

            let held = meron_core::crypto::smime::certs_from_der(&held_der);
            match meron_core::crypto::smime::verify_message(&raw.raw, &held) {
                Some(signature) => Ok(serde_json::to_value(signature)?),
                None => Ok(json!({ "verdict": "none" })),
            }
        }

        // The reader's own S/MIME identity or identities — the parallel to
        // `pgp.secretKeys`/`pgp.importSecret`/`pgp.removeSecret`. The
        // certificate is public and lives in SQLite; the private key goes to
        // the OS keyring, under the same naming scheme OpenPGP secret keys
        // use, just with its own prefix.
        "smime.identities" => {
            let identities = store::smime_identities(&engine.db.lock().unwrap())?;
            Ok(json!({ "identities": identities }))
        }

        "smime.importIdentity" => {
            let p12_b64 = req_str(p, "p12")?;
            let password = req_str(p, "password")?;
            let p12 = {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.decode(p12_b64.trim())
            }
            .context("that is not base64")?;
            let identity = meron_core::crypto::pkcs12::read_pkcs12(&p12, &password)
                .map_err(|failure| anyhow::anyhow!("{failure}"))?;
            let key_der = meron_core::crypto::pkcs12::private_key_to_pkcs8_der(&identity.private_key)
                .map_err(|failure| anyhow::anyhow!("{failure}"))?;
            let cert_der = meron_core::crypto::pkcs12::certificate_to_der(&identity)
                .map_err(|failure| anyhow::anyhow!("{failure}"))?;

            meron_core::secrets::store(
                &format!("smime-identity-{}", identity.info.fingerprint),
                &meron_core::secrets::Secrets {
                    password: {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode(&key_der)
                    },
                    ..Default::default()
                },
            )?;
            store::upsert_smime_identity(
                &engine.db.lock().unwrap(),
                &store::StoredSmimeIdentity {
                    fingerprint: identity.info.fingerprint.clone(),
                    subject: identity.info.subject,
                    addresses: identity.info.addresses,
                    der: cert_der,
                    added_at: 0,
                },
                chrono::Utc::now().timestamp(),
            )?;
            Ok(json!({ "fingerprint": identity.info.fingerprint }))
        }

        "smime.removeIdentity" => {
            let fingerprint = req_str(p, "fingerprint")?;
            store::delete_smime_identity(&engine.db.lock().unwrap(), &fingerprint)?;
            let _ = meron_core::secrets::delete(&format!("smime-identity-{fingerprint}"));
            Ok(json!({ "ok": true }))
        }

        // Open one S/MIME-encrypted message — the parallel to `pgp.decrypt`.
        // No passphrase parameter: unlike an OpenPGP secret key, the private
        // key here was unlocked once, at import, and lives ready-to-use in
        // the OS keyring from then on.
        "smime.decrypt" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let uid = req_u32(p, "uid")?;

            let stored_identities = store::smime_identities(&engine.db.lock().unwrap())?;
            let identities: Vec<meron_core::crypto::pkcs12::Identity> = stored_identities
                .iter()
                .filter_map(|stored| {
                    let secrets =
                        meron_core::secrets::load(&format!("smime-identity-{}", stored.fingerprint)).ok()?;
                    let key_der = {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.decode(secrets.password.trim()).ok()?
                    };
                    meron_core::crypto::pkcs12::identity_from_parts(&stored.der, &key_der).ok()
                })
                .collect();

            let raw_messages = engine
                .with_read_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move {
                        session.fetch_raw_messages_for_copy(&folder, &[uid]).await
                    })
                })
                .await?;
            let raw = raw_messages
                .into_iter()
                .next()
                .with_context(|| format!("message {uid} not found in {folder}"))?;

            // Try every held identity; a message names its recipient inside
            // the CMS structure, not in a header this app parses beforehand.
            let mut last_failure = meron_core::crypto::smime::DecryptionFailure::NoKey;
            for identity in &identities {
                match meron_core::crypto::smime::decrypt_message(&raw.raw, identity) {
                    Ok(opened) => {
                        return Ok(json!({ "ok": true, "body": opened.body, "bodyHtml": opened.body_html }))
                    }
                    Err(failure) => last_failure = failure,
                }
            }
            Ok(json!({ "ok": false, "failure": last_failure }))
        }

        // Out-of-office / Automatic Replies. Which shape the settings take —
        // and where they live — depends entirely on the account's protocol,
        // decided here from the account's own credentials rather than
        // trusted from the caller: an Exchange account's settings live on
        // the server (real, reliable even when Oreneta is closed); a plain
        // IMAP/SMTP account has no server-side equivalent, so its settings
        // are this app's own preference and its auto-replies only go out
        // while Oreneta is running. See `crate::oof` and
        // `store::accounts::OofPrefs` for why.
        "oof.get" => {
            let account = req_str(p, "account")?;
            let creds = engine.ensure_valid_creds(&account).await?;
            if creds.is_ews() {
                let (own_address, _) = {
                    let db = engine.db.lock().unwrap();
                    store::resolve_send_from(&db, &account, &creds.user, "")?
                };
                let config = exchange::EwsConfig {
                    url: creds.ews_url.clone(),
                    username: creds.user.clone(),
                    password: creds.password.clone(),
                    target_mailbox: creds.target_mailbox.clone(),
                    proxy: creds.proxy.clone(),
                };
                let settings = tokio::task::spawn_blocking(move || {
                    exchange::EwsClient::new(config).get_oof_settings(&own_address)
                })
                .await??;
                return Ok(json!({ "kind": "ews", "settings": settings }));
            }
            let prefs = store::oof_prefs(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({ "kind": "imap", "settings": prefs }))
        }

        "oof.set" => {
            let account = req_str(p, "account")?;
            let creds = engine.ensure_valid_creds(&account).await?;
            let settings_json = p
                .get("settings")
                .cloned()
                .context("missing out-of-office settings")?;
            if creds.is_ews() {
                let settings: exchange::EwsOofSettings =
                    serde_json::from_value(settings_json).context("invalid out-of-office settings")?;
                let (own_address, _) = {
                    let db = engine.db.lock().unwrap();
                    store::resolve_send_from(&db, &account, &creds.user, "")?
                };
                let config = exchange::EwsConfig {
                    url: creds.ews_url.clone(),
                    username: creds.user.clone(),
                    password: creds.password.clone(),
                    target_mailbox: creds.target_mailbox.clone(),
                    proxy: creds.proxy.clone(),
                };
                tokio::task::spawn_blocking(move || {
                    exchange::EwsClient::new(config).set_oof_settings(&own_address, &settings)
                })
                .await??;
                return Ok(json!({ "ok": true }));
            }
            let prefs: store::OofPrefs =
                serde_json::from_value(settings_json).context("invalid out-of-office settings")?;
            {
                let db = engine.db.lock().unwrap();
                store::set_account_pref_json(&db, &account, "oof", Some(serde_json::to_value(&prefs)?))?;
                // A fresh save starts every sender's reply count back at
                // zero — see the table's own doc for why this must not be
                // skipped even when only, say, the reply body changed.
                store::clear_oof_replies(&db, &account)?;
            }
            Ok(json!({ "ok": true }))
        }

        // People, from whichever books have been brought in. An empty query
        // is the whole book, which is what the Personas view opens on.
        "people.list" => pim::people::list(engine, p),

        // Creates a person in the local book, or edits one from the version
        // it was read at. A different version saves nothing and answers with
        // the copy that is there now, for the reader to choose (ADR-0012).
        "people.save" => pim::people::save(engine, p).await,

        // People who share an address and may be one person: suggestions,
        // never acted on alone (ADR-0012).
        "people.duplicates" => {
            let db = engine.db.lock().unwrap();
            let groups = store::person_links::suggestions(&db)?;
            let everyone = store::find_people(&db, "", u32::MAX)?;
            let describe = |id: &String| {
                everyone.iter().find(|stored| &stored.id == id).map(|stored| json!({
                    "id": stored.id, "name": stored.person.name, "source": stored.origin.source,
                    "book": stored.origin.book, "emails": stored.person.emails,
                }))
            };
            Ok(json!({
                "groups": groups.iter().map(|ids| ids.iter().filter_map(describe).collect::<Vec<_>>()).collect::<Vec<_>>(),
            }))
        }
        "people.link" => {
            let ids: Vec<String> = serde_json::from_value(p.get("ids").cloned().unwrap_or_default()).context("ids")?;
            let link = store::person_links::link(&engine.db.lock().unwrap(), &ids)?;
            Ok(json!({ "ok": true, "link": link }))
        }
        "people.unlink" => {
            store::person_links::unlink(&engine.db.lock().unwrap(), &req_str(p, "id")?)?;
            Ok(json!({ "ok": true }))
        }
        "people.dismissDuplicate" => {
            let ids: Vec<String> = serde_json::from_value(p.get("ids").cloned().unwrap_or_default()).context("ids")?;
            store::person_links::dismiss(&engine.db.lock().unwrap(), &ids)?;
            Ok(json!({ "ok": true }))
        }

        // A .vcf of the people asked for (all when none are named), each
        // saying where it came from (ADR-0012).
        "people.exportVcf" => {
            let wanted: Option<Vec<String>> = p
                .get("ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect());
            let everyone = store::find_people(&engine.db.lock().unwrap(), "", u32::MAX)?;
            let mut vcf = String::new();
            let mut count = 0;
            for stored in everyone {
                if wanted.as_ref().is_some_and(|ids| !ids.contains(&stored.id)) {
                    continue;
                }
                let uid = if stored.person.uid.is_empty() { stored.id.clone() } else { stored.person.uid.clone() };
                vcf.push_str(&meron_core::contacts::vcard_write::export_card(&stored.person, &uid, &stored.origin.source));
                count += 1;
            }
            Ok(json!({ "vcf": vcf, "count": count }))
        }

        // What a .vcf would bring in, before anything is stored.
        "people.importPreview" => {
            let found = meron_core::contacts::vcard_import::preview(req_str(p, "vcf")?.as_bytes())?;
            Ok(json!({
                "people": found.people.iter().map(|person| json!({
                    "name": person.name, "organisation": person.organisation, "emails": person.emails,
                })).collect::<Vec<_>>(),
                "skipped": found.skipped,
            }))
        }

        // Stores a .vcf's people in the local book or a CardDAV book. One at a
        // time; a person already there (same name and first address) is
        // skipped, and the first failure stops the run and is reported with
        // how far it got.
        "people.import" => {
            let vcf = req_str(p, "vcf")?;
            let book = p.get("book").and_then(Value::as_str).filter(|b| !b.is_empty() && *b != "local").map(str::to_string);
            let found = meron_core::contacts::vcard_import::preview(vcf.as_bytes())?;
            let mut existing: Vec<meron_core::contacts::person::Person> = store::find_people(&engine.db.lock().unwrap(), "", u32::MAX)?
                .into_iter()
                .filter(|stored| match &book {
                    Some(book) => &stored.origin.book == book,
                    None => stored.origin.source == "local",
                })
                .map(|stored| stored.person)
                .collect();
            let source = match &book {
                Some(book) => Some(
                    store::contact_source(&engine.db.lock().unwrap(), book)?
                        .filter(|source| source.kind == "carddav")
                        .context("that address book cannot be written to")?,
                ),
                None => None,
            };
            let (mut imported, mut duplicates) = (0usize, 0usize);
            let mut stopped: Option<String> = None;
            for person in found.people {
                if meron_core::contacts::vcard_import::already_there(&person, &existing) {
                    duplicates += 1;
                    continue;
                }
                let result = match &source {
                    Some(source) => carddav_create(&engine, source, person.clone()).await.map(|_| ()),
                    None => store::local_people::save(&engine.db.lock().unwrap(), None, None, &person, now_seconds())
                        .map(|_| ()),
                };
                match result {
                    Ok(()) => {
                        imported += 1;
                        existing.push(person);
                    }
                    Err(error) => {
                        stopped = Some(format!("{error:#}"));
                        break;
                    }
                }
            }
            Ok(json!({
                "imported": imported,
                "duplicates": duplicates,
                "skipped": found.skipped,
                "stopped": stopped,
            }))
        }

        "people.delete" => pim::people::delete(engine, p).await,

        // Contact groups (ADR-0052): the local book's, CardDAV group cards
        // and Google labels; writes go to the local book and CardDAV books.
        "people.groups" => pim::people::groups(engine),
        "people.groupSave" => pim::people::group_save(engine, p).await,
        "people.groupDelete" => pim::people::group_delete(engine, p).await,
        // The book's names for senders a message gave no name (ADR-0052).
        "people.names" => pim::people::names(engine, p),

        // Text the writer keeps because they write it often: a snippet
        // dropped in at the cursor, or a whole message with its own subject.
        "templates.list" => {
            let stored = store::templates(&engine.db.lock().unwrap())?;
            Ok(json!({ "templates": stored }))
        }

        // Replaces the whole set, arrangement included. Every template is
        // checked before any of them is written: a save that stored four and
        // then refused the fifth would leave the list in a state the writer
        // never asked for and cannot see.
        "templates.save" => {
            let incoming = p
                .get("templates")
                .and_then(Value::as_array)
                .context("missing param: templates")?;
            let mut templates = Vec::with_capacity(incoming.len());
            for value in incoming {
                let template: meron_core::templates::Template =
                    serde_json::from_value(value.clone()).context("invalid template")?;
                if let Some(problem) = meron_core::templates::validate(&template) {
                    let name = template.name.trim();
                    if name.is_empty() {
                        anyhow::bail!("{}", problem.describe());
                    }
                    anyhow::bail!("{name}: {}", problem.describe());
                }
                templates.push(template);
            }
            let now = chrono::Utc::now().timestamp();
            store::replace_templates(&engine.db.lock().unwrap(), &templates, now)?;
            Ok(json!({ "ok": true, "saved": templates.len() }))
        }

        // Labels the reader has made. Local to this install by design: an
        // IMAP keyword is not carried by every server and an Exchange
        // category is a different thing again, so a label that appeared on
        // one device and silently not on another would be worse than one that
        // never claimed to travel.
        "labels.list" => {
            let db = engine.db.lock().unwrap();
            let stored = store::labels(&db)?;
            let links = store::label_links(&db)?;
            drop(db);
            Ok(json!({
                "labels": stored
                    .iter()
                    .map(|label| {
                        let label_links: serde_json::Map<String, Value> = links
                            .iter()
                            .filter(|link| link.label_id == label.id)
                            .map(|link| (link.account_id.clone(), json!(link.remote_name)))
                            .collect();
                        json!({
                            "id": label.id,
                            "name": label.name,
                            "colour": label.colour,
                            "inBar": label.in_bar,
                            "links": label_links,
                        })
                    })
                    .collect::<Vec<_>>()
            }))
        }

        // Replaces the whole set. A label that is gone takes its conversations
        // with it, so nothing carries a label nobody can see or remove.
        "labels.save" => {
            let incoming = p
                .get("labels")
                .and_then(Value::as_array)
                .context("missing param: labels")?;
            let mut labels = Vec::with_capacity(incoming.len());
            for value in incoming {
                let name = req_str(value, "name")?;
                if name.trim().is_empty() {
                    anyhow::bail!("a label needs a name");
                }
                labels.push(store::Label {
                    id: req_str(value, "id")?,
                    name: name.trim().to_string(),
                    colour: req_str(value, "colour").unwrap_or_else(|_| "#2056dd".to_string()),
                    in_bar: value.get("inBar").and_then(Value::as_bool).unwrap_or(false),
                });
            }
            store::replace_labels(&engine.db.lock().unwrap(), &labels)?;
            Ok(json!({ "ok": true, "saved": labels.len() }))
        }

        // The labels on one conversation, stated whole: "these are its labels"
        // is one statement, and applying it one at a time would leave moments
        // where it carried a combination nobody asked for.
        "labels.assign" => {
            let thread_id = req_str(p, "thread_id")?;
            let parsed = meron_core::protocol::mail::parse_thread_id(&thread_id)
                .context("invalid thread_id")?;
            let label_ids: Vec<String> = p
                .get("label_ids")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();

            // What changed, among labels this account has a link for — the
            // only ones a remote write could mean anything for. Read before
            // the local write, so "changed" compares against what was
            // really there a moment ago, not against what this same request
            // is about to make true.
            let (before, links) = {
                let db = engine.db.lock().unwrap();
                let before = store::thread_labels(&db, &parsed.account, &parsed.thread_key)?;
                let links: Vec<store::LabelLink> = store::label_links(&db)?
                    .into_iter()
                    .filter(|link| link.account_id == parsed.account)
                    .collect();
                (before, links)
            };
            let before_set: std::collections::HashSet<&str> =
                before.iter().map(String::as_str).collect();
            let after_set: std::collections::HashSet<&str> =
                label_ids.iter().map(String::as_str).collect();

            // Written before the local state changes, matching how a flag
            // write already works: if the remote write fails, local state is
            // never touched, so the two never quietly disagree about which
            // one is right.
            for link in &links {
                let was_on = before_set.contains(link.label_id.as_str());
                let now_on = after_set.contains(link.label_id.as_str());
                if was_on == now_on {
                    continue;
                }
                write_gmail_label_change(
                    engine,
                    &parsed.account,
                    &parsed.thread_key,
                    &link.remote_name,
                    now_on,
                )
                .await?;
            }

            let db = engine.db.lock().unwrap();
            store::set_thread_labels(&db, &parsed.account, &parsed.thread_key, &label_ids)?;
            Ok(json!({ "labels": store::thread_labels(&db, &parsed.account, &parsed.thread_key)? }))
        }

        // Links a label to an account's remote concept — a Gmail label name,
        // an Exchange category, an IMAP keyword — matched by name. Schema and
        // storage only: no protocol reads or writes the remote side yet (see
        // docs/adr/0002-remote-label-linking.md). Re-linking under a new name
        // replaces the old one rather than adding a second link.
        "labels.link" => {
            let label_id = req_str(p, "label_id")?;
            let account_id = req_str(p, "account_id")?;
            let remote_name = req_str(p, "remote_name")?;
            if remote_name.trim().is_empty() {
                anyhow::bail!("a link needs a remote name; use labels.unlink to clear one");
            }
            let db = engine.db.lock().unwrap();
            let exists: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM labels WHERE id = ?1)",
                    rusqlite::params![label_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if !exists {
                anyhow::bail!("no such label: {label_id}");
            }
            store::set_label_link(&db, &label_id, &account_id, remote_name.trim())?;
            Ok(json!({ "ok": true }))
        }

        // Clears a label's link on one account. The label and whatever it was
        // linked to are both left as they were.
        "labels.unlink" => {
            let label_id = req_str(p, "label_id")?;
            let account_id = req_str(p, "account_id")?;
            store::clear_label_link(&engine.db.lock().unwrap(), &label_id, &account_id)?;
            Ok(json!({ "ok": true }))
        }

        // The rules as they stand, in the order they run.
        "rules.list" => {
            let stored = {
                let db = engine.db.lock().unwrap();
                store::rules(&db)?
            };
            Ok(json!({
                "rules": stored
                    .iter()
                    .filter_map(|definition| serde_json::from_str::<Value>(definition).ok())
                    .collect::<Vec<_>>()
            }))
        }

        // Replaces the whole list. All at once because the order is part of
        // the meaning — rules run top to bottom and one can stop the rest —
        // so saving them one at a time would leave moments where the list
        // means something nobody asked for.
        "rules.save" => {
            let incoming = p
                .get("rules")
                .and_then(Value::as_array)
                .context("missing param: rules")?;
            let mut rows = Vec::with_capacity(incoming.len());
            for value in incoming {
                let rule: rules::Rule = serde_json::from_value(value.clone())
                    .context("this rule cannot be read")?;
                // Refused here rather than tolerated and worked around later:
                // this files people's mail, and a rule nobody can predict is
                // not a rule worth keeping.
                rules::validate(&rule).map_err(|err| anyhow::anyhow!("{}: {err}", rule.name))?;
                rows.push((
                    rule.id.clone(),
                    rule.account.clone(),
                    rule.enabled,
                    serde_json::to_string(&rule)?,
                ));
            }
            store::replace_rules(&engine.db.lock().unwrap(), &rows)?;
            Ok(json!({ "ok": true, "saved": rows.len() }))
        }

        // What the rules would do to mail already in a folder, without doing
        // any of it. The same `plan` the real run uses, so this cannot drift
        // into showing something other than what would happen.
        "rules.preview" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let limit = p.get("limit").and_then(Value::as_i64).unwrap_or(200).clamp(1, 1000);
            // Rules as sent when given, so an unsaved draft can be tried
            // before it is trusted with a mailbox; the stored ones otherwise.
            let from_stored = p.get("rules").and_then(Value::as_array).is_none();
            let candidates: Vec<rules::Rule> = match p.get("rules").and_then(Value::as_array) {
                Some(values) => values
                    .iter()
                    .map(|value| serde_json::from_value::<rules::Rule>(value.clone()))
                    .collect::<Result<Vec<_>, _>>()
                    .context("this rule cannot be read")?,
                None => stored_rules(engine),
            };

            let headers = {
                let db = engine.db.lock().unwrap();
                store::recent_headers(&db, &account, &folder, limit)?
            };
            let mut hits = Vec::new();
            let mut reviewed = Vec::new();
            for header in &headers {
                let planned = rules::plan(&candidates, &account, &rule_subject(header));
                if planned.is_empty() {
                    continue;
                }
                reviewed.push(rules::run::ReviewedMessage {
                    uid: header.uid,
                    subject: header.subject.clone(),
                    from: header.from_addr.clone(),
                    steps: planned.clone(),
                });
                hits.push(json!({
                    "uid": header.uid,
                    "subject": header.subject,
                    "from": header.from_addr,
                    "date": header.date,
                    "actions": planned
                        .iter()
                        .map(|step| json!({
                            "ruleId": step.rule_id,
                            "ruleName": step.rule_name,
                            "action": action_label(&step.action),
                        }))
                        .collect::<Vec<_>>(),
                }));
            }
            // The stored rules' preview can be run as it stands (#50): the
            // review names these messages and these steps, nothing more.
            let review_id = if from_stored && !reviewed.is_empty() {
                let uidvalidity = store::get_folder_state(&engine.db.lock().unwrap(), &account, &folder)?
                    .map(|(validity, _)| validity)
                    .unwrap_or(0);
                Some(rule_runs().issue(
                    &account,
                    &folder,
                    uidvalidity,
                    &rules::run::fingerprint(&candidates),
                    reviewed,
                    now_seconds(),
                ))
            } else {
                None
            };
            Ok(json!({ "examined": headers.len(), "matches": hits, "reviewId": review_id }))
        }

        // Runs a previewed set of rule actions on mail already in a folder,
        // exactly as shown, and says what happened to each step (#50).
        "rules.runReviewed" => {
            let account = req_str(p, "account")?;
            let review_id = req_str(p, "review_id")?;
            let folder = req_str(p, "folder").map(|f| canon_folder(&f)).unwrap_or_else(|_| "INBOX".into());
            let rules_now = stored_rules(engine);
            let validity = store::get_folder_state(&engine.db.lock().unwrap(), &account, &folder)?
                .map(|(v, _)| v)
                .unwrap_or(0);
            let run = rule_runs()
                .take(&review_id, &account, validity, &rules::run::fingerprint(&rules_now), now_seconds())
                .map_err(|err| anyhow::anyhow!("{err}"))?;
            if run.folder != folder {
                anyhow::bail!("this run was previewed for another folder");
            }
            let mut report = Vec::new();
            let (mut done, mut failed) = (0usize, 0usize);
            for message in &run.messages {
                let mut steps = Vec::new();
                let mut stopped = false;
                for step in &message.steps {
                    if stopped {
                        steps.push(json!({ "action": action_label(&step.action), "ok": false, "error": "not run: an earlier step failed" }));
                        continue;
                    }
                    // Boxed: an action runs through `dispatch`, which this is in.
                    let result =
                        Box::pin(run_rule_action(engine, out, &account, &run.folder, message.uid, &step.action)).await;
                    let outcome = match &result {
                        Ok(()) => "done".to_string(),
                        Err(err) => format!("failed: {err:#}"),
                    };
                    {
                        let db = engine.db.lock().unwrap();
                        let _ = store::log_rule_action(
                            &db,
                            &store::RuleLogEntry {
                                at: now_seconds(),
                                account: account.clone(),
                                rule_id: step.rule_id.clone(),
                                rule_name: step.rule_name.clone(),
                                folder: run.folder.clone(),
                                uid: message.uid,
                                subject: message.subject.clone(),
                                from_addr: message.from.clone(),
                                action: action_label(&step.action),
                                outcome,
                            },
                        );
                    }
                    match result {
                        Ok(()) => steps.push(json!({ "action": action_label(&step.action), "ok": true })),
                        Err(err) => {
                            stopped = true;
                            steps.push(json!({ "action": action_label(&step.action), "ok": false, "error": format!("{err:#}") }));
                        }
                    }
                }
                if stopped { failed += 1 } else { done += 1 }
                report.push(json!({ "uid": message.uid, "subject": message.subject, "steps": steps }));
            }
            Ok(json!({ "done": done, "failed": failed, "messages": report }))
        }

        // What the rules have actually done. A mailbox that changes by itself
        // needs somewhere the reader can find out why.
        "rules.log" => {
            let limit = p.get("limit").and_then(Value::as_i64).unwrap_or(200);
            let entries = {
                let db = engine.db.lock().unwrap();
                store::rule_log(&db, limit)?
            };
            Ok(json!({
                "entries": entries
                    .iter()
                    .map(|entry| json!({
                        "at": entry.at,
                        "account": entry.account,
                        "ruleId": entry.rule_id,
                        "ruleName": entry.rule_name,
                        "folder": entry.folder,
                        "uid": entry.uid,
                        "subject": entry.subject,
                        "from": entry.from_addr,
                        "action": entry.action,
                        "outcome": entry.outcome,
                    }))
                    .collect::<Vec<_>>()
            }))
        }

        "rules.clearLog" => {
            store::clear_rule_log(&engine.db.lock().unwrap())?;
            Ok(json!({ "ok": true }))
        }

        // Files a message to go at a chosen hour. The whole send is kept, so
        // what leaves then is what was written now — and it is kept in the
        // store rather than in a timer, because a message due at eight must
        // go whether or not the app was open at eight.
        "mail.scheduleSend" => {
            let id = req_str(p, "id")?;
            let account = req_str(p, "account")?;
            let due_at = p
                .get("due_at")
                .and_then(Value::as_i64)
                .context("missing param: due_at")?;
            if due_at <= now_seconds() {
                anyhow::bail!("a message cannot be scheduled for a moment already past");
            }
            let mut message = p.get("message").cloned().context("missing param: message")?;
            // A key's passphrase is never written down with the message: it
            // would sit in the store until the hour came.
            strip_send_secrets(&mut message);
            if req_str(&message, "to").unwrap_or_default().trim().is_empty() {
                anyhow::bail!("a scheduled message needs a recipient");
            }
            let subject = req_str(&message, "subject").unwrap_or_default();
            store::schedule_send(
                &engine.db.lock().unwrap(),
                &id,
                &account,
                due_at,
                &subject,
                &serde_json::to_string(&message)?,
            )?;
            Ok(json!({ "ok": true, "id": id, "due_at": due_at }))
        }

        // What is still waiting to go, so a message put off is a message the
        // reader can still find, change their mind about, or be told failed.
        "mail.scheduledSends" => {
            let account = req_str(p, "account").ok().filter(|a| !a.is_empty());
            let db = engine.db.lock().unwrap();
            let rows = store::scheduled_sends(&db, account.as_deref())?;
            let messages = rows
                .iter()
                .map(|row| {
                    let uncertain = outgoing::attempt(&db, &row.id)
                        .ok()
                        .flatten()
                        .is_some_and(|attempt| attempt.state == outgoing::AttemptState::Uncertain);
                    scheduled_send_json(row, uncertain)
                })
                .collect::<Vec<_>>();
            Ok(json!({ "messages": messages }))
        }

        // Calls a scheduled send off and hands the message back, so its words
        // return to the composer instead of being taken away.
        // Sends whose outcome nobody knows, and sent messages without a
        // Sent copy. Listed so a person can look at them; nothing here is
        // retried on its own.
        "mail.outgoingAttempts" => {
            let account = req_str(p, "account").ok().filter(|a| !a.is_empty());
            let rows = outgoing::unsettled(&engine.db.lock().unwrap(), account.as_deref())?;
            Ok(json!({ "attempts": rows.iter().map(outgoing::OutgoingAttempt::to_json).collect::<Vec<_>>() }))
        }

        // A person has settled an uncertain send, whichever way. The record
        // stays, marked as looked at; only the doubt is cleared.
        "mail.resolveOutgoing" => {
            let id = req_str(p, "id")?;
            let resolved = outgoing::resolve(&engine.db.lock().unwrap(), &id, now_seconds())?;
            Ok(json!({ "ok": true, "resolved": resolved }))
        }

        "mail.cancelScheduledSend" => {
            let id = req_str(p, "id")?;
            let cancelled = store::cancel_scheduled_send(&engine.db.lock().unwrap(), &id)?;
            match cancelled {
                Some(row) => Ok(json!({
                    "ok": true,
                    "message": serde_json::from_str::<Value>(&row.payload).unwrap_or(Value::Null),
                })),
                None => Ok(json!({ "ok": true, "message": Value::Null })),
            }
        }

        // Lets a scheduled message go now, rather than at its hour. Also the
        // way back for one that gave up trying: the row is only dropped once
        // the message has actually gone.
        "mail.sendScheduledNow" => {
            let id = req_str(p, "id")?;
            let row = {
                let db = engine.db.lock().unwrap();
                store::scheduled_send(&db, &id)?
            };
            let row = row.context("no such scheduled message")?;
            let message: Value = serde_json::from_str(&row.payload)
                .context("this scheduled message can no longer be read")?;
            // Sending again a message whose earlier try may have gone is a
            // decision, not a retry; the interface says so explicitly.
            let resend = p.get("resend").and_then(Value::as_bool).unwrap_or(false);
            match send_scheduled(engine, &row, &message, resend).await {
                Ok(ScheduledOutcome::Sent) => {
                    store::cancel_scheduled_send(&engine.db.lock().unwrap(), &id)?;
                    Ok(json!({ "ok": true, "outcome": "sent" }))
                }
                Ok(ScheduledOutcome::Uncertain(reason)) => {
                    store::give_up_on_send(&engine.db.lock().unwrap(), &id, &reason, now_seconds())?;
                    Ok(json!({ "ok": false, "outcome": "uncertain", "id": id, "error": reason }))
                }
                Ok(ScheduledOutcome::InFlight) => Ok(json!({ "ok": false, "outcome": "in_flight", "id": id })),
                Err(err) => {
                    let reason = format!("{err:#}");
                    store::record_send_failure(&engine.db.lock().unwrap(), &id, &reason, now_seconds())?;
                    Err(err)
                }
            }
        }

        // Serialize accounts, prefs, feeds and settings to a backup document
        // (see `backup`). The passphrase-based key derivation is deliberately
        // slow, so this runs on the blocking pool rather than the reactor.
        // The full-profile archive (#171, ADR-0017). The store is held only
        // while it is copied; packing and encrypting run without it.
        "profileArchive.export" => {
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let passphrase = req_str(p, "passphrase")?;
            let app_version = p.get("app_version").and_then(Value::as_str).unwrap_or_default().to_string();
            let engine = engine.clone();
            let summary = tokio::task::spawn_blocking(move || {
                // Never at the same time as a scheduled backup (#173).
                let _capture = meron_core::backup_schedule::capture_lock()?;
                let media_root = meron_core::parse::media_root();
                let work_dir = store::app_dir().join("backup-work");
                let options = meron_core::profile_archive::ExportOptions {
                    media_root: &media_root,
                    work_dir: &work_dir,
                    app_version: &app_version,
                    now: now_seconds(),
                    // Debug-build tests would spend minutes in scrypt at the real cost.
                    work_factor: if cfg!(test) { 10 } else { meron_core::profile_archive::WORK_FACTOR },
                };
                meron_core::profile_archive::export_with(
                    |dest, key| meron_core::profile_archive::take_snapshot(&engine.db.lock().unwrap(), dest, key),
                    &path,
                    &passphrase,
                    &options,
                )
            })
            .await??;
            Ok(json!({ "saved": true, "summary": summary }))
        }
        // Readies an archive to replace this profile (#172). The profile in
        // use is untouched; the bridge activates it with the core stopped.
        "profileArchive.stage" => {
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let passphrase = req_str(p, "passphrase")?;
            let summary = tokio::task::spawn_blocking(move || {
                let machine_key = meron_core::secrets::db_key()?;
                meron_core::profile_archive::prepare_restore(
                    &path,
                    &passphrase,
                    &store::app_dir(),
                    machine_key.as_deref(),
                    now_seconds(),
                )
            })
            .await??;
            Ok(json!({ "ready": true, "summary": summary }))
        }
        // Opens an archive in a private folder, checks every entry and the
        // store inside, and describes it. Nothing in use is touched.
        "profileArchive.inspect" => {
            let path = std::path::PathBuf::from(req_str(p, "path")?);
            let passphrase = req_str(p, "passphrase")?;
            let summary = tokio::task::spawn_blocking(move || {
                let staging = store::app_dir().join("restore-staging").join(uuid::Uuid::new_v4().to_string());
                let result = meron_core::profile_archive::stage(&path, &passphrase, &staging)
                    .and_then(|manifest| meron_core::profile_archive::summary(&manifest, &staging));
                let _ = std::fs::remove_dir_all(&staging);
                result
            })
            .await??;
            Ok(json!({ "summary": summary }))
        }
        "backup.export" => {
            let include_secrets = p
                .get("include_secrets")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let passphrase = p
                .get("passphrase")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // The Go host owns the product version; core only knows its crate's.
            // The platform goes with it because desktop and mobile version
            // independently, so the number alone doesn't identify a build.
            let app_version = p
                .get("app_version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let platform = p
                .get("platform")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let engine = engine.clone();
            let text = tokio::task::spawn_blocking(move || {
                // Secrets are read up front, with the DB lock released, because
                // they come from the OS keychain — the slowest and most
                // failure-prone dependency here (a Flatpak Secret portal with no
                // backend can hang outright). Holding the store lock across that
                // would stall every other request behind a backup.
                let secrets: std::collections::HashMap<String, secrets::Secrets> =
                    if include_secrets {
                        let ids = {
                            let conn = engine.db.lock().unwrap();
                            let mut ids: Vec<String> = store::list_accounts(&conn)?
                                .iter()
                                .filter_map(|account| account.get("id").and_then(Value::as_str))
                                .map(str::to_string)
                                .collect();
                            // The reader's own OpenPGP/S-MIME identities: not
                            // accounts, but the same keychain and the same
                            // "read every id up front" reasoning applies.
                            ids.extend(
                                store::pgp_secret_keys(&conn)?
                                    .into_iter()
                                    .map(|key| format!("pgp-secret-{}", key.fingerprint)),
                            );
                            ids.extend(
                                store::smime_identities(&conn)?
                                    .into_iter()
                                    .map(|identity| format!("smime-identity-{}", identity.fingerprint)),
                            );
                            ids
                        };
                        ids.into_iter()
                            // An account whose entry is missing or unreadable exports
                            // without one rather than failing the whole backup.
                            .map(|id| {
                                let loaded = secrets::load(&id).unwrap_or_default();
                                (id, loaded)
                            })
                            .collect()
                    } else {
                        std::collections::HashMap::new()
                    };
                backup::export(
                    &engine.db.lock().unwrap(),
                    include_secrets,
                    Some(passphrase.as_str()),
                    backup::Host {
                        platform: platform.as_str(),
                        app_version: app_version.as_str(),
                    },
                    &|account| secrets.get(account).cloned().unwrap_or_default(),
                )
            })
            .await??;
            Ok(json!({ "backup": text }))
        }

        // Restore a backup document. An encrypted file opened without a
        // passphrase comes back as `needs_passphrase` (not an error) so the UI
        // can prompt and call again instead of showing a failure.
        "backup.import" => {
            let text = req_str(p, "backup")?;
            let passphrase = p
                .get("passphrase")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let engine = engine.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let data = match backup::parse(&text, Some(passphrase.as_str())) {
                    Ok(data) => data,
                    Err(err) if backup::needs_passphrase(&err.to_string()) => return Ok(None),
                    Err(err) => return Err(err),
                };
                let conn = engine.db.lock().unwrap();
                let summary = backup::apply(&conn, &data, &|conn, account, secrets| {
                    // Mirror DesktopHost::store_secret: the keychain owns the
                    // secret, and the legacy SQLite column stays empty.
                    let _ = conn;
                    secrets::store(account, secrets)
                })?;
                // Restored settings include the app-wide proxy, which socket
                // code reads from a process-global slot.
                proxy::load_global(&conn)?;
                Ok(Some(summary))
            })
            .await??;
            match outcome {
                Some(summary) => Ok(summary.to_json()),
                None => Ok(json!({ "needs_passphrase": true })),
            }
        }

        // All accounts (mail + rss) as bridge-shaped JSON, from the one DB.
        "account.list" => {
            let mut accounts = store::list_accounts(&engine.db.lock().unwrap())?;
            let live_accounts = engine.accounts.lock().await;
            for account in &mut accounts {
                if account
                    .get("auth_type")
                    .and_then(Value::as_str)
                    .is_some_and(|auth_type| auth_type == "rss")
                {
                    continue;
                }
                let Some(id) = account
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                if let Some(obj) = account.as_object_mut() {
                    // The local archive has nothing to reconnect (ADR-0014).
                    if obj.get("auth_type").and_then(Value::as_str) == Some("local_archive") {
                        obj.insert("needs_reconnect".into(), json!(false));
                        continue;
                    }
                    if obj.get("auth_type").and_then(Value::as_str)==Some("graph_oauth") {
                        let status=meron_core::graph::mail::status(&engine.db.lock().unwrap(),&id);
                        let reconnect=status.as_ref().map_or(true,|s|matches!(s.error.as_deref(),Some("reauthenticate"|"consent_required"|"access_denied")));
                        obj.insert("needs_reconnect".into(),json!(reconnect));
                        // Whether its grant allows message changes (#141).
                        obj.insert("graph_writes".into(),json!(meron_core::graph::mail::writes_enabled(&engine.db.lock().unwrap(),&id)));
                        obj.insert("graph_send".into(),json!(meron_core::graph::mail::send_enabled(&engine.db.lock().unwrap(),&id)));
                        continue;
                    }
                    let needs_reconnect = live_accounts
                        .get(&id)
                        .is_none_or(|creds| !creds_have_required_secret(creds));
                    obj.insert("needs_reconnect".to_string(), json!(needs_reconnect));
                    // An EWS account pointed at Exchange Online (#46): EWS is
                    // retired there, and this client's Basic sign-in already
                    // was. Said in settings with the way forward.
                    if let Some(url) = obj.get("ews_url").and_then(Value::as_str) {
                        if meron_core::exchange::is_exchange_online(url) {
                            obj.insert("ews_exchange_online".to_string(), json!(true));
                        }
                    }
                }
            }
            Ok(json!({ "accounts": accounts }))
        }

        // Add an RSS feed: fetch + parse + persist on the blocking pool (network
        // I/O), returning the bridge Account JSON.
        "account.addRss" => {
            let feed_url = req_str(p, "feed_url")?;
            let display_name = req_str(p, "display_name").unwrap_or_default();
            let engine = engine.clone();
            let account =
                tokio::task::spawn_blocking(move || rss::add(&engine.db, &feed_url, &display_name))
                    .await??;
            Ok(json!({ "account": account }))
        }

        // Add a feed to an existing RSS account (network on the blocking pool).
        "feed.add" => {
            let account = req_str(p, "account")?;
            let feed_url = req_str(p, "feed_url")?;
            let engine = engine.clone();
            let res =
                tokio::task::spawn_blocking(move || rss::add_feed(&engine.db, &account, &feed_url))
                    .await??;
            Ok(res)
        }

        // Remove a single feed (subscription) and its items from an RSS account.
        "feed.remove" => {
            let thread_id = req_str(p, "thread_id")?;
            let res = rss::remove_feed(&engine.db.lock().unwrap(), &thread_id)?;
            Ok(res)
        }

        // Move a feed subscription between RSS accounts without losing cached
        // items or per-item read/starred state.
        "feed.move" => {
            let thread_id = req_str(p, "thread_id")?;
            let target_account = req_str(p, "target_account")?;
            let res = rss::move_feed(&engine.db.lock().unwrap(), &thread_id, &target_account)?;
            Ok(res)
        }

        // Serialize one RSS account's feeds to an OPML 2.0 document.
        "rss.exportOpml" => {
            let account = req_str(p, "account")?;
            let opml = rss::export_opml(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({ "opml": opml }))
        }

        // Import feeds from an OPML document into one RSS account. Returns the
        // number of feeds added; the caller reloads accounts and syncs.
        "rss.importOpml" => {
            let opml = req_str(p, "opml")?;
            let account = req_str(p, "account")?;
            let engine = engine.clone();
            let imported =
                tokio::task::spawn_blocking(move || rss::import_opml(&engine.db, &opml, &account))
                    .await??;
            Ok(json!({ "imported": imported }))
        }

        // RSS thread read: paginated newest-first slice (or full thread when
        // `limit` is omitted), as final Message JSON.
        "rss.thread" => {
            let thread_id = req_str(p, "thread_id")?;
            let limit = p.get("limit").and_then(Value::as_u64).map(|n| n as u32);
            let before_cursor = p
                .get("before_cursor")
                .and_then(Value::as_str)
                .and_then(parse_rss_cursor);
            let (messages, next_cursor) = rss::read_thread_page(
                &engine.db.lock().unwrap(),
                &thread_id,
                before_cursor,
                limit,
            )?;
            let mut out = json!({ "messages": messages });
            if let Some(cursor) = next_cursor {
                out.as_object_mut()
                    .unwrap()
                    .insert("next_cursor".into(), Value::String(cursor));
            }
            Ok(out)
        }

        "rss.markRead" => {
            let thread_id = req_str(p, "thread_id")?;
            // Defaults to read; pass seen:false to mark unread.
            let seen = p.get("seen").and_then(Value::as_bool).unwrap_or(true);
            let item_keys = p
                .get("item_keys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if item_keys.is_empty() {
                rss::mark_thread_read(&engine.db.lock().unwrap(), &thread_id, seen)?;
            } else {
                rss::mark_items_read(&engine.db.lock().unwrap(), &thread_id, &item_keys, seen)?;
            }
            Ok(json!({ "ok": true }))
        }

        "rss.markAllRead" => {
            let account = req_str(p, "account")?;
            let updated = rss::mark_account_read(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({
                "ok": true,
                "updated": updated,
                "folder_unreads": { (account): { "inbox": 0 } },
            }))
        }

        "rss.markStarred" => {
            let thread_id = req_str(p, "thread_id")?;
            let starred = p.get("starred").and_then(Value::as_bool).unwrap_or(true);
            let item_keys = p
                .get("item_keys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if item_keys.is_empty() {
                rss::mark_thread_starred(&engine.db.lock().unwrap(), &thread_id, starred)?;
            } else {
                rss::mark_items_starred(
                    &engine.db.lock().unwrap(),
                    &thread_id,
                    &item_keys,
                    starred,
                )?;
            }
            Ok(json!({ "ok": true }))
        }

        // Store (and validate) IMAP credentials for an account.
        "account.connect" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            anyhow::ensure!(p.get("auth_type").and_then(Value::as_str)!=Some("graph_oauth") && !store::load_account(&engine.db.lock().unwrap(),&id)?.is_some_and(|c|c.is_graph()),"Graph accounts require the dedicated authorization and activation flow");
            // Exchange accounts carry an EWS endpoint URL and no IMAP server,
            // so `host` is required only for the IMAP path.
            let ews_url = p
                .get("ews_url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let host = if ews_url.is_empty() {
                req_str(p, "host")?
            } else {
                req_str(p, "host").unwrap_or_default()
            };
            let mut creds = imap::Creds {
                host: host.clone(),
                port: req_u16(p, "port").unwrap_or(993),
                user: req_str(p, "user")?,
                password: p
                    .get("password")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                tls: p.get("tls").and_then(Value::as_bool).unwrap_or(true),
                starttls: p.get("starttls").and_then(Value::as_bool).unwrap_or(false),
                smtp_host: req_str(p, "smtp_host").unwrap_or(host),
                smtp_port: req_u16(p, "smtp_port").unwrap_or(587),
                smtp_tls: p.get("smtp_tls").and_then(Value::as_bool).unwrap_or(true),
                smtp_starttls: p
                    .get("smtp_starttls")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                auth_type: p
                    .get("auth_type")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "password".to_string()),
                access_token: p
                    .get("access_token")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string()),
                refresh_token: p
                    .get("refresh_token")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string()),
                token_expires_at: p
                    .get("token_expires_at")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                oauth_client_id: p
                    .get("oauth_client_id")
                    .or_else(|| p.get("client_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                oauth_client_secret: p
                    .get("oauth_client_secret")
                    .or_else(|| p.get("client_secret"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                oauth_token_url: p
                    .get("oauth_token_url")
                    .or_else(|| p.get("token_url"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                oauth_scope: p
                    .get("oauth_scope")
                    .or_else(|| p.get("scope"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                proxy: proxy::ProxyChoice::from_json(p.get("proxy").unwrap_or(&Value::Null)),
                // Set once the user has inspected and accepted a certificate
                // that webpki rejects (see `account.probeCert`).
                cert_pin: cert_pin_param(p, "cert_pin"),
                smtp_cert_pin: cert_pin_param(p, "smtp_cert_pin"),
                // Present only for Exchange accounts, and what routes them to
                // the EWS backend; see `backend::connect`.
                ews_url: ews_url.clone(),
                // A shared mailbox is added through `account.addSharedMailbox`,
                // never through this general add/reconnect path.
                delegate_account_id: String::new(),
                target_mailbox: String::new(),
            };
            // A reconnect resends the setup form, which has no field for the
            // account's proxy or the certificates it accepted. Carry those over
            // from the stored account so saving credentials again does not
            // silently reset them.
            let omitted = imap::OmittedSettings {
                proxy: p.get("proxy").is_none(),
                cert_pin: p.get("cert_pin").is_none(),
                smtp_cert_pin: p.get("smtp_cert_pin").is_none(),
                password: p.get("password").is_none(),
            };
            if omitted.any() {
                let stored = {
                    let db = engine.db.lock().unwrap();
                    store::load_account(&db, &id)?
                };
                if let Some(mut stored) = stored {
                    // The password lives in the keychain, not the account row,
                    // so the stored creds have to be hydrated before they can
                    // supply one.
                    if omitted.password {
                        let db = engine.db.lock().unwrap();
                        engine.host.apply_secret(&db, &id, &mut stored);
                    }
                    creds.carry_over(&stored, omitted);
                }
            }
            // Password accounts validate before storage. OAuth accounts may be
            // created directly after Google's token exchange; IMAP validation
            // can be slow or network-dependent, and later sync/watch calls will
            // surface any mailbox access failure.
            if p.get("validate").and_then(Value::as_bool).unwrap_or(true) {
                if creds.is_pop3() {
                    // Signs in over TLS and leaves at once; nothing is
                    // downloaded or deleted until the first sync.
                    let mut client = tokio::time::timeout(Duration::from_secs(20), meron_core::pop3::connect(&creds))
                        .await
                        .map_err(|_| anyhow::anyhow!("POP3 validation timed out"))??;
                    let _ = client.quit().await;
                    tokio::time::timeout(Duration::from_secs(20), smtp::check_certificate(&creds))
                        .await
                        .unwrap_or(Ok(()))?;
                } else if creds.is_ews() {
                    // Exchange carries mail and submission over one HTTPS
                    // endpoint, so a single round trip validates both.
                    let config = exchange::EwsConfig {
                        url: creds.ews_url.clone(),
                        username: creds.user.clone(),
                        password: creds.password.clone(),
                        target_mailbox: creds.target_mailbox.clone(),
                        proxy: creds.proxy.clone(),
                    };
                    tokio::time::timeout(Duration::from_secs(20), exchange::validate(config))
                        .await
                        .map_err(|_| anyhow::anyhow!("Exchange validation timed out"))??;
                } else {
                    let mut session =
                        tokio::time::timeout(Duration::from_secs(20), imap::connect(&creds))
                            .await
                            .map_err(|_| anyhow::anyhow!("IMAP validation timed out"))??;
                    let _ = session.logout().await;
                    // The submission server can be a different daemon with a
                    // certificate of its own; a save that only validated IMAP would
                    // hand the user an account that fails at the first send.
                    tokio::time::timeout(Duration::from_secs(20), smtp::check_certificate(&creds))
                        .await
                        .unwrap_or(Ok(()))?;
                }
            }
            let meta = store::AccountMeta {
                engine: "mail".to_string(),
                provider: p
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("custom")
                    .to_string(),
                email: p
                    .get("email")
                    .and_then(Value::as_str)
                    .unwrap_or(&creds.user)
                    .to_string(),
                display_name: p
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                avatar_url: p
                    .get("avatar_url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                sender_name: p
                    .get("sender_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            };
            {
                let db = engine.db.lock().unwrap();
                store::upsert_account(&db, &id, &meta, &creds)?;
                if creds.is_pop3() {
                    // POP3 has no folders: its mail goes to an Inbox kept here.
                    store::upsert_folders(
                        &db,
                        &id,
                        &[
                            imap::Folder { name: "INBOX".into(), display_name: "INBOX".into(), ..Default::default() },
                            imap::Folder {
                                name: meron_core::archive::TRASH.into(),
                                display_name: meron_core::archive::TRASH.into(),
                                special_use: Some("trash".into()),
                                ..Default::default()
                            },
                        ],
                    )?;
                }
            }
            secrets::store(&id, &secrets::Secrets::from_creds(&creds))?;
            let has_calendars =
                calendar::route::Route::of(&creds) != calendar::route::Route::None;
            engine.accounts.lock().await.insert(id.clone(), creds);
            // Setting up a mail account brings its calendars with it: that is
            // what adding an Exchange (or, later, Google) account means in
            // every established client, so nobody has to know that a separate
            // import exists. Runs behind the response — discovery must not
            // slow down account creation.
            if has_calendars {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|epoch| epoch.as_secs() as i64)
                    .unwrap_or_default();
                spawn_calendar_sync(
                    engine.clone(),
                    out.clone(),
                    id.clone(),
                    now - 7 * 24 * 3600,
                    now + 90 * 24 * 3600,
                );
            }
            // This call also edits an existing account (server settings, a new
            // password, a reconnect). Replacing the cached creds is not enough:
            // warm pooled sessions and the live IDLE watcher are already
            // authenticated against the *old* server, and would keep serving
            // reads and pushes from it indefinitely. Drop the pool and wake the
            // watchers so the next connection is made with what was just saved.
            engine.clear_pool(&id);
            engine.resume_signal.notify_waiters();
            // Start watching the new account right away. Only startup resumed
            // IDLE for known accounts, so an account added mid-session stayed
            // unwatched (and its INBOX unwarmed) until the next launch: mail
            // arrived on the server and nothing pushed it into the store.
            if !engine.is_paused(&id) {
                if start_idle_watch(engine.clone(), out.clone(), id.clone(), "INBOX".to_string()) {
                    spawn_body_prefetch(engine.clone(), id.clone(), "INBOX".to_string());
                }
            }
            Ok(json!({ "ok": true, "account": id }))
        }

        // Cache-only (instant). When refresh != false, also kicks a background
        // sync that emits mail.synced; event-driven reloads pass refresh:false to
        // avoid a sync→event→reload loop.
        // RSS accounts return final Folder JSON (one synthetic Inbox); mail
        // returns raw rows the bridge formats. Routed by the account's engine.
        "calendar.list" => pim::calendar::list(engine, p),

        "calendar.setEnabled" => pim::calendar::set_enabled(engine, p),

        // Answers from the cache and refreshes behind the request, the same
        // contract `folders.list` and `messages.recent` give: a view renders
        // at once and settles when the server answers.
        "calendar.events" => pim::calendar::events(engine, &emitter(out), p),

        // Writes go straight to the server and then refresh the window they
        // land in, so the agenda shows what the server actually stored rather
        // than what was asked for.
        // A local calendar has no server: it is a row here and nothing more,
        // which is exactly what the user asked for when they chose "on this
        // computer" — and what the interface must say, since nothing else has
        // a copy of it.
        "calendar.createLocal" => pim::calendar::create_local(engine, p),

        // Subscribing fetches once before storing, so a wrong URL is reported
        // now rather than as a calendar that silently never fills.
        "calendar.subscribe" => {
            let account = req_str(p, "account")?;
            let name = req_str(p, "name")?;
            let url = calendar::subscription::normalize_url(&req_str(p, "url")?)?;
            let probe_url = url.clone();
            let proxy = lookup_route(&engine, p)?;
            let body = tokio::task::spawn_blocking(move || {
                calendar::subscription::fetch(&probe_url, &proxy)
            })
            .await??;
            let id = format!("sub:{}", uuid::Uuid::new_v4());
            calendar::subscription::parse_window(&body, &id, 0, 1)
                .context("that URL did not answer with a calendar")?;
            calendar::upsert_calendars(
                &engine.db.lock().unwrap(),
                &account,
                &[calendar::Calendar {
                    id: id.clone(),
                    name,
                    kind: calendar::CalendarKind::Subscribed,
                    url: Some(url),
                    read_only: true,
                    enabled: true,
                    ..Default::default()
                }],
            )?;
            Ok(json!({ "id": id }))
        }

        // The search box's own grammar, for a builder that edits a search
        // field by field (#43): read into parts, and written back as text.
        "search.parse" => {
            let query = req_str(p, "query").unwrap_or_default();
            Ok(json!({ "query": search::parse(&query) }))
        }
        "search.compose" => {
            let query: search::Query = serde_json::from_value(p.get("query").cloned().unwrap_or_default())?;
            Ok(json!({ "text": search::compose(&query) }))
        }

        // Every attachment of the mail kept here (#93, ADR-0020). A file whose
        // bytes are no longer on disk (the cache is pruned) is listed without
        // a key: the interface offers its message instead of a dead link.
        // The reader's sidebar: one person's history in one account (#86).
        "context.person" => {
            let mut context = meron_core::person_context::person(
                &engine.db.lock().unwrap(),
                &req_str(p, "account")?,
                &req_str(p, "address")?,
                now_seconds(),
            )?;
            let root = meron_core::parse::media_root();
            for item in &mut context.files {
                if item.key.as_ref().is_some_and(|key| !root.join(key).is_file()) {
                    item.key = None;
                }
                item.thread_id = if item.thread_key.is_empty() {
                    format!("{}#{}#{}", item.account, item.folder, item.uid)
                } else {
                    mail_model::format_thread_id(&item.account, &item.folder, &item.thread_key)
                };
            }
            Ok(serde_json::to_value(context)?)
        }
        "attachments.list" => {
            let query: store::attachment_list::Query = serde_json::from_value(p.clone()).unwrap_or_default();
            let mut page = store::attachment_list::list(&engine.db.lock().unwrap(), &query)?;
            let root = meron_core::parse::media_root();
            for item in &mut page.items {
                if item.key.as_ref().is_some_and(|key| !root.join(key).is_file()) {
                    item.key = None;
                }
                item.thread_id = if item.thread_key.is_empty() {
                    format!("{}#{}#{}", item.account, item.folder, item.uid)
                } else {
                    mail_model::format_thread_id(&item.account, &item.folder, &item.thread_key)
                };
            }
            Ok(serde_json::to_value(page)?)
        }

        // Meeting invitations that arrived by mail (#102, ADR-0019). Each of
        // these runs only because the person asked; reading an invitation
        // never answers it.
        "invite.status" => {
            let account = req_str(p, "account")?;
            let uid = req_str(p, "uid")?;
            let db = engine.db.lock().unwrap();
            let answer = calendar::itip::answer_of(&db, &account, &uid)?;
            let calendars = invitation_calendars(&db, &account, &uid)?;
            Ok(json!({ "answer": answer, "calendars": calendars }))
        }
        "invite.respond" => {
            let account = req_str(p, "account")?;
            let ics = req_str(p, "ics")?;
            let response = calendar::Response::parse(&req_str(p, "response")?).context("unknown answer")?;
            let me = calendar::Participant {
                name: req_str(p, "me_name").unwrap_or_default(),
                addr: req_str(p, "me_addr")?.to_ascii_lowercase(),
                response: String::new(),
            };
            let target = req_str(p, "calendar").unwrap_or_default();
            let invitation = calendar::itip::parse(&ics).context("this is not an invitation")?;
            let kept = calendar::itip::answer_of(&engine.db.lock().unwrap(), &account, &invitation.uid)?;
            if calendar::itip::is_outdated(&invitation, kept.as_ref().map(|answer| answer.sequence)) {
                anyhow::bail!("a newer version of this invitation was already answered; nothing was sent");
            }
            let now = now_seconds();
            let reply = calendar::itip::reply(&invitation, &me, response, now)?;
            if !target.is_empty() {
                if response == calendar::Response::Decline {
                    remove_invitation(&engine, &out, &account, &invitation.uid, Some(&target)).await?;
                } else {
                    keep_invitation(&engine, &out, &account, &target, &invitation, &me.addr, response).await?;
                }
            }
            calendar::itip::record(
                &engine.db.lock().unwrap(),
                &account,
                &invitation.uid,
                &calendar::itip::Answer {
                    sequence: invitation.sequence,
                    response: format!("{response:?}").to_ascii_lowercase(),
                    calendar_id: target,
                    answered_at: now,
                },
            )?;
            let organizer = invitation.organizer.clone().context("this invitation names no organizer to answer")?;
            let verb = match response {
                calendar::Response::Accept => "Accepted",
                calendar::Response::Tentative => "Tentative",
                calendar::Response::Decline => "Declined",
            };
            Ok(json!({ "reply": {
                "to": organizer.addr,
                "subject": format!("{verb}: {}", invitation.summary),
                "ics": reply,
            }}))
        }
        "invite.cancel" => {
            let account = req_str(p, "account")?;
            let ics = req_str(p, "ics")?;
            let invitation = calendar::itip::parse(&ics).context("this is not an invitation")?;
            if invitation.method != "CANCEL" {
                anyhow::bail!("only a cancellation removes an event");
            }
            let removed = remove_invitation(&engine, &out, &account, &invitation.uid, None).await?;
            calendar::itip::record(
                &engine.db.lock().unwrap(),
                &account,
                &invitation.uid,
                &calendar::itip::Answer {
                    sequence: invitation.sequence,
                    response: "cancelled".into(),
                    calendar_id: String::new(),
                    answered_at: now_seconds(),
                },
            )?;
            Ok(json!({ "removed": removed }))
        }
        // Proposing another time, and the organizer's side of it (RFC 5546
        // §3.2.7–3.2.8, ADR-0043). Like answers, each builds what is to be
        // sent and the frontend sends it as an ordinary message; nothing
        // goes out unless a button was pressed.
        "invite.counter" => {
            let account = req_str(p, "account")?;
            let ics = req_str(p, "ics")?;
            let me = calendar::Participant {
                name: req_str(p, "me_name").unwrap_or_default(),
                addr: req_str(p, "me_addr")?.to_ascii_lowercase(),
                response: String::new(),
            };
            let start = req_i64(p, "start")?;
            let end = req_i64(p, "end")?;
            let comment = req_str(p, "comment").unwrap_or_default();
            let invitation = calendar::itip::parse(&ics).context("this is not an invitation")?;
            let kept = calendar::itip::answer_of(&engine.db.lock().unwrap(), &account, &invitation.uid)?;
            if calendar::itip::is_outdated(&invitation, kept.as_ref().map(|answer| answer.sequence)) {
                anyhow::bail!("a newer version of this invitation was already answered; nothing was sent");
            }
            if kept.as_ref().is_some_and(|answer| answer.response == "cancelled" && answer.sequence >= invitation.sequence) {
                anyhow::bail!("this meeting was cancelled; there is no time to propose");
            }
            let proposal = calendar::itip::counter(&invitation, &me, start, end, &comment, now_seconds())?;
            let organizer = invitation.organizer.clone().context("this invitation names no organizer to propose to")?;
            Ok(json!({ "proposal": {
                "to": organizer.addr,
                "subject": format!("New time proposed: {}", invitation.summary),
                "ics": proposal,
            }}))
        }
        "invite.counterStatus" => {
            let account = req_str(p, "account")?;
            let me = req_str(p, "me_addr")?.to_ascii_lowercase();
            let ics = req_str(p, "ics")?;
            let proposal = calendar::itip::parse(&ics).context("this is not an invitation")?;
            let standing = counter_standing(&engine, &account, &me, &proposal).await?;
            Ok(json!({
                "organizer": standing.event.is_some(),
                "event": standing.event,
                "sequence": standing.sequence,
                "outdated": standing.outdated,
            }))
        }
        "invite.declineCounter" => {
            let account = req_str(p, "account")?;
            let ics = req_str(p, "ics")?;
            let me = calendar::Participant {
                name: req_str(p, "me_name").unwrap_or_default(),
                addr: req_str(p, "me_addr")?.to_ascii_lowercase(),
                response: String::new(),
            };
            let comment = req_str(p, "comment").unwrap_or_default();
            let proposal = calendar::itip::parse(&ics).context("this is not an invitation")?;
            if proposal.method != "COUNTER" {
                anyhow::bail!("only a proposal of another time can be declined this way");
            }
            let standing = counter_standing(&engine, &account, &me.addr, &proposal).await?;
            if standing.event.is_none() {
                anyhow::bail!("this meeting is not one you organize in a calendar kept here; nothing was sent");
            }
            if standing.outdated {
                anyhow::bail!("the meeting has changed since this time was proposed; nothing was sent");
            }
            let refusal = calendar::itip::decline_counter(&proposal, &me, &comment, now_seconds())?;
            let proposer = proposal.attendees.first().context("this proposal names nobody who proposed it")?;
            Ok(json!({ "reply": {
                "to": proposer.addr,
                "subject": format!("Proposed time declined: {}", proposal.summary),
                "ics": refusal,
            }}))
        }
        // The organizer of a meeting in a local or CalDAV calendar telling
        // the people on it, after the person confirmed who (2026-10-12).
        // Like answers, the core builds what is to be sent and the frontend
        // sends it as an ordinary message. Built from the event as stored:
        // after a save, its new version; before a delete, the one going.
        // Google and Exchange tell people themselves and are refused here.
        "invite.notify" => {
            let account = req_str(p, "account")?;
            let calendar_id = req_str(p, "calendar")?;
            let event_id = req_str(p, "event")?;
            let notice = calendar::itip::Notice::parse(&req_str(p, "method")?).context("unknown method")?;
            let me = calendar::Participant {
                name: req_str(p, "me_name").unwrap_or_default(),
                addr: req_str(p, "me_addr")?.trim().to_ascii_lowercase(),
                response: String::new(),
            };
            let whole_series = p.get("scope").and_then(Value::as_str).is_some_and(|scope| scope == "series");
            let now = now_seconds();
            let built = if local_calendar_write(&engine, &account, &calendar_id)?.is_some() {
                let event = calendar::event_of(&engine.db.lock().unwrap(), &account, &calendar_id, &event_id)?
                    .context("this event is no longer in the calendar")?;
                let object = calendar::itip::local_object(&event, calendar::local_sequence(&event), now);
                let (_, occurrence) = calendar::itip::local_uid(&event);
                calendar::itip::organizer_notice(&object, notice, occurrence, &me, now)?
            } else if let Some((target, transport)) = caldav_write(&engine, &account, &calendar_id)? {
                let uid = calendar::caldav::uid_of(&event_id);
                let located = calendar::caldav::locate(&engine.db.lock().unwrap(), &account, &target.id, &uid)?
                    .context("this event's place on the server is not known yet; refresh the calendar and try again")?;
                let url = target.id.clone();
                let object = tokio::task::spawn_blocking(move || calendar::caldav::get_object(&transport, &url, &located.href))
                    .await??
                    .context("this event is no longer on the server")?
                    .0;
                let occurrence = if whole_series {
                    None
                } else {
                    calendar::ics::occurrence_of(&event_id).map(|(_, at)| at)
                };
                calendar::itip::organizer_notice(&object, notice, occurrence, &me, now)?
            } else {
                anyhow::bail!("this calendar's own server tells the people on its events; nothing is sent from here");
            };
            // Only the people the person was shown: anyone else on the stored
            // event (a copy changed elsewhere since it was opened) would be
            // mailed without having been named, so nothing is built.
            if let Some(shown) = p.get("people").and_then(Value::as_array) {
                let shown: Vec<String> =
                    shown.iter().filter_map(Value::as_str).map(|addr| addr.trim().to_ascii_lowercase()).collect();
                let unseen: Vec<&str> = built.to.iter().filter(|addr| !shown.contains(addr)).map(String::as_str).collect();
                if !unseen.is_empty() {
                    anyhow::bail!(
                        "the event also names {}, who was not shown; nothing was sent. Refresh the calendar and try again",
                        unseen.join(", ")
                    );
                }
            }
            let subject = match (notice, built.sequence) {
                (calendar::itip::Notice::Cancel, _) => format!("Cancelled: {}", built.summary),
                (calendar::itip::Notice::Request, 0) => format!("Invitation: {}", built.summary),
                (calendar::itip::Notice::Request, _) => format!("Updated invitation: {}", built.summary),
            };
            Ok(json!({ "notice": {
                "method": built.method,
                "to": built.to,
                "subject": subject,
                "sequence": built.sequence,
                "ics": built.ics,
            }}))
        }
        // Which of the person's own events a time overlaps (ADR-0043): read
        // from the events kept here, every account unless one is named. No
        // server is asked.
        "calendar.conflicts" => {
            let start = req_i64(p, "start")?;
            let end = req_i64(p, "end")?;
            let all_day = p.get("all_day").and_then(Value::as_bool).unwrap_or(false);
            let offset = p.get("offset").and_then(Value::as_i64).unwrap_or(0);
            let account = p.get("account").and_then(Value::as_str).filter(|a| !a.is_empty()).map(str::to_string);
            let exclude: Vec<String> = p
                .get("exclude")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect())
                .unwrap_or_default();
            let found = calendar::overlap::overlapping(
                &engine.db.lock().unwrap(),
                account.as_deref(),
                start,
                end,
                all_day,
                offset,
                &exclude,
            )?;
            Ok(json!({ "conflicts": found }))
        }

        // A .ics file into a local or CalDAV calendar (#101): previewed first
        // (`confirm` false), and never added twice.
        "calendar.importIcs" => {
            let account = req_str(p, "account")?;
            let calendar_id = req_str(p, "calendar")?;
            let path = req_str(p, "path")?;
            let confirm = p.get("confirm").and_then(Value::as_bool).unwrap_or(false);
            let size = std::fs::metadata(&path).with_context(|| format!("open {path}"))?.len();
            if size as usize > calendar::import::MAX_FILE_BYTES {
                anyhow::bail!("this file is larger than a calendar file may be (20 MB)");
            }
            let text = String::from_utf8_lossy(&std::fs::read(&path)?).into_owned();
            let items = calendar::import::split(&text)?;
            let target = calendar::calendar_of(&engine.db.lock().unwrap(), &account, &calendar_id)?
                .context("that calendar is no longer here")?;
            let mut summary = calendar::import::Summary::default();
            match target.kind {
                calendar::CalendarKind::Local => {
                    let now = now_seconds();
                    let db = engine.db.lock().unwrap();
                    for item in &items {
                        let (events, skipped) = match calendar::import::local_events(item, &calendar_id, now) {
                            Ok(found) => found,
                            Err(_) => {
                                summary.skipped += 1;
                                continue;
                            }
                        };
                        summary.skipped += skipped;
                        let fresh: Vec<&calendar::Event> = events
                            .iter()
                            .filter(|event| {
                                !db.prepare("SELECT 1 FROM calendar_events WHERE account = ?1 AND calendar_id = ?2 AND event_id = ?3")
                                    .and_then(|mut stmt| stmt.exists(rusqlite::params![account, calendar_id, event.id]))
                                    .unwrap_or(false)
                            })
                            .collect();
                        if fresh.is_empty() {
                            if !events.is_empty() {
                                summary.duplicates += 1;
                            }
                            continue;
                        }
                        summary.added += 1;
                        summary.series += item.repeats as usize;
                        if confirm {
                            for event in fresh {
                                calendar::put_local_event(&db, &account, event)?;
                            }
                        }
                    }
                }
                calendar::CalendarKind::CalDav => {
                    let (target, transport) = caldav_write(&engine, &account, &calendar_id)?
                        .context("that calendar is no longer here")?;
                    let known: Vec<bool> = {
                        let db = engine.db.lock().unwrap();
                        items
                            .iter()
                            .map(|item| calendar::caldav::locate(&db, &account, &target.id, &item.uid).map(|l| l.is_some()))
                            .collect::<anyhow::Result<_>>()?
                    };
                    let url = target.id.clone();
                    let plan: Vec<(calendar::import::Item, bool)> = items.into_iter().zip(known).collect();
                    let (result, located) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                        let mut summary = calendar::import::Summary::default();
                        let mut located = Vec::new();
                        for (item, known) in plan {
                            if known {
                                summary.duplicates += 1;
                                continue;
                            }
                            if !confirm {
                                summary.added += 1;
                                summary.series += item.repeats as usize;
                                continue;
                            }
                            let href = calendar::caldav::new_href(&url, &item.uid)?;
                            match calendar::caldav::put_object(&transport, &url, &href, &item.object, None)? {
                                meron_core::carddav::client::Written::Saved { etag } => {
                                    summary.added += 1;
                                    summary.series += item.repeats as usize;
                                    located.push(calendar::caldav::Located { uid: item.uid, href, etag: etag.unwrap_or_default() });
                                }
                                // Something already lives at that address: the
                                // same event, imported before.
                                meron_core::carddav::client::Written::Conflict => summary.duplicates += 1,
                            }
                        }
                        Ok((summary, located))
                    })
                    .await??;
                    summary = result;
                    if confirm {
                        calendar::caldav::remember(&engine.db.lock().unwrap(), &account, &target.id, &located)?;
                        let now = now_seconds();
                        spawn_calendar_sync(engine.clone(), out.clone(), account.clone(), now - 86_400 * 31, now + 86_400 * 366);
                    }
                }
                _ => anyhow::bail!("{} cannot take imported events; choose a local or CalDAV calendar", target.name),
            }
            Ok(json!({ "summary": summary, "imported": confirm }))
        }

        // A calendar's events, as the calendar holds them here, to a .ics
        // file. Written beside the target and renamed when complete.
        "calendar.exportIcs" => {
            let account = req_str(p, "account")?;
            let calendar_id = req_str(p, "calendar")?;
            let path = req_str(p, "path")?;
            let events = calendar::events_of_calendar(&engine.db.lock().unwrap(), &account, &calendar_id)?;
            let body = calendar::ics::export(&events, now_seconds());
            let partial = format!("{path}.part");
            std::fs::write(&partial, body.as_bytes()).with_context(|| format!("write {path}"))?;
            std::fs::rename(&partial, &path).with_context(|| format!("finish {path}"))?;
            Ok(json!({ "saved": true, "events": events.len() }))
        }

        // CalDAV (#101, ADR-0018): find the calendars on a server, then keep
        // the ones chosen under an account.
        "caldav.discover" => {
            let server = req_str(p, "server")?;
            let transport = meron_core::carddav::http::UreqTransport {
                username: req_str(p, "username").unwrap_or_default(),
                password: req_str(p, "password").unwrap_or_default(),
                proxy: lookup_route(&engine, p)?,
            };
            let found = tokio::task::spawn_blocking(move || calendar::caldav::discover(&transport, &server)).await??;
            Ok(json!({ "calendars": found }))
        }
        "caldav.add" => {
            let account = req_str(p, "account")?;
            let username = req_str(p, "username").unwrap_or_default();
            let password = req_str(p, "password").unwrap_or_default();
            let chosen: Vec<calendar::caldav::RemoteCalendar> = p
                .get("calendars")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|item| {
                            Some(calendar::caldav::RemoteCalendar {
                                url: item.get("url")?.as_str()?.to_string(),
                                name: item.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                                color: item.get("color").and_then(Value::as_str).map(str::to_string),
                                writable: item.get("writable").and_then(Value::as_bool),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if chosen.is_empty() {
                anyhow::bail!("choose at least one calendar");
            }
            for remote in &chosen {
                meron_core::secrets::store(
                    &calendar::caldav::secret_key(&account, &remote.url),
                    &meron_core::secrets::Secrets { password: password.clone(), ..Default::default() },
                )?;
            }
            let ids = calendar::caldav::add_calendars(&engine.db.lock().unwrap(), &account, &chosen, &username)?;
            Ok(json!({ "ids": ids }))
        }

        // Answering a meeting invitation. Unlike every other calendar write,
        // this one deliberately reaches people: an answer nobody receives is
        // not an answer.
        "calendar.respond" => {
            let account = req_str(p, "account")?;
            let calendar_id = p.get("calendar").and_then(Value::as_str).unwrap_or_default();
            let event_id = req_str(p, "event")?;
            let change_key = p.get("change_key").and_then(Value::as_str).filter(|k| !k.is_empty());
            let answer = calendar::Response::parse(&req_str(p, "response")?)
                .context("response must be accept, tentative or decline")?;
            calendar::route::respond(
                &engine,
                &account,
                calendar_id,
                &event_id,
                change_key,
                answer,
            )
            .await?;
            // The answer changes what the server holds; re-read the hours it
            // occupies so the agenda shows the new state.
            let event_start = p.get("start").and_then(Value::as_i64).unwrap_or_default();
            let event_end = p.get("end").and_then(Value::as_i64).unwrap_or(event_start + 1);
            if event_end > event_start {
                spawn_calendar_sync(engine.clone(), out.clone(), account, event_start, event_end);
            }
            Ok(json!({ "ok": true }))
        }

        // People matching a name or partial address, for choosing who to
        // invite. Exchange answers from its directory.
        "calendar.resolveNames" => {
            let account = req_str(p, "account")?;
            let query = req_str(p, "query")?;
            if query.trim().len() < 2 {
                // Two letters is where a directory search starts being a
                // search rather than a dump of the organisation.
                return Ok(json!({ "people": [] }));
            }
            let people = calendar::route::resolve_names(&engine, &account, query.trim()).await?;
            Ok(json!({ "people": serde_json::to_value(people)? }))
        }

        // What a cached occurrence cannot carry: who is on the event and its
        // notes. Exchange's window query returns neither, so they are fetched
        // when a reader opens one.
        "calendar.eventDetails" => pim::calendar::event_details(engine, p).await,

        // The rule behind a series, asked for when a reader opens a repeating
        // event: the store keeps occurrences, never rules.
        "calendar.seriesRule" => {
            let account = req_str(p, "account")?;
            let calendar_id = p.get("calendar").and_then(Value::as_str).unwrap_or_default();
            let event_id = req_str(p, "event")?;
            let change_key = p.get("change_key").and_then(Value::as_str).filter(|k| !k.is_empty());
            let series_id = p.get("series").and_then(Value::as_str).filter(|s| !s.is_empty());
            let rule = calendar::route::series_rule(
                &engine,
                &account,
                calendar_id,
                &event_id,
                change_key,
                series_id,
            )
            .await?;
            Ok(json!({ "recurrence": rule }))
        }

        "calendar.createCalendar" => {
            let account = req_str(p, "account")?;
            let name = req_str(p, "name")?;
            if name.trim().is_empty() {
                anyhow::bail!("a calendar needs a name");
            }
            let id = calendar::route::create_calendar(&engine, &account, &name).await?;
            // Re-list so the new calendar is known with whatever the server
            // decided to call it and where it put it.
            let calendars = calendar::route::list_calendars(&engine, &account).await?;
            calendar::replace_account_calendars(&engine.db.lock().unwrap(), &account, &calendars)?;
            Ok(json!({ "id": id }))
        }

        "calendar.renameCalendar" => {
            let account = req_str(p, "account")?;
            let id = req_str(p, "calendar")?;
            let name = req_str(p, "name")?;
            if name.trim().is_empty() {
                anyhow::bail!("a calendar needs a name");
            }
            calendar::route::rename_calendar(&engine, &account, &id, &name).await?;
            calendar::rename_calendar(&engine.db.lock().unwrap(), &account, &id, &name)?;
            Ok(json!({ "ok": true }))
        }

        "calendar.deleteCalendar" => {
            let account = req_str(p, "account")?;
            let id = req_str(p, "calendar")?;
            // Whether this account owns the calendar decides what removing it
            // can mean: a calendar of one's own is deleted, one merely shared
            // with this account is unsubscribed from, since deleting someone
            // else's calendar is not this account's to do.
            let owned = {
                let db = engine.db.lock().unwrap();
                calendar::get_calendars(&db, &account)?
                    .into_iter()
                    .find(|calendar| calendar.id == id)
                    .is_some_and(|calendar| !calendar.read_only)
            };
            let is_caldav = calendar::calendar_of(&engine.db.lock().unwrap(), &account, &id)?
                .is_some_and(|found| found.kind == calendar::CalendarKind::CalDav);
            if is_caldav {
                // Removing a CalDAV calendar here stops showing it; the
                // collection stays on its server, where it belongs.
                let _ = meron_core::secrets::delete(&calendar::caldav::secret_key(&account, &id));
            } else {
                calendar::route::delete_calendar(&engine, &account, &id, owned).await?;
            }
            // Its events go with it: they lived on the calendar the server
            // just removed.
            calendar::forget_calendar(&engine.db.lock().unwrap(), &account, &id)?;
            Ok(json!({ "ok": true }))
        }

        "calendar.setColor" => {
            let account = req_str(p, "account")?;
            let id = req_str(p, "calendar")?;
            let color = p.get("color").and_then(Value::as_str).filter(|c| !c.is_empty());
            calendar::set_calendar_color(&engine.db.lock().unwrap(), &account, &id, color)?;
            Ok(json!({ "ok": true }))
        }

        "calendar.create" => pim::calendar::create(engine, &emitter(out), p).await,

        "calendar.update" => pim::calendar::update(engine, &emitter(out), p).await,

        "calendar.delete" => pim::calendar::delete(engine, &emitter(out), p).await,

        "folders.list" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                let folders = rss::folders(&engine.db.lock().unwrap(), &account)?;
                return Ok(json!({ "folders": folders }));
            }
            let mut folders = serde_json::to_value(store::get_folders(&engine.db.lock().unwrap(), &account)?)?;
            meron_core::graph::mail::decorate_folders(&engine.db.lock().unwrap(),&account,&mut folders)?;
            // Renames a folder listing made (ADR-0058), for the interface to
            // carry favorites, colors, board columns and searches across.
            let renames = meron_core::folder_move::take_renames(&engine.db.lock().unwrap(), &account)?;
            if p.get("refresh").and_then(Value::as_bool).unwrap_or(true) {
                spawn_folder_sync(engine.clone(), out.clone(), account);
            }
            if renames.is_empty() {
                return Ok(json!({ "folders": folders }));
            }
            Ok(json!({
                "folders": folders,
                "renames": renames.iter().map(|(from, to)| json!({ "from": from, "to": to })).collect::<Vec<_>>(),
            }))
        }

        "folders.create" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                return Err(anyhow::anyhow!("RSS accounts do not support folders"));
            }
            let display_name = req_str(p, "name")?.trim().to_string();
            if display_name.is_empty() {
                return Err(anyhow::anyhow!("Folder name is required"));
            }
            // The user types UTF-8; servers without UTF8=ACCEPT want modified
            // UTF-7, and the wire form is what we store and address it by.
            let name = meron_core::utf7::encode(&display_name);

            engine
                .with_write_session(&account, |session| {
                    let name = name.clone();
                    Box::pin(async move { session.create_folder(&name).await })
                })
                .await?;

            let folder = {
                let db = engine.db.lock().unwrap();
                let folder = imap::Folder {
                    name,
                    display_name,
                    delimiter: store::account_delimiter(&db, &account)?,
                    ..Default::default()
                };
                store::upsert_folders(&db, &account, std::slice::from_ref(&folder))?;
                folder
            };
            Ok(json!({ "folders": serde_json::to_value(vec![folder])? }))
        }

        // Delete a folder and everything nested under it on the server, then
        // forget the whole subtree's cache. Unrecoverable, so the special-use
        // gate is re-checked here rather than trusted from the caller.
        "folders.delete" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                return Err(anyhow::anyhow!("RSS accounts do not support folders"));
            }
            let folder = canon_folder(&req_str(p, "folder").or_else(|_| req_str(p, "name"))?);
            let targets = {
                let db = engine.db.lock().unwrap();
                mail_model::check_folder_deletable(&db, &account, &folder)
                    .map_err(anyhow::Error::msg)?;
                mail_model::folder_delete_targets(&db, &account, &folder)
                    .map_err(anyhow::Error::msg)?
            };

            // EXAMINE is a read-only preflight and may retry on a stale pooled
            // socket. DELETE itself starts only after that succeeds and is
            // never retried.
            let server_result = engine
                .with_preflighted_write_session(
                    &account,
                    |session| Box::pin(session.prepare_folder_delete()),
                    |session| {
                        let targets = targets.clone();
                        Box::pin(async move { session.delete_folders(&targets).await })
                    },
                )
                .await;
            let (removed, warning) = match server_result {
                Ok(removed) => (removed, None),
                Err(err) => match err.downcast::<imap::PartialFolderDelete>() {
                    Ok(partial) => {
                        let (removed, warning) = partial.into_parts();
                        (removed, Some(warning))
                    }
                    Err(err) => return Err(err),
                },
            };

            let (deleted, folders) = {
                let db = engine.db.lock().unwrap();
                let mut deleted = 0;
                for target in &removed {
                    deleted += store::delete_folder(&db, &account, target)?;
                }
                (deleted, store::get_folders(&db, &account)?)
            };
            Ok(json!({
                "ok": warning.is_none(),
                "folder": folder,
                // Every folder that went with it, so the caller can clear the
                // views and caches keyed on a nested folder as well.
                "removed": removed,
                "deleted": deleted,
                "folders": serde_json::to_value(folders)?,
                "warning": warning,
            }))
        }

        // Move a folder under another one of the same account (ADR-0050).
        "folders.move" => {
            if is_rss(engine, &req_str(p, "account")?)? {
                return Err(anyhow::anyhow!("RSS accounts do not support folders"));
            }
            meron_core::folder_move::move_folder(engine, p).await
        }

        "messages.unifiedRecent" => {
            let request = thread_list::ThreadListQuery::from_params(p, "folder");
            let before = p.get("before_cursor").and_then(Value::as_str).filter(|value| !value.is_empty());
            let role = req_str(p, "folder_role").unwrap_or_else(|_| "inbox".to_string()).to_ascii_lowercase();
            if cached_conversations::recent_filter(&request).is_some() {
                let scopes = cached_conversations::unified_mail_scopes(&engine.db.lock().unwrap(), &role)?;
                if let Some(scopes) = scopes {
                    for scope in &scopes {
                        prepare_recent_cache(engine, &scope.account, &scope.folder, &request).await;
                    }
                    let page = cached_conversations::page(
                        &engine.db.lock().unwrap(), scopes.clone(), &format!("recent:unified:{role}"), &request, before,
                    )?.into_response(true);
                    if cached_conversations::should_sync(before, p.get("refresh").and_then(Value::as_bool).unwrap_or(true)) {
                        for scope in scopes {
                            spawn_message_sync(engine.clone(), out.clone(), scope.account, scope.folder, request.limit);
                        }
                    }
                    return Ok(page);
                }
            }
            cached_conversations::reject_conversation_cursor(before)?;
            let cursors = p
                .get("before_cursor")
                .and_then(Value::as_str)
                .and_then(unified::decode_cursor)
                .unwrap_or_default();
            let accounts = store::list_accounts(&engine.db.lock().unwrap())?
                .into_iter()
                .filter(|account| {
                    account
                        .get("included_in_unified")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                })
                .filter_map(|account| {
                    account
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|account| cursors.is_empty() || cursors.contains_key(account))
                .collect::<Vec<_>>();
            // The unified view switches folders by *role*: each account answers
            // from its own Sent/Archive/Trash/…, and an account whose server has
            // no such mailbox drops out of the merge silently. Surfacing that as
            // a failure would pin a permanent error banner on the view for any
            // account whose provider simply lacks the folder.
            let role = req_str(p, "folder_role").unwrap_or_else(|_| "inbox".to_string());
            let mut folders = Vec::with_capacity(accounts.len());
            {
                let db = engine.db.lock().unwrap();
                for account in accounts {
                    if let Some(folder) = store::folder_for_role(&db, &account, &role)? {
                        folders.push((account, folder));
                    }
                }
            }
            let mut pages = Vec::with_capacity(folders.len());
            for (account, folder) in folders {
                let mut params = json!({
                    "account": account.clone(),
                    "folder": folder,
                    "query": req_str(p, "query").unwrap_or_default(),
                    "filter": req_str(p, "filter").unwrap_or_default(),
                    "limit": req_u16(p, "limit").unwrap_or(50),
                    "refresh": p.get("refresh").and_then(Value::as_bool).unwrap_or(true),
                    "group": true,
                    // Mixed RSS/mail remains on its existing per-account
                    // message cursor contract until that source is migrated.
                    "conversation_paging": false,
                });
                if let Some(cursor) = cursors.get(&account) {
                    params["before_cursor"] = Value::String(cursor.clone());
                }
                let request = Request {
                    id: req.id,
                    method: "messages.recent".to_string(),
                    params,
                };
                let result = Box::pin(dispatch(engine, &request, out))
                    .await
                    .map_err(|err| format!("{err:#}"));
                pages.push((account, result));
            }
            Ok(unified::merge_pages(pages, "threads"))
        }

        // RSS returns final thread Message JSON under "threads"; mail returns raw
        // rows under "messages" the bridge groups into threads.
        "messages.recent" => {
            let account = req_str(p, "account")?;
            let request = thread_list::ThreadListQuery::from_params(p, "folder");
            let before = p.get("before_cursor").and_then(Value::as_str).filter(|value| !value.is_empty());
            let refresh = p.get("refresh").and_then(Value::as_bool).unwrap_or(true);
            if is_rss(engine, &account)? {
                cached_conversations::reject_conversation_cursor(before)?;
                let page = thread_list::rss_page(&engine.db.lock().unwrap(), &account, &request)?;
                if refresh {
                    spawn_rss_sync(engine.clone(), out.clone(), account);
                }
                return Ok(page);
            }
            let folder = request.folder.clone();
            let limit = request.limit;
            // Capture this before spawning the background refresh. The returned
            // page was read from the pre-refresh cache, so its empty-state
            // metadata must describe that same snapshot.
            let folder_synced_before =
                store::get_folder_state(&engine.db.lock().unwrap(), &account, &folder)?.is_some();
            if p.get("group").and_then(Value::as_bool).unwrap_or(false)
                && p.get("conversation_paging").and_then(Value::as_bool).unwrap_or(true)
                && cached_conversations::recent_filter(&request).is_some()
            {
                prepare_recent_cache(engine, &account, &folder, &request).await;
                let mut page = cached_conversations::page(
                    &engine.db.lock().unwrap(),
                    vec![meron_core::conversation_page::Scope { account: account.clone(), folder: folder.clone() }],
                    &format!("recent:account:{account}"), &request, before,
                )?.into_response(false);
                page["folder_synced"] = json!(folder_synced_before);
                if cached_conversations::should_sync(before, refresh) {
                    spawn_message_sync(engine.clone(), out.clone(), account, folder, limit);
                }
                return Ok(page);
            }
            cached_conversations::reject_conversation_cursor(before)?;
            // Desktop starred reads are online-first. Search first paints the
            // local index with refresh=false, then repeats with refresh=true;
            // snapshot-backed later pages are local even though they travel
            // through the shared search engine.
            let (messages, next_cursor) = match request.source() {
                thread_list::MailSource::Starred => {
                    let folders = starred_search_folders(engine, &account, &folder).await;
                    (
                        search_starred_mail_messages(engine, &account, &folders, limit, refresh)
                            .await?,
                        None,
                    )
                }
                thread_list::MailSource::Snoozed => (
                    store::get_snoozed_headers(&engine.db.lock().unwrap(), &account)?,
                    None,
                ),
                thread_list::MailSource::Recent {
                    unread_only,
                    starred_only,
                    label_id,
                    with_attachments,
                    priority_only,
                    category,
                } => {
                    // Asking for what has an attachment is asking a question
                    // about every message, and some of them have never been
                    // looked at. Look now, rather than answering for them:
                    // treating "nobody asked" as "no" would hide mail that
                    // does carry a file, which is the one thing this filter
                    // must not do.
                    if with_attachments {
                        fill_in_attachment_flags(engine, &account, &folder).await;
                    }
                    // Same idea, and cheaper: a mailbox cached before this
                    // existed has messages nobody has judged, and treating
                    // those as "not worth interrupting for" would hide mail
                    // behind a filter for no stated reason. Unlike an
                    // attachment, judging one needs nothing from a server —
                    // every signal is already here — so the gap is simply
                    // closed.
                    if priority_only {
                        let db = engine.db.lock().unwrap();
                        if let Err(err) = store::rejudge_priority(&db, &account, true) {
                            eprintln!("meron-core: judging {account}: {err:#}");
                        }
                    }
                    // A category tab must not hide mail nobody has placed yet.
                    if category.is_some() {
                        let db = engine.db.lock().unwrap();
                        if let Err(err) = meron_core::categories::rejudge(&db, &account, true) {
                            eprintln!("meron-core: placing {account}: {err:#}");
                        }
                    }
                    store::get_recent_page_sorted(
                        &engine.db.lock().unwrap(),
                        &account,
                        &folder,
                        limit,
                        request.before_cursor.clone(),
                        store::RecentFilter {
                            unread_only,
                            starred_only,
                            label_id,
                            with_attachments,
                            priority_only,
                            category: category.clone(),
                        },
                        request.sort(),
                    )?
                }
                thread_list::MailSource::Search => {
                    // Chat-view search spans the selected folder plus Sent, so a
                    // lookup surfaces both received and self-sent mail (and old
                    // messages filed under Sent), not just the current mailbox.
                    let folders = search_folders(&engine.db.lock().unwrap(), &account, &folder);
                    if refresh || request.search_before_cursor.as_ref().is_some() {
                        let page = search_mail_messages(
                            engine,
                            &account,
                            &folders,
                            &request.query,
                            limit,
                            request.search_before_cursor.as_ref(),
                        )
                        .await?;
                        (page.messages, page.next_cursor)
                    } else {
                        let messages = store::search_messages_in_folders(
                            &engine.db.lock().unwrap(),
                            &account,
                            &folders,
                            &request.query,
                            limit,
                            None,
                        )?;
                        let next_cursor = store::search_next_cursor(&messages, limit, 0);
                        (messages, next_cursor)
                    }
                }
            };
            if refresh && request.wants_background_sync() {
                spawn_message_sync(
                    engine.clone(),
                    out.clone(),
                    account.clone(),
                    folder.clone(),
                    limit,
                );
            }
            let mut page = thread_list::mail_page(
                &engine.db.lock().unwrap(),
                &account,
                &folder,
                messages,
                next_cursor,
                p.get("group").and_then(Value::as_bool).unwrap_or(false),
                // Except in the view whose whole purpose is to show them.
                !matches!(request.source(), thread_list::MailSource::Snoozed),
            )?;
            page.as_object_mut().unwrap().insert(
                "folder_synced".to_string(),
                Value::Bool(folder_synced_before),
            );
            // How the search box was read, sent back with the answer rather
            // than worked out again in the interface. A second parser is a
            // second reading, and the one thing a reader must be able to trust
            // is that what they are shown is what was searched for.
            if !request.query.trim().is_empty() {
                let parsed = search::parse(&request.query);
                page.as_object_mut().unwrap().insert(
                    "search".to_string(),
                    json!({
                        "text": parsed.text,
                        "parts": search::describe(&parsed),
                        "hasOperators": search::describe(&parsed)
                            .iter()
                            .any(|part| !part.starts_with("text:")),
                    }),
                );
            }
            Ok(page)
        }

        // Every starred item across all accounts, local cache only (the
        // IMAP-backed starred filter keeps mail flags fresh; no round-trip
        // here). Core returns one final, searchable, paginated item model for
        // both mail and RSS so transport adapters do not mint ids or reshape it.
        "starred.items" => {
            let limit = req_u32(p, "limit").unwrap_or(200);
            let db = engine.db.lock().unwrap();
            let mut items = mail_model::starred_thread_cards(&db, 2_000)?;
            items.extend(rss::starred_items(&db, 2_000)?);
            Ok(mail_model::starred_page(
                items,
                &req_str(p, "query").unwrap_or_default(),
                &req_str(p, "filter").unwrap_or_else(|_| "all".to_string()),
                limit as usize,
                p.get("before_cursor").and_then(Value::as_str),
            ))
        }

        "identity.allocate" => Ok(json!({
            "message_id": mail_model::allocate_message_id(
                &req_str(p, "account_id").unwrap_or_default(),
                p.get("draft").and_then(Value::as_bool).unwrap_or(false),
            )
        })),

        // Recipient autocomplete: distinct correspondents from cached messages,
        // matched against `query` and ranked by frequency/recency.
        "contacts.suggest" => {
            let account = req_str(p, "account").unwrap_or_default();
            let query = req_str(p, "query").unwrap_or_default();
            let limit = req_u32(p, "limit").unwrap_or(8);
            let contacts =
                store::suggest_contacts(&engine.db.lock().unwrap(), &account, &query, limit)?;
            Ok(json!({ "contacts": contacts }))
        }

        // Fire-and-forget background sync; the result arrives via mail.synced.
        "messages.sync" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                spawn_rss_sync(engine.clone(), out.clone(), account);
                return Ok(json!({ "ok": true, "queued": true }));
            }
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let limit = req_u16(p, "limit").unwrap_or(50) as u32;
            spawn_message_sync(engine.clone(), out.clone(), account, folder, limit);
            Ok(json!({ "ok": true, "queued": true }))
        }

        "send" => perform_send(engine, p).await,

        "save_draft" => {
            let account = req_str(p, "account")?;
            let to = req_str(p, "to").unwrap_or_default();
            let cc = req_str(p, "cc").unwrap_or_default();
            let bcc = req_str(p, "bcc").unwrap_or_default();
            let subject = req_str(p, "subject").unwrap_or_default();
            let body = req_str(p, "body").unwrap_or_default();
            let html = req_str(p, "html").unwrap_or_default();
            let in_reply_to = req_str(p, "in_reply_to").unwrap_or_default();
            let references = req_str(p, "references").unwrap_or_default();
            let reply_to = req_str(p, "reply_to").unwrap_or_default();
            let attachments = opt_attachments(p)?;
            let requested_from = req_str(p, "from").unwrap_or_default();
            let creds = engine.ensure_valid_creds(&account).await?;
            let (from_addr, sender_name) =
                resolve_send_from(engine, &account, &creds, &requested_from)?;
            // Stable per-draft Message-ID: each autosave reuses it so the IMAP
            // layer can find and prune the prior copy instead of piling up dups.
            let draft_id = req_str(p, "draft_id").unwrap_or_default();
            let raw = smtp::build_message(
                &sender_name,
                &from_addr,
                &to,
                &cc,
                &bcc,
                true,
                &subject,
                &body,
                &html,
                &attachments,
                &in_reply_to,
                &references,
                &reply_to,
                &draft_id,
            )?;
            append_to_drafts(engine, &account, &raw, &draft_id).await?;
            Ok(json!({ "ok": true }))
        }

        "discard_draft" => {
            let account = req_str(p, "account")?;
            let draft_id = req_str(p, "draft_id").unwrap_or_default();
            if draft_id.trim().is_empty() {
                return Ok(json!({ "ok": true, "deleted": 0 }));
            }
            // The LIST that finds the folder changes nothing and is where a dead
            // pooled session gives out, so it preflights the delete that follows.
            let drafts_slot: Arc<std::sync::Mutex<Option<String>>> =
                Arc::new(std::sync::Mutex::new(None));
            let (drafts, deleted) = engine
                .with_preflighted_write_session(
                    &account,
                    |session| {
                        let slot = Arc::clone(&drafts_slot);
                        Box::pin(async move {
                            let drafts = session.find_drafts_folder()
                                .await?
                                .ok_or_else(|| anyhow::anyhow!("no Drafts folder found"))?;
                            *slot.lock().unwrap() = Some(drafts);
                            anyhow::Ok(())
                        })
                    },
                    |session| {
                        let draft_id = draft_id.clone();
                        let slot = Arc::clone(&drafts_slot);
                        Box::pin(async move {
                            let drafts = { slot.lock().unwrap().clone() }
                                .ok_or_else(|| anyhow::anyhow!("no Drafts folder found"))?;
                            let deleted = session.discard_draft(&drafts, &draft_id).await?;
                            anyhow::Ok((drafts, deleted))
                        })
                    },
                )
                .await?;
            // Drop the locally cached copies too, or the discarded draft keeps
            // showing in the thread view until the next full Drafts sync.
            store::delete_draft_copies(
                &engine.db.lock().unwrap(),
                &account,
                &drafts,
                &draft_id,
                None,
            )?;
            if let Ok(thread_key) = req_str(p, "thread_key") {
                store::delete_quick_reply_drafts_in_thread(
                    &engine.db.lock().unwrap(),
                    &account,
                    &drafts,
                    &thread_key,
                )?;
            }
            Ok(json!({ "ok": true, "deleted": deleted, "permanent": true }))
        }

        // Fetch one message's original RFC822 bytes and write them directly to
        // the path selected by the desktop save dialog. Keeping the bytes out
        // of the JSON response avoids its bounded line size; BODY.PEEK[] keeps
        // an unread message unread.
        "messages.saveRaw" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let uid = req_u32(p, "uid")?;
            let path = req_str(p, "path")?;

            let raw_messages = engine
                .with_read_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move {
                        session.fetch_raw_messages_for_copy(&folder, &[uid]).await
                    })
                })
                .await?;
            let message = raw_messages
                .into_iter()
                .next()
                .with_context(|| format!("message {uid} not found in {folder}"))?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut output = options
                .open(&path)
                .with_context(|| format!("open message export {path}"))?;
            output
                .write_all(&message.raw)
                .with_context(|| format!("write message export {path}"))?;
            Ok(json!({ "saved": true, "size": message.raw.len() }))
        }

        // A whole folder, or the chosen messages, as one mboxrd file (#112).
        // Written beside the target and renamed into place, so a failure half
        // way never leaves a truncated file under the chosen name.
        "messages.exportMbox" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let path = req_str(p, "path")?;
            let chosen: Vec<u32> = p
                .get("uids")
                .and_then(Value::as_array)
                .map(|uids| uids.iter().filter_map(|uid| uid.as_u64()).map(|uid| uid as u32).collect())
                .unwrap_or_default();
            let mut uids = if chosen.is_empty() {
                let listed = folder.clone();
                engine
                    .with_read_session(&account, |session| {
                        let folder = listed.clone();
                        Box::pin(async move { session.list_all_uids(&folder).await })
                    })
                    .await?
                    .into_iter()
                    .collect::<Vec<u32>>()
            } else {
                chosen
            };
            uids.sort_unstable();
            uids.dedup();

            let partial = format!("{path}.part");
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let written: anyhow::Result<(usize, u64)> = async {
                let file = options
                    .open(&partial)
                    .with_context(|| format!("open mailbox export {path}"))?;
                let mut output = std::io::BufWriter::new(file);
                let stamp = chrono::Utc::now().timestamp();
                let (mut exported, mut size) = (0usize, 0u64);
                for batch in uids.chunks(50) {
                    let batch = batch.to_vec();
                    let fetched = folder.clone();
                    let messages = engine
                        .with_read_session(&account, |session| {
                            let folder = fetched.clone();
                            let batch = batch.clone();
                            Box::pin(async move {
                                session.fetch_raw_messages_for_copy(&folder, &batch).await
                            })
                        })
                        .await?;
                    for message in messages {
                        meron_core::archive::write_mbox_entry(&mut output, &message.raw, stamp)
                            .with_context(|| format!("write mailbox export {path}"))?;
                        exported += 1;
                        size += message.raw.len() as u64;
                    }
                }
                output
                    .into_inner()
                    .map_err(|error| error.into_error())
                    .and_then(|file| file.sync_all())
                    .with_context(|| format!("write mailbox export {path}"))?;
                std::fs::rename(&partial, &path)
                    .with_context(|| format!("finish mailbox export {path}"))?;
                Ok((exported, size))
            }
            .await;
            match written {
                Ok((exported, size)) => Ok(json!({ "saved": true, "exported": exported, "size": size })),
                Err(error) => {
                    let _ = std::fs::remove_file(&partial);
                    Err(error)
                }
            }
        }

        "messages.read" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let uid = req_u32(p, "uid")?;

            let message = read_cached_or_fetch(engine, &account, &folder, uid).await?;
            let mine = store::self_addrs(&engine.db.lock().unwrap(), &account);
            let outgoing =
                store::is_outgoing(&mine, &folder, &message.from_addr, message.delivered);
            Ok(json!({ "outgoing": outgoing, "message": serde_json::to_value(message)? }))
        }

        "messages.thread" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            // Card ids carry a branch subject suffix; the store queries use the
            // root key and the branch filter narrows the rows afterwards.
            let (thread_key, subject_filter) = store::split_thread_key(&req_str(p, "thread_key")?);
            // Pagination is opt-in: callers that don't pass `limit` get the
            // full thread (preserves the markRead full-scan path in app.go).
            let limit = p.get("limit").and_then(Value::as_u64).map(|n| n as u32);
            let before_cursor = p.get("before_cursor").and_then(Value::as_str);
            // The bridge passes the frontend's exact thread id so message ids
            // match what the UI keys on; direct callers (tests) may omit it.
            let thread_id = req_str(p, "thread_id")
                .unwrap_or_else(|_| mail_model::format_thread_id(&account, &folder, &thread_key));

            // For UI reads (limit present), pull in any referenced ancestor
            // messages missing from the local cache so the reader shows the
            // full conversation instead of just the synced tail or a lone
            // draft. Runs in the background; if the fill finds anything it
            // emits `mail.synced` and the reader re-reads. The markRead
            // full-scan path (no limit) skips this entirely.
            if limit.is_some() {
                maybe_spawn_fill_thread_gaps(engine, out, &account, &thread_key);
            }

            // The background body fill announces itself with `mail.synced`,
            // which the desktop frontend already answers by re-reading the
            // open thread.
            let on_bodies_fetched: thread_read::BodiesFetchedHook = {
                let out = out.clone();
                let account = account.clone();
                Box::new(move || {
                    let out = out.clone();
                    let account = account.clone();
                    tokio::spawn(async move {
                        emit(
                            &out,
                            "mail.synced",
                            json!({ "account": account, "folder": "inbox", "synced": 0 }),
                        )
                        .await;
                    });
                })
            };
            thread_read::read_thread_page(
                engine,
                thread_read::ThreadReadArgs {
                    account: &account,
                    folder: &folder,
                    thread_id: &thread_id,
                    thread_key: &thread_key,
                    subject_filter: subject_filter.as_deref(),
                    limit,
                    before_cursor,
                    media_root: parse::media_root(),
                    bake_html_policy: true,
                },
                Some(on_bodies_fetched),
            )
            .await
        }

        "messages.threadHeaders" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let (thread_key, subject_filter) = store::split_thread_key(&req_str(p, "thread_key")?);
            let headers = {
                let db = engine.db.lock().unwrap();
                store::get_thread_headers(&db, &account, &folder, &thread_key)?
            };
            let headers = headers
                .into_iter()
                .filter(|header| match subject_filter.as_deref() {
                    Some(filter) => store::thread_grouping_subject(&header.subject) == filter,
                    None => true,
                })
                .map(|header| {
                    json!({
                        "uid": header.uid,
                        "folder": folder,
                        "subject": header.subject,
                        "seen": header.seen,
                        "starred": header.starred,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "headers": headers }))
        }

        "messages.markRead" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let (thread_key, subject_filter) =
                store::split_thread_key(&req_str(p, "thread_key").unwrap_or_default());
            let uid = p.get("uid").and_then(Value::as_u64).map(|n| n as u32);
            // Defaults to true (mark read); pass seen:false to mark unread.
            let seen = p.get("seen").and_then(Value::as_bool).unwrap_or(true);

            let explicit_uids = p
                .get("uids")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|n| n as u32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let uids = if !explicit_uids.is_empty() {
                explicit_uids
            } else if thread_key.is_empty() {
                uid.into_iter().collect::<Vec<_>>()
            } else if !seen {
                // Marking a whole thread unread flags its newest message only.
                let db = engine.db.lock().unwrap();
                store::newest_thread_uids(
                    &db,
                    &account,
                    &folder,
                    &thread_key,
                    subject_filter.as_deref(),
                )?
            } else {
                // Only touch the thread's messages whose flag actually differs.
                let db = engine.db.lock().unwrap();
                store::get_thread_headers(&db, &account, &folder, &thread_key)?
                    .into_iter()
                    .filter(|header| header.seen != seen)
                    .filter(|header| match subject_filter.as_deref() {
                        Some(filter) => store::thread_grouping_subject(&header.subject) == filter,
                        None => true,
                    })
                    .map(|header| header.uid)
                    .collect::<Vec<_>>()
            };

            if !uids.is_empty() {
                engine
                    .with_preflighted_write_session(
                        &account,
                        |session| {
                            let folder = folder.clone();
                            Box::pin(
                                async move { session.prepare_flag_update(&folder).await },
                            )
                        },
                        |session| {
                            let uids = uids.clone();
                            Box::pin(async move { session.store_seen(&uids, seen).await })
                        },
                    )
                    .await?;
            }

            {
                let db = engine.db.lock().unwrap();
                if thread_key.is_empty() || subject_filter.is_some() || !seen {
                    // Branch-scoped: a whole-thread update would flip sibling
                    // subject branches sharing the root thread_key. Marking
                    // unread is per-uid for the same reason — only the newest
                    // message was flagged.
                    for marked_uid in &uids {
                        store::update_message_seen(&db, &account, &folder, *marked_uid, seen)?;
                    }
                } else {
                    store::update_thread_seen(&db, &account, &folder, &thread_key, seen)?;
                }
            }
            let changed_thread_id = if thread_key.is_empty() {
                uid.map(|uid| format!("{account}#{folder}#{uid}"))
                    .unwrap_or_default()
            } else {
                let key = subject_filter
                    .as_deref()
                    .map(|subject| store::branch_compound_key(&thread_key, subject))
                    .unwrap_or_else(|| thread_key.clone());
                mail_model::format_thread_id(&account, &folder, &key)
            };
            mail_model::mutation_result(
                json!({ "ok": true }),
                &engine.db.lock().unwrap(),
                &account,
                &changed_thread_id,
                &folder,
                None,
                Some(!seen),
                None,
                false,
            )
        }

        "messages.markStarred" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let (thread_key, subject_filter) =
                store::split_thread_key(&req_str(p, "thread_key").unwrap_or_default());
            let uid = p.get("uid").and_then(Value::as_u64).map(|n| n as u32);
            // Defaults to true (mark starred); pass starred:false to unstar.
            let starred = p.get("starred").and_then(Value::as_bool).unwrap_or(true);

            let explicit_uids = p
                .get("uids")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|n| n as u32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let uids = if !explicit_uids.is_empty() {
                explicit_uids
            } else if thread_key.is_empty() {
                uid.into_iter().collect::<Vec<_>>()
            } else {
                // Only touch the thread's messages whose flag actually differs.
                let db = engine.db.lock().unwrap();
                store::get_thread_headers(&db, &account, &folder, &thread_key)?
                    .into_iter()
                    .filter(|header| header.starred != starred)
                    .filter(|header| match subject_filter.as_deref() {
                        Some(filter) => store::thread_grouping_subject(&header.subject) == filter,
                        None => true,
                    })
                    .map(|header| header.uid)
                    .collect::<Vec<_>>()
            };

            if !uids.is_empty() {
                engine
                    .with_preflighted_write_session(
                        &account,
                        |session| {
                            let folder = folder.clone();
                            Box::pin(
                                async move { session.prepare_flag_update(&folder).await },
                            )
                        },
                        |session| {
                            let uids = uids.clone();
                            Box::pin(
                                async move { session.store_starred(&uids, starred).await },
                            )
                        },
                    )
                    .await?;
            }

            {
                let db = engine.db.lock().unwrap();
                if thread_key.is_empty() || subject_filter.is_some() {
                    // Branch-scoped: a whole-thread update would star sibling
                    // subject branches sharing the root thread_key.
                    for marked_uid in &uids {
                        store::update_message_starred(
                            &db,
                            &account,
                            &folder,
                            *marked_uid,
                            starred,
                        )?;
                    }
                } else {
                    store::update_thread_starred(&db, &account, &folder, &thread_key, starred)?;
                }
            }
            let changed_thread_id = if thread_key.is_empty() {
                uid.map(|uid| format!("{account}#{folder}#{uid}"))
                    .unwrap_or_default()
            } else {
                let key = subject_filter
                    .as_deref()
                    .map(|subject| store::branch_compound_key(&thread_key, subject))
                    .unwrap_or_else(|| thread_key.clone());
                mail_model::format_thread_id(&account, &folder, &key)
            };
            mail_model::mutation_result(
                json!({ "ok": true }),
                &engine.db.lock().unwrap(),
                &account,
                &changed_thread_id,
                &folder,
                None,
                None,
                Some(starred),
                false,
            )
        }

        "messages.delete" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let (thread_key, subject_filter) =
                store::split_thread_key(&req_str(p, "thread_key").unwrap_or_default());
            let uid = p.get("uid").and_then(Value::as_u64).map(|n| n as u32);
            let explicit_uids = p
                .get("uids")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|n| n as u32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let changed_thread_id = if thread_key.is_empty() {
                uid.map(|uid| format!("{account}#{folder}#{uid}"))
                    .unwrap_or_default()
            } else {
                let key = subject_filter
                    .as_deref()
                    .map(|subject| store::branch_compound_key(&thread_key, subject))
                    .unwrap_or_else(|| thread_key.clone());
                mail_model::format_thread_id(&account, &folder, &key)
            };

            let uids = {
                let db = engine.db.lock().unwrap();
                store::resolve_message_uids(
                    &db,
                    &account,
                    &folder,
                    &thread_key,
                    subject_filter.as_deref(),
                    uid,
                    &explicit_uids,
                )?
            };

            if uids.is_empty() {
                return mail_model::mutation_result(
                    json!({ "ok": true, "deleted": 0 }),
                    &engine.db.lock().unwrap(),
                    &account,
                    &changed_thread_id,
                    &folder,
                    None,
                    None,
                    None,
                    false,
                );
            }

            // Mutating, so it never auto-retries.
            let trashed = delete_to_trash(engine, &account, &folder, &uids).await?;

            {
                let db = engine.db.lock().unwrap();
                // Discarding a draft must also drop hidden local copies sharing
                // its Message-ID (stale autosaves the pane deduped away), or the
                // thread card keeps its has_draft badge until the next full sync.
                if store::folder_role(&db, &account, &folder)? == "drafts" {
                    store::delete_draft_sibling_copies(&db, &account, &folder, &uids)?;
                }
                store::delete_messages_by_uid(&db, &account, &folder, &uids)?;
            }
            // The server delete/move-to-Trash completed for every resolved UID.
            // A concurrent source refresh may already have pruned the cache rows.
            let deleted = uids.len();
            let result = match trashed.as_deref() {
                None => json!({ "ok": true, "deleted": deleted, "permanent": true }),
                Some(trash) => json!({ "ok": true, "deleted": deleted, "trash": trash }),
            };
            mail_model::mutation_result(
                result,
                &engine.db.lock().unwrap(),
                &account,
                &changed_thread_id,
                &folder,
                trashed.as_deref(),
                None,
                None,
                true,
            )
        }

        "messages.move" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let target_folder = canon_folder(&req_str(p, "target_folder")?);
            let (thread_key, subject_filter) =
                store::split_thread_key(&req_str(p, "thread_key").unwrap_or_default());
            let uid = p.get("uid").and_then(Value::as_u64).map(|n| n as u32);
            let explicit_uids = p
                .get("uids")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|n| n as u32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let changed_thread_id = if thread_key.is_empty() {
                uid.map(|uid| format!("{account}#{folder}#{uid}"))
                    .unwrap_or_default()
            } else {
                let key = subject_filter
                    .as_deref()
                    .map(|subject| store::branch_compound_key(&thread_key, subject))
                    .unwrap_or_else(|| thread_key.clone());
                mail_model::format_thread_id(&account, &folder, &key)
            };

            if folder == target_folder {
                return mail_model::mutation_result(
                    json!({ "ok": true, "moved": 0, "source_folder": folder, "target_folder": target_folder }),
                    &engine.db.lock().unwrap(),
                    &account,
                    &changed_thread_id,
                    &folder,
                    Some(&target_folder),
                    None,
                    None,
                    false,
                );
            }

            let uids = {
                let db = engine.db.lock().unwrap();
                store::resolve_message_uids(
                    &db,
                    &account,
                    &folder,
                    &thread_key,
                    subject_filter.as_deref(),
                    uid,
                    &explicit_uids,
                )?
            };

            if uids.is_empty() {
                return mail_model::mutation_result(
                    json!({ "ok": true, "moved": 0, "source_folder": folder, "target_folder": target_folder }),
                    &engine.db.lock().unwrap(),
                    &account,
                    &changed_thread_id,
                    &folder,
                    Some(&target_folder),
                    None,
                    None,
                    false,
                );
            }

            engine
                .with_write_session(&account, |session| {
                    let folder = folder.clone();
                    let target_folder = target_folder.clone();
                    let uids = uids.clone();
                    Box::pin(async move {
                        session.move_to_folder(&folder, &target_folder, &uids).await
                    })
                })
                .await?;
            // Read-only refresh, on its own session: the MOVE has landed and
            // must not be retried, and a message the target folder holds that we
            // cannot parse must not sink the whole move.
            let target_batch =
                fetch_recent_resilient(engine, &account, &target_folder, 50.max(uids.len() as u32))
                    .await
                    .context("refresh target folder after move")?;

            {
                let db = engine.db.lock().unwrap();
                store::ensure_folder(&db, &account, &target_folder)?;
                store::upsert_messages(&db, &account, &target_folder, &target_batch.messages)?;
                store::set_folder_state(
                    &db,
                    &account,
                    &target_folder,
                    target_batch.uidvalidity,
                    target_batch.uid_next,
                )?;
                store::preserve_spam_judgments_for_move(
                    &db,
                    &account,
                    &folder,
                    &target_folder,
                    &uids,
                )?;
                store::delete_messages_by_uid(&db, &account, &folder, &uids)?;
            }
            // The IMAP MOVE above completed for every resolved UID. A concurrent
            // source-folder refresh may already have pruned those rows locally,
            // so the cache DELETE count is not the number moved on the server.
            let moved = uids.len();
            mail_model::mutation_result(
                json!({ "ok": true, "moved": moved, "source_folder": folder, "target_folder": target_folder }),
                &engine.db.lock().unwrap(),
                &account,
                &changed_thread_id,
                &folder,
                Some(&target_folder),
                None,
                None,
                true,
            )
        }

        "messages.copy" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let target_account = req_str(p, "target_account")?;
            let target_folder = canon_folder(&req_str(p, "target_folder")?);
            let (thread_key, subject_filter) =
                store::split_thread_key(&req_str(p, "thread_key").unwrap_or_default());
            let uid = p.get("uid").and_then(Value::as_u64).map(|n| n as u32);
            let explicit_uids = p
                .get("uids")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|n| n as u32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let uids = {
                let db = engine.db.lock().unwrap();
                store::resolve_message_uids(
                    &db,
                    &account,
                    &folder,
                    &thread_key,
                    subject_filter.as_deref(),
                    uid,
                    &explicit_uids,
                )?
            };

            if uids.is_empty() {
                return Ok(json!({
                    "ok": true,
                    "copied": 0,
                    "source_folder": folder,
                    "target_account": target_account,
                    "target_folder": target_folder
                }));
            }

            // Within one account, a server that can copy on its own does so
            // (Microsoft Graph, #141): the bytes never travel through here,
            // and its session has already brought both folders up to date.
            let graph_account = store::load_account(&engine.db.lock().unwrap(), &account)?
                .is_some_and(|creds| creds.is_graph());
            if graph_account && account == target_account {
                let native = engine
                    .with_write_session(&account, |session| {
                        let (folder, target_folder, uids) =
                            (folder.clone(), target_folder.clone(), uids.clone());
                        Box::pin(async move { session.copy_within(&folder, &target_folder, &uids).await })
                    })
                    .await?;
                if let Some(copied) = native {
                    return Ok(json!({
                        "ok": true,
                        "copied": copied,
                        "source_folder": folder,
                        "target_account": target_account,
                        "target_folder": target_folder
                    }));
                }
            }

            let raw_messages = engine
                .with_read_session(&account, |session| {
                    let folder = folder.clone();
                    let uids = uids.clone();
                    Box::pin(async move {
                        session.fetch_raw_messages_for_copy(&folder, &uids).await
                    })
                })
                .await?;

            if raw_messages.is_empty() {
                return Ok(json!({
                    "ok": true,
                    "copied": 0,
                    "source_folder": folder,
                    "target_account": target_account,
                    "target_folder": target_folder
                }));
            }

            let copied = raw_messages.len();
            engine
                .with_write_session(&target_account, |session| {
                    let target_folder = target_folder.clone();
                    let raw_messages = raw_messages.clone();
                    Box::pin(async move {
                        for message in &raw_messages {
                            session.append_copied_message(&target_folder, message).await?;
                        }
                        anyhow::Ok(())
                    })
                })
                .await?;
            // Read-only refresh, on its own session; see the move handler above.
            let target_batch = fetch_recent_resilient(
                engine,
                &target_account,
                &target_folder,
                50.max(raw_messages.len() as u32),
            )
            .await
            .context("refresh target folder after copy")?;

            {
                let db = engine.db.lock().unwrap();
                store::ensure_folder(&db, &target_account, &target_folder)?;
                store::upsert_messages(
                    &db,
                    &target_account,
                    &target_folder,
                    &target_batch.messages,
                )?;
                store::set_folder_state(
                    &db,
                    &target_account,
                    &target_folder,
                    target_batch.uidvalidity,
                    target_batch.uid_next,
                )?;
            }

            Ok(json!({
                "ok": true,
                "copied": copied,
                "source_folder": folder,
                "target_account": target_account,
                "target_folder": target_folder
            }))
        }

        "folders.archive" => {
            let account = req_str(p, "account")?;
            let archive = engine
                .with_read_session(&account, |session| {
                    Box::pin(async move { session.find_archive_folder().await })
                })
                .await?;
            match archive {
                Some(folder) => Ok(json!({ "folder": folder })),
                None => Err(anyhow::anyhow!("Archive folder not found for this account")),
            }
        }

        // Where an account files its junk, and where mail comes back to.
        //
        // Read from the cached folder list rather than asked of the server:
        // the roles were resolved when the folders were listed, and a junk
        // folder that has not changed since does not need a round trip to
        // find. Absent means the account has no such folder — which is a
        // real answer, not a failure to look.
        "folders.byRole" => {
            let account = req_str(p, "account")?;
            let role = req_str(p, "role")?;
            let folder = {
                let db = engine.db.lock().unwrap();
                store::folder_for_role(&db, &account, &role)?
            };
            Ok(json!({ "folder": folder }))
        }

        // Mark every message in a folder as read: set \Seen on the server for the
        // currently-unseen UIDs, then flip the whole folder seen in the store.
        "messages.markAllRead" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));

            let uids = {
                let db = engine.db.lock().unwrap();
                store::get_unseen_uids(&db, &account, &folder)?
            };

            if !uids.is_empty() {
                engine
                    .with_preflighted_write_session(
                        &account,
                        |session| {
                            let folder = folder.clone();
                            Box::pin(
                                async move { session.prepare_flag_update(&folder).await },
                            )
                        },
                        |session| {
                            let uids = uids.clone();
                            Box::pin(async move { session.store_seen(&uids, true).await })
                        },
                    )
                    .await?;
            }

            {
                let db = engine.db.lock().unwrap();
                store::mark_folder_seen(&db, &account, &folder, true)?;
            }
            mail_model::mutation_result(
                json!({ "ok": true, "updated": uids.len(), "folder": folder }),
                &engine.db.lock().unwrap(),
                &account,
                "",
                &folder,
                None,
                Some(false),
                None,
                false,
            )
        }

        "messages.markAllReadUnified" => {
            let role = req_str(p, "folder").unwrap_or_else(|_| "inbox".to_string());
            let account_folders = {
                let db = engine.db.lock().unwrap();
                store::list_accounts(&db)?
                    .into_iter()
                    .filter(|account| {
                        account
                            .get("included_in_unified")
                            .and_then(Value::as_bool)
                            .unwrap_or(true)
                    })
                    .filter(|account| {
                        account.get("auth_type").and_then(Value::as_str) != Some("rss")
                    })
                    .filter_map(|account| {
                        account
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .map(|account| {
                        let folder = store::folder_for_role(&db, &account, &role)?;
                        Ok(folder.map(|folder| (account, folder)))
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
            };
            let mut updated = 0_u64;
            let mut failures = Vec::new();
            let mut folder_unreads = serde_json::Map::new();
            let mut folder_counts = Vec::new();
            for (account, folder) in account_folders {
                let request = Request {
                    id: req.id,
                    method: "messages.markAllRead".to_string(),
                    params: json!({ "account": account, "folder": folder }),
                };
                match Box::pin(dispatch(engine, &request, out)).await {
                    Ok(result) => {
                        updated += result
                            .get("updated")
                            .and_then(Value::as_u64)
                            .unwrap_or_default();
                        if let Some(counts) = result
                            .get("folder_unreads")
                            .and_then(|all| all.get(&account))
                        {
                            folder_unreads.insert(account.clone(), counts.clone());
                        }
                        folder_counts.extend(
                            result
                                .get("folder_counts")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        );
                    }
                    Err(err) => failures
                        .push(json!({ "account_id": account, "message": format!("{err:#}") })),
                }
            }
            Ok(json!({
                "ok": failures.is_empty(),
                "updated": updated,
                "failures": failures,
                "folder_unreads": folder_unreads,
                "folder_counts": folder_counts,
            }))
        }

        // Permanently delete every message in a folder, server side and in the
        // store. Restricted to Trash and Junk: the operation is unrecoverable,
        // so an arbitrary folder must never reach it even if a caller asks.
        "messages.emptyFolder" => {
            let account = req_str(p, "account")?;
            let folder = canon_folder(&req_str(p, "folder")?);
            let role = {
                let db = engine.db.lock().unwrap();
                store::folder_role(&db, &account, &folder)?
            };
            if role != "trash" && role != "junk" {
                return Err(anyhow::anyhow!(
                    "Only Trash and Junk folders can be emptied"
                ));
            }

            // Mutating, so it never auto-retries.
            let expunged = engine
                .with_write_session(&account, |session| {
                    let folder = folder.clone();
                    Box::pin(async move { session.empty_folder(&folder).await })
                })
                .await?;

            let deleted = {
                let db = engine.db.lock().unwrap();
                store::delete_folder_messages(&db, &account, &folder)?
            };
            mail_model::mutation_result(
                json!({
                    "ok": true,
                    "deleted": deleted,
                    "expunged": expunged,
                    "folder": folder,
                    "role": role,
                }),
                &engine.db.lock().unwrap(),
                &account,
                "",
                &folder,
                None,
                None,
                None,
                true,
            )
        }

        // Fetch the certificate a mail server presents, so the account dialog
        // can show it and let the user pin it. Needed for local bridges (Proton
        // Mail Bridge) whose self-signed leaf webpki refuses outright; nothing
        // is sent over the probe connection.
        "account.probeCert" => {
            let host = req_str(p, "host")?;
            let port = req_u16(p, "port").unwrap_or(993);
            let protocol = p
                .get("protocol")
                .and_then(Value::as_str)
                .unwrap_or("imap")
                .to_string();
            let starttls = p.get("starttls").and_then(Value::as_bool).unwrap_or(false);
            let proxy = proxy::ProxyChoice::from_json(p.get("proxy").unwrap_or(&Value::Null));
            let info =
                meron_core::tls::probe(&host, port, &protocol, starttls, proxy.resolve()?.as_ref())
                    .await?;
            Ok(json!({ "certificate": info }))
        }

        // Forget an account: drop its in-memory creds, cached state, and the
        // keychain secret. The IDLE watcher notices the account is gone on its
        // next loop and exits.
        "account.remove" => {
            let _lifecycle = engine.graph_lifecycle.lock().await;
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let graph = engine.graph_auth.clone();
            let graph_account = id.clone();
            // Secure cleanup first: failure must preserve the account and cache.
            tokio::task::spawn_blocking(move || graph.forget_account(&graph_account)).await??;
            // A shared mailbox delegating to this account has no path back
            // to working once it is gone — nothing left to reconnect — so
            // it goes with it rather than sitting stuck forever.
            let dependents = store::shared_mailboxes_of(&engine.db.lock().unwrap(), &id).unwrap_or_default();
            for dependent in &dependents {
                engine.accounts.lock().await.remove(dependent);
                engine.clear_pool(dependent);
                let removal = store::delete_account(&engine.db.lock().unwrap(), dependent)?;
                for source in removal.contact_sources.iter().chain(&removal.calendar_secrets) {
                    let _ = secrets::delete(source);
                }
            }
            engine.accounts.lock().await.remove(&id);
            // Drop any warm sessions: their creds are gone and must not be reused.
            engine.clear_pool(&id);
            let removal = store::delete_account(&engine.db.lock().unwrap(), &id)?;
            // An address book's password is kept under the book's own id,
            // and a CalDAV calendar's under its own key.
            for source in removal.contact_sources.iter().chain(&removal.calendar_secrets) {
                let _ = secrets::delete(source);
            }
            parse::remove_account_media(&parse::media_root(), &id);
            let _ = secrets::delete(&id);
            // What the person wrote stays (ADR-0011); the caller says so.
            Ok(json!({
                "ok": true,
                "kept": {
                    "drafts": removal.kept_drafts,
                    "scheduled": removal.kept_scheduled,
                    "attempts": removal.kept_attempts,
                },
            }))
        }

        // Add a shared mailbox: an Exchange account the reader has been
        // granted full-access permission on, reached through an existing
        // Exchange account's own credentials rather than its own. Stored as
        // an ordinary account row with delegate_account_id set — see
        // `imap::Creds::delegate_account_id` and `Engine::resolve_shared_mailbox`
        // for how that becomes a real, connectable account.
        "account.addSharedMailbox" => {
            let parent_id = req_str(p, "parent_account")?;
            let address = req_str(p, "address")?.trim().to_lowercase();
            if address.is_empty() {
                return Err(anyhow::anyhow!("no shared mailbox address given"));
            }
            let display_name = req_str(p, "display_name")
                .ok()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| address.clone());

            let parent_creds = engine
                .ensure_valid_creds(&parent_id)
                .await
                .context("the account granting access needs to be reconnected first")?;
            if !parent_creds.is_ews() {
                return Err(anyhow::anyhow!(
                    "only an Exchange account can add a shared mailbox"
                ));
            }

            let id = address.clone();
            {
                let db = engine.db.lock().unwrap();
                // The id is the address, the same as any other account — if
                // one already exists here and is not already this exact
                // shared mailbox, adding would silently overwrite a real
                // account's credentials or someone else's delegation.
                if let Some(existing) = store::load_account(&db, &id)? {
                    if existing.delegate_account_id != parent_id {
                        return Err(anyhow::anyhow!(
                            "an account already exists for {address}"
                        ));
                    }
                }
            }

            let creds = imap::Creds {
                host: String::new(),
                port: 993,
                user: String::new(),
                password: String::new(),
                tls: true,
                starttls: false,
                smtp_host: String::new(),
                smtp_port: 587,
                smtp_tls: true,
                smtp_starttls: false,
                auth_type: "password".to_string(),
                access_token: None,
                refresh_token: None,
                token_expires_at: 0,
                oauth_client_id: String::new(),
                oauth_client_secret: String::new(),
                oauth_token_url: String::new(),
                oauth_scope: String::new(),
                proxy: proxy::ProxyChoice::default(),
                cert_pin: None,
                smtp_cert_pin: None,
                ews_url: String::new(),
                delegate_account_id: parent_id.clone(),
                target_mailbox: address.clone(),
            };
            {
                let db = engine.db.lock().unwrap();
                store::upsert_account(
                    &db,
                    &id,
                    &store::AccountMeta {
                        engine: "mail".to_string(),
                        provider: "exchange".to_string(),
                        email: address,
                        display_name,
                        avatar_url: String::new(),
                        sender_name: String::new(),
                    },
                    &creds,
                )?;
            }
            // Usable immediately, without waiting for the sidecar to restart.
            engine.resolve_shared_mailbox(&id, &parent_id).await;
            Ok(json!({ "id": id }))
        }

        // Set the per-account "load remote images" preference.
        "account.setImages" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let enabled = req_bool(p, "enabled")?;
            store::set_load_remote_images(&engine.db.lock().unwrap(), &id, enabled)?;
            Ok(json!({ "ok": true }))
        }

        // Toggle whether conversation bubbles render original HTML when available.
        "account.setConversationHtml" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let enabled = req_bool(p, "enabled")?;
            store::set_account_pref(
                &engine.db.lock().unwrap(),
                &id,
                "conversation_html",
                enabled,
            )?;
            Ok(json!({ "ok": true }))
        }

        // Set or clear the per-account chat wallpaper preference. The bridge
        // owns image-file validation and storage; the sidecar validates the
        // persisted JSON shape.
        "account.setChatWallpaper" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let wallpaper = match p.get("wallpaper") {
                Some(Value::Null) | None => None,
                Some(value) => {
                    let obj = value
                        .as_object()
                        .ok_or_else(|| anyhow::anyhow!("wallpaper must be an object"))?;
                    let kind = obj.get("kind").and_then(Value::as_str).unwrap_or_default();
                    match kind {
                        "preset" => {
                            let preset_id = obj
                                .get("presetId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim();
                            if preset_id.is_empty() {
                                anyhow::bail!("preset wallpaper requires presetId");
                            }
                            Some(json!({ "kind": "preset", "presetId": preset_id }))
                        }
                        "custom" => {
                            let url = obj
                                .get("url")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim();
                            if !url.starts_with("/media/wallpapers/") {
                                anyhow::bail!("custom wallpaper URL must be an Oreneta wallpaper");
                            }
                            Some(json!({ "kind": "custom", "url": url }))
                        }
                        _ => anyhow::bail!("unknown wallpaper kind"),
                    }
                }
            };
            store::set_account_pref_json(
                &engine.db.lock().unwrap(),
                &id,
                "chat_wallpaper",
                wallpaper,
            )?;
            Ok(json!({ "ok": true }))
        }

        // Set the account's display name.
        // Point one account at a different proxy than the app-wide setting (or
        // at none). Live sessions keep their sockets; the choice applies as
        // they reconnect.
        "account.setProxy" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let choice = proxy::ProxyChoice::from_json(p.get("proxy").unwrap_or(&Value::Null));
            store::set_account_proxy(&engine.db.lock().unwrap(), &id, &choice)?;
            if let Some(creds) = engine.accounts.lock().await.get_mut(&id) {
                creds.proxy = choice;
            }
            // A pooled Exchange session carries its route from when it connected.
            engine.clear_pool(&id);
            Ok(json!({ "ok": true }))
        }

        // Store certificate pins the user accepted for an account that already
        // exists — a server whose certificate rotated, or one whose failure only
        // showed up on a later sync or send. Omitting a key leaves that server's
        // pin alone; an explicit null clears it.
        "account.setCertPin" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let mut accounts = engine.accounts.lock().await;
            let existing = accounts.get(&id);
            let cert_pin = match p.get("cert_pin") {
                Some(_) => cert_pin_param(p, "cert_pin"),
                None => existing.and_then(|creds| creds.cert_pin.clone()),
            };
            let smtp_cert_pin = match p.get("smtp_cert_pin") {
                Some(_) => cert_pin_param(p, "smtp_cert_pin"),
                None => existing.and_then(|creds| creds.smtp_cert_pin.clone()),
            };
            store::set_account_cert_pins(
                &engine.db.lock().unwrap(),
                &id,
                cert_pin.as_deref(),
                smtp_cert_pin.as_deref(),
            )?;
            if let Some(creds) = accounts.get_mut(&id) {
                creds.cert_pin = cert_pin;
                creds.smtp_cert_pin = smtp_cert_pin;
            }
            drop(accounts);
            // Pooled sessions were built with the old trust decision.
            engine.clear_pool(&id);
            Ok(json!({ "ok": true }))
        }

        "account.setName" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let name = req_str(p, "name")?;
            {
                let db = engine.db.lock().unwrap();
                db.execute(
                    "UPDATE accounts SET display_name = ?1, updated_at = strftime('%s', 'now') WHERE id = ?2",
                    rusqlite::params![name.trim(), id],
                )?;
            }
            Ok(json!({ "ok": true }))
        }

        // Set the account's sender name.
        "account.setSenderName" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let name = req_str(p, "name")?;
            {
                let db = engine.db.lock().unwrap();
                db.execute(
                    "UPDATE accounts SET sender_name = ?1, updated_at = strftime('%s', 'now') WHERE id = ?2",
                    rusqlite::params![name.trim(), id],
                )?;
            }
            Ok(json!({ "ok": true }))
        }

        // The picture is a copy on this computer; `avatar_source` is where a
        // copy that could not be made yet is to be fetched from, through the
        // account's route (#194). A key left out is left as it was.
        "account.setAvatar" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let avatar_url = p.get("avatar_url").and_then(Value::as_str);
            let avatar_source = p.get("avatar_source").and_then(Value::as_str);
            // `expect_*` make a retry that read the account earlier apply only
            // while it still holds what it read.
            let expect_url = p.get("expect_avatar_url").and_then(Value::as_str);
            let expect_source = p.get("expect_avatar_source").and_then(Value::as_str);
            let applied = store::set_account_avatar_if(
                &engine.db.lock().unwrap(),
                &id,
                avatar_url,
                avatar_source,
                expect_url,
                expect_source,
            )?;
            Ok(json!({ "ok": true, "applied": applied }))
        }

        // Accounts whose picture is still to be fetched, or that hold a remote
        // address as their picture (#194).
        "account.pendingAvatars" => {
            let pending = store::pending_avatars(&engine.db.lock().unwrap())?;
            Ok(json!({ "accounts": pending }))
        }

        // Replace an account's send-as aliases (the whole list). Entries are
        // {email, name?}; we trim, drop blank emails, and dedupe by email.
        "account.setAliases" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let mut aliases: Vec<store::Alias> = match p.get("aliases") {
                Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
                None => Vec::new(),
            };
            let mut seen = std::collections::HashSet::new();
            aliases.retain_mut(|a| {
                a.email = a.email.trim().to_string();
                a.name = a.name.trim().to_string();
                !a.email.is_empty() && seen.insert(a.email.to_lowercase())
            });
            {
                let db = engine.db.lock().unwrap();
                store::set_account_aliases(&db, &id, &aliases)?;
            }
            Ok(json!({ "ok": true }))
        }

        // Set or clear this account's signature override. A null `signature`
        // drops the pref, so the account follows the app-wide signature again.
        "account.setSignature" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let signature = store::AccountSignature::from_param(p.get("signature"))
                .map_err(|err| anyhow::anyhow!(err))?;
            store::set_account_pref_json(
                &engine.db.lock().unwrap(),
                &id,
                "signature",
                signature.map(|sig| json!(sig)),
            )?;
            Ok(json!({ "ok": true }))
        }

        // Toggle whether the account folds into the unified inbox. Purely a stored
        // pref the UI reads via account.list; no engine side effects.
        "account.setUnified" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let enabled = req_bool(p, "enabled")?;
            store::set_account_pref(
                &engine.db.lock().unwrap(),
                &id,
                "included_in_unified",
                enabled,
            )?;
            Ok(json!({ "ok": true }))
        }

        // Toggle whether new mail/feed items raise a desktop notification. The
        // watcher still runs (mail keeps arriving); the bridge reads the `muted`
        // flag on each mail.newMessages event to decide whether to notify.
        "account.setMuted" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let enabled = req_bool(p, "enabled")?;
            store::set_account_pref(&engine.db.lock().unwrap(), &id, "muted", enabled)?;
            Ok(json!({ "ok": true }))
        }

        // Pause/resume automatic checking. Pausing stops the IDLE watcher and
        // gates background syncs; resuming restarts the watcher for mail accounts.
        "account.setPaused" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let enabled = req_bool(p, "enabled")?;
            store::set_account_pref(&engine.db.lock().unwrap(), &id, "paused", enabled)?;
            if enabled {
                // Wake live watchers so the just-paused one shuts down promptly,
                // and drop warm sessions so a paused account holds no connections.
                engine.pause_signal.notify_waiters();
                engine.clear_pool(&id);
            } else if !is_rss(engine, &id)? {
                // Resume: restart the IDLE watcher (deduped) and warm the inbox.
                if start_idle_watch(engine.clone(), out.clone(), id.clone(), "INBOX".to_string()) {
                    spawn_body_prefetch(engine.clone(), id.clone(), "INBOX".to_string());
                }
            }
            Ok(json!({ "ok": true }))
        }

        // Override Sent-copy behavior. Null removes the override so provider
        // defaults apply; true/false force or suppress IMAP APPEND after SMTP.
        "account.setSaveSentCopy" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let value = match p.get("value") {
                Some(Value::Bool(enabled)) => Some(json!(enabled)),
                Some(Value::Null) | None => None,
                _ => return Err(anyhow::anyhow!("value must be true, false, or null")),
            };
            store::set_account_pref_json(&engine.db.lock().unwrap(), &id, "save_sent_copy", value)?;
            Ok(json!({ "ok": true }))
        }

        // The host OS resumed from suspend. Connections held across sleep are
        // likely dead but look fresh (monotonic clock froze), so drop pooled
        // sessions and wake every IDLE watcher to reconnect, rather than waiting
        // out TCP keepalive / the IDLE timeout with no mail being pushed.
        "system.resumed" => {
            engine.clear_all_pools();
            engine.resume_signal.notify_waiters();
            Ok(json!({ "ok": true }))
        }

        // The host showed a missed-reminders notice (#225): the reminders it
        // held, `keys: [{account, key}]`, are no longer said again at start.
        "reminders.missedShown" => {
            let shown: Vec<(String, String)> = p
                .get("keys")
                .and_then(Value::as_array)
                .map(|keys| {
                    keys.iter()
                        .filter_map(|k| Some((k.get("account")?.as_str()?.to_string(), k.get("key")?.as_str()?.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            pim::reminders::missed_shown(engine, &shown)?;
            Ok(json!({ "ok": true }))
        }

        // Set the RSS automatic sync interval. Stored in minutes so the UI and
        // scheduler can read it from account.list without sidecar state.
        "account.setRSSSyncInterval" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let minutes = req_u32(p, "minutes")?.clamp(5, 1440) as u64;
            store::set_account_pref_u64(
                &engine.db.lock().unwrap(),
                &id,
                "rss_sync_interval_minutes",
                minutes,
            )?;
            Ok(json!({ "ok": true, "minutes": minutes }))
        }

        // Reorder accounts in the database.
        "account.reorder" => {
            let ids = req_str_array(p, "accounts")?;
            store::reorder_accounts(&engine.db.lock().unwrap(), &ids)?;
            Ok(json!({ "ok": true }))
        }

        // Start watching one account folder over IMAP IDLE. IMAP IDLE is per
        // selected mailbox, so kanban starts visible non-INBOX folders here while
        // account startup keeps INBOX watched.
        "watch.start" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            if engine.is_paused(&account) {
                return Ok(json!({ "ok": true, "paused": true }));
            }
            let started = start_idle_watch(engine.clone(), out.clone(), account, folder);
            Ok(json!({ "ok": true, "already": !started }))
        }

        "watch.stop" => {
            let account = req_str(p, "account")?;
            let folder =
                canon_folder(&req_str(p, "folder").unwrap_or_else(|_| "INBOX".to_string()));
            let removed = engine
                .watched
                .lock()
                .unwrap()
                .remove(&watch_key(&account, &folder));
            if removed {
                engine.pause_signal.notify_waiters();
            }
            Ok(json!({ "ok": true, "stopped": removed }))
        }

        other => Err(anyhow::anyhow!("unknown method: {other}")),
    }
}

/// Decode an opaque RSS pagination cursor `"ts:<i64>:<item_key>"`.
fn parse_rss_cursor(raw: &str) -> Option<(i64, String)> {
    let rest = raw.strip_prefix("ts:")?;
    let (ts, key) = rest.split_once(':')?;
    Some((ts.parse().ok()?, key.to_string()))
}

/// Whether an account is RSS-backed (vs mail), per its row in the unified DB.
fn is_rss(engine: &Arc<Engine>, account: &str) -> anyhow::Result<bool> {
    Ok(store::account_engine(&engine.db.lock().unwrap(), account)?.as_deref() == Some("rss"))
}

/// Parse the optional `attachments` array. An entry that fails to deserialize
/// is a hard error: skipping it would send/save the message without its file
/// while reporting success.
fn opt_attachments(params: &Value) -> anyhow::Result<Vec<smtp::AttachmentInput>> {
    match params.get("attachments") {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|val| {
                serde_json::from_value::<smtp::AttachmentInput>(val.clone())
                    .map_err(|err| anyhow::anyhow!("invalid attachment: {err}"))
            })
            .collect(),
        Some(Value::Null) | None => Ok(Vec::new()),
        Some(_) => Err(anyhow::anyhow!("attachments must be an array")),
    }
}

/// How many unlooked-at messages one filter click is willing to ask about.
///
/// Bounded so turning the filter on in a mailbox of fifty thousand is one
/// reasonable FETCH rather than an enormous one. Whatever is left stays
/// unknown and is filled in by later syncs.
const ATTACHMENT_BACKFILL_LIMIT: i64 = 500;

/// Asks the server about the messages of a folder nobody has looked at yet.
///
/// Failure is quiet on purpose. This makes an answer more complete; it is not
/// the answer. A folder that cannot be reached still lists what is already
/// known, which is better than refusing to list anything.
async fn fill_in_attachment_flags(engine: &Arc<Engine>, account: &str, folder: &str) {
    let unknown = {
        let db = engine.db.lock().unwrap();
        store::uids_without_structure(&db, account, folder, ATTACHMENT_BACKFILL_LIMIT)
            .unwrap_or_default()
    };
    if unknown.is_empty() {
        return;
    }
    let folder_owned = folder.to_string();
    let answers = engine
        .with_read_session(account, move |session| {
            let folder = folder_owned.clone();
            let uids = unknown.clone();
            Box::pin(async move { session.attachment_flags(&folder, &uids).await })
        })
        .await;
    match answers {
        Ok(answers) => {
            let db = engine.db.lock().unwrap();
            let _ = store::set_has_attachments(&db, account, folder, &answers);
        }
        Err(err) => {
            eprintln!("meron-core: attachment structures for {account}/{folder}: {err:#}");
        }
    }
}

/// The rules as they are stored, in the order they run.
///
/// A rule that no longer parses is skipped rather than sinking the rest: one
/// bad row must not stop every other rule from filing mail.
fn stored_rules(engine: &Arc<Engine>) -> Vec<rules::Rule> {
    let definitions = {
        let db = engine.db.lock().unwrap();
        store::rules(&db).unwrap_or_default()
    };
    definitions
        .iter()
        .filter_map(|definition| match serde_json::from_str::<rules::Rule>(definition) {
            Ok(rule) => Some(rule),
            Err(err) => {
                eprintln!("meron-core: unreadable rule skipped: {err}");
                None
            }
        })
        .collect()
}

/// What a message offers the rules to match on.
fn rule_subject(header: &imap::MessageHeader) -> rules::Subject<'_> {
    rules::Subject {
        from_name: &header.from_name,
        from_addr: &header.from_addr,
        to: header.to.iter().map(|r| format!("{} {}", r.name, r.addr)).collect(),
        cc: header.cc.iter().map(|r| format!("{} {}", r.name, r.addr)).collect(),
        subject: &header.subject,
    }
}

/// How an action reads in the record.
fn action_label(action: &rules::Action) -> String {
    match action {
        rules::Action::MoveTo { folder } => format!("moveTo:{folder}"),
        rules::Action::MarkRead => "markRead".to_string(),
        rules::Action::Star => "star".to_string(),
        rules::Action::AddLabel { label_id } => format!("label:{label_id}"),
        rules::Action::Stop => "stop".to_string(),
    }
}

/// Carries out one planned action, through the same request a person's own
/// gesture would make.
///
/// Deliberately not a second implementation of moving and flagging: a rule
/// that files mail must do exactly what filing mail by hand does, including
/// every cache and folder-count update that comes with it.
async fn run_rule_action(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    folder: &str,
    uid: u32,
    action: &rules::Action,
) -> anyhow::Result<()> {
    let (method, params) = match action {
        rules::Action::MoveTo { folder: target } => (
            "messages.move",
            json!({
                "account": account,
                "folder": folder,
                "target_folder": target,
                "uids": [uid],
            }),
        ),
        rules::Action::MarkRead => (
            "messages.markRead",
            json!({ "account": account, "folder": folder, "uids": [uid], "seen": true }),
        ),
        rules::Action::Star => (
            "messages.markStarred",
            json!({ "account": account, "folder": folder, "uids": [uid], "starred": true }),
        ),
        // Labels live only here, so this one is a store write rather than a
        // request. Added to whatever the conversation already carries: a rule
        // must not strip what someone put on by hand.
        rules::Action::AddLabel { label_id } => {
            let thread_key = {
                let db = engine.db.lock().unwrap();
                store::thread_key_for_uid(&db, account, folder, uid)?
            };
            let db = engine.db.lock().unwrap();
            store::add_thread_label(&db, account, &thread_key, label_id)?;
            return Ok(());
        }
        // Never reaches here: `plan` returns before emitting a Stop.
        rules::Action::Stop => return Ok(()),
    };
    let request = Request {
        id: 0,
        method: method.to_string(),
        params,
    };
    dispatch(engine, &request, out).await.map(|_| ())
}

/// Applies the rules to mail that has just arrived.
///
/// Every action is recorded, whether it worked or not. A rule failing in
/// silence is worse than a rule that never ran: the reader believes their mail
/// was filed and it is in the inbox, or believes it is in the inbox and it is
/// not.
///
/// Returns the arrivals the rules dealt with — filed away or marked read — so
/// the caller does not announce mail that is no longer waiting to be read.
async fn apply_rules_to_arrivals(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    folder: &str,
    arrivals: &[imap::MessageHeader],
) -> std::collections::HashSet<u32> {
    let mut handled = std::collections::HashSet::new();
    // Rules the account's server already applies are not applied twice (#94).
    let on_server = rules::server::on_server(&engine.db.lock().unwrap(), account);
    let rules: Vec<rules::Rule> = stored_rules(engine).into_iter().filter(|r| !on_server.contains(&r.id)).collect();
    if rules.is_empty() || arrivals.is_empty() {
        return handled;
    }

    for header in arrivals {
        for step in rules::plan(&rules, account, &rule_subject(header)) {
            let moved = matches!(step.action, rules::Action::MoveTo { .. });
            let done = run_rule_action(engine, out, account, folder, header.uid, &step.action).await;
            let outcome = match &done {
                Ok(()) => "done".to_string(),
                Err(err) => format!("failed: {err:#}"),
            };
            if done.is_ok() {
                handled.insert(header.uid);
            }
            {
                let db = engine.db.lock().unwrap();
                let _ = store::log_rule_action(
                    &db,
                    &store::RuleLogEntry {
                        at: now_seconds(),
                        account: account.to_string(),
                        rule_id: step.rule_id.clone(),
                        rule_name: step.rule_name.clone(),
                        folder: folder.to_string(),
                        uid: header.uid,
                        subject: header.subject.clone(),
                        from_addr: header.from_addr.clone(),
                        action: action_label(&step.action),
                        outcome,
                    },
                );
            }
            // A message that has been filed elsewhere is no longer where the
            // next action would look for it, so the rest of its plan is
            // abandoned rather than run against a UID that has left.
            if moved && done.is_ok() {
                break;
            }
        }
    }
    handled
}

/// Reply automatically to genuinely new inbox mail, for an account with the
/// client-side out-of-office auto-responder on. Exchange accounts never
/// reach this: they configure the server's own Automatic Replies instead
/// (`oof.get`/`oof.set` calling the EWS operations directly), which sends
/// the reply itself regardless of whether Oreneta is even running — the
/// whole reason that path exists alongside this one. See `crate::oof` for
/// what makes a message worth replying to at all.
async fn apply_oof_to_arrivals(engine: &Arc<Engine>, account: &str, headers: &[imap::MessageHeader]) {
    if headers.is_empty() {
        return;
    }
    let Ok(creds) = engine.ensure_valid_creds(account).await else {
        return;
    };
    if creds.is_ews() || creds.is_graph() || creds.is_local_store() {
        return;
    }
    let oof = {
        let db = engine.db.lock().unwrap();
        store::oof_prefs(&db, account).unwrap_or_default()
    };
    if !oof.active_at(now_seconds()) {
        return;
    }
    let (own_address, sender_name) = {
        let db = engine.db.lock().unwrap();
        match store::resolve_send_from(&db, account, &creds.user, "") {
            Ok(pair) => pair,
            Err(_) => return,
        }
    };
    let subject = if oof.subject.trim().is_empty() {
        "Automatic reply".to_string()
    } else {
        oof.subject.clone()
    };

    for header in headers {
        let from_addr = header.from_addr.trim().to_lowercase();
        if from_addr.is_empty() {
            continue;
        }
        let already_replied = {
            let db = engine.db.lock().unwrap();
            store::oof_already_replied(&db, account, &from_addr).unwrap_or(true)
        };
        if already_replied {
            continue;
        }

        let uid = header.uid;
        let raw = engine
            .with_read_session(account, |session| {
                Box::pin(async move { session.fetch_raw_messages_for_copy("INBOX", &[uid]).await })
            })
            .await
            .ok()
            .and_then(|mut messages| messages.pop());
        let Some(raw) = raw else { continue };
        let Ok(mail) = mailparse::parse_mail(&raw.raw) else {
            continue;
        };
        if !meron_core::oof::should_reply(&mail, &header.from_addr, &own_address) {
            continue;
        }

        match smtp::send_oof_reply(
            &creds,
            &own_address,
            &sender_name,
            &header.from_addr,
            &subject,
            &oof.body,
            &header.message_id,
        )
        .await
        {
            Ok(_) => {
                let db = engine.db.lock().unwrap();
                let _ = store::record_oof_reply(&db, account, &from_addr, now_seconds());
            }
            Err(err) => {
                eprintln!("meron-core: out-of-office reply to {account} failed: {err:#}");
            }
        }
    }
}

/// A scheduled message that will not be tried again, and why.
fn failed_send_json(row: &store::ScheduledSend, reason: &str) -> Value {
    json!({
        "id": row.id,
        "account": row.account,
        "subject": row.subject,
        "error": reason,
        "uncertain": false,
    })
}

/// A scheduled message that may or may not have gone. Told apart from a
/// refusal so the interface does not offer "send now" as if nothing had
/// happened.
fn uncertain_send_json(row: &store::ScheduledSend, reason: &str) -> Value {
    json!({
        "id": row.id,
        "account": row.account,
        "subject": row.subject,
        "error": reason,
        "uncertain": true,
    })
}

/// How long settled send history is kept before it is forgotten. Doubt is
/// never forgotten on a timer; see `outgoing::prune_settled`.
const OUTGOING_HISTORY_SECONDS: i64 = 30 * 24 * 60 * 60;

/// How one try at a scheduled message ended, for the watch and for
/// "send now" alike.
enum ScheduledOutcome {
    /// Accepted by the server (whether or not the Sent copy was filed).
    Sent,
    /// Transmitted without an answer, or already transmitted by an earlier
    /// try nobody recorded the end of. Carries the reason to show.
    Uncertain(String),
    /// Another caller is sending this very message right now (the watch and
    /// "send now" at once, or a held reply let go as the watch reached it).
    /// Nothing is settled yet: the row stays, and the one sending settles it.
    InFlight,
}

/// What a send's answer means for its scheduled row. An "already attempted"
/// answer is not a success: the earlier attempt may still be in flight, or
/// may yet be refused, and dropping the row then would lose the message.
fn scheduled_outcome_of(result: &Value) -> ScheduledOutcome {
    let error = || result.get("error").and_then(Value::as_str).unwrap_or("outcome unknown").to_string();
    match result.get("outcome").and_then(Value::as_str) {
        Some("uncertain") => ScheduledOutcome::Uncertain(error()),
        Some("already_attempted") => match result.get("state").and_then(Value::as_str) {
            Some("accepted") | Some("archived") => ScheduledOutcome::Sent,
            Some("sending") => ScheduledOutcome::InFlight,
            _ => ScheduledOutcome::Uncertain(if result.get("error").and_then(Value::as_str).unwrap_or("").is_empty() {
                "an earlier try of this message may already have gone".to_string()
            } else {
                error()
            }),
        },
        _ => ScheduledOutcome::Sent,
    }
}

/// Previewed rule runs waiting to be confirmed (#50).
fn rule_runs() -> &'static rules::run::Registry {
    static RUNS: std::sync::OnceLock<rules::run::Registry> = std::sync::OnceLock::new();
    RUNS.get_or_init(Default::default)
}

/// Why an account's rules cannot run on its server through ManageSieve.
fn sieve_unavailable(creds: &imap::Creds) -> Option<String> {
    if creds.is_ews() || creds.is_graph() {
        return Some("Exchange keeps its own server rules, which Oreneta does not edit yet".into());
    }
    if creds.is_local() {
        return Some("a local archive has no server".into());
    }
    if creds.is_pop3() {
        return Some("a POP3 account's rules run here: POP3 has no server rules".into());
    }
    if creds.password.is_empty() || creds.is_oauth() {
        return Some("this account signs in without a password; its provider's own filters are not edited yet".into());
    }
    None
}

/// The script for an account from the stored rules, given what its server
/// supports, with labels linked to this account's keywords.
fn server_rule_plan(engine: &Arc<Engine>, account: &str, extensions: &[String]) -> rules::sieve::Plan {
    let rules = stored_rules(engine);
    let links = store::label_links(&engine.db.lock().unwrap()).unwrap_or_default();
    let keyword = |label: &str| {
        links.iter().find(|l| l.label_id == label && l.account_id == account).map(|l| l.remote_name.clone())
    };
    rules::sieve::plan(&rules, account, extensions, &keyword)
}

/// Batches with a worker sending them now, so carrying on twice cannot start
/// a second one (#90).
fn cloud_account(engine: &Engine, p: &Value) -> anyhow::Result<(meron_core::cloud::CloudAccount, String)> {
    let account = meron_core::cloud::get(&engine.db.lock().unwrap(), &req_str(p, "id")?)?;
    let password = meron_core::secrets::load(&meron_core::cloud::secret_key(&account.id))?.password;
    anyhow::ensure!(!password.is_empty(), "this cloud storage has no app password saved");
    Ok((account, password))
}

fn cloud_uploads() -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
        std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Uploads in the background, reporting progress about every 256 KB and the
/// end once, with what went wrong.
fn spawn_cloud_upload(
    out: Writer,
    account: meron_core::cloud::CloudAccount,
    password: String,
    path: std::path::PathBuf,
    upload_id: String,
) {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    cloud_uploads().lock().unwrap().insert(upload_id.clone(), cancel.clone());
    let total = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<u64>();
    let progress_out = out.clone();
    let progress_id = upload_id.clone();
    tokio::spawn(async move {
        while let Some(done) = rx.recv().await {
            emit(&progress_out, "cloud.progress", json!({ "upload_id": progress_id, "done": done, "total": total })).await;
        }
    });
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let mut last = 0u64;
            meron_core::cloud::upload(&account, &password, &path, &cancel, &mut |done| {
                if done == total || done - last >= 256 * 1024 {
                    last = done;
                    let _ = tx.send(done);
                }
            })
        })
        .await;
        cloud_uploads().lock().unwrap().remove(&upload_id);
        let detail = match result {
            Ok(Ok(remote)) => json!({ "upload_id": upload_id, "path": remote }),
            Ok(Err(err)) => json!({ "upload_id": upload_id, "error": { "message": err.to_string(), "detail": err } }),
            Err(err) => json!({ "upload_id": upload_id, "error": { "message": err.to_string() } }),
        };
        emit(&out, "cloud.uploaded", detail).await;
    });
}

fn chat_sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, tokio::sync::mpsc::UnboundedSender<meron_core::chat::xmpp::Command>>> {
    static SESSIONS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::mpsc::UnboundedSender<meron_core::chat::xmpp::Command>>>> =
        std::sync::OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

/// Each chat account's last known connection state, for the app to show.
fn chat_status() -> &'static std::sync::Mutex<std::collections::HashMap<String, Value>> {
    static STATUS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Value>>> =
        std::sync::OnceLock::new();
    STATUS.get_or_init(Default::default)
}

fn stop_chat(id: &str) {
    if let Some(tx) = chat_sessions().lock().unwrap().remove(id) {
        let _ = tx.send(meron_core::chat::xmpp::Command::Stop);
    }
}

/// (Re)starts an account's chat connection.
/// The scheduled backups' password, if one is saved.
fn backup_password() -> anyhow::Result<Option<String>> {
    let password = secrets::load(meron_core::backup_schedule::SECRET_KEY)?.password;
    Ok(Some(password).filter(|p| !p.is_empty()))
}

fn backup_schedule_status(engine: &Arc<Engine>) -> anyhow::Result<Value> {
    let status = meron_core::backup_schedule::status(&engine.db.lock().unwrap())?;
    let mut value = serde_json::to_value(status)?;
    value["password_saved"] = json!(backup_password().ok().flatten().is_some());
    value["running"] = json!(BACKUP_RUNNING.load(std::sync::atomic::Ordering::SeqCst));
    Ok(value)
}

static BACKUP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// One scheduled backup, written and checked off the reactor.
async fn run_scheduled_backup(engine: &Arc<Engine>) -> anyhow::Result<meron_core::backup_schedule::Outcome> {
    let password = backup_password()?.unwrap_or_default();
    let db = engine.db.clone();
    BACKUP_RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);
    let result = tokio::task::spawn_blocking(move || {
        meron_core::backup_schedule::run(
            &db,
            &store::app_dir(),
            &meron_core::parse::media_root(),
            &password,
            &std::env::var("MERON_APP_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string()),
            now_seconds(),
            if cfg!(test) { 10 } else { meron_core::profile_archive::WORK_FACTOR },
        )
    })
    .await;
    BACKUP_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    result?
}

/// Checks every few minutes whether a scheduled backup is due (#173). The
/// first check waits a little, so a missed run never slows startup.
fn spawn_backup_schedule(engine: Arc<Engine>, out: Writer) {
    if let Err(err) = meron_core::backup_schedule::recover(&engine.db.lock().unwrap()) {
        eprintln!("meron-core: could not tidy scheduled backups: {err:#}");
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(300));
        loop {
            ticker.tick().await;
            let due = {
                let db = engine.db.lock().unwrap();
                meron_core::backup_schedule::status(&db)
                    .ok()
                    .and_then(|s| s.next_run)
                    .is_some_and(|at| at <= now_seconds())
            };
            if !due {
                continue;
            }
            emit(&out, "backup.scheduled", json!({ "state": "running" })).await;
            let result = run_scheduled_backup(&engine).await;
            if let Err(err) = &result {
                eprintln!("meron-core: scheduled backup failed: {err:#}");
            }
            let status = backup_schedule_status(&engine).unwrap_or(Value::Null);
            emit(&out, "backup.scheduled", json!({ "state": if result.is_ok() { "done" } else { "failed" }, "status": status })).await;
        }
    });
}

/// What automatic archiving needs to know about an account: its kind, its
/// folders as last listed, and the name its mail is filed under locally.
fn auto_archive_context(
    engine: &Arc<Engine>,
    account: &str,
) -> anyhow::Result<(meron_core::auto_archive::AccountKind, Vec<meron_core::imap::Folder>, String)> {
    let db = engine.db.lock().unwrap();
    let creds = store::load_account(&db, account)?.context("no such account")?;
    Ok((
        meron_core::auto_archive::AccountKind::of(&creds),
        store::get_folders(&db, account)?,
        meron_core::auto_archive::account_label(&db, account)?,
    ))
}

fn auto_archive_status(engine: &Arc<Engine>, account: &str) -> anyhow::Result<Value> {
    let (kind, folders, _) = auto_archive_context(engine, account)?;
    Ok(serde_json::to_value(meron_core::auto_archive::status(&engine.db.lock().unwrap(), account, kind, &folders)?)?)
}

/// One archiving run for an account (ADR-0054), then the lists it touched
/// are refreshed. Says whether the local archive was created by it.
async fn run_auto_archive(
    engine: &Arc<Engine>,
    out: &Writer,
    account: &str,
    trigger: &str,
) -> anyhow::Result<(meron_core::auto_archive::RunLog, bool)> {
    let (_, _, label) = auto_archive_context(engine, account)?;
    let had_archive = store::load_account(&engine.db.lock().unwrap(), meron_core::archive::ACCOUNT)?.is_some();
    let mut steps = meron_core::auto_archive::EngineSteps {
        engine: engine.clone(),
        account: account.to_string(),
        media_root: parse::media_root(),
    };
    let log = meron_core::auto_archive::run(
        &mut steps,
        &engine.db,
        account,
        &label,
        trigger,
        |policy| meron_core::auto_archive::cutoffs(policy, &chrono::Local::now()),
        now_seconds(),
        now_seconds,
    )
    .await?;
    let created = !had_archive && {
        let creds = store::load_account(&engine.db.lock().unwrap(), meron_core::archive::ACCOUNT)?;
        match creds {
            Some(creds) => {
                engine.accounts.lock().await.insert(meron_core::archive::ACCOUNT.to_string(), creds);
                true
            }
            None => false,
        }
    };
    if log.moved + log.kept > 0 {
        emit(out, "mail.synced", json!({ "account": account, "folders": true })).await;
        if log.destination == Some(meron_core::auto_archive::Destination::Local) {
            emit(out, "mail.synced", json!({ "account": meron_core::archive::ACCOUNT, "folders": true })).await;
        }
    }
    Ok((log, created))
}

/// Checks every few minutes whether an account's archiving is due (#112),
/// as scheduled backups do; the first check waits a little.
fn spawn_auto_archive(engine: Arc<Engine>, out: Writer) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(150)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(300));
        loop {
            ticker.tick().await;
            let due = meron_core::auto_archive::due(&engine.db.lock().unwrap(), now_seconds()).unwrap_or_default();
            for account in due {
                if engine.is_paused(&account) {
                    continue;
                }
                let result = run_auto_archive(&engine, &out, &account, "scheduled").await;
                let (run, created, error) = match result {
                    Ok((run, created)) => (serde_json::to_value(&run).unwrap_or(Value::Null), created, None),
                    Err(err) => (Value::Null, false, Some(format!("{err:#}"))),
                };
                if let Some(error) = &error {
                    eprintln!("meron-core: automatic archiving for {account} did not run: {error}");
                }
                emit(
                    &out,
                    "autoArchive.ran",
                    json!({ "account": account, "run": run, "archive_created": created, "error": error }),
                )
                .await;
            }
        }
    });
}

fn start_chat(engine: &Arc<Engine>, out: Writer, id: &str) -> anyhow::Result<()> {
    stop_chat(id);
    let account = meron_core::chat::account(&engine.db.lock().unwrap(), id)?;
    let password = secrets::load(&meron_core::chat::secret_key(id))?.password;
    anyhow::ensure!(!password.is_empty(), "this chat account has no password saved");
    let connector = meron_core::chat::xmpp::connector(&account, false)?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    chat_sessions().lock().unwrap().insert(id.to_string(), tx);
    // Events leave the session through a channel to the async writer.
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
    tokio::spawn(async move {
        while let Some((name, mut detail)) = erx.recv().await {
            let account = detail["account"].as_str().unwrap_or_default().to_string();
            match name.as_str() {
                "chat.status" if !account.is_empty() => {
                    chat_status().lock().unwrap().insert(account, detail.clone());
                }
                "chat.room" => {
                    let room = detail["room"].as_str().unwrap_or_default().to_string();
                    chat_room_status().lock().unwrap().insert((account, room), detail.clone());
                }
                "chat.uploaded" => {
                    chat_uploads().lock().unwrap().remove(detail["upload_id"].as_str().unwrap_or_default());
                }
                // An invitation's room password goes to the keychain; the app
                // only hears that there is one.
                "chat.invitation" => {
                    if let Some(password) = detail.get("password").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                        let room = detail["room"].as_str().unwrap_or_default().to_string();
                        if let Err(err) = store_room_password(&account, &room, password) {
                            eprintln!("meron-core: could not keep a room password: {err:#}");
                        }
                    }
                    if let Some(map) = detail.as_object_mut() {
                        map.remove("password");
                    }
                }
                _ => {}
            }
            emit(&out, &name, detail).await;
        }
    });
    let emit_fn: meron_core::chat::xmpp::Emit = Arc::new(move |name: &str, detail: Value| {
        let _ = etx.send((name.to_string(), detail));
    });
    let account_id = id.to_string();
    // Starts from the saved status, so nothing reports "available" before
    // the connection says how it went.
    let live = meron_core::chat::presence::Live::shared(&engine.db.lock().unwrap(), id);
    chat_live().lock().unwrap().insert(id.to_string(), live.clone());
    let options = meron_core::chat::xmpp::Options {
        room_password: Arc::new(move |room: &str| {
            secrets::load(&meron_core::chat::room_secret_key(&account_id, room))
                .ok()
                .map(|s| s.password)
                .filter(|p| !p.is_empty())
        }),
        file_roots: Vec::new(),
        live,
    };
    tokio::spawn(meron_core::chat::xmpp::run(account, password, engine.db.clone(), connector, rx, emit_fn, options));
    Ok(())
}

/// Hands a message to its account's connection; with none, it failed.
fn chat_dispatch(engine: &Arc<Engine>, message: &meron_core::chat::ChatMessage, mentions: Vec<String>) {
    let sent = chat_sessions().lock().unwrap().get(&message.account).is_some_and(|tx| {
        tx.send(meron_core::chat::xmpp::Command::Send {
            conversation: message.conversation.clone(),
            id: message.id.clone(),
            body: message.body.clone(),
            group: message.kind == meron_core::chat::KIND_GROUP,
            file: message.file_url.clone(),
            mentions,
        })
        .is_ok()
    });
    if !sent {
        let _ = meron_core::chat::set_state(&engine.db.lock().unwrap(), &message.account, &message.id, "failed");
    }
}

/// What each chat account's session knows about presence (ADR-0055): the
/// person's own status as applied, contacts, requests and room occupants.
fn chat_live() -> &'static std::sync::Mutex<std::collections::HashMap<String, meron_core::chat::presence::Shared>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, meron_core::chat::presence::Shared>>> =
        std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}

/// Each room's last known state (joining, joined, out, error), by account
/// and room, for the app to show.
fn chat_room_status() -> &'static std::sync::Mutex<std::collections::HashMap<(String, String), Value>> {
    static STATUS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<(String, String), Value>>> =
        std::sync::OnceLock::new();
    STATUS.get_or_init(Default::default)
}

/// Chat uploads running, each with its cancel flag.
fn chat_uploads() -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
        std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// A room's password goes to the keychain, never to the store.
fn store_room_password(account: &str, room: &str, password: &str) -> anyhow::Result<()> {
    secrets::store(
        &meron_core::chat::room_secret_key(account, room),
        &secrets::Secrets { password: password.to_string(), ..Default::default() },
    )
}

struct TranslationDownload {
    cancel: std::sync::atomic::AtomicBool,
    done: std::sync::atomic::AtomicU64,
    total: u64,
}

fn translation_downloads() -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<TranslationDownload>>> {
    static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<TranslationDownload>>>> =
        std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn translation_pair(p: &Value) -> anyhow::Result<&'static meron_core::translation::Pair> {
    let (from, to) = (req_str(p, "from")?, req_str(p, "to")?);
    meron_core::translation::pair(&from, &to).with_context(|| format!("there is no model from {from} to {to}"))
}

/// One download per model at a time; progress is reported about every
/// megabyte and the end, with what went wrong, once.
fn spawn_translation_download(out: Writer, pair: &'static meron_core::translation::Pair) {
    let key = pair.key();
    let state = Arc::new(TranslationDownload {
        cancel: std::sync::atomic::AtomicBool::new(false),
        done: std::sync::atomic::AtomicU64::new(0),
        total: pair.size(),
    });
    {
        let mut running = translation_downloads().lock().unwrap();
        if running.contains_key(&key) {
            return;
        }
        running.insert(key.clone(), state.clone());
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();
    let progress_out = out.clone();
    let progress_key = key.clone();
    tokio::spawn(async move {
        while let Some((done, total)) = rx.recv().await {
            emit(&progress_out, "translation.progress", json!({ "key": progress_key, "done": done, "total": total })).await;
        }
    });
    tokio::spawn(async move {
        let worker = state.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut last = 0u64;
            meron_core::translation::download(
                &meron_core::translation::models_dir(),
                pair,
                &meron_core::translation::Http,
                &worker.cancel,
                meron_core::translation::DEFAULT_QUOTA_BYTES,
                &mut |done, total| {
                    worker.done.store(done, std::sync::atomic::Ordering::Relaxed);
                    if done == 0 || done == total || done - last >= 1024 * 1024 {
                        last = done;
                        let _ = tx.send((done, total));
                    }
                },
            )
        })
        .await;
        translation_downloads().lock().unwrap().remove(&key);
        let error = match result {
            Ok(Ok(())) => Value::Null,
            Ok(Err(err)) => json!({ "message": err.to_string(), "detail": err }),
            Err(err) => json!({ "message": err.to_string(), "detail": { "code": "disk", "message": err.to_string() } }),
        };
        emit(&out, "translation.done", json!({ "key": key, "error": error })).await;
    });
}

fn merge_running() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// What one send's answer means for a mailing's message.
fn merge_outcome(result: anyhow::Result<Value>) -> meron_core::merge::Outcome {
    use meron_core::merge::Outcome;
    match result {
        Ok(answer) => match scheduled_outcome_of(&answer) {
            ScheduledOutcome::Sent => Outcome::Accepted,
            ScheduledOutcome::Uncertain(reason) => Outcome::Uncertain(reason),
            ScheduledOutcome::InFlight => Outcome::Uncertain("another send of this message was under way".into()),
        },
        Err(err) => {
            let reason = format!("{err:#}");
            if meron_core::merge::is_deferral(&reason) {
                Outcome::Deferred(reason)
            } else {
                Outcome::Rejected(reason)
            }
        }
    }
}

/// Sends a mailing's messages one at a time, spaced, for as long as it is
/// sending. Each message settles from its own answer before the next goes.
fn spawn_merge(engine: Arc<Engine>, out: Writer, id: String) {
    if !merge_running().lock().unwrap().insert(id.clone()) {
        return;
    }
    tokio::spawn(async move {
        loop {
            let (next, batch) = {
                let db = engine.db.lock().unwrap();
                let next = meron_core::merge::claim_next(&db, &id, now_seconds());
                (next, meron_core::merge::batch(&db, &id))
            };
            let (Ok(Some(item)), Ok(Some(batch))) = (next, batch) else { break };
            let to = if item.name.trim().is_empty() {
                item.to.clone()
            } else {
                format!("\"{}\" <{}>", item.name.replace('"', ""), item.to)
            };
            let request = json!({
                "account": batch.account,
                "from": batch.from,
                "to": to,
                "subject": item.subject,
                "body": item.body,
                "message_id": item.message_id,
                "attempt_id": item.message_id,
            });
            let outcome = merge_outcome(perform_send(&engine, &request).await);
            {
                let db = engine.db.lock().unwrap();
                if let Err(err) = meron_core::merge::settle(&db, &id, item.index, outcome, now_seconds()) {
                    eprintln!("meron-core: recording a mailing's message: {err:#}");
                }
            }
            emit(&out, "merge.changed", json!({ "id": id })).await;
            tokio::time::sleep(std::time::Duration::from_secs(batch.spacing.max(0) as u64)).await;
        }
        merge_running().lock().unwrap().remove(&id);
        emit(&out, "merge.changed", json!({ "id": id })).await;
    });
}

/// A scheduled message sent more than five minutes after its hour went late:
/// the app was not running, or the computer was asleep.
fn sent_late(due_at: i64, now: i64) -> bool {
    now - due_at > 300
}

/// Removes what must never be stored with a message waiting to go.
fn strip_send_secrets(message: &mut Value) {
    if let Some(object) = message.as_object_mut() {
        object.remove("passphrase");
    }
}

/// What a scheduled row's earlier attempt, if any, already settles.
///
/// Pure, so the rule can be tested without a server: a row whose attempt
/// was accepted has gone, however the process ended afterwards; one whose
/// attempt is uncertain stays uncertain; anything else is tried.
fn scheduled_send_precheck(earlier: Option<&outgoing::OutgoingAttempt>) -> Option<ScheduledOutcome> {
    let earlier = earlier?;
    match earlier.state {
        outgoing::AttemptState::Accepted | outgoing::AttemptState::Archived => Some(ScheduledOutcome::Sent),
        // Startup turns every attempt a dead process left "sending" into
        // "uncertain" before the watch starts, so one still sending now is in
        // flight in this process: the caller that started it settles it.
        outgoing::AttemptState::Sending => Some(ScheduledOutcome::InFlight),
        outgoing::AttemptState::Uncertain => Some(ScheduledOutcome::Uncertain(if earlier.error.is_empty() {
            "the application stopped while this message was being sent".to_string()
        } else {
            earlier.error.clone()
        })),
        outgoing::AttemptState::Rejected | outgoing::AttemptState::Resolved => None,
    }
}

/// Sends a scheduled message once, looking first at what an earlier try
/// already settled. A row still present after an accepted send is a crash
/// between sending and forgetting, not a message that never went: it is
/// reported as sent, never sent again.
async fn send_scheduled(
    engine: &Arc<Engine>,
    row: &store::ScheduledSend,
    message: &Value,
    resend: bool,
) -> anyhow::Result<ScheduledOutcome> {
    if !resend {
        let earlier = outgoing::attempt(&engine.db.lock().unwrap(), &row.id)?;
        if let Some(settled) = scheduled_send_precheck(earlier.as_ref()) {
            return Ok(settled);
        }
    }
    let mut request = message.clone();
    if let Some(object) = request.as_object_mut() {
        object.insert("attempt_id".to_string(), Value::String(row.id.clone()));
        object.insert("attempt_kind".to_string(), Value::String("scheduled".to_string()));
        object.insert("resend".to_string(), Value::Bool(resend));
    }
    let result = perform_send(engine, &request).await?;
    Ok(scheduled_outcome_of(&result))
}

/// One scheduled message as the interface reads it.
///
/// The payload is left out: it is the message itself, sometimes with megabytes
/// of attachment, and a list of what is waiting has no use for it.
fn scheduled_send_json(row: &store::ScheduledSend, uncertain: bool) -> Value {
    json!({
        "id": row.id,
        "account": row.account,
        "dueAt": row.due_at,
        "subject": row.subject,
        "to": serde_json::from_str::<Value>(&row.payload)
            .ok()
            .and_then(|message| message.get("to").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default(),
        "attempts": row.attempts,
        "lastError": row.last_error,
        // Whether the watch has stopped trying, so the interface can say so
        // rather than leave a failed message looking merely late.
        "gaveUp": row.attempts >= store::MAX_SEND_ATTEMPTS,
        // Whether it stopped because nobody knows if the message went: the
        // one case where "send now" is not the obvious next thing.
        "uncertain": uncertain,
    })
}

/// Sends one message, from the parameters the composer wrote.
///
/// Its own function because two callers need it and they must not drift: the
/// `send` request, and the watch that lets go of a message scheduled for
/// later. A message posted at eight has to be the same message in every
/// respect as the one that would have gone at six.
async fn perform_send(engine: &Arc<Engine>, p: &Value) -> anyhow::Result<Value> {
        meron_core::graph::mail::guard_command(&engine.db.lock().unwrap(),"send",p)?;
        let account = req_str(p, "account")?;
        let to = req_str(p, "to")?;
        // Every send is written down before it goes and settled after, so a
        // crash, a lost connection or a failed Sent copy can be told apart
        // from a refusal later. The id is the scheduled row's for a scheduled
        // message and the Message-ID for an immediate one, so trying the
        // same message again finds its own earlier attempt.
        let attempt_kind = match p.get("attempt_kind").and_then(Value::as_str) {
            Some("scheduled") => outgoing::AttemptKind::Scheduled,
            _ => outgoing::AttemptKind::Now,
        };
        let attempt_id = {
            let explicit = req_str(p, "attempt_id").unwrap_or_default();
            let message_id = req_str(p, "message_id").unwrap_or_default();
            if !explicit.trim().is_empty() {
                explicit.trim().to_string()
            } else if !message_id.trim().is_empty() {
                message_id.trim().to_string()
            } else {
                uuid::Uuid::new_v4().to_string()
            }
        };
        let resend = p.get("resend").and_then(Value::as_bool).unwrap_or(false);
        {
            let db = engine.db.lock().unwrap();
            // The same message tried again while its earlier attempt may
            // already have reached the recipient is not retried on a hunch:
            // the caller has to say so, having told the reader what it means.
            if let Some(earlier) = outgoing::attempt(&db, &attempt_id)? {
                if earlier.state.may_have_gone() && !resend {
                    return Ok(json!({
                        "ok": false,
                        "outcome": "already_attempted",
                        "attempt_id": attempt_id,
                        "state": earlier.state.as_str(),
                        "error": earlier.error,
                    }));
                }
            }
            outgoing::begin_attempt(
                &db,
                &attempt_id,
                &account,
                attempt_kind,
                &req_str(p, "message_id").unwrap_or_default(),
                p,
                now_seconds(),
            )?;
        }
        match perform_send_transaction(engine, p, &account, &to).await {
            Ok(SendTransaction { raw, archived_by_server, delivery_receipt, delivery_receipt_reason }) => {
                {
                    let db = engine.db.lock().unwrap();
                    outgoing::mark_accepted(&db, &attempt_id, now_seconds())?;
                }
                // Finalize the Sent view. For Gmail/Outlook defaults this only
                // refreshes the provider-created copy; other accounts get Meron's
                // best-effort APPEND plus refresh. The mail already left, so
                // Sent-folder issues are recorded, never reported as "send failed".
                let outcome = match append_to_sent(engine, &account, &raw).await {
                    Ok(()) => {
                        outgoing::mark_archived(&engine.db.lock().unwrap(), &attempt_id, now_seconds())?;
                        "archived"
                    }
                    Err(err) if archived_by_server => {
                        // The server filed its own copy; only the local view
                        // failed to refresh, which the next sync will mend.
                        eprintln!("meron-core: Sent refresh failed for {account}: {err:#}");
                        outgoing::mark_archived(&engine.db.lock().unwrap(), &attempt_id, now_seconds())?;
                        "archived"
                    }
                    Err(err) => {
                        eprintln!("meron-core: APPEND to Sent failed for {account}: {err:#}");
                        outgoing::mark_archive_failed(
                            &engine.db.lock().unwrap(),
                            &attempt_id,
                            &format!("{err:#}"),
                            now_seconds(),
                        )?;
                        "accepted"
                    }
                };
                let mut answer = json!({
                    "ok": true,
                    "outcome": outcome,
                    "attempt_id": attempt_id,
                    "delivery_receipt": delivery_receipt.as_str(),
                });
                // Why a delivery receipt asked for on Graph was not requested
                // (#210): "needsChanges", "bcc" or "protected".
                if let Some(reason) = delivery_receipt_reason {
                    answer["delivery_receipt_reason"] = json!(reason);
                }
                Ok(answer)
            }
            Err(err) if smtp::is_uncertain(&err) => {
                let reason = format!("{err:#}");
                outgoing::mark_uncertain(&engine.db.lock().unwrap(), &attempt_id, &reason, now_seconds())?;
                Ok(json!({ "ok": false, "outcome": "uncertain", "attempt_id": attempt_id, "error": reason }))
            }
            Err(err) => {
                outgoing::mark_rejected(&engine.db.lock().unwrap(), &attempt_id, &format!("{err:#}"), now_seconds())?;
                Err(err)
            }
        }
}

/// What a completed transaction hands back: the message as it should be
/// filed in Sent, and whether the server already filed it itself.
struct SendTransaction {
    raw: Vec<u8>,
    archived_by_server: bool,
    /// What became of a delivery receipt request (ADR-0048).
    delivery_receipt: smtp::DeliveryReceipt,
    /// Why a delivery receipt the sender asked for was not requested, when
    /// the route could have carried one (#210).
    delivery_receipt_reason: Option<&'static str>,
}

/// Builds, protects and transmits one message. Everything up to the server's
/// answer; nothing about recording it, which [`perform_send`] does around
/// this so the record is kept whichever way this returns.
async fn perform_send_transaction(
    engine: &Arc<Engine>,
    p: &Value,
    account: &str,
    to: &str,
) -> anyhow::Result<SendTransaction> {
        let account = account.to_string();
        let to = to.to_string();
        let cc = req_str(p, "cc").unwrap_or_default();
        let bcc = req_str(p, "bcc").unwrap_or_default();
        let subject = req_str(p, "subject").unwrap_or_default();
        let body = req_str(p, "body").unwrap_or_default();
        let html = req_str(p, "html").unwrap_or_default();
        let in_reply_to = req_str(p, "in_reply_to").unwrap_or_default();
        let references = req_str(p, "references").unwrap_or_default();
        let reply_to = req_str(p, "reply_to").unwrap_or_default();
        // Client-generated Message-ID so the optimistic bubble and a quick
        // follow-up reply share the id the Sent copy will carry.
        let message_id = req_str(p, "message_id").unwrap_or_default();
        let attachments = opt_attachments(p)?;
        let requested_from = req_str(p, "from").unwrap_or_default();
        // Receipts the sender asked for (ADR-0048).
        let receipts = smtp::Receipts {
            read: p.get("read_receipt").and_then(Value::as_bool).unwrap_or(false),
            delivery: p.get("delivery_receipt").and_then(Value::as_bool).unwrap_or(false),
        };

        // Sign and/or encrypt, when the sender asked for it — with whichever
        // protocol can actually do the whole job. Assembled here, before
        // anything is sent, so a request neither protocol can satisfy fails
        // loudly instead of the message quietly going out in the clear.
        //
        // The choice between OpenPGP and S/MIME is not put to the sender:
        // one "sign"/"encrypt" pair covers both, and this picks S/MIME
        // whenever it alone can cover the sender (if signing) and every
        // recipient (if encrypting), falling back to OpenPGP otherwise. A
        // message is never protected with a mix of the two.
        let protection = {
            let sign = p.get("sign").and_then(Value::as_bool).unwrap_or(false);
            let encrypt = p.get("encrypt").and_then(Value::as_bool).unwrap_or(false);
            if !sign && !encrypt {
                None
            } else {
                let addresses: Vec<String> = [to.as_str(), cc.as_str(), bcc.as_str()]
                    .iter()
                    .flat_map(|field| meron_core::parse::split_address_list(field))
                    .collect();
                let wanted = requested_from.trim().to_lowercase();

                let (smime_identity, smime_recipients, pgp_signing_key, pgp_recipients) = {
                    let db = engine.db.lock().unwrap();

                    let smime_identity = if sign {
                        store::smime_identities(&db)?
                            .into_iter()
                            .find(|id| wanted.is_empty() || id.addresses.iter().any(|a| *a == wanted))
                            .and_then(|stored| {
                                let secrets = meron_core::secrets::load(&format!(
                                    "smime-identity-{}",
                                    stored.fingerprint
                                ))
                                .ok()?;
                                let key_der = {
                                    use base64::Engine as _;
                                    base64::engine::general_purpose::STANDARD
                                        .decode(secrets.password.trim())
                                        .ok()?
                                };
                                meron_core::crypto::pkcs12::identity_from_parts(&stored.der, &key_der).ok()
                            })
                    } else {
                        None
                    };
                    let smime_recipients = if encrypt {
                        let der: Vec<Vec<u8>> =
                            store::smime_certs(&db)?.into_iter().map(|cert| cert.der).collect();
                        meron_core::crypto::smime::certs_from_der(&der)
                    } else {
                        Vec::new()
                    };

                    // The sender's own key, chosen by the address they are
                    // sending from: somebody with two keys should sign as
                    // whoever they are being right now.
                    let pgp_signing_key = if sign {
                        store::pgp_secret_keys(&db)?
                            .into_iter()
                            .find(|key| {
                                wanted.is_empty()
                                    || key.addresses.iter().any(|addr| *addr == wanted)
                            })
                            .and_then(|key| {
                                meron_core::secrets::load(&format!(
                                    "pgp-secret-{}",
                                    key.fingerprint
                                ))
                                .ok()
                                .map(|secrets| secrets.password)
                            })
                            .map(|armoured| {
                                meron_core::crypto::pgp::certs_from_armoured(&[armoured])
                            })
                            .and_then(|certs| certs.into_iter().next())
                    } else {
                        None
                    };
                    let pgp_recipients = if encrypt {
                        let armoured: Vec<String> = store::pgp_certs(&db)?
                            .into_iter()
                            .map(|cert| cert.armoured)
                            .collect();
                        meron_core::crypto::pgp::certs_from_armoured(&armoured)
                    } else {
                        Vec::new()
                    };

                    (smime_identity, smime_recipients, pgp_signing_key, pgp_recipients)
                };

                let smime_missing = meron_core::crypto::smime::missing_recipients(&smime_recipients, &addresses);
                let smime_ok = (!sign || smime_identity.is_some()) && (!encrypt || smime_missing.is_empty());

                if smime_ok {
                    Some(smtp::Protection::Smime {
                        what: meron_core::crypto::smime::Protect { sign, encrypt },
                        identity: smime_identity,
                        recipients: smime_recipients,
                        recipient_addresses: addresses,
                    })
                } else {
                    Some(smtp::Protection::Pgp {
                        what: meron_core::crypto::pgp::Protect { sign, encrypt },
                        signing_key: pgp_signing_key,
                        passphrase: req_str(p, "passphrase").ok(),
                        recipients: pgp_recipients,
                        recipient_addresses: addresses,
                    })
                }
            }
        };
        let creds = engine.ensure_valid_creds(&account).await?;
        if creds.is_local() {
            anyhow::bail!("the local archive cannot send mail: choose one of your accounts as the sender");
        }
        let (from_addr, sender_name) =
            resolve_send_from(engine, &account, &creds, &requested_from)?;
        if creds.is_ews() || creds.is_graph() {
            // Exchange and Microsoft Graph (#143) submit the MIME themselves
            // and file the Sent copy, so there is no separate append.
            //
            // The Bcc header is written into the message here, unlike the
            // SMTP path: SMTP carries blind recipients in the envelope,
            // while Exchange has only the MIME to read them from. It
            // strips the header before delivering, so recipients still do
            // not see the list.
            //
            // Signing and encryption are applied here too. Before, this branch
            // built the MIME without them, so a message the sender asked to
            // encrypt went to Exchange in the clear.
            let raw = smtp::build_submission(
                &sender_name,
                &from_addr,
                &to,
                &cc,
                &bcc,
                &subject,
                &body,
                &html,
                &attachments,
                &in_reply_to,
                &references,
                &reply_to,
                &message_id,
                protection.as_ref(),
                receipts.read,
            )?;
            // A delivery receipt is a property of the message on Graph, set
            // on a draft before it is sent, so it is asked for only where the
            // account allows changes as well as sending (#210, ADR-0057).
            // Exchange takes it on the item it submits, next to the MIME
            // (`IsDeliveryReceiptRequested`, ADR-0058). Where it cannot be
            // carried the message goes without one, and the sender is told.
            // Nor, until a real tenant shows a draft keeps them, for a message
            // with Bcc recipients or signed or encrypted: those go as before.
            let asked = receipts.delivery;
            let has_bcc = !bcc.trim().is_empty();
            let protected = protection.is_some();
            let (delivery_receipt, delivery_receipt_reason) = engine
                .with_write_session(&account, |session| {
                    let raw = raw.clone();
                    Box::pin(async move { session.send_mime_with_receipt(raw, asked, has_bcc, protected).await })
                })
                .await
                .map_err(if creds.is_graph() { classify_graph_send_error } else { classify_ews_send_error })?;
            // The server files its own copy, so the caller's Sent step only
            // refreshes the local view — the upload is suppressed for
            // Exchange in `should_append_sent_copy`.
            return Ok(SendTransaction { raw, archived_by_server: true, delivery_receipt, delivery_receipt_reason });
        }
        // What the sender asked for, with the keys it needs: built before
        // either branch, and applied by both, so no path sends in the clear
        // what was meant to be protected.
        let sent = smtp::send_with_receipts(
            &creds,
            &from_addr,
            &sender_name,
            &to,
            &cc,
            &bcc,
            &subject,
            &body,
            &html,
            &attachments,
            &in_reply_to,
            &references,
            &reply_to,
            &message_id,
            protection.as_ref(),
            receipts,
        )
        .await?;
        Ok(SendTransaction {
            raw: sent.raw,
            archived_by_server: false,
            delivery_receipt: sent.delivery_receipt,
            delivery_receipt_reason: None,
        })
}

/// An Exchange submission that failed without a verdict.
///
/// EWS submits and files in one call, so there is no data phase to watch:
/// a SOAP fault or a refused request is a refusal, while a connection that
/// broke or a reply that never came after the request went out leaves the
/// same doubt as a lost SMTP reply, and is marked the same way.
fn classify_ews_send_error(err: anyhow::Error) -> anyhow::Error {
    let transport_lost = err.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some()
            || cause.downcast_ref::<tokio::time::error::Elapsed>().is_some()
            || cause
                .downcast_ref::<ureq::Error>()
                .is_some_and(|e| matches!(e, ureq::Error::Io(_) | ureq::Error::Timeout(_)))
    });
    if transport_lost {
        err.context(smtp::UncertainSend)
    } else {
        err
    }
}

/// A Microsoft Graph submission that failed (#143).
///
/// sendMail answers 202 when it accepts a message. A connection lost after
/// the request went out, or a 5xx (a gateway can time out after Microsoft
/// accepted it), leaves the outcome unknown: marked like a lost SMTP reply and
/// never retried. A 4xx, a throttle or a message refused before sending as too
/// large is a refusal: nothing was accepted.
fn classify_graph_send_error(err: anyhow::Error) -> anyhow::Error {
    use meron_core::graph::ErrorKind;
    // A send that stopped before Microsoft was asked to send (#210): nothing
    // left, whatever went wrong, so it is a refusal and never uncertain.
    let not_sent = err.downcast_ref::<meron_core::graph::NotSent>().cloned();
    let kind = match &not_sent {
        Some(not_sent) => Some(not_sent.error.kind),
        None => err.chain().find_map(|cause| cause.downcast_ref::<meron_core::graph::Error>()).map(|e| e.kind),
    };
    match kind {
        Some(ErrorKind::Uncertain | ErrorKind::Unavailable) if not_sent.is_some() => err,
        Some(ErrorKind::ConsentRequired) if not_sent.is_some() => err.context(
            "a delivery receipt needs this account to allow changes; allow them in the account settings, or send without one",
        ),
        Some(ErrorKind::Uncertain | ErrorKind::Unavailable) => err.context(smtp::UncertainSend),
        Some(ErrorKind::TooLarge) => err.context(format!(
            "too large to send through Microsoft Graph (limit {} MB including attachments)",
            meron_core::graph::MAX_SEND_REQUEST / (1024 * 1024)
        )),
        Some(ErrorKind::ConsentRequired) => {
            err.context("this account does not allow sending yet; allow it in the account settings")
        }
        _ => err,
    }
}

fn req_str(params: &Value, key: &str) -> anyhow::Result<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("missing string param: {key}"))
}

fn req_bool(params: &Value, key: &str) -> anyhow::Result<bool> {
    params
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow::anyhow!("missing bool param: {key}"))
}

fn req_u16(params: &Value, key: &str) -> anyhow::Result<u16> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as u16)
        .ok_or_else(|| anyhow::anyhow!("missing number param: {key}"))
}

fn req_i64(params: &Value, key: &str) -> anyhow::Result<i64> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .with_context(|| format!("missing number param: {key}"))
}

fn req_u32(params: &Value, key: &str) -> anyhow::Result<u32> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .ok_or_else(|| anyhow::anyhow!("missing number param: {key}"))
}

/// A certificate pin parameter: hex, normalized, with blank treated as absent.
fn cert_pin_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|pin| !pin.is_empty())
        .map(|pin| pin.to_ascii_lowercase())
}

fn req_str_array(params: &Value, key: &str) -> anyhow::Result<Vec<String>> {
    let arr = params
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("missing array param: {key}"))?;
    let mut out = Vec::new();
    for v in arr {
        if let Some(s) = v.as_str() {
            out.push(s.to_string());
        } else {
            return Err(anyhow::anyhow!("array element is not a string"));
        }
    }
    Ok(out)
}

/// IMAP APPEND a freshly-sent message to the account's Sent folder, with
/// `\Seen`. Best-effort: callers log and ignore errors so SMTP success doesn't
/// surface as "send failed" when the server's Sent folder is unusual.
///
/// After the APPEND succeeds we also fetch the most recent envelopes from the
/// Sent folder and upsert them into the local store. Without this, the just-
/// sent message would only land in the DB at the next periodic sync — meaning
/// it wouldn't appear in the thread view until the user reconnects or refreshes.
/// Resolve the outgoing From address + display name for a send/draft, deferring
/// to the shared store rule so desktop and mobile accept the same identities.
/// An unowned address is an error, surfaced to the composer rather than sent
/// under a substituted sender.
fn resolve_send_from(
    engine: &Arc<Engine>,
    account: &str,
    creds: &imap::Creds,
    requested_from: &str,
) -> anyhow::Result<(String, String)> {
    let db = engine.db.lock().unwrap();
    store::resolve_send_from(&db, account, &creds.user, requested_from)
}

async fn write_line(out: &Writer, value: Value) {
    let mut line = value.to_string();
    line.push('\n');
    let mut guard = out.lock().await;
    let _ = guard.write_all(line.as_bytes()).await;
    let _ = guard.flush().await;
}

async fn emit(out: &Writer, name: &str, detail: Value) {
    write_line(out, json!({ "event": name, "detail": detail })).await;
}

/// The shared commands' event channel (`pim::Emit`), written to stdout like
/// every other event.
fn emitter(out: &Writer) -> pim::Emit {
    let out = out.clone();
    Arc::new(move |name, detail| {
        let out = out.clone();
        Box::pin(async move { emit(&out, name, detail).await })
    })
}

/// Refreshes a calendar window in the background (`pim::calendar::spawn_sync`),
/// reporting on stdout.
fn spawn_calendar_sync(engine: Arc<Engine>, out: Writer, account: String, from: i64, to: i64) {
    pim::calendar::spawn_sync(engine, emitter(&out), account, from, to);
}

async fn respond(out: &Writer, id: u64, result: Value) {
    write_line(out, json!({ "id": id, "result": result })).await;
}

async fn respond_error(out: &Writer, id: u64, message: &str) {
    write_line(out, json!({ "id": id, "error": { "message": message } })).await;
}
