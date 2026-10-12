use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A POP3 mailbox the fake server serves, and what it was asked.
#[derive(Default)]
struct Mailbox {
    messages: Vec<(String, Vec<u8>)>,
    /// Cut the connection partway through this message's download.
    cut_retr: Option<usize>,
    /// Drop the connection instead of answering QUIT.
    lose_quit: bool,
    stls: bool,
    password: String,
    commands: Vec<String>,
}

type Shared = Arc<Mutex<Mailbox>>;

fn mail(subject: &str, body: &str) -> Vec<u8> {
    format!(
        "From: Ana <ana@example.test>\r\nTo: pau@example.test\r\nSubject: {subject}\r\n\
         Message-ID: <{subject}@example.test>\r\nDate: Mon, 5 Oct 2026 09:00:00 +0000\r\n\r\n{body}\r\n"
    )
    .into_bytes()
}

async fn put<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(io: &mut BufReader<S>, text: String) {
    let _ = io.get_mut().write_all(text.as_bytes()).await;
}

/// Serves one session on `stream` the way a POP3 server would: deletions
/// marked with DELE happen only on a clean QUIT.
async fn serve<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send>(stream: S, mailbox: Shared) {
    let mut io = BufReader::new(stream);
    let mut marked: HashSet<usize> = HashSet::new();
    put(&mut io, "+OK ready\r\n".into()).await;
    loop {
        let mut line = String::new();
        if io.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end().to_string();
        mailbox.lock().unwrap().commands.push(line.clone());
        let mut words = line.split_whitespace();
        let verb = words.next().unwrap_or_default().to_ascii_uppercase();
        let arg = words.next().unwrap_or_default().to_string();
        let (reply, cut) = {
            let m = mailbox.lock().unwrap();
            let mut cut = false;
            let reply: String = 
            match verb.as_str() {
                "CAPA" => format!("+OK\r\nUSER\r\nUIDL\r\n{}.\r\n", if m.stls { "STLS\r\n" } else { "" }),
                "USER" => "+OK\r\n".into(),
                "PASS" if arg == m.password => "+OK\r\n".into(),
                "PASS" => "-ERR [AUTH] invalid credentials\r\n".into(),
                "UIDL" => {
                    let mut out = "+OK\r\n".to_string();
                    for (i, (uidl, _)) in m.messages.iter().enumerate() {
                        out.push_str(&format!("{} {uidl}\r\n", i + 1));
                    }
                    out + ".\r\n"
                }
                "LIST" => {
                    let mut out = "+OK\r\n".to_string();
                    for (i, (_, raw)) in m.messages.iter().enumerate() {
                        out.push_str(&format!("{} {}\r\n", i + 1, raw.len()));
                    }
                    out + ".\r\n"
                }
                "RETR" => {
                    let n: usize = arg.parse().unwrap();
                    let raw = String::from_utf8(m.messages[n - 1].1.clone()).unwrap();
                    // Dot-stuffed, as on the wire.
                    let body: String = raw
                        .split_inclusive("\r\n")
                        .map(|l| if l.starts_with('.') { format!(".{l}") } else { l.to_string() })
                        .collect();
                    if m.cut_retr == Some(n) {
                        cut = true;
                        format!("+OK\r\n{}", &body[..body.len() / 2])
                    } else {
                        format!("+OK\r\n{body}.\r\n")
                    }
                }
                "DELE" => {
                    marked.insert(arg.parse::<usize>().unwrap());
                    "+OK\r\n".into()
                }
                "QUIT" => {
                    cut = m.lose_quit;
                    String::new()
                }
                _ => "-ERR unknown\r\n".into(),
            };
            (reply, cut)
        };
        if cut {
            // The connection drops here: half a message, or no answer to QUIT.
            put(&mut io, reply).await;
            return;
        }
        if verb == "QUIT" {
            {
                let mut m = mailbox.lock().unwrap();
                let mut index = 0;
                m.messages.retain(|_| {
                    index += 1;
                    !marked.contains(&index)
                });
            }
            put(&mut io, "+OK bye\r\n".into()).await;
            return;
        }
        put(&mut io, reply).await;
    }
}

fn db() -> std::sync::Mutex<Connection> {
    std::sync::Mutex::new(crate::store::open_in_memory_for_test().unwrap())
}

fn media() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("oreneta-pop3-media-{}", std::process::id()))
}

/// One fetch against the mailbox, as the account would run it.
async fn run(db: &std::sync::Mutex<Connection>, mailbox: &Shared, now: i64) -> Result<FetchSummary> {
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    tokio::spawn(serve(theirs, mailbox.clone()));
    let mut client = Client::open(ours).await?;
    client.login("pau", "secret").await?;
    fetch(db, "pop", &mut client, now, &media()).await
}

fn mailbox(messages: &[(&str, Vec<u8>)]) -> Shared {
    Arc::new(Mutex::new(Mailbox {
        messages: messages.iter().map(|(u, r)| (u.to_string(), r.clone())).collect(),
        password: "secret".into(),
        ..Default::default()
    }))
}

fn stored(db: &std::sync::Mutex<Connection>, folder: &str) -> usize {
    db.lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM archive_messages WHERE account = 'pop' AND folder = ?1",
            [folder],
            |r| r.get::<_, i64>(0),
        )
        .unwrap() as usize
}

#[tokio::test]
async fn a_second_check_downloads_nothing_already_here() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "First.\r\n.hidden dot")), ("u2", mail("two", "Second."))]);
    let first = run(&db, &server, 1000).await.unwrap();
    assert_eq!(first.downloaded, 2);
    let again = run(&db, &server, 2000).await.unwrap();
    assert_eq!(again, FetchSummary::default());
    assert_eq!(stored(&db, INBOX), 2);
    // Dot-stuffing undone: the line starting with a dot is as it was sent.
    let raw: Vec<u8> = db
        .lock()
        .unwrap()
        .query_row("SELECT raw FROM archive_messages WHERE account='pop' AND uid=1", [], |r| r.get(0))
        .unwrap();
    assert!(String::from_utf8(raw).unwrap().contains("\r\n.hidden dot"));
    // Nothing deleted from the server by default.
    assert_eq!(server.lock().unwrap().messages.len(), 2);
    assert!(!server.lock().unwrap().commands.iter().any(|c| c.starts_with("DELE")));
}

#[tokio::test]
async fn a_server_that_renumbers_its_uidls_does_not_make_duplicates() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "a")), ("u2", mail("two", "b"))]);
    run(&db, &server, 1000).await.unwrap();
    for (i, entry) in server.lock().unwrap().messages.iter_mut().enumerate() {
        entry.0 = format!("new-{i}");
    }
    let after = run(&db, &server, 2000).await.unwrap();
    assert_eq!((after.downloaded, after.already_here), (0, 2));
    assert_eq!(stored(&db, INBOX), 2);
}

#[tokio::test]
async fn a_cut_download_keeps_what_arrived_and_fetches_the_rest_next_time() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "a")), ("u2", mail("two", "b".repeat(5000).as_str())), ("u3", mail("three", "c"))]);
    server.lock().unwrap().cut_retr = Some(2);
    assert!(run(&db, &server, 1000).await.is_err());
    assert_eq!(stored(&db, INBOX), 1, "the first is kept, the cut one is not");
    server.lock().unwrap().cut_retr = None;
    let next = run(&db, &server, 2000).await.unwrap();
    assert_eq!(next.downloaded, 2);
    assert_eq!(stored(&db, INBOX), 3);
}

#[tokio::test]
async fn stopping_between_storing_and_noting_it_does_not_store_it_twice() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "a"))]);
    run(&db, &server, 1000).await.unwrap();
    // As if the app stopped after storing the message but before noting its UIDL.
    db.lock().unwrap().execute("DELETE FROM pop3_seen", []).unwrap();
    let next = run(&db, &server, 2000).await.unwrap();
    assert_eq!((next.downloaded, next.already_here), (0, 1));
    assert_eq!(stored(&db, INBOX), 1);
}

#[tokio::test]
async fn deleting_from_the_server_follows_the_chosen_policy_and_keeps_the_copy_here() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "a")), ("u2", mail("two", "b"))]);
    run(&db, &server, 1_000_000).await.unwrap();

    set_retention(&db.lock().unwrap(), "pop", Retention::AfterDays { days: 7 }).unwrap();
    let early = run(&db, &server, 1_000_000 + 6 * 86_400).await.unwrap();
    assert_eq!(early.deleted_on_server, 0);
    let late = run(&db, &server, 1_000_000 + 7 * 86_400).await.unwrap();
    assert_eq!(late.deleted_on_server, 2);
    assert!(server.lock().unwrap().messages.is_empty());
    assert_eq!(stored(&db, INBOX), 2, "deleting on the server never deletes here");
}

#[tokio::test]
async fn deleted_here_means_in_trash_or_gone_and_moved_means_kept() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "a")), ("u2", mail("two", "b")), ("u3", mail("three", "c"))]);
    run(&db, &server, 1000).await.unwrap();
    set_retention(&db.lock().unwrap(), "pop", Retention::WhenDeletedHere).unwrap();
    {
        let conn = db.lock().unwrap();
        conn.execute("UPDATE archive_messages SET folder = 'Trash' WHERE account='pop' AND uid = 1", []).unwrap();
        conn.execute("UPDATE archive_messages SET folder = 'Kept' WHERE account='pop' AND uid = 2", []).unwrap();
    }
    let summary = run(&db, &server, 2000).await.unwrap();
    assert_eq!(summary.deleted_on_server, 1);
    let left: Vec<String> = server.lock().unwrap().messages.iter().map(|m| m.0.clone()).collect();
    assert_eq!(left, ["u2", "u3"]);
}

#[tokio::test]
async fn a_deletion_counts_only_when_the_session_ends_cleanly() {
    let db = db();
    let server = mailbox(&[("u1", mail("one", "a"))]);
    run(&db, &server, 1000).await.unwrap();
    set_retention(&db.lock().unwrap(), "pop", Retention::AfterDays { days: 1 }).unwrap();
    server.lock().unwrap().lose_quit = true;
    assert!(run(&db, &server, 1000 + 86_400).await.is_err());
    assert_eq!(server.lock().unwrap().messages.len(), 1, "the server deleted nothing");
    let marked: i64 = db.lock().unwrap().query_row("SELECT deleted_on_server FROM pop3_seen", [], |r| r.get(0)).unwrap();
    assert_eq!(marked, 0, "and nothing here says it did");
    server.lock().unwrap().lose_quit = false;
    assert_eq!(run(&db, &server, 2000 + 86_400).await.unwrap().deleted_on_server, 1);
}

#[tokio::test]
async fn what_is_not_mail_is_left_alone_and_not_asked_for_again() {
    let db = db();
    let server = mailbox(&[("junk", b"\x00\x01 not a message\r\n".to_vec()), ("u1", mail("one", "a"))]);
    let first = run(&db, &server, 1000).await.unwrap();
    assert_eq!((first.downloaded, first.skipped), (1, 1));
    let commands_before = server.lock().unwrap().commands.iter().filter(|c| c.starts_with("RETR")).count();
    run(&db, &server, 2000).await.unwrap();
    let commands_after = server.lock().unwrap().commands.iter().filter(|c| c.starts_with("RETR")).count();
    assert_eq!(commands_before, commands_after);
}

#[tokio::test]
async fn a_wrong_password_is_said_as_such() {
    let server = mailbox(&[]);
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve(theirs, server));
    let mut client = Client::open(ours).await.unwrap();
    let err = client.login("pau", "wrong").await.unwrap_err();
    assert!(err.to_string().contains("did not accept the user name and password"));
}

#[tokio::test]
async fn the_password_is_never_sent_to_a_server_without_tls() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = mailbox(&[]);
    let seen = server.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        serve(stream, server).await;
    });
    let creds = crate::imap::Creds {
        host: "127.0.0.1".into(),
        port,
        user: "pau".into(),
        password: "secret".into(),
        tls: false,
        starttls: true,
        smtp_host: String::new(),
        smtp_port: 587,
        smtp_tls: true,
        smtp_starttls: false,
        auth_type: "pop3".into(),
        access_token: None,
        refresh_token: None,
        token_expires_at: 0,
        oauth_client_id: String::new(),
        oauth_client_secret: String::new(),
        oauth_token_url: String::new(),
        oauth_scope: String::new(),
        proxy: crate::proxy::ProxyChoice::default(),
        cert_pin: None,
        smtp_cert_pin: None,
        ews_url: String::new(),
        delegate_account_id: String::new(),
        target_mailbox: String::new(),
    };
    let err = connect(&creds).await.err().unwrap();
    assert!(err.to_string().contains("does not offer TLS"), "{err}");
    assert!(!seen.lock().unwrap().commands.iter().any(|c| c.starts_with("PASS") || c.starts_with("USER")));
}

#[test]
fn retention_is_kept_and_keeping_is_the_default() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    assert_eq!(retention(&conn, "pop").unwrap(), Retention::Keep);
    set_retention(&conn, "pop", Retention::AfterDays { days: 14 }).unwrap();
    assert_eq!(retention(&conn, "pop").unwrap(), Retention::AfterDays { days: 14 });
    assert!(set_retention(&conn, "pop", Retention::AfterDays { days: 0 }).is_err());
    let json = serde_json::to_value(Retention::WhenDeletedHere).unwrap();
    assert_eq!(json, serde_json::json!({ "policy": "whenDeletedHere" }));
}

/// Against a real Dovecot (tests/dovecot-pop3.sh): set ORENETA_DOVECOT_POP3
/// to its address and ORENETA_DOVECOT_DIR to its directory. Skipped otherwise.
#[tokio::test]
async fn against_dovecot_nothing_twice_and_deletion_only_as_chosen() {
    let (Ok(address), Ok(dir)) = (std::env::var("ORENETA_DOVECOT_POP3"), std::env::var("ORENETA_DOVECOT_DIR")) else {
        eprintln!("skipped: no Dovecot (see tests/dovecot-pop3.sh)");
        return;
    };
    let maildir = std::path::Path::new(&dir).join("home/pau/Maildir");
    for sub in ["new", "cur"] {
        for entry in std::fs::read_dir(maildir.join(sub)).unwrap().flatten() {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    for (i, body) in ["First.\r\n.a line with a dot", "Second."].iter().enumerate() {
        // A name Dovecot has not seen: it keeps an index by file name.
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = maildir.join("new").join(format!("{stamp}.M{i}P{}.test", std::process::id()));
        std::fs::write(&path, mail(&format!("real{i}"), body)).unwrap();
    }
    let session = || async {
        let stream = tokio::net::TcpStream::connect(&address).await.unwrap();
        let mut client = Client::open(stream).await.unwrap();
        client.login("pau", "secret").await.unwrap();
        client
    };
    let db = db();
    let first = fetch(&db, "pop", &mut session().await, 1_000_000, &media()).await.unwrap();
    assert_eq!(first.downloaded, 2);
    // A later check, as after a restart: the same database, nothing again.
    let again = fetch(&db, "pop", &mut session().await, 1_000_100, &media()).await.unwrap();
    assert_eq!(again, FetchSummary::default());
    let left_on_server = || {
        ["new", "cur"].iter().map(|s| std::fs::read_dir(maildir.join(s)).unwrap().count()).sum::<usize>()
    };
    assert_eq!(left_on_server(), 2, "kept on the server by default");

    set_retention(&db.lock().unwrap(), "pop", Retention::AfterDays { days: 1 }).unwrap();
    let later = fetch(&db, "pop", &mut session().await, 1_000_000 + 86_400, &media()).await.unwrap();
    assert_eq!(later.deleted_on_server, 2);
    assert_eq!(left_on_server(), 0, "Dovecot deleted them at QUIT");
    assert_eq!(stored(&db, INBOX), 2, "and they are still here");
    let raw: Vec<u8> = db
        .lock()
        .unwrap()
        .query_row("SELECT raw FROM archive_messages WHERE account='pop' AND uid=1", [], |r| r.get(0))
        .unwrap();
    assert!(String::from_utf8(raw).unwrap().contains("\r\n.a line with a dot"));
}
