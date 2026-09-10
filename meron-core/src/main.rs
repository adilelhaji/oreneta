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
use meron_core::protocol::{Request, ping_response, ready_event};
use meron_core::{
    backup, cached_conversations, calendar, changelog, exchange, imap, mail_model, parse, priority, proxy, rss, rules,
    search, secrets, smtp, spam, store, thread_list, thread_read, unified,
};

/// Shared, serialized writer so responses and events never interleave on stdout.
type Writer = Arc<Mutex<Stdout>>;

const BACKGROUND_SYNC_RETRY_DELAY: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    Duration::from_secs(2)
};

fn is_transient_io_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::HostUnreachable
            | std::io::ErrorKind::NetworkUnreachable
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::UnexpectedEof
    )
}

fn is_transient_sync_error(error: &anyhow::Error) -> bool {
    if error.downcast_ref::<meron_core::graph::Error>().is_some() { return false; }
    for cause in error.chain() {
        if let Some(io_error) = cause.downcast_ref::<std::io::Error>()
            && is_transient_io_error(io_error)
        {
            return true;
        }
        if let Some(imap_error) = cause.downcast_ref::<async_imap::error::Error>() {
            match imap_error {
                async_imap::error::Error::ConnectionLost => return true,
                async_imap::error::Error::Io(io_error) if is_transient_io_error(io_error) => {
                    return true;
                }
                _ => {}
            }
        }
    }

    // Tokio timeouts and SOCKS reply codes are repository-generated anyhow
    // messages rather than typed sources. Keep this fallback narrow; protocol,
    // authentication, and certificate errors must not retry.
    let message = format!("{error:#}").to_ascii_lowercase();
    [
        "tcp connect",
        "dial tcp",
        "dns lookup",
        "timed out",
        "timeout",
        "network is unreachable",
        "network unreachable",
        "host unreachable",
        "connection refused",
        "connection reset",
        "connection abort",
        "connection closed",
        "connection lost",
        "broken pipe",
        "failed to lookup address",
        "no address associated with hostname",
        "server closed before greeting",
        "unexpected eof",
        "bytes remaining in stream",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

#[derive(Debug)]
struct BackgroundSyncCancelled;

impl std::fmt::Display for BackgroundSyncCancelled {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("background sync cancelled")
    }
}

impl std::error::Error for BackgroundSyncCancelled {}

/// Retry a background read once when it fails for a recognizable transport
/// reason. Both attempts share the configured per-folder ceiling so a stuck
/// sync does not hold its dedup key indefinitely.
async fn retry_background_sync<T, C, F, Fut>(
    label: &str,
    mut can_attempt: C,
    mut operation: F,
) -> anyhow::Result<T>
where
    C: FnMut() -> bool,
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    if !can_attempt() {
        return Err(anyhow::Error::new(BackgroundSyncCancelled));
    }
    let sync_timeout = background_sync_timeout();
    let deadline = tokio::time::Instant::now() + sync_timeout;
    let first = tokio::time::timeout_at(deadline, operation()).await;
    let first_error = match first {
        Ok(Ok(value)) => return Ok(value),
        Ok(Err(error)) if is_transient_sync_error(&error) => error,
        Ok(Err(error)) => return Err(error),
        Err(_) => anyhow::bail!("timed out after {}s", sync_timeout.as_secs()),
    };

    eprintln!("meron-core: {label} failed, retrying: {first_error:#}");
    if tokio::time::timeout_at(deadline, tokio::time::sleep(BACKGROUND_SYNC_RETRY_DELAY))
        .await
        .is_err()
    {
        return Err(first_error.context(format!(
            "retry budget exhausted after {}s",
            sync_timeout.as_secs()
        )));
    }
    if !can_attempt() {
        return Err(anyhow::Error::new(BackgroundSyncCancelled));
    }

    match tokio::time::timeout_at(deadline, operation()).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(retry_error)) => Err(anyhow::anyhow!(
            "retry failed: {retry_error:#}; first attempt: {first_error:#}"
        )),
        Err(_) => Err(first_error.context(format!(
            "retry timed out within the {}s sync budget",
            sync_timeout.as_secs()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{BackgroundSyncCancelled, is_transient_sync_error, retry_background_sync};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct GraphTestHost;
    impl meron_core::engine::EngineHost for GraphTestHost {
        fn open_db(&self) -> anyhow::Result<rusqlite::Connection> { meron_core::store::open_at(":memory:") }
        fn apply_secret(&self, _: &rusqlite::Connection, _: &str, _: &mut meron_core::imap::Creds) {}
        fn store_secret(&self, _: &rusqlite::Connection, _: &str, _: &meron_core::secrets::Secrets) -> anyhow::Result<()> { Ok(()) }
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
        for method in ["send","save_draft","discard_draft","messages.markRead","messages.markStarred","messages.delete","messages.move","messages.copy","messages.markAllRead","messages.emptyFolder","folders.create","folders.delete","mail.scheduleSend"] {
            let error=dispatch(&engine,&request(method,json!({"account":account})),&writer).await.unwrap_err();
            assert!(error.to_string().contains("read-only"),"{method}: {error}");
        }
        assert!(dispatch(&engine,&request("account.connect",json!({"account":account,"host":"should-not-dial"})),&writer).await.is_err());
        let list=dispatch(&engine,&request("account.list",json!({})),&writer).await.unwrap();
        assert_eq!(list["accounts"][0]["needs_reconnect"],true);
        assert!(!list.to_string().contains("access_token"));
    }
    #[test]
    fn graph_failures_do_not_enter_imap_retry_policy() {
        for kind in [meron_core::graph::ErrorKind::Throttled,meron_core::graph::ErrorKind::Transport,meron_core::graph::ErrorKind::Unavailable,meron_core::graph::ErrorKind::Reauthenticate] {
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

        let message = error.to_string();
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
                match perform_send(&engine, &message).await {
                    Ok(_) => {
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
                            }),
                        )
                        .await;
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
fn spawn_reminder_watch(engine: Arc<Engine>, out: Writer) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(REMINDER_TICK);
        loop {
            ticker.tick().await;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|epoch| epoch.as_secs() as i64)
                .unwrap_or_default();

            let accounts: Vec<String> =
                engine.accounts.lock().await.keys().cloned().collect();
            for account in accounts {
                if engine.is_paused(&account) || engine.is_muted(&account) {
                    continue;
                }
                let due = {
                    let db = engine.db.lock().unwrap();
                    calendar::due_reminders(&db, &account, now).unwrap_or_default()
                };
                for event in due {
                    {
                        let db = engine.db.lock().unwrap();
                        // Recorded before it is announced: a reminder given
                        // twice is worse than one lost to a crash in between.
                        if calendar::mark_reminder_fired(&db, &account, &event.id, now).is_err() {
                            continue;
                        }
                    }
                    emit(
                        &out,
                        "calendar.reminder",
                        json!({
                            "account": account,
                            "event": event.id,
                            "subject": event.subject,
                            "location": event.location,
                            "start": event.start,
                            "all_day": event.all_day,
                            "minutes": event.reminder_minutes,
                        }),
                    )
                    .await;
                }
            }
            let db = engine.db.lock().unwrap();
            let _ = calendar::forget_old_reminders(&db, now);
        }
    });
}

fn spawn_calendar_sync(
    engine: Arc<Engine>,
    out: Writer,
    account: String,
    from: i64,
    to: i64,
) {
    if engine.is_paused(&account) {
        return;
    }
    let key = format!("calendar:{account}:{from}:{to}");
    if !engine.syncing.lock().unwrap().insert(key.clone()) {
        return;
    }
    tokio::spawn(async move {
        let result = retry_background_sync(
            &format!("calendar sync for {account}"),
            || !engine.is_paused(&account),
            || sync_calendar_window(&engine, &account, from, to),
        )
        .await;
        engine.syncing.lock().unwrap().remove(&key);
        match result {
            Ok(_) => {
                emit(
                    &out,
                    "calendar.synced",
                    json!({ "account": account, "from": from, "to": to }),
                )
                .await
            }
            Err(e) if e.is::<BackgroundSyncCancelled>() => {}
            Err(e) => {
                emit(
                    &out,
                    "calendar.syncError",
                    json!({ "account": account, "message": format!("calendar sync: {e:#}") }),
                )
                .await
            }
        }
    });
}

/// Pulls the calendar list, then one window of occurrences per enabled
/// calendar.
///
/// A calendar the user hid is not fetched at all: the point of hiding one is
/// not to pay for it.
/// Now, as epoch seconds. A clock that cannot be read is treated as the epoch,
/// which shows as "never synced" rather than as a plausible wrong time.
fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|epoch| epoch.as_secs() as i64)
        .unwrap_or_default()
}

async fn sync_calendar_window(
    engine: &Arc<Engine>,
    account: &str,
    from: i64,
    to: i64,
) -> anyhow::Result<()> {
    let calendars = calendar::route::list_calendars(engine, account).await?;
    {
        let db = engine.db.lock().unwrap();
        // Only the account's own calendars are refreshed from the server;
        // local and subscribed ones are not its to report, and upserting the
        // server's answer over them would drop them.
        calendar::replace_account_calendars(&db, account, &calendars)?;
    }
    let wanted: Vec<calendar::Calendar> = {
        let db = engine.db.lock().unwrap();
        calendar::get_calendars(&db, account)?
            .into_iter()
            .filter(|calendar| calendar.enabled)
            .collect()
    };

    for calendar in wanted {
        match calendar.kind {
            // Nothing to fetch: its events only ever came from here.
            calendar::CalendarKind::Local => continue,
            calendar::CalendarKind::Subscribed => {
                let Some(url) = calendar.url.clone() else {
                    continue;
                };
                let id = calendar.id.clone();
                let body =
                    tokio::task::spawn_blocking(move || calendar::subscription::fetch(&url))
                        .await??;
                let (events, skipped) =
                    calendar::subscription::parse_window(&body, &id, from, to)?;
                if skipped > 0 {
                    meron_core::mlog!(
                        meron_core::log::Level::Warn,
                        "calendar",
                        "{id}: {skipped} entr(ies) in the published file could not be read"
                    );
                }
                let db = engine.db.lock().unwrap();
                calendar::replace_window(&db, account, &id, (from, to), &events)?;
                calendar::mark_calendar_synced(&db, account, &id, now_seconds())?;
            }
            calendar::CalendarKind::Account => {
                let id = calendar.id.clone();
                let events =
                    calendar::route::events_in_window(engine, account, &id, from, to).await?;
                // An occurrence with no series identifier cannot be edited as
                // a series, and nothing on screen would explain why. Said once
                // per sync rather than per event.
                let unidentified = events
                    .iter()
                    .filter(|event| event.is_recurring && event.series_id.is_none())
                    .count();
                if unidentified > 0 {
                    meron_core::mlog!(
                        meron_core::log::Level::Warn,
                        "calendar",
                        "{id}: {unidentified} recurring occurrence(s) arrived without a series id"
                    );
                }
                let db = engine.db.lock().unwrap();
                calendar::replace_window(&db, account, &id, (from, to), &events)?;
                calendar::mark_calendar_synced(&db, account, &id, now_seconds())?;
            }
        }
    }
    Ok(())
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
            Some(creds) if creds.is_ews() || creds.is_graph() => {
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

/// Read one CardDAV source into the address book, and record how it went.
///
/// Off the async runtime, because the DAV client is blocking HTTP. The
/// outcome is written to the source either way: a sync that failed leaves its
/// reason where the settings screen can show it, and a sync that succeeded
/// clears whatever the last one said.
async fn sync_contact_source(engine: &Arc<Engine>, id: &str) -> anyhow::Result<()> {
    let source = store::contact_source(&engine.db.lock().unwrap(), id)?
        .with_context(|| format!("no such contact source: {id}"))?;

    let fetched = match source.kind.as_str() {
        "carddav" => {
            let password = meron_core::secrets::load(id)
                .map(|secrets| secrets.password)
                .unwrap_or_default();
            let transport = meron_core::carddav::http::UreqTransport {
                username: source.username.clone(),
                password,
            };
            let url = source.url.clone();
            tokio::task::spawn_blocking(move || {
                meron_core::carddav::client::fetch_book(&transport, &url)
            })
            .await?
        }
        // The mail account's own token, refreshed if it had expired. The one
        // new thing asked of it is the contacts scope; a token from before
        // that existed is refused by Google and the refusal names the fix.
        "google" => match engine.ensure_valid_creds(&source.account).await {
            Ok(creds) if creds.auth_type == "gmail_oauth" => {
                let token = creds.access_token.clone().unwrap_or_default();
                if token.is_empty() {
                    Err(anyhow::anyhow!("account needs reconnect: {}", source.account))
                } else {
                    tokio::task::spawn_blocking(move || {
                        meron_core::contacts::google::fetch_connections(&token)
                    })
                    .await?
                }
            }
            Ok(_) => Err(anyhow::anyhow!("not a Google account: {}", source.account)),
            Err(error) => Err(error),
        },
        other => Err(anyhow::anyhow!("unknown contact source kind: {other}")),
    };

    let now = chrono::Utc::now().timestamp();
    let db = engine.db.lock().unwrap();
    match fetched {
        Ok(people) => {
            let origin = store::BookOrigin {
                source: source.kind.clone(),
                account: source.account.clone(),
                book: source.id.clone(),
            };
            // Photos are not cached yet; the key stays empty until they are.
            let rows: Vec<_> = people.into_iter().map(|person| (person, String::new())).collect();
            store::replace_book(&db, &origin, &rows, now)?;
            store::mark_contact_source_synced(&db, id, "", "", now)?;
            Ok(())
        }
        Err(error) => {
            store::mark_contact_source_synced(&db, id, "", &format!("{error:#}"), now)?;
            Err(error)
        }
    }
}

#[tokio::main]
async fn main() {
    // Tag panics consistently on stderr, which the desktop bridge copies into
    // meron.log; a panic in a worker task would otherwise be easy to miss.
    meron_core::log::install_panic_hook();
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
    spawn_reminder_watch(engine.clone(), out.clone());
    spawn_deferred_watch(engine.clone(), out.clone());

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
}

async fn dispatch(engine: &Arc<Engine>, req: &Request, out: &Writer) -> anyhow::Result<Value> {
    let p = &req.params;
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
            let begin = tokio::task::spawn_blocking(move || manager.begin(selected, &client, &redirect, route)).await??;
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
                proxy::set_global(proxy::parse_global(&value));
            }
            Ok(json!({ "ok": true }))
        }

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
            let candidates = {
                let db = engine.db.lock().unwrap();
                store::sweep_candidates(&db, &account, &folder, &from_addr, keep)?
            };
            Ok(json!({
                "from": from_addr,
                "folder": folder,
                "keepNewest": keep,
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
                        "thread_id": mail_model::format_thread_id(&task.account, &task.folder, &task.thread_key),
                        "account_id": task.account,
                        "folder_id": task.folder,
                        "note": task.note,
                        "due_at": task.due_at,
                        "completed_at": task.completed_at,
                        "created_at": task.created_at,
                        "subject": task.subject,
                        "from_name": task.from_name,
                        "from_addr": task.from_addr,
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
            let task = store::get_task(&db, id)?;
            Ok(match task {
                Some((due_at, note)) => json!({ "due_at": due_at, "note": note }),
                None => Value::Null,
            })
        }

        "tasks.setCompleted" => {
            let id = req_i64(p, "id")?;
            let completed = req_bool(p, "completed")?;
            let db = engine.db.lock().unwrap();
            store::set_task_completed(&db, id, completed, now_seconds())?;
            Ok(json!({ "ok": true }))
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
        "google.contacts.sync" => {
            let account = req_str(p, "account")?;
            let id = format!("google-{account}");
            let existing = store::contact_source(&engine.db.lock().unwrap(), &id)?;
            if existing.is_none() {
                store::upsert_contact_source(
                    &engine.db.lock().unwrap(),
                    &store::ContactSource {
                        id: id.clone(),
                        kind: "google".into(),
                        account: account.clone(),
                        url: String::new(),
                        username: String::new(),
                        name: req_str(p, "name").unwrap_or_default(),
                        enabled: true,
                        ctag: String::new(),
                        last_sync_at: 0,
                        last_error: String::new(),
                    },
                    chrono::Utc::now().timestamp(),
                )?;
            }
            let outcome = sync_contact_source(engine, &id).await;
            Ok(json!({ "id": id, "ok": outcome.is_ok(), "error": outcome.err().map(|e| format!("{e:#}")) }))
        }

        "carddav.sync" => {
            let id = req_str(p, "id")?;
            let outcome = sync_contact_source(engine, &id).await;
            Ok(json!({ "ok": outcome.is_ok(), "error": outcome.err().map(|e| format!("{e:#}")) }))
        }

        "carddav.list" => {
            let sources = store::contact_sources(&engine.db.lock().unwrap())?;
            Ok(json!({ "sources": sources }))
        }

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
        "people.list" => {
            let query = req_str(p, "query").unwrap_or_default();
            let limit = req_u32(p, "limit").unwrap_or(500);
            let found = store::find_people(&engine.db.lock().unwrap(), &query, limit)?;
            Ok(json!({
                "people": found
                    .iter()
                    .map(|stored| json!({
                        "id": stored.id,
                        "source": stored.origin.source,
                        "account": stored.origin.account,
                        "book": stored.origin.book,
                        "name": stored.person.name,
                        "organisation": stored.person.organisation,
                        "note": stored.person.note,
                        "photo": stored.photo_key,
                        "emails": stored.person.emails,
                        "phones": stored.person.phones,
                    }))
                    .collect::<Vec<_>>()
            }))
        }

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
            for header in &headers {
                let planned = rules::plan(&candidates, &account, &rule_subject(header));
                if planned.is_empty() {
                    continue;
                }
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
            Ok(json!({ "examined": headers.len(), "matches": hits }))
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
            let message = p.get("message").cloned().context("missing param: message")?;
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
            let rows = store::scheduled_sends(&engine.db.lock().unwrap(), account.as_deref())?;
            Ok(json!({ "messages": rows.iter().map(scheduled_send_json).collect::<Vec<_>>() }))
        }

        // Calls a scheduled send off and hands the message back, so its words
        // return to the composer instead of being taken away.
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
            match perform_send(engine, &message).await {
                Ok(_) => {
                    store::cancel_scheduled_send(&engine.db.lock().unwrap(), &id)?;
                    Ok(json!({ "ok": true }))
                }
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
                    if obj.get("auth_type").and_then(Value::as_str)==Some("graph_oauth") {
                        let status=meron_core::graph::mail::status(&engine.db.lock().unwrap(),&id);
                        let reconnect=status.as_ref().map_or(true,|s|matches!(s.error.as_deref(),Some("reauthenticate"|"consent_required"|"access_denied")));
                        obj.insert("needs_reconnect".into(),json!(reconnect));
                        continue;
                    }
                    let needs_reconnect = live_accounts
                        .get(&id)
                        .is_none_or(|creds| !creds_have_required_secret(creds));
                    obj.insert("needs_reconnect".to_string(), json!(needs_reconnect));
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
                if creds.is_ews() {
                    // Exchange carries mail and submission over one HTTPS
                    // endpoint, so a single round trip validates both.
                    let config = exchange::EwsConfig {
                        url: creds.ews_url.clone(),
                        username: creds.user.clone(),
                        password: creds.password.clone(),
                        target_mailbox: creds.target_mailbox.clone(),
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
        "calendar.list" => {
            let account = req_str(p, "account")?;
            let calendars = calendar::get_calendars(&engine.db.lock().unwrap(), &account)?;
            Ok(json!({ "calendars": serde_json::to_value(calendars)? }))
        }

        "calendar.setEnabled" => {
            let account = req_str(p, "account")?;
            let id = req_str(p, "calendar")?;
            let enabled = p
                .get("enabled")
                .and_then(Value::as_bool)
                .context("missing bool param: enabled")?;
            calendar::set_calendar_enabled(&engine.db.lock().unwrap(), &account, &id, enabled)?;
            Ok(json!({ "ok": true }))
        }

        // Answers from the cache and refreshes behind the request, the same
        // contract `folders.list` and `messages.recent` give: a view renders
        // at once and settles when the server answers.
        "calendar.events" => {
            let account = req_str(p, "account")?;
            let from = req_i64(p, "from")?;
            let to = req_i64(p, "to")?;
            if to <= from {
                anyhow::bail!("calendar window ends before it starts");
            }
            let events = calendar::events_in_window(
                &engine.db.lock().unwrap(),
                &account,
                (from, to),
            )?;
            if p.get("refresh").and_then(Value::as_bool).unwrap_or(true) {
                spawn_calendar_sync(engine.clone(), out.clone(), account, from, to);
            }
            Ok(json!({ "events": serde_json::to_value(events)? }))
        }

        // Writes go straight to the server and then refresh the window they
        // land in, so the agenda shows what the server actually stored rather
        // than what was asked for.
        // A local calendar has no server: it is a row here and nothing more,
        // which is exactly what the user asked for when they chose "on this
        // computer" — and what the interface must say, since nothing else has
        // a copy of it.
        "calendar.createLocal" => {
            let account = req_str(p, "account")?;
            let name = req_str(p, "name")?;
            if name.trim().is_empty() {
                anyhow::bail!("a calendar needs a name");
            }
            let id = format!("local:{}", uuid::Uuid::new_v4());
            calendar::upsert_calendars(
                &engine.db.lock().unwrap(),
                &account,
                &[calendar::Calendar {
                    id: id.clone(),
                    name,
                    kind: calendar::CalendarKind::Local,
                    enabled: true,
                    ..Default::default()
                }],
            )?;
            Ok(json!({ "id": id }))
        }

        // Subscribing fetches once before storing, so a wrong URL is reported
        // now rather than as a calendar that silently never fills.
        "calendar.subscribe" => {
            let account = req_str(p, "account")?;
            let name = req_str(p, "name")?;
            let url = req_str(p, "url")?;
            if !url.starts_with("https://") && !url.starts_with("http://") {
                anyhow::bail!("a subscription needs an http(s) URL");
            }
            let probe_url = url.clone();
            let body = tokio::task::spawn_blocking(move || {
                calendar::subscription::fetch(&probe_url)
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
        "calendar.eventDetails" => {
            let account = req_str(p, "account")?;
            let calendar_id = p.get("calendar").and_then(Value::as_str).unwrap_or_default();
            let event_id = req_str(p, "event")?;
            let change_key = p.get("change_key").and_then(Value::as_str).filter(|k| !k.is_empty());
            let (attendees, description) = calendar::route::event_details(
                &engine,
                &account,
                calendar_id,
                &event_id,
                change_key,
            )
            .await?;
            Ok(json!({
                "attendees": serde_json::to_value(attendees)?,
                "description": description,
            }))
        }

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
            calendar::route::delete_calendar(&engine, &account, &id, owned).await?;
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

        "calendar.create" => {
            let account = req_str(p, "account")?;
            let event: calendar::Event = serde_json::from_value(
                p.get("event").cloned().context("missing param: event")?,
            )
            .context("event")?;
            if event.end < event.start {
                anyhow::bail!("an event cannot end before it starts");
            }
            // Telling the people on an event is never assumed: the caller says
            // so only after the reader has confirmed it.
            let notify = p.get("notify").and_then(Value::as_bool).unwrap_or(false);
            let created = calendar::route::create_event(&engine, &account, &event, notify).await?;
            spawn_calendar_sync(
                engine.clone(),
                out.clone(),
                account,
                created.start,
                created.end.max(created.start + 1),
            );
            Ok(json!({ "event": serde_json::to_value(created)? }))
        }

        "calendar.update" => {
            let account = req_str(p, "account")?;
            let event: calendar::Event = serde_json::from_value(
                p.get("event").cloned().context("missing param: event")?,
            )
            .context("event")?;
            if event.end < event.start {
                anyhow::bail!("an event cannot end before it starts");
            }
            // Which of the two questions an edit answers: this day, or every
            // day the series falls on. Absent means this one, which is what a
            // caller that has never heard of series should get.
            let whole_series = p
                .get("scope")
                .and_then(Value::as_str)
                .is_some_and(|scope| scope == "series");
            let notify = p.get("notify").and_then(Value::as_bool).unwrap_or(false);
            calendar::route::update_event(&engine, &account, &event, whole_series, notify).await?;
            spawn_calendar_sync(
                engine.clone(),
                out.clone(),
                account,
                event.start,
                event.end.max(event.start + 1),
            );
            Ok(json!({ "ok": true }))
        }

        "calendar.delete" => {
            let account = req_str(p, "account")?;
            let id = req_str(p, "event")?;
            let change_key = p.get("change_key").and_then(Value::as_str);
            // Exchange addresses an event by its own id alone; Google needs
            // the calendar holding it, so it is taken from the cached row the
            // agenda is showing.
            let calendar_id = p
                .get("calendar")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            let whole_series = p
                .get("scope")
                .and_then(Value::as_str)
                .is_some_and(|scope| scope == "series");
            let series_id = p.get("series").and_then(Value::as_str);
            calendar::route::delete_event(
                &engine,
                &account,
                &calendar_id,
                &id,
                change_key,
                series_id,
                whole_series,
                p.get("notify").and_then(Value::as_bool).unwrap_or(false),
            )
            .await?;
            // Drop the cached rows now: the agenda should not keep showing what
            // the server has already accepted the deletion of. A series takes
            // all of its occurrences with it.
            {
                let db = engine.db.lock().unwrap();
                match (whole_series, series_id) {
                    (true, Some(series)) => {
                        calendar::forget_series(&db, &account, series)?;
                    }
                    _ => calendar::forget_event(&db, &account, &id)?,
                }
            }
            Ok(json!({ "ok": true }))
        }

        "folders.list" => {
            let account = req_str(p, "account")?;
            if is_rss(engine, &account)? {
                let folders = rss::folders(&engine.db.lock().unwrap(), &account)?;
                return Ok(json!({ "folders": folders }));
            }
            let mut folders = serde_json::to_value(store::get_folders(&engine.db.lock().unwrap(), &account)?)?;
            meron_core::graph::mail::decorate_folders(&engine.db.lock().unwrap(),&account,&mut folders)?;
            if p.get("refresh").and_then(Value::as_bool).unwrap_or(true) {
                spawn_folder_sync(engine.clone(), out.clone(), account);
            }
            Ok(json!({ "folders": folders }))
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

            let folder = imap::Folder {
                name,
                display_name,
                delimiter: None,
                ..Default::default()
            };
            {
                let db = engine.db.lock().unwrap();
                store::upsert_folders(&db, &account, std::slice::from_ref(&folder))?;
            }
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
                meron_core::tls::probe(&host, port, &protocol, starttls, proxy.resolve().as_ref())
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
                let db = engine.db.lock().unwrap();
                store::delete_account(&db, dependent)?;
            }
            engine.accounts.lock().await.remove(&id);
            // Drop any warm sessions: their creds are gone and must not be reused.
            engine.clear_pool(&id);
            {
                let db = engine.db.lock().unwrap();
                store::delete_account(&db, &id)?;
            }
            parse::remove_account_media(&parse::media_root(), &id);
            let _ = secrets::delete(&id);
            Ok(json!({ "ok": true }))
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
                                anyhow::bail!("custom wallpaper URL must be a Meron wallpaper");
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

        // Set or clear the account's UI avatar URL/path.
        "account.setAvatar" => {
            let id = req_str(p, "account").or_else(|_| req_str(p, "id"))?;
            let avatar_url = req_str(p, "avatar_url").unwrap_or_default();
            {
                let db = engine.db.lock().unwrap();
                db.execute(
                    "UPDATE accounts SET avatar_url = ?1, updated_at = strftime('%s', 'now') WHERE id = ?2",
                    rusqlite::params![avatar_url.trim(), id],
                )?;
            }
            Ok(json!({ "ok": true }))
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
    let rules = stored_rules(engine);
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
    if creds.is_ews() || creds.is_graph() {
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
    })
}

/// One scheduled message as the interface reads it.
///
/// The payload is left out: it is the message itself, sometimes with megabytes
/// of attachment, and a list of what is waiting has no use for it.
fn scheduled_send_json(row: &store::ScheduledSend) -> Value {
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
        let (from_addr, sender_name) =
            resolve_send_from(engine, &account, &creds, &requested_from)?;
        if creds.is_ews() {
            // Exchange submits the MIME itself and files the Sent copy in
            // the same call, so there is no separate append.
            //
            // The Bcc header is written into the message here, unlike the
            // SMTP path: SMTP carries blind recipients in the envelope,
            // while Exchange has only the MIME to read them from. It
            // strips the header before delivering, so recipients still do
            // not see the list.
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
                &message_id,
            )?;
            engine
                .with_write_session(&account, |session| {
                    let raw = raw.clone();
                    Box::pin(async move { session.send_mime(raw).await })
                })
                .await?;
            // The server files its own copy, so this only refreshes the
            // local Sent view — the upload is suppressed for Exchange in
            // `should_append_sent_copy`.
            if let Err(err) = append_to_sent(engine, &account, &raw).await {
                eprintln!("meron-core: Sent refresh failed for {account}: {err:#}");
            }
            return Ok(json!({ "ok": true }));
        }
        // What the sender asked for, with the keys it needs. Built before the
        // Exchange branch above would have returned, so a request to protect a
        // message on an account that cannot do it fails loudly rather than
        // sending it in the clear.
        let raw = smtp::send(
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
        )
        .await?;
        // Finalize the Sent view. For Gmail/Outlook defaults this only
        // refreshes the provider-created copy; other accounts get Meron's
        // best-effort APPEND plus refresh. The mail already left via SMTP,
        // so Sent-folder issues should not surface as "send failed".
        if let Err(err) = append_to_sent(engine, &account, &raw).await {
            eprintln!("meron-core: APPEND to Sent failed for {account}: {err:#}");
        }
        Ok(json!({ "ok": true }))
    
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

async fn respond(out: &Writer, id: u64, result: Value) {
    write_line(out, json!({ "id": id, "result": result })).await;
}

async fn respond_error(out: &Writer, id: u64, message: &str) {
    write_line(out, json!({ "id": id, "error": { "message": message } })).await;
}
