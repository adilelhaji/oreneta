use super::*;
use std::str::FromStr;
use std::sync::Arc;
use tokio_xmpp::parsers::jid::BareJid;
use tokio_xmpp::parsers::message::{Message, MessageType};

fn conn() -> Connection {
    crate::store::open_in_memory_for_test().unwrap()
}

fn incoming(id: &str, archive: Option<&str>, body: &str, stamp: i64) -> ChatMessage {
    ChatMessage {
        account: "a".into(),
        conversation: "pau@chat.test".into(),
        id: id.into(),
        stanza_id: archive.map(String::from),
        direction: "in".into(),
        sender: "pau@chat.test".into(),
        body: body.into(),
        stamp,
        state: "received".into(),
    }
}

#[test]
fn a_message_is_kept_once_however_it_arrives() {
    let c = conn();
    assert!(record(&c, &incoming("m1", None, "Hola", 10)).unwrap());
    // The same message from the archive: gets its archive id, nothing new.
    assert!(record(&c, &incoming("m1", Some("arch-1"), "Hola", 10)).unwrap());
    assert!(!record(&c, &incoming("m1", Some("arch-1"), "Hola", 10)).unwrap());
    // Another id but the same archive entry: still the same message.
    assert!(!record(&c, &incoming("other", Some("arch-1"), "Hola", 10)).unwrap());
    assert_eq!(history(&c, "a", "pau@chat.test", 50).unwrap().len(), 1);
    assert_eq!(last_archive_id(&c, "a").unwrap().as_deref(), Some("arch-1"));
}

#[test]
fn a_sent_message_only_moves_forward_and_a_lost_one_is_uncertain_not_resent() {
    let c = conn();
    queue(&c, "a", "pau@chat.test", "s1", "ana@chat.test", "Hi", 10).unwrap();
    set_state(&c, "a", "s1", "sent").unwrap();
    set_state(&c, "a", "s1", "sending").unwrap();
    assert_eq!(outgoing(&c, "a", "s1").unwrap().state, "sent", "never back");
    // The connection dropped before the server confirmed it.
    assert_eq!(after_disconnect(&c, "a").unwrap(), 1);
    assert_eq!(outgoing(&c, "a", "s1").unwrap().state, "uncertain");
    // The archive has it: settled as accepted.
    let mut copy = incoming("s1", Some("arch-9"), "Hi", 10);
    copy.direction = "out".into();
    copy.sender = "ana@chat.test".into();
    copy.state = "accepted".into();
    record(&c, &copy).unwrap();
    assert_eq!(outgoing(&c, "a", "s1").unwrap().state, "accepted");
    set_state(&c, "a", "s1", "delivered").unwrap();
    set_state(&c, "a", "s1", "uncertain").unwrap();
    assert_eq!(outgoing(&c, "a", "s1").unwrap().state, "delivered", "a delivered message stays delivered");
    assert!(queue(&c, "a", "pau@chat.test", "s2", "ana@chat.test", "   ", 11).is_err());
}

#[test]
fn conversations_say_what_is_unread_until_read() {
    let c = conn();
    record(&c, &incoming("m1", None, "one", 10)).unwrap();
    record(&c, &incoming("m2", None, "two", 20)).unwrap();
    queue(&c, "a", "pau@chat.test", "s1", "ana@chat.test", "mine", 30).unwrap();
    let list = conversations(&c, "a").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].last_body.as_str(), list[0].unread), ("mine", 2));
    mark_read(&c, "a", "pau@chat.test", 20).unwrap();
    assert_eq!(conversations(&c, "a").unwrap()[0].unread, 0);
    // Reading never goes back.
    mark_read(&c, "a", "pau@chat.test", 5).unwrap();
    assert_eq!(conversations(&c, "a").unwrap()[0].unread, 0);
    // Other accounts see nothing of it.
    assert!(conversations(&c, "b").unwrap().is_empty());
    let order: Vec<String> = history(&c, "a", "pau@chat.test", 2).unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(order, ["m2", "s1"], "the newest two, oldest first");
}

#[test]
fn removing_an_account_removes_its_chat() {
    let c = conn();
    save_account(&c, &ChatAccount { id: "a".into(), jid: "Ana@Chat.Test".into(), host: String::new(), port: 5222 }, 1).unwrap();
    assert_eq!(accounts(&c).unwrap()[0].jid, "ana@chat.test");
    record(&c, &incoming("m1", None, "x", 1)).unwrap();
    mark_read(&c, "a", "pau@chat.test", 1).unwrap();
    remove_account(&c, "a").unwrap();
    assert!(accounts(&c).unwrap().is_empty());
    assert!(history(&c, "a", "pau@chat.test", 10).unwrap().is_empty());
    assert!(save_account(&c, &ChatAccount { id: "b".into(), jid: "nobody".into(), host: String::new(), port: 5222 }, 1).is_err());
}

#[test]
fn a_stanza_means_what_it_says_and_only_our_server_archive_id_counts() {
    let own = BareJid::from_str("ana@chat.test").unwrap();
    let mut m = Message::new(Some(tokio_xmpp::parsers::jid::Jid::from_str("ana@chat.test/phone").unwrap()));
    m.from = Some(tokio_xmpp::parsers::jid::Jid::from_str("pau@chat.test/laptop").unwrap());
    m.type_ = MessageType::Chat;
    m.id = Some(tokio_xmpp::parsers::message::Id("live-1".into()));
    m.bodies.insert(Default::default(), "Hola".into());
    m.payloads.push(tokio_xmpp::parsers::stanza_id::OriginId { id: "origin-1".into() }.into());
    // An archive id claimed by someone else's server is ignored.
    m.payloads.push(
        tokio_xmpp::parsers::stanza_id::StanzaId { id: "forged".into(), by: tokio_xmpp::parsers::jid::Jid::from_str("evil.test").unwrap() }.into(),
    );
    let got = xmpp::interpret(&m, &own, None, 100, "a").unwrap();
    assert_eq!(
        (got.conversation.as_str(), got.id.as_str(), got.direction.as_str(), got.stanza_id),
        ("pau@chat.test", "origin-1", "in", None)
    );
    // Our own, seen from another device: outgoing, to the other person.
    let mut mine = Message::new(Some(tokio_xmpp::parsers::jid::Jid::from_str("pau@chat.test").unwrap()));
    mine.from = Some(tokio_xmpp::parsers::jid::Jid::from_str("ana@chat.test/desk").unwrap());
    mine.type_ = MessageType::Chat;
    mine.id = Some(tokio_xmpp::parsers::message::Id("x".into()));
    mine.bodies.insert(Default::default(), "Bye".into());
    let got = xmpp::interpret(&mine, &own, Some("arch-2".into()), 100, "a").unwrap();
    assert_eq!((got.conversation.as_str(), got.direction.as_str()), ("pau@chat.test", "out"));
    // Group chat, errors and empty bodies are not chat messages here.
    let mut group = m.clone();
    group.type_ = MessageType::Groupchat;
    assert!(xmpp::interpret(&group, &own, None, 1, "a").is_none());
    let mut empty = m.clone();
    empty.bodies.clear();
    assert!(xmpp::interpret(&empty, &own, None, 1, "a").is_none());
    // What we send carries its id as origin-id and asks for a receipt.
    let out = xmpp::outgoing(&BareJid::from_str("pau@chat.test").unwrap(), "s1", "Hi");
    assert!(out.payloads.iter().any(|p| tokio_xmpp::parsers::receipts::Request::try_from(p.clone()).is_ok()));
    assert_eq!(xmpp::interpret(&out, &own, None, 1, "a").unwrap().id, "s1");
}

/// Against a real Prosody (tests/prosody-xmpp.sh): ORENETA_PROSODY is its
/// address. Skipped otherwise.
#[tokio::test(flavor = "multi_thread")]
async fn against_prosody_messages_arrive_once_and_offline_ones_come_from_the_archive() {
    let Ok(address) = std::env::var("ORENETA_PROSODY") else {
        eprintln!("skipped: no Prosody (see tests/prosody-xmpp.sh)");
        return;
    };
    let (host, port) = address.rsplit_once(':').unwrap();
    let port: u16 = port.parse().unwrap();
    let start = |id: &str, jid: &str, db: Arc<std::sync::Mutex<Connection>>| {
        let account = ChatAccount { id: id.into(), jid: jid.into(), host: host.into(), port };
        let connector = xmpp::Connector { host: host.into(), port, proxy: None, cert_pin: None, plain_loopback: true };
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (etx, erx) = std::sync::mpsc::channel::<(String, serde_json::Value)>();
        let emit: xmpp::Emit = Arc::new(move |name: &str, detail: serde_json::Value| {
            let _ = etx.send((name.to_string(), detail));
        });
        let task = tokio::spawn(xmpp::run(account, "secret".into(), db, connector, rx, emit));
        (tx, erx, task)
    };
    let online = |events: &std::sync::mpsc::Receiver<(String, serde_json::Value)>| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if let Ok((name, detail)) = events.recv_timeout(std::time::Duration::from_millis(200)) {
                if name == "chat.status" && detail["state"] == "online" {
                    return;
                }
                assert_ne!(detail["state"], "error", "{detail}");
            }
        }
        panic!("never online");
    };
    let wait_until = |what: &dyn Fn() -> bool| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if what() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        false
    };
    let ana_db = Arc::new(std::sync::Mutex::new(conn()));
    let pau_db = Arc::new(std::sync::Mutex::new(conn()));
    let (ana, ana_events, _ana_task) = start("ana", "ana@chat.test", ana_db.clone());
    let (pau, pau_events, pau_task) = start("pau", "pau@chat.test", pau_db.clone());
    tokio::task::spawn_blocking(move || {
        online(&ana_events);
        online(&pau_events);
    })
    .await
    .unwrap();

    // Live: delivered, receipted, accepted by the server.
    let id = format!("t-{}", std::process::id());
    queue(&ana_db.lock().unwrap(), "ana", "pau@chat.test", &id, "ana@chat.test", "Hola Pau", 1).unwrap();
    ana.send(xmpp::Command::Send { conversation: "pau@chat.test".into(), id: id.clone(), body: "Hola Pau".into() }).unwrap();
    let (pdb, adb, mid) = (pau_db.clone(), ana_db.clone(), id.clone());
    tokio::task::spawn_blocking(move || {
        assert!(wait_until(&|| history(&pdb.lock().unwrap(), "pau", "ana@chat.test", 10).unwrap().iter().any(|m| m.id == mid)));
        assert!(wait_until(&|| outgoing(&adb.lock().unwrap(), "ana", &mid).unwrap().state == "delivered"), "receipt");
    })
    .await
    .unwrap();

    // Pau goes offline; Ana writes; Pau comes back and catches up once.
    pau.send(xmpp::Command::Stop).unwrap();
    pau_task.await.unwrap();
    let id2 = format!("t2-{}", std::process::id());
    queue(&ana_db.lock().unwrap(), "ana", "pau@chat.test", &id2, "ana@chat.test", "¿Estás?", 2).unwrap();
    ana.send(xmpp::Command::Send { conversation: "pau@chat.test".into(), id: id2.clone(), body: "¿Estás?".into() }).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    for round in 0..2 {
        let (pau, pau_events, pau_task) = start("pau", "pau@chat.test", pau_db.clone());
        let (pdb, mid) = (pau_db.clone(), id2.clone());
        tokio::task::spawn_blocking(move || {
            online(&pau_events);
            assert!(wait_until(&|| history(&pdb.lock().unwrap(), "pau", "ana@chat.test", 50).unwrap().iter().any(|m| m.id == mid)));
            std::thread::sleep(std::time::Duration::from_millis(500));
        })
        .await
        .unwrap();
        let all = history(&pau_db.lock().unwrap(), "pau", "ana@chat.test", 50).unwrap();
        let ids: Vec<&str> = all.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids.iter().filter(|i| **i == id2).count(), 1, "round {round}: {ids:?}");
        assert_eq!(ids.iter().filter(|i| **i == id).count(), 1, "round {round}: {ids:?}");
        pau.send(xmpp::Command::Stop).unwrap();
        pau_task.await.unwrap();
    }
    ana.send(xmpp::Command::Stop).unwrap();
}
