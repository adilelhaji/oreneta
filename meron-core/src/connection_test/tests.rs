use super::*;
use base64::Engine as _;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const PASSWORD: &str = "s3cret-pass";

fn short() -> Limits {
    Limits {
        lookup: Duration::from_secs(5),
        connect_attempt: Duration::from_secs(2),
        connect: Duration::from_secs(3),
        command: Duration::from_secs(2),
        total: Duration::from_secs(10),
    }
}

fn server(protocol: Protocol, port: u16, security: Security) -> Server {
    Server { protocol, host: "127.0.0.1".into(), port, security, cert_pin: None }
}

fn request(incoming: Server, outgoing: Server, password: &str) -> TestRequest {
    TestRequest {
        incoming,
        outgoing,
        login: Login { user: "pau@example.test".into(), password: password.into() },
        proxy: ProxyChoice::Direct,
    }
}

fn statuses(report: &ServerReport) -> Vec<(Step, Status, Option<Kind>)> {
    report.steps.iter().map(|s| (s.step, s.status, s.kind)).collect()
}

type Log = Arc<Mutex<Vec<String>>>;

/// A one-connection-at-a-time line server: `greeting` first, then each line
/// the client sends goes to `answer`, whose reply is written back (`None`
/// closes the connection). Every line received is logged.
async fn line_server(
    greeting: Option<&'static str>,
    answer: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
) -> (u16, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let seen = log.clone();
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let seen = seen.clone();
            let answer = answer.clone();
            tokio::spawn(async move {
                let mut io = tokio::io::BufReader::new(stream);
                if let Some(greeting) = greeting {
                    let _ = io.get_mut().write_all(greeting.as_bytes()).await;
                }
                loop {
                    let mut line = String::new();
                    if io.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let line = line.trim_end().to_string();
                    seen.lock().unwrap().push(line.clone());
                    match (*answer)(&line) {
                        Some(reply) => {
                            let _ = io.get_mut().write_all(reply.as_bytes()).await;
                        }
                        None => return,
                    }
                }
            });
        }
    });
    (port, log)
}

/// An IMAP server without TLS. `starttls` is its answer to STARTTLS.
async fn imap_server(starttls: &'static str) -> (u16, Log) {
    line_server(Some("* OK IMAP ready\r\n"), move |line| {
        let mut words = line.split_whitespace();
        let tag = words.next().unwrap_or("*").to_string();
        let command = words.next().unwrap_or_default().to_ascii_uppercase();
        Some(match command.as_str() {
            "LOGIN" if line.contains(PASSWORD) => format!("{tag} OK LOGIN completed\r\n"),
            "LOGIN" => format!("{tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n"),
            "LOGOUT" => format!("* BYE\r\n{tag} OK LOGOUT completed\r\n"),
            "CAPABILITY" => format!("* CAPABILITY IMAP4rev1\r\n{tag} OK\r\n"),
            "STARTTLS" => format!("{tag} {starttls}\r\n"),
            _ => format!("{tag} BAD unknown\r\n"),
        })
    })
    .await
}

/// A submission server without TLS. With `auth` false it refuses AUTH as a
/// command it does not implement.
async fn smtp_server(auth: bool) -> (u16, Log) {
    let awaiting_plain = Arc::new(Mutex::new(false));
    line_server(Some("220 smtp.example.test ESMTP\r\n"), move |line| {
        let upper = line.to_ascii_uppercase();
        let plain_ok = |encoded: &str| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map(|raw| String::from_utf8_lossy(&raw).ends_with(&format!("\0{PASSWORD}")))
                .unwrap_or(false)
        };
        if std::mem::take(&mut *awaiting_plain.lock().unwrap()) {
            return Some(if plain_ok(line) { "235 2.7.0 ok\r\n".into() } else { "535 5.7.8 bad credentials\r\n".into() });
        }
        Some(if upper.starts_with("EHLO") || upper.starts_with("HELO") {
            if auth {
                "250-smtp.example.test\r\n250 AUTH PLAIN LOGIN\r\n".into()
            } else {
                "250 smtp.example.test\r\n".into()
            }
        } else if upper.starts_with("AUTH") && !auth {
            "502 5.5.1 not implemented\r\n".into()
        } else if upper.starts_with("AUTH PLAIN") {
            match line.split_whitespace().nth(2) {
                Some(encoded) if plain_ok(encoded) => "235 2.7.0 ok\r\n".into(),
                Some(_) => "535 5.7.8 bad credentials\r\n".into(),
                None => {
                    *awaiting_plain.lock().unwrap() = true;
                    "334 \r\n".into()
                }
            }
        } else if upper.starts_with("AUTH") {
            "535 5.7.8 bad credentials\r\n".into()
        } else if upper.starts_with("QUIT") {
            "221 bye\r\n".into()
        } else {
            "500 unknown\r\n".into()
        })
    })
    .await
}

/// A port nothing listens on.
async fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

#[tokio::test]
async fn both_servers_pass_and_each_step_is_reported() {
    let (imap, _) = imap_server("NO no").await;
    let (smtp, smtp_log) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::None), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    assert!(report.ok, "{report:?}");
    for side in [&report.incoming, &report.outgoing] {
        assert_eq!(
            statuses(side),
            vec![
                (Step::Dns, Status::Ok, None),
                (Step::Tcp, Status::Ok, None),
                (Step::Tls, Status::Skipped, Some(Kind::NoEncryption)),
                (Step::Auth, Status::Ok, None),
            ]
        );
    }
    // Signed in and left: no sender, no recipient, no message.
    let log = smtp_log.lock().unwrap().clone();
    assert!(!log.iter().any(|l| {
        let l = l.to_ascii_uppercase();
        l.starts_with("MAIL") || l.starts_with("RCPT") || l.starts_with("DATA")
    }), "{log:?}");
}

#[tokio::test]
async fn a_wrong_password_fails_the_sign_in_of_each_server() {
    let (imap, _) = imap_server("NO no").await;
    let (smtp, _) = smtp_server(true).await;
    let wrong = "wr0ng-secret";
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::None), server(Protocol::Smtp, smtp, Security::None), wrong),
        short(),
    )
    .await;
    assert!(!report.ok);
    for side in [&report.incoming, &report.outgoing] {
        let auth = &side.steps[3];
        assert_eq!((auth.status, auth.kind), (Status::Failed, Some(Kind::Rejected)), "{side:?}");
        assert!(!side.ok);
    }
    // The first refusal is the one shown, not the second mechanism's.
    assert!(report.outgoing.steps[3].detail.contains("bad credentials"), "{:?}", report.outgoing);
    // A failed report carries the servers' words, never the password, plain
    // or as the AUTH PLAIN blob.
    let text = serde_json::to_string(&report).unwrap();
    let blob = base64::engine::general_purpose::STANDARD.encode(format!("\0pau@example.test\0{wrong}"));
    assert!(!text.contains(wrong) && !text.contains(&blob), "{text}");
}

/// A submission server that takes AUTH only after STARTTLS.
async fn smtp_server_requiring_tls() -> (u16, Log) {
    line_server(Some("220 smtp.example.test ESMTP\r\n"), |line| {
        let upper = line.to_ascii_uppercase();
        Some(if upper.starts_with("EHLO") {
            "250-smtp.example.test\r\n250 STARTTLS\r\n".into()
        } else if upper.starts_with("AUTH") {
            "530 5.7.0 Must issue a STARTTLS command first\r\n".into()
        } else if upper.starts_with("QUIT") {
            "221 bye\r\n".into()
        } else {
            "500 unknown\r\n".into()
        })
    })
    .await
}

#[tokio::test]
async fn a_server_that_wants_encryption_first_is_not_a_wrong_password() {
    let (imap, _) = line_server(Some("* OK IMAP ready\r\n"), |line| {
        let tag = line.split_whitespace().next().unwrap_or("*").to_string();
        Some(if line.to_ascii_uppercase().contains("LOGIN") {
            format!("{tag} NO [PRIVACYREQUIRED] Use STARTTLS first\r\n")
        } else {
            format!("{tag} OK\r\n")
        })
    })
    .await;
    let (smtp, _) = smtp_server_requiring_tls().await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::None), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    for side in [&report.incoming, &report.outgoing] {
        let auth = &side.steps[3];
        assert_eq!((auth.status, auth.kind), (Status::Failed, Some(Kind::EncryptionRequired)), "{side:?}");
    }
}

#[tokio::test]
async fn a_proxy_that_cannot_be_reached_is_blamed_not_the_mail_port() {
    let closed = closed_port().await;
    let (imap, _) = imap_server("NO no").await;
    let mut req = request(
        server(Protocol::Imap, imap, Security::None),
        server(Protocol::Smtp, imap, Security::None),
        PASSWORD,
    );
    req.proxy = ProxyChoice::from_json(&json!({ "mode": "socks5", "host": "127.0.0.1", "port": closed }));
    assert!(matches!(req.proxy, ProxyChoice::Custom(_)), "{:?}", req.proxy);
    let report = run_with_limits(&req, short()).await;
    for side in [&report.incoming, &report.outgoing] {
        assert_eq!(
            statuses(side),
            vec![
                (Step::Dns, Status::Skipped, Some(Kind::ViaProxy)),
                (Step::Tcp, Status::Failed, Some(Kind::Proxy)),
                (Step::Tls, Status::NotRun, None),
                (Step::Auth, Status::NotRun, None),
            ]
        );
    }
}

#[tokio::test]
async fn the_servers_are_tested_independently() {
    let closed = closed_port().await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, closed, Security::Tls), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    assert!(!report.ok);
    assert_eq!(
        statuses(&report.incoming),
        vec![
            (Step::Dns, Status::Ok, None),
            (Step::Tcp, Status::Failed, Some(Kind::Refused)),
            (Step::Tls, Status::NotRun, None),
            (Step::Auth, Status::NotRun, None),
        ]
    );
    assert!(report.outgoing.ok, "{:?}", report.outgoing);
}

#[tokio::test]
async fn a_name_that_does_not_resolve_fails_the_lookup() {
    let mut incoming = server(Protocol::Imap, 993, Security::Tls);
    incoming.host = "no-such-server.invalid".into();
    let mut outgoing = server(Protocol::Smtp, 465, Security::Tls);
    outgoing.host = "no-such-server.invalid".into();
    let report = run_with_limits(&request(incoming, outgoing, PASSWORD), short()).await;
    let dns = &report.incoming.steps[0];
    assert_eq!(dns.status, Status::Failed);
    assert!(matches!(dns.kind, Some(Kind::NameNotFound) | Some(Kind::Timeout)), "{dns:?}");
    assert!(report.incoming.steps[1..].iter().all(|s| s.status == Status::NotRun));
}

#[tokio::test]
async fn tls_on_a_plaintext_port_is_reported_as_not_tls() {
    let (imap, log) = imap_server("NO no").await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::Tls), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!((tls.status, tls.kind), (Status::Failed, Some(Kind::NotTls)), "{tls:?}");
    assert_eq!(report.incoming.steps[3].status, Status::NotRun);
    assert!(!log.lock().unwrap().iter().any(|l| l.contains(PASSWORD)));
}

#[tokio::test]
async fn a_refused_starttls_is_reported_before_any_password_is_sent() {
    let (imap, log) = imap_server("NO STARTTLS not available").await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::Starttls), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!((tls.status, tls.kind), (Status::Failed, Some(Kind::StarttlsUnsupported)), "{tls:?}");
    assert!(!log.lock().unwrap().iter().any(|l| l.contains(PASSWORD)));
}

#[tokio::test]
async fn a_silent_server_has_no_greeting() {
    // Implicit TLS expected from the first byte: the server waits for the
    // client and a STARTTLS client waits for the server.
    let (silent, _) = line_server(None, |_| None).await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, silent, Security::Starttls), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!((tls.status, tls.kind), (Status::Failed, Some(Kind::NoGreeting)), "{tls:?}");
}

#[tokio::test]
async fn smtp_without_auth_is_skipped_not_failed() {
    let (imap, _) = imap_server("NO no").await;
    let (smtp, _) = smtp_server(false).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::None), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let auth = &report.outgoing.steps[3];
    assert_eq!((auth.status, auth.kind), (Status::Skipped, Some(Kind::AuthNotOffered)));
    assert!(report.outgoing.ok);
    assert!(report.ok);
}

#[tokio::test]
async fn pop3_never_sends_the_password_without_tls() {
    let (pop3, log) = line_server(Some("+OK ready\r\n"), |line| {
        Some(if line.eq_ignore_ascii_case("CAPA") { "+OK\r\nUSER\r\n.\r\n".into() } else { "+OK\r\n".into() })
    })
    .await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Pop3, pop3, Security::None), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!((tls.status, tls.kind), (Status::Failed, Some(Kind::PlaintextRefused)));

    let report = run_with_limits(
        &request(server(Protocol::Pop3, pop3, Security::Starttls), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!((tls.status, tls.kind), (Status::Failed, Some(Kind::StarttlsUnsupported)), "{tls:?}");
    assert!(!log.lock().unwrap().iter().any(|l| l.starts_with("USER") || l.starts_with("PASS")));
}

/// As `pop3::connect` does, "no encryption" on POP3 still upgrades with STLS
/// when the server offers it; here the upgrade never completes, and nothing
/// of the sign-in is sent.
#[tokio::test]
async fn pop3_without_tls_chosen_still_upgrades_with_stls() {
    let (pop3, log) = line_server(Some("+OK ready\r\n"), |line| {
        Some(if line.eq_ignore_ascii_case("CAPA") { "+OK\r\nSTLS\r\nUSER\r\n.\r\n".into() } else { "+OK\r\n".into() })
    })
    .await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Pop3, pop3, Security::None), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!(tls.status, Status::Failed, "{tls:?}");
    assert_ne!(tls.kind, Some(Kind::PlaintextRefused));
    let log = log.lock().unwrap().clone();
    assert!(log.iter().any(|l| l.eq_ignore_ascii_case("STLS")), "{log:?}");
    assert!(!log.iter().any(|l| l.starts_with("USER") || l.starts_with("PASS")), "{log:?}");
}

/// POP3 signs in only over TLS, so its sign-in is checked on its own here, on a
/// connection that stands for the one TLS would have given.
#[tokio::test]
async fn pop3_sign_in_accepts_and_rejects() {
    for (password, expected) in [(PASSWORD, Status::Ok), ("wrong", Status::Failed)] {
        let (ours, theirs) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let mut io = tokio::io::BufReader::new(theirs);
            let _ = io.get_mut().write_all(b"+OK ready\r\n").await;
            loop {
                let mut line = String::new();
                if io.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                let reply = if line.starts_with("PASS") && !line.contains(PASSWORD) {
                    "-ERR [AUTH] invalid\r\n"
                } else {
                    "+OK\r\n"
                };
                let _ = io.get_mut().write_all(reply.as_bytes()).await;
            }
        });
        let login = Login { user: "pau".into(), password: password.into() };
        let step = pop3_sign_in(ours, false, &login, short()).await;
        assert_eq!(step.status, expected, "{step:?}");
        if expected == Status::Failed {
            assert_eq!(step.kind, Some(Kind::Rejected));
        }
    }
}

#[tokio::test]
async fn an_unusable_proxy_stops_before_any_connection() {
    let mut req = request(
        server(Protocol::Imap, 993, Security::Tls),
        server(Protocol::Smtp, 465, Security::Tls),
        PASSWORD,
    );
    req.proxy = ProxyChoice::Unusable(json!({ "mode": "socks5" }));
    let report = run_with_limits(&req, short()).await;
    for side in [&report.incoming, &report.outgoing] {
        assert_eq!(
            statuses(side),
            vec![
                (Step::Dns, Status::NotRun, None),
                (Step::Tcp, Status::Failed, Some(Kind::Proxy)),
                (Step::Tls, Status::NotRun, None),
                (Step::Auth, Status::NotRun, None),
            ]
        );
    }
}

#[tokio::test]
async fn the_whole_test_is_bounded() {
    let (silent, _) = line_server(None, |_| None).await;
    let (smtp, _) = smtp_server(true).await;
    let mut limits = short();
    limits.command = Duration::from_secs(5);
    limits.total = Duration::from_millis(300);
    let report = run_with_limits(
        &request(server(Protocol::Imap, silent, Security::Starttls), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        limits,
    )
    .await;
    let tls = &report.incoming.steps[2];
    assert_eq!((tls.status, tls.kind), (Status::Failed, Some(Kind::Timeout)), "{:?}", report.incoming);
    assert_eq!(report.incoming.steps[3].status, Status::NotRun);
}

#[tokio::test]
async fn the_report_never_carries_the_password() {
    let (imap, _) = imap_server("NO no").await;
    let (smtp, _) = smtp_server(true).await;
    let report = run_with_limits(
        &request(server(Protocol::Imap, imap, Security::None), server(Protocol::Smtp, smtp, Security::None), PASSWORD),
        short(),
    )
    .await;
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains(PASSWORD), "{text}");
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["incoming"]["protocol"], "imap");
    assert_eq!(value["incoming"]["security"], "none");
    assert_eq!(value["incoming"]["steps"][0]["step"], "dns");
    assert_eq!(value["incoming"]["steps"][2]["status"], "skipped");
    assert_eq!(value["incoming"]["steps"][2]["kind"], "no_encryption");
    assert!(value["incoming"]["steps"][3].get("kind").is_none());
}

#[test]
fn the_parameters_are_read_as_account_connect_reads_them() {
    let req = TestRequest::from_params(&json!({
        "host": " imap.example.test ",
        "port": 143,
        "tls": false,
        "starttls": true,
        "smtp_host": "smtp.example.test",
        "smtp_port": 465,
        "smtp_tls": true,
        "smtp_starttls": false,
        "user": "pau",
        "password": " spaced ",
        "cert_pin": " AB12 ",
        "smtp_cert_pin": "",
    }))
    .unwrap();
    assert_eq!(
        req.incoming,
        Server {
            protocol: Protocol::Imap,
            host: "imap.example.test".into(),
            port: 143,
            security: Security::Starttls,
            cert_pin: Some("ab12".into()),
        }
    );
    assert_eq!(req.outgoing.security, Security::Tls);
    assert_eq!(req.outgoing.port, 465);
    assert_eq!(req.outgoing.cert_pin, None);
    // A password is taken as typed: spaces can be part of it.
    assert_eq!(req.login.password, " spaced ");
    assert_eq!(req.proxy, ProxyChoice::Global);

    let pop3 = TestRequest::from_params(&json!({
        "host": "pop.example.test", "port": 995, "user": "pau", "auth_type": "pop3", "smtp_tls": false,
    }))
    .unwrap();
    assert_eq!(pop3.incoming.protocol, Protocol::Pop3);
    assert_eq!(pop3.incoming.security, Security::Tls);
    // No submission server given: the incoming one, as account.connect does.
    assert_eq!(pop3.outgoing.host, "pop.example.test");
    assert_eq!(pop3.outgoing.security, Security::None);
    assert_eq!(pop3.outgoing.port, 587);
    assert!(pop3.login.password.is_empty());
}

#[test]
fn incomplete_parameters_are_refused() {
    for params in [
        json!({ "port": 993, "user": "pau" }),
        json!({ "host": "imap.example.test" }),
        json!({ "host": "imap.example.test", "user": "pau", "port": 0 }),
        json!({ "host": "imap.example.test", "user": "pau", "smtp_port": 70000 }),
        json!({ "host": "imap.example.test", "user": "pau", "auth_type": "oauth" }),
    ] {
        assert!(TestRequest::from_params(&params).is_err(), "{params}");
    }
}
