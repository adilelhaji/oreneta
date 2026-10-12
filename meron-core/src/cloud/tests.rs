use super::*;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};

type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

/// A server on this machine that answers like Nextcloud, as each test says,
/// and keeps every request it got: method, path and body.
fn server(answer: impl Fn(&str, &str, &str) -> (u16, String) + Send + 'static) -> (String, Seen) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::default();
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            if reader.read_line(&mut first).is_err() || first.is_empty() {
                continue;
            }
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            let body = String::from_utf8_lossy(&body).to_string();
            let (status, reply) = answer(&method, &path, &body);
            log.lock().unwrap().push((method, path, body));
            let mut stream = stream;
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (format!("http://127.0.0.1:{port}"), seen)
}

fn account(server: &str) -> CloudAccount {
    CloudAccount {
        id: "c1".into(),
        provider: "nextcloud".into(),
        name: "Office".into(),
        server: server.into(),
        username: "ana maria".into(),
        folder: "Oreneta/Shared".into(),
    }
}

fn file(name: &str, bytes: usize) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("oreneta-cloud-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, vec![b'x'; bytes]).unwrap();
    path
}

fn caps() -> Capabilities {
    Capabilities { links: true, ..Default::default() }
}

const SHARE_OK: &str = r#"{"ocs":{"meta":{"status":"ok"},"data":{"id":"42","url":"http://127.0.0.1/s/AbC","permissions":1,"expiration":"2026-10-20 00:00:00","share_with":"$2y$hash"}}}"#;

#[test]
fn accounts_are_kept_without_their_password_and_only_for_usable_providers() {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::run_migrations(&conn).unwrap();
    let mut a = account("https://cloud.example.org/");
    save(&conn, &a, 1).unwrap();
    assert_eq!(list(&conn).unwrap()[0].server, "https://cloud.example.org");
    a.provider = "dropbox".into();
    assert!(save(&conn, &a, 1).is_err(), "no registration yet");
    a.provider = "nextcloud".into();
    a.server = "http://cloud.example.org".into();
    assert!(save(&conn, &a, 1).is_err(), "an app password never goes in clear");
    a.server = "https://cloud.example.org".into();
    a.folder = "../../etc".into();
    assert!(save(&conn, &a, 1).is_err());
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('cloud_accounts')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!columns.iter().any(|c| c.contains("password") || c.contains("token")));
    remove(&conn, "c1").unwrap();
    assert!(list(&conn).unwrap().is_empty());
}

#[test]
fn what_the_server_allows_is_read_from_its_capabilities() {
    let caps = parse_capabilities(
        r#"{"ocs":{"data":{"capabilities":{"files_sharing":{"public":{"enabled":true,"password":{"enforced":true},"expire_date":{"enabled":true,"days":7,"enforced":true}}}}}}}"#,
    )
    .unwrap();
    assert_eq!(
        caps,
        Capabilities { links: true, password_enforced: true, expiry_enforced: true, expiry_max_days: Some(7) }
    );
    assert!(!parse_capabilities(r#"{"ocs":{"data":{"capabilities":{}}}}"#).unwrap().links);
    assert!(parse_capabilities("<html>").is_err());
}

#[test]
fn a_file_is_uploaded_into_its_folder_under_a_name_not_taken() {
    let (url, seen) = server(|method, path, _| match (method, path) {
        ("MKCOL", p) if p.ends_with("/Oreneta") => (405, String::new()),
        ("MKCOL", _) => (201, String::new()),
        ("HEAD", p) if p.ends_with("/Shared/quote.pdf") => (200, String::new()),
        ("HEAD", _) => (404, String::new()),
        ("PUT", _) => (201, String::new()),
        _ => (500, String::new()),
    });
    let path = file("quote.pdf", 300_000);
    let mut last = 0;
    let target = upload(&account(&url), "app-pass", &path, &AtomicBool::new(false), &mut |done| last = done).unwrap();
    assert_eq!(target, "Oreneta/Shared/quote (2).pdf");
    assert_eq!(last, 300_000);
    let seen = seen.lock().unwrap();
    let put = seen.iter().find(|(m, _, _)| m == "PUT").unwrap();
    assert_eq!(put.1, "/remote.php/dav/files/ana%20maria/Oreneta/Shared/quote%20%282%29.pdf");
    assert_eq!(put.2.len(), 300_000);
}

#[test]
fn a_revoked_password_and_a_full_storage_are_said_and_leave_nothing() {
    let (url, _) = server(|_, _, _| (401, String::new()));
    let err = upload(&account(&url), "old", &file("a.txt", 10), &AtomicBool::new(false), &mut |_| {}).unwrap_err();
    assert_eq!(err, CloudError::Revoked);

    let (url, seen) = server(|method, _, _| match method {
        "MKCOL" => (405, String::new()),
        "HEAD" => (404, String::new()),
        "PUT" => (507, "<d:error>Insufficient Storage</d:error>".into()),
        _ => (204, String::new()),
    });
    let err = upload(&account(&url), "p", &file("b.txt", 10), &AtomicBool::new(false), &mut |_| {}).unwrap_err();
    assert_eq!(err, CloudError::Quota);
    assert!(seen.lock().unwrap().iter().any(|(m, _, _)| m == "DELETE"), "a refused upload is cleaned up");
}

#[test]
fn a_cancelled_upload_stops_and_is_removed() {
    let (url, seen) = server(|method, _, _| match method {
        "MKCOL" => (405, String::new()),
        "HEAD" => (404, String::new()),
        _ => (204, String::new()),
    });
    let cancel = AtomicBool::new(false);
    let err = upload(&account(&url), "p", &file("big.bin", 2_000_000), &cancel, &mut |done| {
        if done > 100_000 {
            cancel.store(true, Ordering::Relaxed);
        }
    })
    .unwrap_err();
    assert_eq!(err, CloudError::Cancelled);
    assert!(seen.lock().unwrap().iter().any(|(m, _, _)| m == "DELETE"));
}

#[test]
fn a_link_is_view_only_with_what_was_asked_and_read_back() {
    let (url, seen) = server(|_, _, _| (200, SHARE_OK.into()));
    let want = LinkRequest { password: Some("horse-battery".into()), expires: Some("2026-10-20".into()) };
    let link = share(&account(&url), "p", "Oreneta/Shared/quote.pdf", &want, &caps()).unwrap();
    assert_eq!(
        link,
        Link {
            id: "42".into(),
            url: "http://127.0.0.1/s/AbC".into(),
            path: "Oreneta/Shared/quote.pdf".into(),
            view_only: true,
            expires: Some("2026-10-20".into()),
            password_protected: true,
        }
    );
    let body = &seen.lock().unwrap()[0].2;
    assert!(body.contains("shareType=3") && body.contains("permissions=1"));
    assert!(body.contains("expireDate=2026-10-20") && body.contains("password=horse-battery"));
}

#[test]
fn a_link_more_open_than_asked_is_withdrawn() {
    for reply in [
        // Editable.
        SHARE_OK.replace(r#""permissions":1"#, r#""permissions":15"#),
        // Expiry dropped or moved.
        SHARE_OK.replace(r#""expiration":"2026-10-20 00:00:00""#, r#""expiration":null"#),
        // No password kept.
        SHARE_OK.replace(r#""share_with":"$2y$hash""#, r#""share_with":null"#),
    ] {
        let (url, seen) = server(move |method, _, _| match method {
            "POST" => (200, reply.clone()),
            _ => (200, r#"{"ocs":{"data":[]}}"#.into()),
        });
        let want = LinkRequest { password: Some("pw".into()), expires: Some("2026-10-20".into()) };
        let err = share(&account(&url), "p", "f.pdf", &want, &caps()).unwrap_err();
        assert!(matches!(err, CloudError::PermissionMismatch { .. }), "{err:?}");
        let seen = seen.lock().unwrap();
        assert!(
            seen.iter().any(|(m, p, _)| m == "DELETE" && p.ends_with("/shares/42")),
            "the link is withdrawn"
        );
    }
}

#[test]
fn what_the_server_requires_is_asked_before_any_link_exists() {
    let (url, seen) = server(|_, _, _| (200, SHARE_OK.into()));
    let strict = Capabilities { links: true, password_enforced: true, expiry_enforced: true, expiry_max_days: Some(7) };
    let err = share(&account(&url), "p", "f", &LinkRequest::default(), &strict).unwrap_err();
    assert!(matches!(err, CloudError::Unsupported { .. }));
    let none = Capabilities::default();
    assert!(share(&account(&url), "p", "f", &LinkRequest::default(), &none).is_err());
    assert!(seen.lock().unwrap().is_empty(), "nothing was created");
}
