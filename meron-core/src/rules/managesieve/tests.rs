//! Against a fake ManageSieve server over an in-memory pipe. Synthetic: the
//! real-server check (Dovecot Pigeonhole) is part of the final provider
//! verification.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};

use super::*;

#[derive(Default)]
struct Server {
    scripts: BTreeMap<String, String>,
    active: Option<String>,
    refuse_check: bool,
    log: Vec<String>,
}

fn unquote(text: &str) -> String {
    text.trim().trim_matches('"').replace("\\\"", "\"").replace("\\\\", "\\")
}

async fn serve(stream: DuplexStream, state: Arc<Mutex<Server>>) {
    let mut io = BufReader::new(stream);
    let caps = "\"IMPLEMENTATION\" \"Fake\"\r\n\"SIEVE\" \"fileinto imap4flags\"\r\n\"SASL\" \"PLAIN\"\r\nOK\r\n";
    io.get_mut().write_all(caps.as_bytes()).await.unwrap();
    loop {
        let mut line = String::new();
        if io.read_line(&mut line).await.unwrap() == 0 {
            return;
        }
        let line = line.trim_end().to_string();
        // A trailing literal: read its bytes.
        let mut body = String::new();
        let mut head = line.clone();
        if let Some(open) = line.rfind('{') {
            if line.ends_with("+}") {
                let n: usize = line[open + 1..line.len() - 2].parse().unwrap();
                let mut bytes = vec![0u8; n];
                io.read_exact(&mut bytes).await.unwrap();
                let mut crlf = String::new();
                io.read_line(&mut crlf).await.unwrap();
                body = String::from_utf8(bytes).unwrap();
                head = line[..open].trim().to_string();
            }
        }
        let (verb, rest) = head.split_once(' ').unwrap_or((head.as_str(), ""));
        let reply = {
            let mut s = state.lock().unwrap();
            s.log.push(verb.to_string());
            match verb {
                "AUTHENTICATE" => {
                    let token = unquote(rest.split_once(' ').unwrap().1);
                    let decoded = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(token).unwrap()).unwrap();
                    if decoded == "\0me@example.com\0secret" { "OK\r\n".into() } else { "NO \"Authentication failed\"\r\n".into() }
                }
                "LISTSCRIPTS" => {
                    let mut out = String::new();
                    for name in s.scripts.keys() {
                        let active = s.active.as_deref() == Some(name.as_str());
                        out.push_str(&format!("\"{name}\"{}\r\n", if active { " ACTIVE" } else { "" }));
                    }
                    out + "OK\r\n"
                }
                "GETSCRIPT" => match s.scripts.get(&unquote(rest)) {
                    Some(script) => format!("{{{}}}\r\n{script}\r\nOK\r\n", script.len()),
                    None => "NO (NONEXISTENT) \"There is no such script\"\r\n".into(),
                },
                "CHECKSCRIPT" => {
                    if s.refuse_check { "NO \"line 3: unknown test\"\r\n".into() } else { "OK\r\n".into() }
                }
                "PUTSCRIPT" => {
                    s.scripts.insert(unquote(rest), body);
                    "OK\r\n".into()
                }
                "SETACTIVE" => {
                    let name = unquote(rest);
                    s.active = if name.is_empty() { None } else { Some(name) };
                    "OK\r\n".into()
                }
                "DELETESCRIPT" => {
                    s.scripts.remove(&unquote(rest));
                    "OK\r\n".into()
                }
                "LOGOUT" => "OK\r\n".into(),
                other => format!("NO \"unknown {other}\"\r\n"),
            }
        };
        io.get_mut().write_all(reply.as_bytes()).await.unwrap();
    }
}

async fn session(state: Arc<Mutex<Server>>) -> (Session<DuplexStream>, Capabilities) {
    let (client, server) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve(server, state));
    let (mut session, caps) = Session::open(client).await.unwrap();
    session.authenticate_plain("me@example.com", "secret").await.unwrap();
    (session, caps)
}

const SCRIPT: &str = "require [\"fileinto\"];\n# Say \"hi\"\nif header :contains \"subject\" \"x\" {\n    fileinto \"X\";\n}\n";

#[tokio::test]
async fn reads_capabilities_and_refuses_a_wrong_password() {
    let state = Arc::new(Mutex::new(Server::default()));
    let (client, server) = tokio::io::duplex(1 << 16);
    tokio::spawn(serve(server, state));
    let (mut session, caps) = Session::open(client).await.unwrap();
    assert_eq!(caps.sieve, vec!["fileinto", "imap4flags"]);
    assert_eq!(caps.sasl, vec!["PLAIN"]);
    assert_eq!(caps.implementation, "Fake");
    assert!(session.authenticate_plain("me@example.com", "wrong").await.is_err());
}

#[tokio::test]
async fn writes_and_activates_its_script_and_reads_it_back_exactly() {
    let state = Arc::new(Mutex::new(Server::default()));
    let (mut s, caps) = session(state.clone()).await;
    let pushed = push(&mut s, SCRIPT, None, false).await.unwrap();
    let hash = script_hash(SCRIPT);
    assert_eq!(pushed, Pushed::Stored { hash: hash.clone(), active: true, other_active: None });
    assert_eq!(s.get(SCRIPT_NAME).await.unwrap().as_deref(), Some(SCRIPT));
    let status = status(&mut s, caps, Some(&hash)).await.unwrap();
    assert_eq!((status.ours.as_str(), status.ours_active, status.other_active), ("current", true, None));
    // Checked before it is stored.
    let log = state.lock().unwrap().log.clone();
    let check = log.iter().position(|v| v == "CHECKSCRIPT").unwrap();
    let put = log.iter().position(|v| v == "PUTSCRIPT").unwrap();
    assert!(check < put);
}

#[tokio::test]
async fn never_overwrites_a_copy_changed_elsewhere_unless_told() {
    let state = Arc::new(Mutex::new(Server::default()));
    state.lock().unwrap().scripts.insert(SCRIPT_NAME.into(), "# edited in webmail\n".into());
    let (mut s, caps) = session(state.clone()).await;
    let stale = script_hash("what Oreneta wrote before");
    assert_eq!(status(&mut s, caps, Some(&stale)).await.unwrap().ours, "changedElsewhere");
    match push(&mut s, SCRIPT, Some(&stale), false).await.unwrap() {
        Pushed::ChangedElsewhere { on_server } => assert_eq!(on_server, "# edited in webmail\n"),
        other => panic!("{other:?}"),
    }
    assert_eq!(state.lock().unwrap().scripts[SCRIPT_NAME], "# edited in webmail\n");
    push(&mut s, SCRIPT, Some(&stale), true).await.unwrap();
    assert_eq!(state.lock().unwrap().scripts[SCRIPT_NAME], SCRIPT);
}

#[tokio::test]
async fn never_switches_off_someone_elses_active_script() {
    let state = Arc::new(Mutex::new(Server::default()));
    {
        let mut s = state.lock().unwrap();
        s.scripts.insert("roundcube".into(), "keep;".into());
        s.active = Some("roundcube".into());
    }
    let (mut s, _) = session(state.clone()).await;
    let pushed = push(&mut s, SCRIPT, None, false).await.unwrap();
    assert_eq!(
        pushed,
        Pushed::Stored { hash: script_hash(SCRIPT), active: false, other_active: Some("roundcube".into()) }
    );
    assert_eq!(state.lock().unwrap().active.as_deref(), Some("roundcube"));
    // Removing takes only Oreneta's script.
    assert!(remove(&mut s).await.unwrap());
    let st = state.lock().unwrap();
    assert!(st.scripts.contains_key("roundcube") && !st.scripts.contains_key(SCRIPT_NAME));
    assert_eq!(st.active.as_deref(), Some("roundcube"));
}

#[tokio::test]
async fn a_script_the_server_refuses_is_not_stored() {
    let state = Arc::new(Mutex::new(Server { refuse_check: true, ..Default::default() }));
    let (mut s, _) = session(state.clone()).await;
    let err = push(&mut s, SCRIPT, None, false).await.unwrap_err().to_string();
    assert!(err.contains("unknown test"), "{err}");
    assert!(state.lock().unwrap().scripts.is_empty());
}

#[tokio::test]
async fn removing_its_active_script_deactivates_it_first() {
    let state = Arc::new(Mutex::new(Server::default()));
    let (mut s, _) = session(state.clone()).await;
    push(&mut s, SCRIPT, None, false).await.unwrap();
    assert!(remove(&mut s).await.unwrap());
    let st = state.lock().unwrap();
    assert!(st.active.is_none() && st.scripts.is_empty());
    drop(st);
    assert!(!remove(&mut s).await.unwrap(), "nothing to remove the second time");
}
