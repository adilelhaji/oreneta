use super::*;
use std::str::FromStr;
use std::sync::Arc;
use tokio_xmpp::parsers::jid::BareJid;
use tokio_xmpp::parsers::message::{Message, MessageType};

fn conn() -> Connection {
    crate::store::open_in_memory_for_test().unwrap()
}

fn incoming(id: &str, archive: Option<&str>, body: &str, stamp: i64) -> ChatMessage {
    let mut m = ChatMessage::chat("a", "pau@chat.test", id, "in", "pau@chat.test", body, stamp, "received");
    m.stanza_id = archive.map(String::from);
    m
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


// ---- Group chats, invitations and files (ADR-0044) -------------------------------------

fn jid(s: &str) -> tokio_xmpp::parsers::jid::Jid {
    tokio_xmpp::parsers::jid::Jid::from_str(s).unwrap()
}

fn element(xml: &str) -> tokio_xmpp::parsers::minidom::Element {
    xml.parse().unwrap()
}

fn group_message(from: &str, id: &str, body: &str) -> Message {
    let mut m = Message::new(Some(jid("ana@chat.test/desk")));
    m.from = Some(jid(from));
    m.type_ = MessageType::Groupchat;
    m.id = Some(tokio_xmpp::parsers::message::Id(id.into()));
    m.bodies.insert(Default::default(), body.into());
    m
}

#[test]
fn joining_a_room_asks_for_history_and_carries_its_password() {
    use tokio_xmpp::parsers::muc::Muc;
    let room = BareJid::from_str("team@rooms.chat.test").unwrap();
    let presence = xmpp::join_presence(&room, "Ana", Some("s3cret"), None).unwrap();
    assert_eq!(presence.to.as_ref().unwrap().to_string(), "team@rooms.chat.test/Ana");
    let muc = presence.payloads.iter().find_map(|p| Muc::try_from(p.clone()).ok()).unwrap();
    assert_eq!(muc.password.as_deref(), Some("s3cret"));
    assert_eq!(muc.history.as_ref().unwrap().maxstanzas, Some(50), "nothing kept yet: the last 50");
    // Joining again asks only for what came since the newest message kept.
    let again = xmpp::join_presence(&room, "Ana", None, Some(1_760_000_000)).unwrap();
    let muc = again.payloads.iter().find_map(|p| Muc::try_from(p.clone()).ok()).unwrap();
    assert_eq!(muc.password, None);
    let history = muc.history.unwrap();
    assert_eq!((history.maxstanzas, history.since.map(|d| d.0.timestamp())), (None, Some(1_760_000_000)));
    let leave = xmpp::leave_presence(&room, "Ana").unwrap();
    assert_eq!(leave.type_, tokio_xmpp::parsers::presence::Type::Unavailable);
    assert!(xmpp::join_presence(&room, "", None, None).is_err());
}

#[test]
fn a_room_message_says_who_said_it_and_only_the_rooms_archive_id_counts() {
    let room = BareJid::from_str("team@rooms.chat.test").unwrap();
    let mut m = group_message("team@rooms.chat.test/Pau", "live-1", "Hola a todos");
    m.payloads.push(tokio_xmpp::parsers::stanza_id::OriginId { id: "origin-7".into() }.into());
    m.payloads.push(tokio_xmpp::parsers::stanza_id::StanzaId { id: "forged".into(), by: jid("chat.test") }.into());
    m.payloads.push(tokio_xmpp::parsers::stanza_id::StanzaId { id: "room-1".into(), by: jid("team@rooms.chat.test") }.into());
    let got = xmpp::interpret_group(&m, &room, "Ana", None, 5, "a").unwrap();
    assert_eq!(
        (got.conversation.as_str(), got.sender.as_str(), got.id.as_str(), got.stanza_id.as_deref(), got.direction.as_str(), got.kind.as_str()),
        ("team@rooms.chat.test", "Pau", "origin-7", Some("room-1"), "in", KIND_GROUP)
    );
    // Said with our nickname: ours, reflected by the room.
    let mine = xmpp::interpret_group(&group_message("team@rooms.chat.test/Ana", "s1", "Hi"), &room, "Ana", None, 5, "a").unwrap();
    assert_eq!((mine.direction.as_str(), mine.state.as_str()), ("out", "accepted"));
    // The room speaking, another room, a subject change: not messages.
    assert!(xmpp::interpret_group(&group_message("team@rooms.chat.test", "x", "Room notice"), &room, "Ana", None, 5, "a").is_none());
    assert!(xmpp::interpret_group(&group_message("other@rooms.chat.test/Pau", "x", "Hi"), &room, "Ana", None, 5, "a").is_none());
    let mut subject = group_message("team@rooms.chat.test/Pau", "x", "");
    subject.bodies.clear();
    subject.subjects.insert(Default::default(), "Topic".into());
    assert!(xmpp::interpret_group(&subject, &room, "Ana", None, 5, "a").is_none());
    // A one-to-one reading never takes a room's message.
    assert!(xmpp::interpret(&m, &BareJid::from_str("ana@chat.test").unwrap(), None, 5, "a").is_none());
    // What we send to a room is a group message with its origin-id, no receipt asked.
    let out = xmpp::outgoing_message(&room, "g1", "Hola", true, None);
    assert_eq!(out.type_, MessageType::Groupchat);
    assert!(!out.payloads.iter().any(|p| tokio_xmpp::parsers::receipts::Request::try_from(p.clone()).is_ok()));
    assert!(out.payloads.iter().any(|p| tokio_xmpp::parsers::stanza_id::OriginId::try_from(p.clone()).is_ok_and(|o| o.id == "g1")));
}

#[test]
fn our_message_reflected_by_the_room_is_kept_once_and_counts_as_accepted() {
    let c = conn();
    save_account(&c, &ChatAccount { id: "a".into(), jid: "ana@chat.test".into(), host: String::new(), port: 5222 }, 1).unwrap();
    save_room(&c, "a", "Team@Rooms.Chat.Test", "Ana", false, 1).unwrap();
    let mut mine = ChatMessage::chat("a", "team@rooms.chat.test", "g1", "out", "Ana", "Hola", 10, "sending");
    mine.kind = KIND_GROUP.into();
    queue_message(&c, &mine).unwrap();
    set_state(&c, "a", "g1", "sent").unwrap();
    // The room sends it back with the same origin-id and its archive id.
    let room = BareJid::from_str("team@rooms.chat.test").unwrap();
    let mut echo = group_message("team@rooms.chat.test/Ana", "g1", "Hola");
    echo.payloads.push(tokio_xmpp::parsers::stanza_id::OriginId { id: "g1".into() }.into());
    echo.payloads.push(tokio_xmpp::parsers::stanza_id::StanzaId { id: "room-9".into(), by: jid("team@rooms.chat.test") }.into());
    let copy = xmpp::interpret_group(&echo, &room, "Ana", None, 11, "a").unwrap();
    assert!(record(&c, &copy).unwrap());
    // And again from the room's archive, under another nickname even.
    let mut later = copy.clone();
    later.direction = "in".into();
    later.sender = "Ana2".into();
    assert!(!record(&c, &later).unwrap());
    let kept = history(&c, "a", "team@rooms.chat.test", 10).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!((kept[0].state.as_str(), kept[0].stanza_id.as_deref(), kept[0].sender.as_str()), ("accepted", Some("room-9"), "Ana"));
    assert!(is_ours(&c, "a", "team@rooms.chat.test", "g1").unwrap());
    // A room is not a one-to-one conversation, nor its archive the account's.
    assert!(conversations(&c, "a").unwrap().is_empty());
    assert_eq!(last_archive_id(&c, "a").unwrap(), None);
    assert_eq!(last_room_archive_id(&c, "a", "team@rooms.chat.test").unwrap().as_deref(), Some("room-9"));
}

#[test]
fn rooms_are_listed_with_what_is_new_and_leaving_takes_what_was_kept_here() {
    let c = conn();
    save_room(&c, "a", "team@rooms.chat.test", "Ana", true, 1).unwrap();
    save_room(&c, "a", "club@rooms.chat.test", "Ana", false, 2).unwrap();
    assert!(save_room(&c, "a", "not-a-room", "Ana", false, 1).is_err());
    assert!(save_room(&c, "a", "x@rooms.chat.test", "  ", false, 1).is_err());
    let mut said = ChatMessage::chat("a", "team@rooms.chat.test", "m1", "in", "Pau", "Hola", 50, "received");
    said.kind = KIND_GROUP.into();
    record(&c, &said).unwrap();
    let list = rooms(&c, "a").unwrap();
    assert_eq!(list.iter().map(|r| r.room.as_str()).collect::<Vec<_>>(), ["team@rooms.chat.test", "club@rooms.chat.test"]);
    assert_eq!((list[0].unread, list[0].last_body.as_str(), list[0].has_password), (1, "Hola", true));
    assert_eq!(last_room_stamp(&c, "a", "team@rooms.chat.test").unwrap(), Some(50));
    mark_read(&c, "a", "team@rooms.chat.test", 50).unwrap();
    assert_eq!(rooms(&c, "a").unwrap()[0].unread, 0);
    assert_eq!(room_secret_keys(&c, "a").unwrap(), [room_secret_key("a", "team@rooms.chat.test")]);
    leave_room(&c, "a", "team@rooms.chat.test").unwrap();
    assert!(room(&c, "a", "team@rooms.chat.test").unwrap().is_none());
    assert!(history(&c, "a", "team@rooms.chat.test", 10).unwrap().is_empty());
    // Removing the account takes its rooms and invitations too.
    save_invitation(&c, &invite("a", "x@rooms.chat.test")).unwrap();
    remove_account(&c, "a").unwrap();
    assert!(rooms(&c, "a").unwrap().is_empty() && invitations(&c, "a").unwrap().is_empty());
    // The step that adds all this can run again.
    migrate_groups(&c).unwrap();
}

fn invite(account: &str, room: &str) -> Invitation {
    Invitation {
        account: account.into(),
        room: room.into(),
        inviter: "pau@chat.test".into(),
        reason: String::new(),
        has_password: false,
        received_at: 1,
    }
}

#[test]
fn an_invitation_is_offered_not_acted_on_and_cannot_flood() {
    // XEP-0249, direct: from the person, with the room's password.
    let mut m = Message::new(Some(jid("ana@chat.test")));
    m.from = Some(jid("pau@chat.test/phone"));
    m.payloads.push(element(
        "<x xmlns='jabber:x:conference' jid='team@rooms.chat.test' password='pw' reason='Ven al equipo'/>",
    ));
    let (got, password) = xmpp::invitation(&m, "a", 7).unwrap();
    assert_eq!(
        (got.room.as_str(), got.inviter.as_str(), got.reason.as_str(), got.has_password, password.as_deref()),
        ("team@rooms.chat.test", "pau@chat.test", "Ven al equipo", true, Some("pw"))
    );
    // XEP-0045, through the room.
    let mut mediated = Message::new(Some(jid("ana@chat.test")));
    mediated.from = Some(jid("club@rooms.chat.test"));
    mediated.payloads.push(element(
        "<x xmlns='http://jabber.org/protocol/muc#user'><invite from='pau@chat.test/phone'><reason>Hola</reason></invite></x>",
    ));
    let (got, password) = xmpp::invitation(&mediated, "a", 7).unwrap();
    assert_eq!((got.room.as_str(), got.inviter.as_str(), got.reason.as_str(), password), ("club@rooms.chat.test", "pau@chat.test", "Hola", None));
    // A plain message is no invitation.
    assert!(xmpp::invitation(&group_message("team@rooms.chat.test/Pau", "x", "hi"), "a", 7).is_none());

    let c = conn();
    assert!(save_invitation(&c, &invite("a", "team@rooms.chat.test")).unwrap());
    assert_eq!(invitations(&c, "a").unwrap().len(), 1);
    // Joining answers it; an invitation to a room already joined is not kept.
    save_room(&c, "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    assert!(invitations(&c, "a").unwrap().is_empty());
    assert!(!save_invitation(&c, &invite("a", "team@rooms.chat.test")).unwrap());
    for n in 0..MAX_INVITATIONS {
        assert!(save_invitation(&c, &invite("a", &format!("r{n}@rooms.chat.test"))).unwrap());
    }
    assert!(!save_invitation(&c, &invite("a", "one-more@rooms.chat.test")).unwrap(), "no more than {MAX_INVITATIONS}");
    // The same room again only refreshes its invitation.
    assert!(save_invitation(&c, &invite("a", "r0@rooms.chat.test")).unwrap());
    dismiss_invitation(&c, "a", "r0@rooms.chat.test").unwrap();
    assert_eq!(invitations(&c, "a").unwrap().len() as i64, MAX_INVITATIONS - 1);
}

#[test]
fn a_room_tells_us_we_are_in_or_why_not() {
    use xmpp::RoomPresence;
    let joined: tokio_xmpp::parsers::presence::Presence = element(
        "<presence xmlns='jabber:client' from='team@rooms.chat.test/Ana'><x xmlns='http://jabber.org/protocol/muc#user'>\
         <item affiliation='owner' role='moderator'/><status code='110'/><status code='201'/></x></presence>",
    )
    .try_into()
    .unwrap();
    assert_eq!(xmpp::room_presence(&joined), Some(RoomPresence::Joined { created: true }));
    let other: tokio_xmpp::parsers::presence::Presence = element(
        "<presence xmlns='jabber:client' from='team@rooms.chat.test/Pau'><x xmlns='http://jabber.org/protocol/muc#user'>\
         <item affiliation='none' role='participant'/></x></presence>",
    )
    .try_into()
    .unwrap();
    assert_eq!(xmpp::room_presence(&other), None);
    let refused: tokio_xmpp::parsers::presence::Presence = element(
        "<presence xmlns='jabber:client' type='error' from='team@rooms.chat.test/Ana'>\
         <error type='auth'><not-authorized xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></presence>",
    )
    .try_into()
    .unwrap();
    assert!(matches!(xmpp::room_presence(&refused), Some(RoomPresence::Error { condition, .. }) if condition == "password"));
}

#[test]
fn the_upload_service_its_limit_and_a_slot_are_read_and_a_large_file_is_refused_first() {
    use tokio_xmpp::parsers::disco::DiscoInfoResult;
    let info = DiscoInfoResult::try_from(element(
        "<query xmlns='http://jabber.org/protocol/disco#info'>\
           <identity category='store' type='file' name='HTTP File Upload'/>\
           <feature var='urn:xmpp:http:upload:0'/>\
           <x type='result' xmlns='jabber:x:data'>\
             <field var='FORM_TYPE' type='hidden'><value>urn:xmpp:http:upload:0</value></field>\
             <field var='max-file-size'><value>1048576</value></field>\
           </x></query>",
    ))
    .unwrap();
    assert_eq!(files::upload_service(&info), Some(Some(1_048_576)));
    let plain = DiscoInfoResult::try_from(element(
        "<query xmlns='http://jabber.org/protocol/disco#info'><identity category='server' type='im'/></query>",
    ))
    .unwrap();
    assert_eq!(files::upload_service(&plain), None);
    assert_eq!(
        files::check_size(2_000_000, Some(1_048_576)),
        Err(files::FileError::TooLarge { size: 2_000_000, max: 1_048_576 })
    );
    assert!(files::check_size(10, Some(1_048_576)).is_ok() && files::check_size(u64::MAX, None).is_ok());

    let request: tokio_xmpp::parsers::minidom::Element = files::slot_request("foto.jpg", 1234).into();
    assert_eq!((request.attr("filename"), request.attr("size")), (Some("foto.jpg"), Some("1234")));
    let slot = tokio_xmpp::parsers::http_upload::SlotResult::try_from(element(
        "<slot xmlns='urn:xmpp:http:upload:0'>\
           <put url='https://up.chat.test/abc/foto.jpg'><header name='Authorization'>Basic x</header></put>\
           <get url='https://up.chat.test/abc/foto.jpg'/></slot>",
    ))
    .unwrap();
    let parsed = files::parse_slot(slot).unwrap();
    assert_eq!(parsed.headers, [("Authorization".to_string(), "Basic x".to_string())]);
    assert_eq!(parsed.get, "https://up.chat.test/abc/foto.jpg");
    // A slot over plain HTTP is not used.
    let insecure = tokio_xmpp::parsers::http_upload::SlotResult::try_from(element(
        "<slot xmlns='urn:xmpp:http:upload:0'><put url='http://up.chat.test/a'/><get url='https://up.chat.test/a'/></slot>",
    ))
    .unwrap();
    assert_eq!(files::parse_slot(insecure), Err(files::FileError::NotHttps));
}

#[test]
fn a_file_goes_as_a_link_and_comes_back_as_a_file_with_its_name() {
    let own = BareJid::from_str("ana@chat.test").unwrap();
    let link = "https://up.chat.test/abc/Informe%20final.pdf";
    let out = xmpp::outgoing_message(&BareJid::from_str("pau@chat.test").unwrap(), "f1", link, false, Some(link));
    assert_eq!(files::link_of(&out).as_deref(), Some(link));
    let mut incoming = out.clone();
    incoming.from = Some(jid("pau@chat.test/phone"));
    incoming.to = Some(jid("ana@chat.test"));
    let got = xmpp::interpret(&incoming, &own, None, 1, "a").unwrap();
    assert_eq!((got.file_url.as_deref(), got.file_name.as_deref()), (Some(link), Some("Informe final.pdf")));
    // Only the link, no body: still a file.
    incoming.bodies.clear();
    assert_eq!(xmpp::interpret(&incoming, &own, None, 1, "a").unwrap().body, link);
    // A name never reaches outside a folder.
    assert_eq!(files::file_name_of("https://x.test/a/..%2F..%2Fetc%2Fpasswd"), "_.._etc_passwd");
    assert_eq!(files::file_name_of("https://x.test/"), "file");
    // Kept with the message, and the list shows its name.
    let c = conn();
    record(&c, &xmpp::interpret(&out.clone(), &own, None, 1, "a").unwrap()).unwrap();
    assert_eq!(conversations(&c, "a").unwrap()[0].last_body, "Informe final.pdf");
}

#[test]
fn files_come_and_go_over_https_only() {
    // Through the app-wide route: not while a test publishes a broken one.
    let _route = crate::proxy::steady_global();
    use files::{FileError, https_only};
    assert!(https_only("https://up.chat.test/a/b.png").is_ok());
    for bad in ["http://up.chat.test/a", "ftp://up.chat.test/a", "file:///etc/passwd", "https://user:pw@up.chat.test/a", "nonsense", "javascript:alert(1)"] {
        assert_eq!(https_only(bad).err(), Some(FileError::NotHttps), "{bad}");
    }
    let agent = files::agent(&[]).unwrap();
    let dir = std::env::temp_dir().join(format!("oreneta-chat-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dest = dir.join("x.bin");
    assert_eq!(files::download(&agent, "http://127.0.0.1:1/x.bin", &dest).err(), Some(FileError::NotHttps));
    assert!(!dest.exists(), "nothing written");
    let source = dir.join("up.bin");
    std::fs::write(&source, b"hello").unwrap();
    let slot = files::Slot { put: "http://127.0.0.1:1/x".into(), headers: vec![], get: "https://x.test/x".into() };
    let cancel = std::sync::atomic::AtomicBool::new(false);
    assert_eq!(files::put(&agent, &slot, &source, &cancel, &mut |_| {}).err(), Some(FileError::NotHttps));
    let _ = std::fs::remove_dir_all(&dir);
}

fn timed_out(answer: &Result<tokio_xmpp::IqResponse, tokio_xmpp::IqFailure>) -> bool {
    matches!(answer, Err(tokio_xmpp::IqFailure::SendError(e)) if e.kind() == std::io::ErrorKind::TimedOut)
}

/// A question about a file that gets no answer, or was never sent, ends at
/// its deadline as a failure; one answered in time comes through as it was
/// (#220).
#[tokio::test]
async fn an_unanswered_upload_question_ends_at_its_deadline() {
    type Token = std::future::Pending<Result<tokio_xmpp::IqResponse, tokio_xmpp::IqFailure>>;
    let soon = || tokio::time::Instant::now() + std::time::Duration::from_millis(50);
    let late = xmpp::answered_by(soon(), Some(std::future::pending())).await;
    assert!(timed_out(&late), "{late:?}");
    let unsent = xmpp::answered_by(soon(), None::<Token>).await;
    assert!(timed_out(&unsent), "{unsent:?}");
    let in_time = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let answered = xmpp::answered_by(in_time, Some(async { Ok(tokio_xmpp::IqResponse::Result(None)) })).await;
    assert!(matches!(answered, Ok(tokio_xmpp::IqResponse::Result(None))), "{answered:?}");
}

/// Getting a question into the outgoing queue counts against its deadline:
/// a queue with no room gives up at the deadline, a question already past
/// it is not even tried, and one queued in time goes on (#220).
#[tokio::test]
async fn an_upload_question_gets_into_the_queue_by_its_deadline_or_not_at_all() {
    let soon = tokio::time::Instant::now() + std::time::Duration::from_millis(50);
    assert_eq!(xmpp::sent_by(soon, std::future::pending::<u8>()).await, None, "no room in time");
    let tried = std::sync::atomic::AtomicBool::new(false);
    let past = tokio::time::Instant::now();
    let sent = xmpp::sent_by(past, async {
        tried.store(true, std::sync::atomic::Ordering::SeqCst);
        1u8
    })
    .await;
    assert_eq!(sent, None);
    assert!(!tried.load(std::sync::atomic::Ordering::SeqCst), "a question past its deadline is not sent");
    let in_time = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    assert_eq!(xmpp::sent_by(in_time, async { 7u8 }).await, Some(7));
}

/// With tokio-xmpp's outgoing queue full (a server that takes the
/// connection and never answers, so nothing is sent), asking about a file
/// returns by its deadline instead of waiting for room, and the question
/// ends as unanswered; the next one in the batch, past the deadline, does
/// not wait at all. Without the deadline covering the queue, `ask_by`
/// would wait for good and hold up the session (#220).
#[tokio::test]
async fn an_upload_question_does_not_wait_past_its_deadline_for_a_full_queue() {
    use futures::StreamExt;
    use std::time::Duration;
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = silent.local_addr().unwrap().port();
    let connector = xmpp::Connector { host: "127.0.0.1".into(), port, proxy: None, cert_pin: None, plain_loopback: true };
    let jid = BareJid::from_str("pau@chat.test").unwrap();
    let mut client = tokio_xmpp::Client::new_with_connector(jid, "secret", connector, tokio_xmpp::xmlstream::Timeouts::default());
    let question = || tokio_xmpp::IqRequest::Get(tokio_xmpp::parsers::disco::DiscoInfoQuery { node: None }.into());
    let mut full = false;
    for _ in 0..64 {
        if tokio::time::timeout(Duration::from_millis(200), client.send_iq(None, question())).await.is_err() {
            full = true;
            break;
        }
    }
    assert!(full, "the outgoing queue never filled up");

    let mut pending = xmpp::Pending::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    tokio::time::timeout(Duration::from_secs(10), xmpp::ask_by(&mut client, &mut pending, deadline, xmpp::Asked::Slot("a".into()), None, question()))
        .await
        .expect("the question waited past its deadline for room in the queue");
    let (what, answer) = tokio::time::timeout(Duration::from_secs(10), pending.next()).await.expect("ended by its deadline").expect("one question");
    assert!(matches!(what, xmpp::Asked::Slot(ref id) if id == "a"));
    assert!(timed_out(&answer), "{answer:?}");

    tokio::time::timeout(Duration::from_secs(1), xmpp::ask_by(&mut client, &mut pending, deadline, xmpp::Asked::Slot("b".into()), None, question()))
        .await
        .expect("a question past its deadline does not wait for room");
    let (what, answer) = tokio::time::timeout(Duration::from_secs(1), pending.next()).await.expect("ended at once").expect("one question");
    assert!(matches!(what, xmpp::Asked::Slot(ref id) if id == "b"));
    assert!(timed_out(&answer), "{answer:?}");
    drop(silent);
}

/// A discovery question with no answer (a failure, as at its deadline) is
/// noted; a server's "no" is not. The first upload service answering is
/// the one used, and a slot never answered is a failed connection (#220).
#[test]
fn upload_answers_are_read_and_a_missing_one_is_noted() {
    use files::FileError;
    use tokio_xmpp::parsers::stanza_error::{DefinedCondition, ErrorType, StanzaError};
    use tokio_xmpp::{IqFailure, IqResponse};
    let none = || Err(IqFailure::SendError(std::io::Error::new(std::io::ErrorKind::TimedOut, "no answer in time")));
    let refused = || Ok(IqResponse::Error(StanzaError::new(ErrorType::Cancel, DefinedCondition::ServiceUnavailable, "en", "")));
    let service = || {
        Ok(IqResponse::Result(Some(element(
            "<query xmlns='http://jabber.org/protocol/disco#info'>\
               <feature var='urn:xmpp:http:upload:0'/>\
               <x type='result' xmlns='jabber:x:data'>\
                 <field var='FORM_TYPE' type='hidden'><value>urn:xmpp:http:upload:0</value></field>\
                 <field var='max-file-size'><value>1048576</value></field>\
               </x></query>",
        ))))
    };
    let jid = |j: &str| tokio_xmpp::parsers::jid::Jid::from_str(j).unwrap();

    let mut uploads = xmpp::Uploads { searching: 3, ..Default::default() };
    xmpp::info_answered(&mut uploads, jid("chat.test"), refused());
    assert_eq!((uploads.searching, uploads.unanswered, uploads.service.is_none()), (2, false, true));
    xmpp::info_answered(&mut uploads, jid("rooms.chat.test"), none());
    assert_eq!((uploads.searching, uploads.unanswered, uploads.service.is_none()), (1, true, true));
    xmpp::info_answered(&mut uploads, jid("upload.chat.test"), service());
    assert_eq!((uploads.searching, uploads.unanswered), (0, false), "found: the unanswered one no longer matters");
    assert_eq!(uploads.service, Some((jid("upload.chat.test"), Some(1_048_576))));
    xmpp::info_answered(&mut uploads, jid("other.chat.test"), service());
    assert_eq!(uploads.service.as_ref().map(|(j, _)| j.to_string()).as_deref(), Some("upload.chat.test"), "the first one stays");

    let mut items = xmpp::Uploads { searching: 1, ..Default::default() };
    xmpp::discovery_answered(&mut items, &none());
    assert_eq!((items.searching, items.unanswered), (0, true));

    assert_eq!(xmpp::slot_from(none()).err(), Some(FileError::Disconnected));
    assert!(matches!(xmpp::slot_from(refused()), Err(FileError::Refused { .. })));
    assert!(matches!(xmpp::slot_from(Ok(IqResponse::Result(None))), Err(FileError::Refused { .. })));
}

/// With the search over and no service, the waiting uploads end once each:
/// "disconnected" when a question went unanswered, "no service" when all
/// were answered. While questions are out, they keep waiting (#220).
#[test]
fn a_search_without_a_service_ends_the_waiting_uploads() {
    use files::FileError;
    let upload = |id: &str| xmpp::Upload {
        id: id.into(),
        conversation: "pau@chat.test".into(),
        group: false,
        path: "x.bin".into(),
        name: "x.bin".into(),
        size: 1,
        cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let ended = std::sync::Mutex::new(Vec::new());
    let record = |u: &xmpp::Upload, result: Result<String, FileError>| ended.lock().unwrap().push((u.id.clone(), result.err()));
    let mut uploads = xmpp::Uploads { searching: 1, unanswered: true, waiting: vec![upload("a")], ..Default::default() };
    xmpp::end_search(&mut uploads, &record);
    assert!(ended.lock().unwrap().is_empty() && uploads.waiting.len() == 1, "a question is still out");
    uploads.searching = 0;
    xmpp::end_search(&mut uploads, &record);
    uploads.waiting.push(upload("b"));
    xmpp::end_search(&mut uploads, &record);
    assert_eq!(
        *ended.lock().unwrap(),
        vec![("a".to_string(), Some(FileError::Disconnected)), ("b".to_string(), Some(FileError::NoService))]
    );
    assert!(uploads.waiting.is_empty() && !uploads.unanswered);
}

// ---- Presence, mentions, notifications and private messages (ADR-0055) -----------------

fn stanza<T: TryFrom<tokio_xmpp::parsers::minidom::Element>>(xml: &str) -> T
where
    T::Error: std::fmt::Debug,
{
    T::try_from(element(xml)).unwrap()
}

#[test]
fn the_own_status_is_kept_per_account_and_a_bad_field_falls_back_alone() {
    use presence::{own, save_own};
    let c = conn();
    assert_eq!(own(&c, "a").unwrap(), presence::OwnPresence::default(), "nothing saved: available, no text");
    let saved = save_own(&c, "a", "away", "  En una reunión\n hasta las 5\u{7}  ").unwrap();
    assert_eq!((saved.show.as_str(), saved.status.as_str()), ("away", "En una reunión  hasta las 5"));
    assert_eq!(own(&c, "a").unwrap(), saved);
    // Another account is untouched.
    assert_eq!(own(&c, "b").unwrap().show, "available");
    // At most 200 characters; an unknown status is refused and changes nothing.
    let long = save_own(&c, "a", "dnd", &"ñ".repeat(250)).unwrap();
    assert_eq!(long.status.chars().count(), presence::MAX_STATUS);
    assert!(save_own(&c, "a", "busy", "x").is_err());
    assert_eq!(own(&c, "a").unwrap().show, "dnd");
    // A damaged row: the bad field falls back, the good one stays.
    crate::store::setting_set(&c, "chat_presence:a", &serde_json::json!({ "show": "partying", "status": "Aquí" })).unwrap();
    assert_eq!(own(&c, "a").unwrap(), presence::OwnPresence { show: "available".into(), status: "Aquí".into() });
    crate::store::setting_set(&c, "chat_presence:a", &serde_json::json!({ "show": "away", "status": 7 })).unwrap();
    assert_eq!(own(&c, "a").unwrap(), presence::OwnPresence { show: "away".into(), status: String::new() });
    // Removing the account forgets it.
    save_account(&c, &ChatAccount { id: "a".into(), jid: "ana@chat.test".into(), host: String::new(), port: 5222 }, 1).unwrap();
    remove_account(&c, "a").unwrap();
    assert_eq!(own(&c, "a").unwrap(), presence::OwnPresence::default());
}

#[test]
fn invisible_is_used_only_where_the_server_offers_it_and_never_turns_visible_alone() {
    use presence::{Applied, plan};
    assert_eq!(plan("available", None), Applied::Announced);
    assert_eq!(plan("dnd", Some(false)), Applied::Announced);
    assert_eq!(plan("invisible", Some(true)), Applied::Invisible);
    // Not offered: nothing is announced, the person stays hidden.
    assert_eq!(plan("invisible", Some(false)), Applied::Withheld);
    // Not known yet: wait for the server to say.
    assert_eq!(plan("invisible", None), Applied::Waiting);
    let offers = tokio_xmpp::parsers::disco::DiscoInfoResult::try_from(element(
        "<query xmlns='http://jabber.org/protocol/disco#info'><identity category='server' type='im'/>\
         <feature var='urn:xmpp:invisible:0'/><feature var='urn:xmpp:mam:2'/></query>",
    ))
    .unwrap();
    let lacks = tokio_xmpp::parsers::disco::DiscoInfoResult::try_from(element(
        "<query xmlns='http://jabber.org/protocol/disco#info'><identity category='server' type='im'/>\
         <feature var='urn:xmpp:mam:2'/></query>",
    ))
    .unwrap();
    assert!(presence::supports_invisible(&offers) && !presence::supports_invisible(&lacks));
    let hide = presence::invisible_command(true);
    let show = presence::invisible_command(false);
    assert!(hide.is("invisible", presence::NS_INVISIBLE) && show.is("visible", presence::NS_INVISIBLE));
}

#[test]
fn contacts_hear_availability_and_text_but_rooms_hear_no_text() {
    use tokio_xmpp::parsers::presence::Show;
    let away = presence::own_stanza("away", " Comiendo ");
    assert_eq!((away.show, away.to.is_none()), (Some(Show::Away), true), "announced to no one in particular");
    assert_eq!(away.statuses.get("").map(String::as_str), Some("Comiendo"));
    let busy = presence::own_stanza("dnd", "");
    assert_eq!((busy.show, busy.statuses.is_empty()), (Some(Show::Dnd), true));
    assert_eq!(presence::own_stanza("available", "").show, None);
    // A room hears that we are busy, never why.
    let to_room = presence::room_stanza(jid("team@rooms.chat.test/Ana"), "dnd");
    assert_eq!((to_room.show, to_room.statuses.is_empty()), (Some(Show::Dnd), true));
    let room = BareJid::from_str("team@rooms.chat.test").unwrap();
    let join = xmpp::join_presence_as(&room, "Ana", None, None, "away").unwrap();
    assert_eq!(join.show, Some(Show::Away));
    assert!(join.statuses.is_empty());
    assert!(join.payloads.iter().any(|p| tokio_xmpp::parsers::muc::Muc::try_from(p.clone()).is_ok()), "still a join");
    // Asking to see someone's status, and answering.
    let ask = presence::subscription(&BareJid::from_str("pau@chat.test").unwrap(), tokio_xmpp::parsers::presence::Type::Subscribe);
    assert_eq!((ask.type_, ask.to.unwrap().to_string()), (tokio_xmpp::parsers::presence::Type::Subscribe, "pau@chat.test".to_string()));
}

#[test]
fn a_contacts_status_follows_their_best_device_and_requests_wait_for_the_person() {
    use presence::{ContactPresence, contact_presence};
    let own = BareJid::from_str("ana@chat.test").unwrap();
    let phone: tokio_xmpp::parsers::presence::Presence = stanza(
        "<presence xmlns='jabber:client' from='pau@chat.test/phone'><show>away</show><status>En el tren</status><priority>5</priority></presence>",
    );
    assert_eq!(
        contact_presence(&phone, &own),
        Some(ContactPresence::Status { jid: "pau@chat.test".into(), resource: "phone".into(), show: "away", status: "En el tren".into(), priority: 5 })
    );
    let gone: tokio_xmpp::parsers::presence::Presence = stanza("<presence xmlns='jabber:client' type='unavailable' from='pau@chat.test/desk'/>");
    assert!(matches!(contact_presence(&gone, &own), Some(ContactPresence::Status { show: "offline", .. })));
    let asks: tokio_xmpp::parsers::presence::Presence = stanza("<presence xmlns='jabber:client' type='subscribe' from='eva@chat.test'/>");
    assert_eq!(contact_presence(&asks, &own), Some(ContactPresence::Request { jid: "eva@chat.test".into() }));
    // Our own other devices, and answers to our own requests, are not contacts' statuses.
    let mine: tokio_xmpp::parsers::presence::Presence = stanza("<presence xmlns='jabber:client' from='ana@chat.test/phone'/>");
    assert_eq!(contact_presence(&mine, &own), None);
    let allowed: tokio_xmpp::parsers::presence::Presence = stanza("<presence xmlns='jabber:client' type='subscribed' from='pau@chat.test'/>");
    assert_eq!(contact_presence(&allowed, &own), None);

    let mut contacts = presence::Contacts::default();
    assert_eq!(contacts.update("pau@chat.test", "phone", "away", "En el tren", 5).unwrap().show, "away");
    // A device with a higher priority wins, whatever it says.
    assert_eq!(contacts.update("pau@chat.test", "desk", "dnd", "Concentrado", 10).unwrap().show, "dnd");
    // At the same priority, the more available one.
    contacts.update("pau@chat.test", "desk", "dnd", "", 5);
    assert_eq!(contacts.seen("pau@chat.test").show, "away");
    contacts.update("pau@chat.test", "tablet", "chat", "", 5);
    assert_eq!(contacts.seen("pau@chat.test").show, "chat");
    for device in ["phone", "desk", "tablet"] {
        contacts.update("pau@chat.test", device, "offline", "", 0);
    }
    assert_eq!(contacts.seen("pau@chat.test"), presence::Seen { show: "offline".into(), status: String::new() });
    // Seen once, then gone: known as offline, so the app does not offer to ask again.
    assert_eq!(contacts.all().get("pau@chat.test").map(|s| s.show.as_str()), Some("offline"));
    // The server saying a contact the person may see is offline: known too.
    contacts.update("eva@chat.test", "", "offline", "", 0);
    assert_eq!(contacts.all().len(), 2);
    // A presence from someone in a room is not a contact's.
    let occupant: tokio_xmpp::parsers::presence::Presence = stanza(
        "<presence xmlns='jabber:client' type='unavailable' from='team@rooms.chat.test/Pau'>\
         <x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='none' role='none'/></x></presence>",
    );
    assert_eq!(contact_presence(&occupant, &own), None);

    // What a session knows starts again with a new session.
    let mut live = presence::Live::default();
    live.contacts.update("pau@chat.test", "phone", "away", "", 0);
    live.requests.insert("eva@chat.test".into());
    live.invisible_supported = Some(true);
    let snapshot = live.snapshot();
    assert_eq!(snapshot["contacts"]["pau@chat.test"]["show"], "away");
    assert_eq!(snapshot["requests"], serde_json::json!(["eva@chat.test"]));
    assert_eq!(snapshot["own"]["applied"], "offline");
    live.fresh_session();
    assert!(live.contacts.all().is_empty() && live.requests.is_empty() && live.invisible_supported.is_none());
}

#[test]
fn who_is_in_a_room_follows_its_presence_and_the_room_may_rename_us() {
    use presence::{OccupantChange, occupant_change};
    let came: tokio_xmpp::parsers::presence::Presence = stanza(
        "<presence xmlns='jabber:client' from='team@rooms.chat.test/Pau'><show>dnd</show>\
         <x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='member' role='moderator'/></x></presence>",
    );
    let Some(OccupantChange::Here(pau)) = occupant_change(&came) else { panic!("Pau came") };
    assert_eq!((pau.nick.as_str(), pau.show.as_str(), pau.role.as_str()), ("Pau", "dnd", "moderator"));
    let renamed: tokio_xmpp::parsers::presence::Presence = stanza(
        "<presence xmlns='jabber:client' type='unavailable' from='team@rooms.chat.test/Pau'>\
         <x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='member' role='participant' nick='Pau R'/><status code='303'/></x></presence>",
    );
    assert_eq!(occupant_change(&renamed), Some(OccupantChange::Renamed { from: "Pau".into(), to: "Pau R".into() }));
    let left: tokio_xmpp::parsers::presence::Presence = stanza(
        "<presence xmlns='jabber:client' type='unavailable' from='team@rooms.chat.test/Pau R'>\
         <x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='member' role='none'/></x></presence>",
    );
    // About us (110), or not from a room: not someone else in it.
    let us: tokio_xmpp::parsers::presence::Presence = stanza(
        "<presence xmlns='jabber:client' from='team@rooms.chat.test/Ana2'>\
         <x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='none' role='participant'/><status code='110'/><status code='210'/></x></presence>",
    );
    assert_eq!(occupant_change(&us), None);
    assert_eq!(occupant_change(&stanza("<presence xmlns='jabber:client' from='pau@chat.test/phone'/>")), None);
    assert_eq!(presence::own_nick_in(&us, "Ana").as_deref(), Some("Ana2"), "the room gave us another nickname");
    assert_eq!(presence::own_nick_in(&us, "Ana2"), None);

    let mut occupants = presence::Occupants::default();
    assert!(occupants.apply("team@rooms.chat.test", occupant_change(&came).unwrap()));
    assert!(!occupants.apply("team@rooms.chat.test", occupant_change(&came).unwrap()), "nothing new");
    assert!(occupants.apply("team@rooms.chat.test", occupant_change(&renamed).unwrap()));
    assert_eq!(occupants.list("team@rooms.chat.test").iter().map(|o| o.nick.as_str()).collect::<Vec<_>>(), ["Pau R"]);
    assert!(occupants.list("other@rooms.chat.test").is_empty());
    assert!(occupants.apply("team@rooms.chat.test", occupant_change(&left).unwrap()));
    assert!(occupants.list("team@rooms.chat.test").is_empty());

    // The nickname the room gave is kept, so mentions follow it.
    let c = conn();
    save_room(&c, "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    set_room_nick(&c, "a", "team@rooms.chat.test", "Ana2").unwrap();
    assert_eq!(room_nick(&c, "a", "team@rooms.chat.test").unwrap().as_deref(), Some("Ana2"));
    // Whatever the room gives is kept, even a nickname we would not choose.
    let long = "N".repeat(80);
    set_room_nick(&c, "a", "team@rooms.chat.test", &long).unwrap();
    assert_eq!(room_nick(&c, "a", "team@rooms.chat.test").unwrap(), Some(long));
    assert!(set_room_nick(&c, "a", "team@rooms.chat.test", "").is_err());
}

#[test]
fn a_mention_is_the_nickname_as_a_whole_word_or_a_reference_to_us() {
    use mentions::{find_word, mentions_nick};
    assert!(mentions_nick("@Ana, ¿vienes?", "Ana"));
    assert!(mentions_nick("hola ana", "Ana"), "case does not matter");
    assert!(mentions_nick("¿ÁLVARO?", "Álvaro"), "nor the alphabet");
    assert!(mentions_nick("pregunta a Ana María", "Ana María"), "a nickname with a space");
    assert!(mentions_nick("gracias, J.R.", "J.R."));
    assert!(!mentions_nick("Anabel dijo", "Ana"), "not inside another word");
    assert!(!mentions_nick("Mariana", "Ana"));
    assert!(!mentions_nick("ana_b llegó", "Ana"), "_ continues a word");
    assert!(!mentions_nick("hola", "  "), "an empty nickname mentions nobody");
    // A short nickname only after @: "al" and "Jo" are ordinary words too.
    assert!(!mentions_nick("vamos al cine", "Al"));
    assert!(mentions_nick("@Al ¿vienes?", "Al"));
    assert!(!mentions_nick("Jo, qué frío", "Jo"));
    assert!(mentions_nick("gracias @jo", "Jo"));
    assert!(mentions_nick("Ana, ¿vienes?", "Ana"), "three letters or more: the word is enough");
    assert_eq!(
        mentions::written_mentions("@Pau R y @Eva, y Joan", &["Pau R".into(), "Eva".into(), "Joan".into(), "Eva".into()]),
        ["Pau R", "Eva"],
        "only those written with @, once"
    );
    assert_eq!(find_word("Hi 日本 and @Ana!", "ana"), Some((11, 14)), "counted in characters, not bytes");

    let own = BareJid::from_str("ana@chat.test").unwrap();
    let room = BareJid::from_str("team@rooms.chat.test").unwrap();
    let mut by_reference = group_message("team@rooms.chat.test/Pau", "r1", "mira esto");
    by_reference.payloads.push(element(
        "<reference xmlns='urn:xmpp:reference:0' type='mention' uri='xmpp:team@rooms.chat.test/Ana' begin='0' end='4'/>",
    ));
    assert!(mentions::is_mention(&by_reference, "mira esto", &own, &room, "Ana"));
    let mut by_address = group_message("team@rooms.chat.test/Pau", "r2", "x");
    by_address.payloads.push(element("<reference xmlns='urn:xmpp:reference:0' type='mention' uri='xmpp:ana@chat.test'/>"));
    assert!(mentions::references_me(&by_address, &own, &room, "Ana"));
    // Someone else, another room, or a reference that is not a mention: no.
    let mut other = group_message("team@rooms.chat.test/Pau", "r3", "x");
    other.payloads.push(element("<reference xmlns='urn:xmpp:reference:0' type='mention' uri='xmpp:team@rooms.chat.test/Eva'/>"));
    other.payloads.push(element("<reference xmlns='urn:xmpp:reference:0' type='mention' uri='xmpp:club@rooms.chat.test/Ana'/>"));
    other.payloads.push(element("<reference xmlns='urn:xmpp:reference:0' type='data' uri='xmpp:ana@chat.test'/>"));
    assert!(!mentions::is_mention(&other, "x", &own, &room, "Ana"));

    // Picked nicknames still in the text go as references, once each.
    let out = xmpp::outgoing_group(&room, "g1", "@Pau R y @Eva: ¿café?", None, &["Pau R".into(), "Eva".into(), "Eva".into(), "Joan".into()]);
    let refs: Vec<_> = out.payloads.iter().filter(|p| p.is("reference", mentions::NS_REFERENCE)).collect();
    assert_eq!(refs.len(), 2, "Joan is not in the text; Eva once");
    assert_eq!(
        (refs[0].attr("uri"), refs[0].attr("begin"), refs[0].attr("end"), refs[0].attr("type")),
        (Some("xmpp:team@rooms.chat.test/Pau%20R"), Some("1"), Some("6"), Some("mention"))
    );
    assert_eq!((refs[1].attr("begin"), refs[1].attr("end")), (Some("10"), Some("13")));
    // A reference we sent is understood as one, by the person it names.
    let mut echo = out.clone();
    echo.from = Some(jid("team@rooms.chat.test/Ana"));
    assert!(mentions::references_me(&echo, &BareJid::from_str("pau@chat.test").unwrap(), &room, "Pau R"));
}

#[test]
fn reading_a_room_marks_what_names_the_person_and_nothing_else() {
    let c = conn();
    save_room(&c, "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    for (id, direction, sender, body, stamp) in [
        ("g1", "in", "Pau", "@Ana ¿vienes?", 10),
        ("g2", "in", "Pau", "Anabel viene", 11),
        ("g3", "out", "Ana", "Ana aquí", 12),
    ] {
        let mut m = ChatMessage::chat("a", "team@rooms.chat.test", id, direction, sender, body, stamp, "received");
        m.kind = KIND_GROUP.into();
        record(&c, &m).unwrap();
    }
    let marks: Vec<(String, bool)> = history(&c, "a", "team@rooms.chat.test", 10).unwrap().into_iter().map(|m| (m.id, m.mention)).collect();
    assert_eq!(marks, [("g1".to_string(), true), ("g2".to_string(), false), ("g3".to_string(), false)]);
    // A direct conversation has no mentions, whatever it says.
    record(&c, &incoming("d1", None, "Ana, hola", 13)).unwrap();
    assert!(!history(&c, "a", "pau@chat.test", 10).unwrap()[0].mention);
    // Another account sees none of it.
    assert!(history(&c, "b", "team@rooms.chat.test", 10).unwrap().is_empty());
}

fn group_in(body: &str, mention: bool) -> ChatMessage {
    let mut m = ChatMessage::chat("a", "team@rooms.chat.test", "g", "in", "Pau", body, 1, "received");
    m.kind = KIND_GROUP.into();
    m.mention = mention;
    m
}

#[test]
fn only_a_new_message_from_someone_else_just_sent_notifies() {
    use presence::{Arrival, should_notify};
    let direct = incoming("d1", None, "Hola", 1);
    assert!(should_notify(&direct, Arrival::Live, "available", false));
    assert!(should_notify(&direct, Arrival::Live, "away", false));
    assert!(should_notify(&direct, Arrival::Carbon, "available", false), "got by another device: still new here");
    assert!(!should_notify(&direct, Arrival::Backfill, "available", false), "caught up: shown as unread, no popup");
    assert!(!should_notify(&direct, Arrival::Live, "dnd", false), "busy holds them back");
    let mut mine = direct.clone();
    mine.direction = "out".into();
    assert!(!should_notify(&mine, Arrival::Carbon, "available", false), "our own, from another device");
    // In a room, only a mention.
    assert!(!should_notify(&group_in("hola a todos", false), Arrival::Live, "available", false));
    assert!(should_notify(&group_in("@Ana hola", true), Arrival::Live, "available", false));
    assert!(!should_notify(&group_in("@Ana hola", true), Arrival::Backfill, "available", false), "room history on joining");
    assert!(!should_notify(&group_in("@Ana hola", true), Arrival::Live, "dnd", false));
    // Privately through a room: like a direct one.
    let mut private = incoming("p1", None, "psst", 1);
    private.conversation = "team@rooms.chat.test/Pau".into();
    private.sender = "Pau".into();
    private.kind = KIND_PRIVATE.into();
    assert!(should_notify(&private, Arrival::Live, "available", false));

    // What the bridge is told: who, where, and the text cut short.
    let mut long = group_in(&"a".repeat(400), true);
    long.sender = "Pau".into();
    let mut wordy = long.clone();
    wordy.sender = "P".repeat(300);
    assert_eq!(presence::notification(&wordy)["title"].as_str().unwrap().chars().count(), presence::MAX_TITLE);
    let event = presence::notification(&long);
    assert_eq!((event["title"].as_str(), event["room"].as_str(), event["mention"].as_bool()), (Some("Pau · team@rooms.chat.test"), Some("team@rooms.chat.test"), Some(true)));
    assert_eq!(event["body"].as_str().unwrap().chars().count(), 280);
    let event = presence::notification(&private);
    assert_eq!((event["title"].as_str(), event["room"].as_str(), event["kind"].as_str()), (Some("Pau · team@rooms.chat.test"), Some("team@rooms.chat.test"), Some("private")));
    let mut file = direct.clone();
    file.file_name = Some("Informe.pdf".into());
    let event = presence::notification(&file);
    assert_eq!((event["title"].as_str(), event["body"].as_str(), event["room"].is_null()), (Some("pau@chat.test"), Some("Informe.pdf"), true));
}

/// Runs one stanza through the session's handling and says what it led to.
fn handle(db: &Arc<std::sync::Mutex<Connection>>, xml: &str, own_show: &str) -> xmpp::Handled {
    let message: Message = stanza(xml);
    xmpp::handle_message(db, "a", &BareJid::from_str("ana@chat.test").unwrap(), &message, own_show, &|_| {}, &|_, _| {})
}

#[test]
fn what_arrives_notifies_only_when_new_live_and_meant_for_the_person() {
    let db = Arc::new(std::sync::Mutex::new(conn()));
    save_room(&db.lock().unwrap(), "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    let live = "<message xmlns='jabber:client' type='chat' from='pau@chat.test/phone' to='ana@chat.test/desk' id='d1'><body>Hola</body></message>";
    let handled = handle(&db, live, "available");
    assert_eq!(handled.notify.map(|m| (m.id, m.kind)), Some(("d1".to_string(), KIND_CHAT.to_string())));
    // The same message again (a second copy): kept once, no second popup.
    assert!(handle(&db, live, "available").notify.is_none());
    // Kept for us while away (delayed), or caught up from the archive: no popup, but kept.
    let delayed = "<message xmlns='jabber:client' type='chat' from='pau@chat.test/phone' to='ana@chat.test' id='d2'><body>¿Estás?</body>\
                   <delay xmlns='urn:xmpp:delay' stamp='2026-10-14T10:00:00Z'/></message>";
    assert!(handle(&db, delayed, "available").notify.is_none());
    let archived = "<message xmlns='jabber:client' from='ana@chat.test' to='ana@chat.test/desk'>\
                    <result xmlns='urn:xmpp:mam:2' queryid='oreneta' id='arch-3'><forwarded xmlns='urn:xmpp:forward:0'>\
                    <delay xmlns='urn:xmpp:delay' stamp='2026-10-14T11:00:00Z'/>\
                    <message xmlns='jabber:client' type='chat' from='pau@chat.test/phone' to='ana@chat.test' id='d3'><body>Del archivo</body></message>\
                    </forwarded></result></message>";
    assert!(handle(&db, archived, "available").notify.is_none());
    let kept: Vec<String> = history(&db.lock().unwrap(), "a", "pau@chat.test", 10).unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(kept.len(), 3, "{kept:?}");
    // Busy: kept, no popup.
    let busy = "<message xmlns='jabber:client' type='chat' from='pau@chat.test/phone' to='ana@chat.test' id='d4'><body>Urgente</body></message>";
    assert!(handle(&db, busy, "dnd").notify.is_none());
    assert_eq!(history(&db.lock().unwrap(), "a", "pau@chat.test", 10).unwrap().len(), 4);
    // Our own, sent from another device: no popup.
    let sent = "<message xmlns='jabber:client' from='ana@chat.test' to='ana@chat.test/desk'><sent xmlns='urn:xmpp:carbons:2'>\
                <forwarded xmlns='urn:xmpp:forward:0'><message xmlns='jabber:client' type='chat' from='ana@chat.test/phone' to='pau@chat.test' id='d5'>\
                <body>Desde el móvil</body></message></forwarded></sent></message>";
    assert!(handle(&db, sent, "available").notify.is_none());

    // In a room: a mention notifies and is marked; anything else does not.
    let said = |id: &str, body: &str| {
        format!("<message xmlns='jabber:client' type='groupchat' from='team@rooms.chat.test/Pau' to='ana@chat.test/desk' id='{id}'><body>{body}</body></message>")
    };
    let mention = handle(&db, &said("g1", "@Ana mira"), "available").notify.unwrap();
    assert_eq!((mention.kind.as_str(), mention.mention), (KIND_GROUP, true));
    assert!(handle(&db, &said("g2", "hola a todos"), "available").notify.is_none());
    // The room's history on joining carries a delay: no popup even for a mention.
    let replay = "<message xmlns='jabber:client' type='groupchat' from='team@rooms.chat.test/Pau' to='ana@chat.test/desk' id='g3'>\
                  <body>Ana, ayer</body><delay xmlns='urn:xmpp:delay' stamp='2026-10-14T10:00:00Z' from='team@rooms.chat.test'/></message>";
    assert!(handle(&db, replay, "available").notify.is_none());
    // Our own nickname speaking is our echo, never a mention.
    assert!(handle(&db, "<message xmlns='jabber:client' type='groupchat' from='team@rooms.chat.test/Ana' id='g4'><body>Ana dice</body></message>", "available").notify.is_none());
    // A room we are not in is not taken at all.
    assert!(handle(&db, "<message xmlns='jabber:client' type='groupchat' from='club@rooms.chat.test/Pau' id='g5'><body>@Ana</body></message>", "available").notify.is_none());
    assert!(history(&db.lock().unwrap(), "a", "club@rooms.chat.test", 10).unwrap().is_empty());
}

#[test]
fn a_private_message_in_a_room_is_its_own_conversation_kept_apart_from_the_room() {
    let db = Arc::new(std::sync::Mutex::new(conn()));
    save_room(&db.lock().unwrap(), "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    let pm = "<message xmlns='jabber:client' type='chat' from='team@rooms.chat.test/Pau' to='ana@chat.test/desk' id='p1'>\
              <body>¿Hablamos en privado?</body><x xmlns='http://jabber.org/protocol/muc#user'/></message>";
    let handled = handle(&db, pm, "available");
    let new = handled.notify.expect("a private message notifies like a direct one");
    assert_eq!(
        (new.conversation.as_str(), new.kind.as_str(), new.sender.as_str(), new.direction.as_str()),
        ("team@rooms.chat.test/Pau", KIND_PRIVATE, "Pau", "in")
    );
    assert!(handled.receipt.is_none());
    let c = db.lock().unwrap();
    // Not in the room, listed with the direct ones and tied to its room.
    assert!(history(&c, "a", "team@rooms.chat.test", 10).unwrap().is_empty());
    let list = conversations(&c, "a").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].conversation.as_str(), list[0].kind.as_str(), list[0].room.as_deref(), list[0].unread),
        ("team@rooms.chat.test/Pau", KIND_PRIVATE, Some("team@rooms.chat.test"), 1)
    );
    assert_eq!(rooms(&c, "a").unwrap()[0].unread, 0, "the room has nothing new");
    drop(c);

    // Our reply, seen back from another device, is ours in the same conversation.
    let sent = "<message xmlns='jabber:client' from='ana@chat.test' to='ana@chat.test/desk'><sent xmlns='urn:xmpp:carbons:2'>\
                <forwarded xmlns='urn:xmpp:forward:0'><message xmlns='jabber:client' type='chat' from='ana@chat.test/phone' to='team@rooms.chat.test/Pau' id='p2'>\
                <body>Vale</body></message></forwarded></sent></message>";
    assert!(handle(&db, sent, "available").notify.is_none());
    let kept = history(&db.lock().unwrap(), "a", "team@rooms.chat.test/Pau", 10).unwrap();
    assert_eq!(kept.iter().map(|m| (m.id.as_str(), m.direction.as_str(), m.sender.as_str())).collect::<Vec<_>>(), [("p1", "in", "Pau"), ("p2", "out", "Ana")]);
    // The room itself writing directly is not a conversation; nor someone's
    // nickname spelt in another case a different person.
    assert!(handle(&db, "<message xmlns='jabber:client' type='chat' from='team@rooms.chat.test' id='p3'><body>Aviso</body></message>", "available").notify.is_none());
    handle(&db, "<message xmlns='jabber:client' type='chat' from='team@rooms.chat.test/pau' id='p4'><body>otro</body></message>", "available");
    assert_eq!(conversations(&db.lock().unwrap(), "a").unwrap().len(), 2, "Pau and pau are two people");
    assert_eq!(normalize_conversation(" Team@Rooms.Chat.Test/Pau "), "team@rooms.chat.test/Pau");

    // One of ours bouncing from `room/nick` is not sent.
    let mut out = ChatMessage::chat("a", "team@rooms.chat.test/Pau", "p5", "out", "Ana", "¿sigues?", 20, "sending");
    out.kind = KIND_PRIVATE.into();
    queue_message(&db.lock().unwrap(), &out).unwrap();
    set_state(&db.lock().unwrap(), "a", "p5", "sent").unwrap();
    handle(&db, "<message xmlns='jabber:client' type='error' from='team@rooms.chat.test/Pau' id='p5'>\
                 <error type='cancel'><item-not-found xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></message>", "available");
    assert_eq!(outgoing(&db.lock().unwrap(), "a", "p5").unwrap().state, "failed");

    // What we send goes to the occupant through the room, without asking a receipt.
    let room = BareJid::from_str("team@rooms.chat.test").unwrap();
    let message = xmpp::outgoing_private(&room, "Pau", "p6", "Hola", None).unwrap();
    assert_eq!((message.to.as_ref().unwrap().to_string(), message.type_.clone()), ("team@rooms.chat.test/Pau".to_string(), MessageType::Chat));
    assert!(message.payloads.iter().any(|p| p.is("x", "http://jabber.org/protocol/muc#user")));
    assert!(message.payloads.iter().any(|p| tokio_xmpp::parsers::stanza_id::OriginId::try_from(p.clone()).is_ok_and(|o| o.id == "p6")));
    assert!(!message.payloads.iter().any(|p| tokio_xmpp::parsers::receipts::Request::try_from(p.clone()).is_ok()));
    // Its archive id counts for catching up, like a direct one.
    let mut archived = ChatMessage::chat("a", "team@rooms.chat.test/Pau", "p7", "in", "Pau", "x", 30, "received");
    archived.kind = KIND_PRIVATE.into();
    archived.stanza_id = Some("arch-p7".into());
    record(&db.lock().unwrap(), &archived).unwrap();
    assert_eq!(last_archive_id(&db.lock().unwrap(), "a").unwrap().as_deref(), Some("arch-p7"));
}

#[test]
fn leaving_a_room_keeps_its_private_conversations_to_read() {
    let c = conn();
    for room in ["team_x@rooms.chat.test", "teamyx@rooms.chat.test"] {
        save_room(&c, "a", room, "Ana", false, 1).unwrap();
        let mut pm = ChatMessage::chat("a", &format!("{room}/Pau"), &format!("{room}-p"), "in", "Pau", "psst", 5, "received");
        pm.kind = KIND_PRIVATE.into();
        record(&c, &pm).unwrap();
        mark_read(&c, "a", &format!("{room}/Pau"), 5).unwrap();
    }
    record(&c, &incoming("d1", None, "directo", 6)).unwrap();
    let mut said = ChatMessage::chat("a", "team_x@rooms.chat.test", "g1", "in", "Pau", "en el grupo", 7, "received");
    said.kind = KIND_GROUP.into();
    record(&c, &said).unwrap();
    leave_room(&c, "a", "team_x@rooms.chat.test").unwrap();
    // The room's own messages go; the private ones stay, with their reading.
    assert!(history(&c, "a", "team_x@rooms.chat.test", 10).unwrap().is_empty());
    let mut left: Vec<(String, i64)> = conversations(&c, "a").unwrap().into_iter().map(|c| (c.conversation, c.unread)).collect();
    left.sort();
    assert_eq!(
        left,
        [("pau@chat.test".to_string(), 1), ("team_x@rooms.chat.test/Pau".to_string(), 0), ("teamyx@rooms.chat.test/Pau".to_string(), 0)]
    );
    assert_eq!(history(&c, "a", "team_x@rooms.chat.test/Pau", 10).unwrap().len(), 1);
    // Without the room, there is no nickname to write with.
    assert_eq!(room_nick(&c, "a", "team_x@rooms.chat.test").unwrap(), None);
}

#[test]
fn the_saved_status_is_reported_before_connecting_and_never_reset_by_a_session() {
    let c = conn();
    presence::save_own(&c, "a", "invisible", "Fuera").unwrap();
    // No session yet: the saved status, nothing applied.
    let alone = presence::snapshot(&c, "a", None).unwrap();
    assert_eq!((alone["own"]["show"].as_str(), alone["own"]["status"].as_str(), alone["own"]["applied"].as_str()), (Some("invisible"), Some("Fuera"), Some("offline")));
    // A session starts from it.
    let live = presence::Live::shared(&c, "a");
    assert_eq!(live.lock().unwrap().own, presence::OwnPresence { show: "invisible".into(), status: "Fuera".into() });
    // Even a session that holds something else reports what is saved.
    let stale: presence::Shared = Default::default();
    live.lock().unwrap().contacts.update("pau@chat.test", "phone", "away", "", 0);
    let reported = presence::snapshot(&c, "a", Some(&stale)).unwrap();
    assert_eq!(reported["own"]["show"], "invisible");
    assert_eq!(presence::snapshot(&c, "a", Some(&live)).unwrap()["contacts"]["pau@chat.test"]["show"], "away");
    // Going from announced to held back leaves the rooms: they are joined again.
    use presence::{Applied, rejoin_rooms};
    assert!(rejoin_rooms(Applied::Announced, Applied::Withheld));
    for (before, now) in [(Applied::Waiting, Applied::Withheld), (Applied::Withheld, Applied::Announced), (Applied::Announced, Applied::Invisible), (Applied::Offline, Applied::Withheld)] {
        assert!(!rejoin_rooms(before, now), "{before:?} -> {now:?}");
    }
}

#[test]
fn requests_and_contacts_are_bounded_and_allowing_answers_only_who_asked() {
    use tokio_xmpp::parsers::presence::Type;
    let mut live = presence::Live::default();
    assert!(live.request("eva@chat.test"));
    assert!(!live.request("eva@chat.test"), "once");
    assert_eq!(live.answer("pau@chat.test", true), None, "Pau did not ask");
    assert_eq!(live.answer("pau@chat.test", false), Some(Type::Unsubscribed), "denying is always possible");
    assert_eq!(live.answer("eva@chat.test", true), Some(Type::Subscribed));
    assert!(live.requests.is_empty());
    for n in 0..presence::MAX_REQUESTS + 10 {
        live.request(&format!("p{n}@chat.test"));
    }
    assert_eq!(live.requests.len(), presence::MAX_REQUESTS);
    for n in 0..presence::MAX_CONTACTS + 10 {
        live.contacts.update(&format!("c{n}@chat.test"), "r", "available", "", 0);
    }
    assert_eq!(live.contacts.len(), presence::MAX_CONTACTS);
    assert_eq!(live.contacts.seen("c1005@chat.test").show, "offline", "beyond the bound: dropped");
    // Nothing is said about a contact beyond the bound, so the app cannot grow either.
    assert_eq!(live.contacts.update("late@chat.test", "r", "available", "", 0), None);
    assert!(live.contacts.update("c1@chat.test", "r", "away", "", 0).is_some(), "those kept still change");
    for n in 0..presence::MAX_DEVICES + 10 {
        live.contacts.update("c0@chat.test", &format!("d{n}"), "away", "", 0);
    }
    live.contacts.update("c0@chat.test", "r", "offline", "", 0);
    assert_eq!(live.contacts.seen("c0@chat.test").show, "away", "the devices kept still count");
}

// ---- Who may see the status, muting and unread mentions (ADR-0064) ---------------------

#[test]
fn who_may_see_the_status_comes_from_the_roster_and_only_our_server_changes_it() {
    use tokio_xmpp::parsers::iq::Iq;
    use tokio_xmpp::parsers::roster::Roster;
    let own = BareJid::from_str("ana@chat.test").unwrap();
    assert!(presence::roster_query().is("query", "jabber:iq:roster"), "the whole roster, asked plainly");
    let push = |xml: &str| -> Option<(Roster, String)> { presence::roster_push(&stanza::<Iq>(xml), &own) };

    // Before the server answers it is unknown, never "nobody", and a push
    // alone does not make it known.
    let mut live = presence::Live::default();
    assert_eq!(live.snapshot()["allowed"], serde_json::Value::Null);
    let (early, _) = push(
        "<iq xmlns='jabber:client' type='set' id='p0'><query xmlns='jabber:iq:roster'>\
         <item jid='eva@chat.test' subscription='from'/></query></iq>",
    )
    .unwrap();
    assert!(!live.apply_roster_push(&early));
    assert!(live.allowed.is_none());

    // Only `from` and `both` let someone see the person's status.
    let roster: Roster = stanza(
        "<query xmlns='jabber:iq:roster'>\
         <item jid='eva@chat.test' subscription='from'/>\
         <item jid='pau@chat.test' subscription='both'/>\
         <item jid='joan@chat.test' subscription='to'/>\
         <item jid='marta@chat.test' subscription='none' ask='subscribe'/>\
         <item jid='rita@chat.test'/>\
         </query>",
    );
    live.set_roster(&roster);
    assert_eq!(live.snapshot()["allowed"], serde_json::json!(["eva@chat.test", "pau@chat.test"]));
    assert_eq!(live.snapshot()["allowed_more"], false);

    // A push from our own server (no address, or our bare one) changes it.
    let (changes, id) = push(
        "<iq xmlns='jabber:client' type='set' id='push1'><query xmlns='jabber:iq:roster'>\
         <item jid='eva@chat.test' subscription='none'/><item jid='joan@chat.test' subscription='both'/></query></iq>",
    )
    .unwrap();
    assert_eq!(id, "push1");
    assert!(live.apply_roster_push(&changes));
    assert_eq!(live.snapshot()["allowed"], serde_json::json!(["joan@chat.test", "pau@chat.test"]));
    assert!(!live.apply_roster_push(&changes), "the same again changes nothing");
    let (removed, _) = push(
        "<iq xmlns='jabber:client' type='set' id='push2' from='ana@chat.test'><query xmlns='jabber:iq:roster'>\
         <item jid='pau@chat.test' subscription='remove'/></query></iq>",
    )
    .unwrap();
    assert!(live.apply_roster_push(&removed));
    assert_eq!(live.snapshot()["allowed"], serde_json::json!(["joan@chat.test"]));
    // It is answered with an empty result, to our own server.
    assert_eq!(
        presence::roster_push_answer(id),
        Iq::Result { from: None, to: None, id: "push1".into(), payload: None }
    );

    // Anyone else's is not a push: another device, a stranger, a question, another payload.
    for xml in [
        "<iq xmlns='jabber:client' type='set' id='x1' from='ana@chat.test/phone'><query xmlns='jabber:iq:roster'>\
         <item jid='evil@chat.test' subscription='from'/></query></iq>",
        "<iq xmlns='jabber:client' type='set' id='x2' from='evil@chat.test'><query xmlns='jabber:iq:roster'>\
         <item jid='evil@chat.test' subscription='from'/></query></iq>",
        "<iq xmlns='jabber:client' type='get' id='x3'><query xmlns='jabber:iq:roster'/></iq>",
        "<iq xmlns='jabber:client' type='set' id='x4'><query xmlns='http://jabber.org/protocol/disco#info'/></iq>",
    ] {
        assert!(push(xml).is_none(), "{xml}");
    }

    // Bounded: beyond the bound nothing more is kept, and the app is told.
    let items = |n: usize| -> String { (0..n).map(|i| format!("<item jid='c{i}@chat.test' subscription='from'/>")).collect() };
    let mut full = presence::Live::default();
    full.set_roster(&stanza(&format!("<query xmlns='jabber:iq:roster'>{}</query>", items(presence::MAX_ALLOWED))));
    assert_eq!((full.allowed.as_ref().unwrap().len(), full.allowed_more), (presence::MAX_ALLOWED, false));
    let (late, _) = push(
        "<iq xmlns='jabber:client' type='set' id='p9'><query xmlns='jabber:iq:roster'>\
         <item jid='late@chat.test' subscription='both'/></query></iq>",
    )
    .unwrap();
    assert!(full.apply_roster_push(&late), "the app learns there are more");
    assert!(full.allowed_more && !full.allowed.as_ref().unwrap().contains("late@chat.test"));
    let mut over = presence::Live::default();
    over.set_roster(&stanza(&format!("<query xmlns='jabber:iq:roster'>{}</query>", items(presence::MAX_ALLOWED + 3))));
    assert_eq!((over.allowed.as_ref().unwrap().len(), over.allowed_more), (presence::MAX_ALLOWED, true));

    // A new session knows nothing of the old one's list.
    live.fresh_session();
    assert!(live.allowed.is_none() && !live.allowed_more);
}

#[test]
fn a_muted_conversation_raises_nothing_but_still_counts_as_unread() {
    use presence::{Arrival, should_notify};
    // Muted holds everything back, a mention too.
    assert!(!should_notify(&incoming("d1", None, "Hola", 1), Arrival::Live, "available", true));
    assert!(!should_notify(&group_in("@Ana hola", true), Arrival::Live, "available", true));

    let db = Arc::new(std::sync::Mutex::new(conn()));
    save_room(&db.lock().unwrap(), "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    // Kept as the core spells a conversation: the address in lower case, a nickname as it is.
    let list = mute::set_muted(&db.lock().unwrap(), "a", " Pau@Chat.Test ", true).unwrap();
    assert_eq!(list.into_iter().collect::<Vec<_>>(), ["pau@chat.test"]);
    mute::set_muted(&db.lock().unwrap(), "a", "team@rooms.chat.test", true).unwrap();
    mute::set_muted(&db.lock().unwrap(), "a", "team@rooms.chat.test/Pau", true).unwrap();
    assert!(mute::is_muted(&db.lock().unwrap(), "a", "team@rooms.chat.test/Pau").unwrap());
    assert!(!mute::is_muted(&db.lock().unwrap(), "a", "team@rooms.chat.test/pau").unwrap(), "pau is someone else");
    assert!(!mute::is_muted(&db.lock().unwrap(), "b", "pau@chat.test").unwrap(), "per account");

    let direct = "<message xmlns='jabber:client' type='chat' from='pau@chat.test/phone' to='ana@chat.test/desk' id='m1'><body>Hola</body></message>";
    assert!(handle(&db, direct, "available").notify.is_none(), "muted: no popup");
    let mention = "<message xmlns='jabber:client' type='groupchat' from='team@rooms.chat.test/Pau' to='ana@chat.test/desk' id='g1'><body>@Ana mira</body></message>";
    assert!(handle(&db, mention, "available").notify.is_none(), "not even a mention");
    let private = "<message xmlns='jabber:client' type='chat' from='team@rooms.chat.test/Pau' to='ana@chat.test/desk' id='p1'>\
                   <body>psst</body><x xmlns='http://jabber.org/protocol/muc#user'/></message>";
    assert!(handle(&db, private, "available").notify.is_none());
    {
        // Kept and unread all the same, and listed as muted.
        let c = db.lock().unwrap();
        let listed = conversations(&c, "a").unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|one| one.muted && one.unread == 1), "{listed:?}");
        let groups = rooms(&c, "a").unwrap();
        assert_eq!((groups[0].muted, groups[0].unread, groups[0].unread_mentions), (true, 1, 1));
    }
    // Unmuted, it notifies again.
    mute::set_muted(&db.lock().unwrap(), "a", "pau@chat.test", false).unwrap();
    let next = "<message xmlns='jabber:client' type='chat' from='pau@chat.test/phone' to='ana@chat.test/desk' id='m2'><body>¿Estás?</body></message>";
    assert!(handle(&db, next, "available").notify.is_some());
    assert!(!conversations(&db.lock().unwrap(), "a").unwrap().iter().any(|one| one.conversation == "pau@chat.test" && one.muted));

    // Leaving the room forgets its mute; its private conversation stays, muted.
    leave_room(&db.lock().unwrap(), "a", "team@rooms.chat.test").unwrap();
    assert_eq!(mute::muted(&db.lock().unwrap(), "a").unwrap().into_iter().collect::<Vec<_>>(), ["team@rooms.chat.test/Pau"]);
    // The last one unmuted leaves no row behind.
    let c = db.lock().unwrap();
    assert!(mute::set_muted(&c, "a", "team@rooms.chat.test/Pau", false).unwrap().is_empty());
    assert!(crate::store::settings_get(&c, &["chat_mute:a".to_string()]).unwrap().get("chat_mute:a").is_none());

    // Only a conversation can be muted, and only so many.
    assert!(mute::set_muted(&c, "a", "   ", true).is_err());
    assert!(mute::set_muted(&c, "a", "pau\u{7}@chat.test", true).is_err());
    for n in 0..mute::MAX_MUTED {
        mute::set_muted(&c, "b", &format!("p{n}@chat.test"), true).unwrap();
    }
    assert!(mute::set_muted(&c, "b", "late@chat.test", true).is_err(), "refused, never dropped");
    assert!(mute::set_muted(&c, "b", "p1@chat.test", true).is_ok(), "already muted");
    assert_eq!(mute::muted(&c, "b").unwrap().len(), mute::MAX_MUTED);
    // A damaged row: what is not a conversation is skipped, the rest stays.
    crate::store::setting_set(&c, "chat_mute:c", &serde_json::json!(["eva@chat.test", 7, "", null])).unwrap();
    assert_eq!(mute::muted(&c, "c").unwrap().into_iter().collect::<Vec<_>>(), ["eva@chat.test"]);
    crate::store::setting_set(&c, "chat_mute:c", &serde_json::json!({ "eva@chat.test": true })).unwrap();
    assert!(mute::muted(&c, "c").unwrap().is_empty());
    // Removing the account forgets its mutes.
    save_account(&c, &ChatAccount { id: "b".into(), jid: "bea@chat.test".into(), host: String::new(), port: 5222 }, 1).unwrap();
    remove_account(&c, "b").unwrap();
    assert!(mute::muted(&c, "b").unwrap().is_empty());
}

#[test]
fn a_room_counts_its_unread_mentions_until_read_and_says_when_it_stopped_looking() {
    let c = conn();
    save_room(&c, "a", "team@rooms.chat.test", "Ana", false, 1).unwrap();
    save_room(&c, "a", "club@rooms.chat.test", "Ana", false, 1).unwrap();
    let say = |room: &str, id: &str, direction: &str, body: &str, stamp: i64| {
        let sender = if direction == "in" { "Pau" } else { "Ana" };
        let mut m = ChatMessage::chat("a", room, id, direction, sender, body, stamp, "received");
        m.kind = KIND_GROUP.into();
        record(&c, &m).unwrap();
    };
    let counted = |room: &str| {
        let r = super::room(&c, "a", room).unwrap().unwrap();
        (r.unread, r.unread_mentions, r.mentions_capped)
    };
    say("team@rooms.chat.test", "g1", "in", "@Ana ¿vienes?", 10);
    say("team@rooms.chat.test", "g2", "in", "hola a todos", 11);
    say("team@rooms.chat.test", "g3", "in", "ana, mira esto", 12);
    say("team@rooms.chat.test", "g4", "out", "Ana aquí", 13);
    say("team@rooms.chat.test", "g5", "in", "Anabel viene", 14);
    // Two of four unread name the person; our own and "Anabel" do not.
    assert_eq!(counted("team@rooms.chat.test"), (4, 2, false));
    assert_eq!(counted("club@rooms.chat.test"), (0, 0, false));
    // Reading counts them down.
    mark_read(&c, "a", "team@rooms.chat.test", 10).unwrap();
    assert_eq!(counted("team@rooms.chat.test"), (3, 1, false));
    mark_read(&c, "a", "team@rooms.chat.test", 14).unwrap();
    assert_eq!(counted("team@rooms.chat.test"), (0, 0, false));
    // With the nickname the person has there now.
    set_room_nick(&c, "a", "team@rooms.chat.test", "Anabel").unwrap();
    say("team@rooms.chat.test", "g6", "in", "Anabel, ¿y tú?", 20);
    say("team@rooms.chat.test", "g7", "in", "Ana, ¿y tú?", 21);
    assert_eq!(counted("team@rooms.chat.test"), (2, 1, false));
    // Another account in the same room, with the same nickname, counts its
    // own messages and reading, and changes nothing of the first one's.
    save_room(&c, "b", "team@rooms.chat.test", "Anabel", false, 1).unwrap();
    let mut other = ChatMessage::chat("b", "team@rooms.chat.test", "b1", "in", "Pau", "@Anabel ¿vienes?", 30, "received");
    other.kind = KIND_GROUP.into();
    record(&c, &other).unwrap();
    let theirs = super::room(&c, "b", "team@rooms.chat.test").unwrap().unwrap();
    assert_eq!((theirs.unread, theirs.unread_mentions), (1, 1));
    assert_eq!(counted("team@rooms.chat.test"), (2, 1, false));
    mark_read(&c, "b", "team@rooms.chat.test", 30).unwrap();
    assert_eq!(counted("team@rooms.chat.test"), (2, 1, false), "their reading is not ours");
    // Past the newest MAX_MENTION_SCAN unread, older ones are not looked at,
    // and the count says it is a lower bound.
    for n in 0..MAX_MENTION_SCAN + 5 {
        let body = if n < 5 { "@Ana" } else { "nada" };
        say("club@rooms.chat.test", &format!("c{n}"), "in", body, 100 + n);
    }
    assert_eq!(counted("club@rooms.chat.test"), (MAX_MENTION_SCAN + 5, 0, true));
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
        let task = tokio::spawn(xmpp::run(account, "secret".into(), db, connector, rx, emit, xmpp::Options::default()));
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
    ana.send(xmpp::Command::Send { conversation: "pau@chat.test".into(), id: id.clone(), body: "Hola Pau".into(), group: false, file: None, mentions: vec![] }).unwrap();
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
    ana.send(xmpp::Command::Send { conversation: "pau@chat.test".into(), id: id2.clone(), body: "¿Estás?".into(), group: false, file: None, mentions: vec![] }).unwrap();
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

// ---- Against a real Prosody: rooms and files (ADR-0044) -------------------------------

type Events = std::sync::mpsc::Receiver<(String, serde_json::Value)>;

struct Session {
    tx: tokio::sync::mpsc::UnboundedSender<xmpp::Command>,
    events: Arc<std::sync::Mutex<Events>>,
    task: tokio::task::JoinHandle<()>,
}

fn prosody() -> Option<(String, u16)> {
    let address = std::env::var("ORENETA_PROSODY").ok()?;
    let (host, port) = address.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

fn start_session(id: &str, jid: &str, db: Arc<std::sync::Mutex<Connection>>, options: xmpp::Options) -> Session {
    let (host, port) = prosody().unwrap();
    save_account(&db.lock().unwrap(), &ChatAccount { id: id.into(), jid: jid.into(), host: host.clone(), port }, 1).unwrap();
    let account = ChatAccount { id: id.into(), jid: jid.into(), host: host.clone(), port };
    let connector = xmpp::Connector { host, port, proxy: None, cert_pin: None, plain_loopback: true };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (etx, erx) = std::sync::mpsc::channel::<(String, serde_json::Value)>();
    let emit: xmpp::Emit = Arc::new(move |name: &str, detail: serde_json::Value| {
        let _ = etx.send((name.to_string(), detail));
    });
    let task = tokio::spawn(xmpp::run(account, "secret".into(), db, connector, rx, emit, options));
    Session { tx, events: Arc::new(std::sync::Mutex::new(erx)), task }
}

/// Waits (off the reactor) for an event that matches; panics after 20 s,
/// naming the events that came instead.
async fn wait_event(session: &Session, what: &'static str, matches: impl Fn(&str, &serde_json::Value) -> bool + Send + 'static) -> serde_json::Value {
    let events = session.events.clone();
    tokio::task::spawn_blocking(move || {
        let events = events.lock().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = Vec::new();
        while std::time::Instant::now() < deadline {
            if let Ok((name, detail)) = events.recv_timeout(std::time::Duration::from_millis(200)) {
                assert_ne!(detail["state"], "error", "{name}: {detail}");
                if matches(&name, &detail) {
                    return detail;
                }
                seen.push(format!("{name} {detail}"));
            }
        }
        panic!("never saw: {what}; saw instead: {seen:?}");
    })
    .await
    .unwrap()
}

async fn wait_until(what: &'static str, check: impl Fn() -> bool + Send + 'static) {
    tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            if check() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("never: {what}");
    })
    .await
    .unwrap()
}

fn say_in_room(db: &Arc<std::sync::Mutex<Connection>>, session: &Session, account: &str, room: &str, nick: &str, id: &str, body: &str) {
    let mut message = ChatMessage::chat(account, room, id, "out", nick, body, crate::store::now_unix(), "sending");
    message.kind = KIND_GROUP.into();
    queue_message(&db.lock().unwrap(), &message).unwrap();
    session
        .tx
        .send(xmpp::Command::Send { conversation: room.into(), id: id.into(), body: body.into(), group: true, file: None, mentions: vec![] })
        .unwrap();
}

/// Two people in a room: what each says reaches the other under their
/// nickname, our own echo is not a second message, and someone who comes
/// back gets what was said meanwhile, once, by joining again on their own.
#[tokio::test(flavor = "multi_thread")]
async fn against_prosody_two_people_talk_in_a_room_and_catch_up_on_rejoining() {
    if prosody().is_none() {
        eprintln!("skipped: no Prosody (see tests/prosody-xmpp.sh)");
        return;
    }
    let tag = format!("{}-{}", std::process::id(), crate::store::now_unix());
    let room = format!("team-{tag}@rooms.chat.test");
    let ana_db = Arc::new(std::sync::Mutex::new(conn()));
    let pau_db = Arc::new(std::sync::Mutex::new(conn()));
    let ana = start_session("ana", "ana@chat.test", ana_db.clone(), xmpp::Options::default());
    wait_event(&ana, "Ana online", |n, d| n == "chat.status" && d["state"] == "online").await;
    // Ana makes the room by joining it first.
    save_room(&ana_db.lock().unwrap(), "ana", &room, "Ana", false, 1).unwrap();
    ana.tx.send(xmpp::Command::Join { room: room.clone(), nick: "Ana".into(), password: None }).unwrap();
    wait_event(&ana, "Ana in the room", |n, d| n == "chat.room" && d["state"] == "joined").await;

    let pau = start_session("pau", "pau@chat.test", pau_db.clone(), xmpp::Options::default());
    wait_event(&pau, "Pau online", |n, d| n == "chat.status" && d["state"] == "online").await;
    save_room(&pau_db.lock().unwrap(), "pau", &room, "Pau", false, 1).unwrap();
    pau.tx.send(xmpp::Command::Join { room: room.clone(), nick: "Pau".into(), password: None }).unwrap();
    wait_event(&pau, "Pau in the room", |n, d| n == "chat.room" && d["state"] == "joined").await;

    let first = format!("g1-{tag}");
    say_in_room(&ana_db, &ana, "ana", &room, "Ana", &first, "Hola equipo");
    let (pdb, r, id) = (pau_db.clone(), room.clone(), first.clone());
    wait_until("Pau hears Ana", move || {
        history(&pdb.lock().unwrap(), "pau", &r, 50).unwrap().iter().any(|m| m.id == id && m.sender == "Ana" && m.direction == "in")
    })
    .await;
    // Ana's own message came back from the room: accepted, not doubled.
    let (adb, r, id) = (ana_db.clone(), room.clone(), first.clone());
    wait_until("the room's echo", move || outgoing(&adb.lock().unwrap(), "ana", &id).unwrap().state == "accepted").await;
    let mine: Vec<_> = history(&ana_db.lock().unwrap(), "ana", &room, 50).unwrap().into_iter().filter(|m| m.id == first).collect();
    assert_eq!(mine.len(), 1);
    assert!(mine[0].stanza_id.is_some(), "the room's archive id is kept");
    let _ = r;

    let reply = format!("g2-{tag}");
    say_in_room(&pau_db, &pau, "pau", &room, "Pau", &reply, "¡Hola Ana!");
    let (adb, r, id) = (ana_db.clone(), room.clone(), reply.clone());
    wait_until("Ana hears Pau", move || {
        history(&adb.lock().unwrap(), "ana", &r, 50).unwrap().iter().any(|m| m.id == id && m.sender == "Pau")
    })
    .await;

    // Pau goes; Ana says something; Pau comes back twice and has it once.
    pau.tx.send(xmpp::Command::Stop).unwrap();
    pau.task.await.unwrap();
    let missed = format!("g3-{tag}");
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    say_in_room(&ana_db, &ana, "ana", &room, "Ana", &missed, "¿Seguís ahí?");
    let (adb, id) = (ana_db.clone(), missed.clone());
    wait_until("the room took it", move || outgoing(&adb.lock().unwrap(), "ana", &id).unwrap().state == "accepted").await;
    for round in 0..2 {
        let pau = start_session("pau", "pau@chat.test", pau_db.clone(), xmpp::Options::default());
        wait_event(&pau, "Pau back in the room", |n, d| n == "chat.room" && d["state"] == "joined").await;
        let (pdb, r, id) = (pau_db.clone(), room.clone(), missed.clone());
        wait_until("Pau catches up", move || history(&pdb.lock().unwrap(), "pau", &r, 50).unwrap().iter().any(|m| m.id == id)).await;
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let all = history(&pau_db.lock().unwrap(), "pau", &room, 50).unwrap();
        for id in [&first, &reply, &missed] {
            assert_eq!(all.iter().filter(|m| &m.id == id).count(), 1, "round {round}: {id} in {:?}", all.iter().map(|m| &m.id).collect::<Vec<_>>());
        }
        let own = all.iter().find(|m| m.id == reply).unwrap();
        assert_eq!((own.direction.as_str(), own.sender.as_str()), ("out", "Pau"), "round {round}");
        pau.tx.send(xmpp::Command::Stop).unwrap();
        pau.task.await.unwrap();
    }
    ana.tx.send(xmpp::Command::Leave { room: room.clone(), nick: "Ana".into() }).unwrap();
    wait_event(&ana, "Ana out", |n, d| n == "chat.room" && d["state"] == "out").await;
    ana.tx.send(xmpp::Command::Stop).unwrap();
}

/// A file through the server's upload service and back: refused before
/// uploading when too large, cancelled when asked, and otherwise put over
/// HTTPS and received as a link that is saved only when asked. Needs the
/// test authority (ORENETA_PROSODY_CA) that tests/prosody-xmpp.sh makes.
#[tokio::test(flavor = "multi_thread")]
async fn against_prosody_a_file_goes_up_and_arrives_as_a_link() {
    let (Some(_), Ok(ca)) = (prosody(), std::env::var("ORENETA_PROSODY_CA")) else {
        eprintln!("skipped: no Prosody with HTTPS upload (see tests/prosody-xmpp.sh)");
        return;
    };
    let ca = std::fs::read(ca).unwrap();
    let options = xmpp::Options { room_password: Arc::new(|_| None), file_roots: vec![ca.clone()], ..Default::default() };
    let dir = std::env::temp_dir().join(format!("oreneta-chat-upload-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ana_db = Arc::new(std::sync::Mutex::new(conn()));
    let pau_db = Arc::new(std::sync::Mutex::new(conn()));
    let ana = start_session("ana", "ana@chat.test", ana_db.clone(), options.clone());
    let pau = start_session("pau", "pau@chat.test", pau_db.clone(), options);
    wait_event(&ana, "Ana online", |n, d| n == "chat.status" && d["state"] == "online").await;
    wait_event(&pau, "Pau online", |n, d| n == "chat.status" && d["state"] == "online").await;
    let upload = |id: &str, path: &std::path::Path| xmpp::Upload {
        id: id.into(),
        conversation: "pau@chat.test".into(),
        group: false,
        path: path.to_path_buf(),
        name: path.file_name().unwrap().to_string_lossy().into(),
        size: std::fs::metadata(path).unwrap().len(),
        cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

    // Larger than the service's 1 MiB: refused here, nothing goes up.
    let big = dir.join("big.bin");
    std::fs::write(&big, vec![7u8; 1_048_577]).unwrap();
    ana.tx.send(xmpp::Command::Upload(upload("u-big", &big))).unwrap();
    let refused = wait_event(&ana, "too large", |n, d| n == "chat.uploaded" && d["upload_id"] == "u-big").await;
    assert_eq!(refused["error"]["detail"]["code"], "tooLarge", "{refused}");

    // Cancelled before it starts: nothing sent.
    let small = dir.join("Nota de prueba.txt");
    let content: Vec<u8> = (0..300_000u32).map(|n| (n % 251) as u8).collect();
    std::fs::write(&small, &content).unwrap();
    let cancelled = upload("u-cancel", &small);
    cancelled.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    ana.tx.send(xmpp::Command::Upload(cancelled)).unwrap();
    let gone = wait_event(&ana, "cancelled", |n, d| n == "chat.uploaded" && d["upload_id"] == "u-cancel").await;
    assert_eq!(gone["error"]["detail"]["code"], "cancelled");

    // The real thing: progress, then the link as a message.
    ana.tx.send(xmpp::Command::Upload(upload("u-1", &small))).unwrap();
    let progress = wait_event(&ana, "progress", |n, d| n == "chat.progress" && d["upload_id"] == "u-1").await;
    assert_eq!(progress["total"], 300_000);
    let done = wait_event(&ana, "uploaded", |n, d| n == "chat.uploaded" && d["upload_id"] == "u-1").await;
    assert!(done.get("error").is_none(), "{done}");
    let id = done["id"].as_str().unwrap().to_string();
    let sent = outgoing(&ana_db.lock().unwrap(), "ana", &id).unwrap();
    assert_eq!(sent.file_name.as_deref(), Some("Nota de prueba.txt"));
    let link = sent.file_url.clone().unwrap();
    assert!(link.starts_with("https://127.0.0.1:"), "{link}");

    let (pdb, mid) = (pau_db.clone(), id.clone());
    wait_until("Pau gets the link", move || history(&pdb.lock().unwrap(), "pau", "ana@chat.test", 50).unwrap().iter().any(|m| m.id == mid)).await;
    let got = history(&pau_db.lock().unwrap(), "pau", "ana@chat.test", 50).unwrap().into_iter().find(|m| m.id == id).unwrap();
    assert_eq!((got.file_url.as_deref(), got.file_name.as_deref()), (Some(link.as_str()), Some("Nota de prueba.txt")));
    // Saved only now, when asked, and exactly what was sent.
    let saved = dir.join("saved.txt");
    let bytes = tokio::task::spawn_blocking(move || {
        let agent = files::agent(&[ca]).unwrap();
        files::download(&agent, &link, &saved).map(|n| (n, std::fs::read(&saved).unwrap()))
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(bytes.0, 300_000);
    assert!(bytes.1 == content);
    ana.tx.send(xmpp::Command::Stop).unwrap();
    pau.tx.send(xmpp::Command::Stop).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Against a real Prosody: presence, mentions and private messages (ADR-0055) -------

/// A session whose events are all kept, and what it knows about presence.
struct Watched {
    tx: tokio::sync::mpsc::UnboundedSender<xmpp::Command>,
    events: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
    live: presence::Shared,
    task: tokio::task::JoinHandle<()>,
}

fn watch_session(id: &str, jid: &str, db: Arc<std::sync::Mutex<Connection>>) -> Watched {
    let (host, port) = prosody().unwrap();
    save_account(&db.lock().unwrap(), &ChatAccount { id: id.into(), jid: jid.into(), host: host.clone(), port }, 1).unwrap();
    let account = ChatAccount { id: id.into(), jid: jid.into(), host: host.clone(), port };
    let connector = xmpp::Connector { host, port, proxy: None, cert_pin: None, plain_loopback: true };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let events: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> = Default::default();
    let sink = events.clone();
    let emit: xmpp::Emit = Arc::new(move |name: &str, detail: serde_json::Value| sink.lock().unwrap().push((name.to_string(), detail)));
    let live: presence::Shared = Default::default();
    let options = xmpp::Options { live: live.clone(), ..Default::default() };
    let task = tokio::spawn(xmpp::run(account, "secret".into(), db, connector, rx, emit, options));
    Watched { tx, events, live, task }
}

impl Watched {
    fn saw(&self) -> impl Fn(&dyn Fn(&str, &serde_json::Value) -> bool) -> bool + Send + 'static {
        let events = self.events.clone();
        move |what| events.lock().unwrap().iter().any(|(name, detail)| what(name, detail))
    }

    fn notified(&self, text: &str) -> bool {
        self.events.lock().unwrap().iter().any(|(name, d)| name == "chat.notify" && d["body"].as_str().is_some_and(|b| b.contains(text)))
    }

    async fn online(&self) {
        let saw = self.saw();
        wait_until("online", move || saw(&|n, d| n == "chat.status" && d["state"] == "online")).await;
    }
}

fn say(db: &Arc<std::sync::Mutex<Connection>>, w: &Watched, message: ChatMessage, mentions: Vec<String>) {
    queue_message(&db.lock().unwrap(), &message).unwrap();
    w.tx.send(xmpp::Command::Send {
        conversation: message.conversation.clone(),
        id: message.id.clone(),
        body: message.body.clone(),
        group: message.kind == KIND_GROUP,
        file: None,
        mentions,
    })
    .unwrap();
}

fn seen_show(live: &presence::Shared, jid: &str) -> String {
    live.lock().unwrap().contacts.seen(jid).show
}

/// Eva asks to see Joan's status and Joan allows it: from then on Eva sees
/// each change (availability and text), Joan sees nothing of Eva's, busy
/// keeps Joan's popups back, and "invisible" on a server without XEP-0186
/// hides Joan without losing what was sent meanwhile, which arrives once.
#[tokio::test(flavor = "multi_thread")]
async fn against_prosody_a_status_reaches_only_an_allowed_contact_and_busy_holds_popups_back() {
    if prosody().is_none() {
        eprintln!("skipped: no Prosody (see tests/prosody-xmpp.sh)");
        return;
    }
    let tag = format!("{}-{}", std::process::id(), crate::store::now_unix());
    let eva_db = Arc::new(std::sync::Mutex::new(conn()));
    let joan_db = Arc::new(std::sync::Mutex::new(conn()));
    let eva = watch_session("eva", "eva@chat.test", eva_db.clone());
    let joan = watch_session("joan", "joan@chat.test", joan_db.clone());
    eva.online().await;
    joan.online().await;
    // A new session tells the app to drop what it showed of an old one.
    let saw = eva.saw();
    wait_until("a fresh session", move || saw(&|n, d| n == "chat.presence" && d["reset"] == true)).await;
    // This server does not offer invisibility: known, and nothing hidden by mistake.
    let live = eva.live.clone();
    wait_until("the server's features", move || {
        let l = live.lock().unwrap();
        l.invisible_supported == Some(false) && l.applied == presence::Applied::Announced
    })
    .await;

    // Eva asks; Joan decides. (On a server that already holds the permission
    // from an earlier run, Joan is not asked again and Eva just sees Joan.)
    eva.tx.send(xmpp::Command::Subscribe { jid: "joan@chat.test".into() }).unwrap();
    let (joan_live, eva_live) = (joan.live.clone(), eva.live.clone());
    wait_until("Joan is asked", move || {
        joan_live.lock().unwrap().requests.contains("eva@chat.test") || seen_show(&eva_live, "joan@chat.test") != "offline"
    })
    .await;
    if joan.live.lock().unwrap().requests.contains("eva@chat.test") {
        assert_eq!(seen_show(&eva.live, "joan@chat.test"), "offline", "nothing before Joan allows it");
        joan.tx.send(xmpp::Command::AnswerSubscription { jid: "eva@chat.test".into(), allow: true }).unwrap();
    }
    let eva_live = eva.live.clone();
    wait_until("Eva sees Joan", move || seen_show(&eva_live, "joan@chat.test") == "available").await;
    assert!(joan.live.lock().unwrap().requests.is_empty(), "answered");
    // Allowing is not asking back: Joan sees nothing of Eva.
    assert_eq!(seen_show(&joan.live, "eva@chat.test"), "offline");

    // Joan is away, with a text; then busy, without.
    presence::save_own(&joan_db.lock().unwrap(), "joan", "away", "Comiendo").unwrap();
    joan.tx.send(xmpp::Command::Presence).unwrap();
    let eva_live = eva.live.clone();
    wait_until("away, eating", move || eva_live.lock().unwrap().contacts.seen("joan@chat.test") == presence::Seen { show: "away".into(), status: "Comiendo".into() }).await;
    presence::save_own(&joan_db.lock().unwrap(), "joan", "dnd", "").unwrap();
    joan.tx.send(xmpp::Command::Presence).unwrap();
    let eva_live = eva.live.clone();
    wait_until("busy", move || eva_live.lock().unwrap().contacts.seen("joan@chat.test") == presence::Seen { show: "dnd".into(), status: String::new() }).await;

    // Busy: the message is kept and shown, but raises no popup.
    let dm = |id: &str, body: &str| ChatMessage::chat("eva", "joan@chat.test", id, "out", "eva@chat.test", body, crate::store::now_unix(), "sending");
    let quiet = format!("Mientras estás ocupado {tag}");
    say(&eva_db, &eva, dm(&format!("q-{tag}"), &quiet), vec![]);
    let (jdb, id) = (joan_db.clone(), format!("q-{tag}"));
    wait_until("Joan gets it", move || history(&jdb.lock().unwrap(), "joan", "eva@chat.test", 50).unwrap().iter().any(|m| m.id == id)).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(!joan.notified(&quiet), "busy: no popup");

    // Available again: a new message raises one.
    presence::save_own(&joan_db.lock().unwrap(), "joan", "available", "").unwrap();
    joan.tx.send(xmpp::Command::Presence).unwrap();
    let eva_live = eva.live.clone();
    wait_until("Joan available", move || seen_show(&eva_live, "joan@chat.test") == "available").await;
    let loud = format!("¿Comemos? {tag}");
    say(&eva_db, &eva, dm(&format!("l-{tag}"), &loud), vec![]);
    let saw = joan.saw();
    let wanted = loud.clone();
    wait_until("a popup", move || saw(&|n, d| n == "chat.notify" && d["body"] == wanted && d["kind"] == "chat" && d["title"] == "eva@chat.test")).await;

    // Both in a room: going unannounced must not take Joan out of it.
    let room = format!("presence-{tag}@rooms.chat.test");
    for (w, db, account, nick) in [(&eva, &eva_db, "eva", "Eva"), (&joan, &joan_db, "joan", "Joan")] {
        save_room(&db.lock().unwrap(), account, &room, nick, false, 1).unwrap();
        w.tx.send(xmpp::Command::Join { room: room.clone(), nick: nick.into(), password: None }).unwrap();
        let saw = w.saw();
        wait_until("in the room", move || saw(&|n, d| n == "chat.room" && d["state"] == "joined")).await;
    }
    let in_room = |id: &str, body: &str| {
        let mut m = ChatMessage::chat("eva", &room, id, "out", "Eva", body, crate::store::now_unix(), "sending");
        m.kind = KIND_GROUP.into();
        m
    };

    // Invisible, which this server cannot do: nothing is announced, so Eva
    // sees Joan offline; what Eva writes meanwhile waits on the server.
    presence::save_own(&joan_db.lock().unwrap(), "joan", "invisible", "").unwrap();
    joan.tx.send(xmpp::Command::Presence).unwrap();
    let (eva_live, joan_live) = (eva.live.clone(), joan.live.clone());
    wait_until("Joan hidden", move || {
        seen_show(&eva_live, "joan@chat.test") == "offline" && joan_live.lock().unwrap().applied == presence::Applied::Withheld
    })
    .await;
    // The room still has Joan: what is said there arrives as it is said.
    let (jl, r) = (joan.live.clone(), room.clone());
    wait_until("Joan back in the room", move || jl.lock().unwrap().occupants.list(&r).iter().any(|o| o.nick == "Eva")).await;
    say(&eva_db, &eva, in_room(&format!("r1-{tag}"), "Sigues en el grupo"), vec![]);
    let (jdb, r, id) = (joan_db.clone(), room.clone(), format!("r1-{tag}"));
    wait_until("Joan hears the room while hidden", move || history(&jdb.lock().unwrap(), "joan", &r, 50).unwrap().iter().any(|m| m.id == id)).await;
    let waiting = format!("¿Dónde estás? {tag}");
    say(&eva_db, &eva, dm(&format!("w-{tag}"), &waiting), vec![]);
    let (adb, id) = (eva_db.clone(), format!("w-{tag}"));
    wait_until("the server took it", move || outgoing(&adb.lock().unwrap(), "eva", &id).unwrap().state == "accepted").await;
    // Choosing to be seen again: announced, and what waited arrives once, without a popup.
    presence::save_own(&joan_db.lock().unwrap(), "joan", "available", "").unwrap();
    joan.tx.send(xmpp::Command::Presence).unwrap();
    let eva_live = eva.live.clone();
    wait_until("Joan back", move || seen_show(&eva_live, "joan@chat.test") == "available").await;
    let (jdb, id) = (joan_db.clone(), format!("w-{tag}"));
    wait_until("what waited", move || history(&jdb.lock().unwrap(), "joan", "eva@chat.test", 50).unwrap().iter().any(|m| m.id == id)).await;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let kept = history(&joan_db.lock().unwrap(), "joan", "eva@chat.test", 50).unwrap();
    assert_eq!(kept.iter().filter(|m| m.id == format!("w-{tag}")).count(), 1);
    assert!(!joan.notified(&waiting), "caught up, not live");
    // And still in the room once seen again.
    say(&eva_db, &eva, in_room(&format!("r2-{tag}"), "Bienvenido"), vec![]);
    let (jdb, r, id) = (joan_db.clone(), room.clone(), format!("r2-{tag}"));
    wait_until("Joan hears the room after", move || history(&jdb.lock().unwrap(), "joan", &r, 50).unwrap().iter().any(|m| m.id == id)).await;

    for w in [eva, joan] {
        w.tx.send(xmpp::Command::Stop).unwrap();
        w.task.await.unwrap();
    }
}

/// In a room: who is there is known, a mention is marked and raises a
/// popup while other talk does not, and a private message to someone in it
/// is its own conversation both ways, kept apart from the room.
#[tokio::test(flavor = "multi_thread")]
async fn against_prosody_mentions_notify_and_private_messages_stay_apart_from_the_room() {
    if prosody().is_none() {
        eprintln!("skipped: no Prosody (see tests/prosody-xmpp.sh)");
        return;
    }
    let tag = format!("{}-{}", std::process::id(), crate::store::now_unix());
    let room = format!("mentions-{tag}@rooms.chat.test");
    let ana_db = Arc::new(std::sync::Mutex::new(conn()));
    let pau_db = Arc::new(std::sync::Mutex::new(conn()));
    let ana = watch_session("ana", "ana@chat.test", ana_db.clone());
    ana.online().await;
    save_room(&ana_db.lock().unwrap(), "ana", &room, "Ana", false, 1).unwrap();
    ana.tx.send(xmpp::Command::Join { room: room.clone(), nick: "Ana".into(), password: None }).unwrap();
    let saw = ana.saw();
    wait_until("Ana in", move || saw(&|n, d| n == "chat.room" && d["state"] == "joined")).await;
    let pau = watch_session("pau", "pau@chat.test", pau_db.clone());
    pau.online().await;
    save_room(&pau_db.lock().unwrap(), "pau", &room, "Pau", false, 1).unwrap();
    pau.tx.send(xmpp::Command::Join { room: room.clone(), nick: "Pau".into(), password: None }).unwrap();
    // Each knows the other is there: what completion offers.
    let (al, pl, r) = (ana.live.clone(), pau.live.clone(), room.clone());
    wait_until("occupants", move || {
        al.lock().unwrap().occupants.list(&r).iter().any(|o| o.nick == "Pau") && pl.lock().unwrap().occupants.list(&r).iter().any(|o| o.nick == "Ana")
    })
    .await;
    assert!(!ana.live.lock().unwrap().occupants.list(&room).iter().any(|o| o.nick == "Ana"), "not ourselves");

    let group = |id: &str, body: &str, nick: &str| {
        let mut m = ChatMessage::chat("pau", &room, id, "out", nick, body, crate::store::now_unix(), "sending");
        m.kind = KIND_GROUP.into();
        m
    };
    let named = format!("@Ana ¿vienes? {tag}");
    say(&pau_db, &pau, group(&format!("m1-{tag}"), &named, "Pau"), vec!["Ana".into()]);
    let other = format!("Nada para nadie {tag}");
    say(&pau_db, &pau, group(&format!("m2-{tag}"), &other, "Pau"), vec![]);
    let (adb, r, id) = (ana_db.clone(), room.clone(), format!("m2-{tag}"));
    wait_until("Ana hears both", move || history(&adb.lock().unwrap(), "ana", &r, 50).unwrap().iter().any(|m| m.id == id)).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let heard = history(&ana_db.lock().unwrap(), "ana", &room, 50).unwrap();
    let marks: Vec<(bool, &str)> = heard.iter().filter(|m| m.id.ends_with(&tag)).map(|m| (m.mention, m.sender.as_str())).collect();
    assert_eq!(marks, [(true, "Pau"), (false, "Pau")]);
    let saw = ana.saw();
    let wanted = named.clone();
    assert!(saw(&|n, d| n == "chat.notify" && d["body"] == wanted && d["mention"] == true && d["kind"] == "groupchat"));
    assert!(!ana.notified(&other), "talk without a mention raises no popup");
    // Pau's own message is no mention for Pau.
    assert!(!pau.notified(&named));

    // Privately, to Ana's place in the room.
    let secret = format!("Esto solo para ti {tag}");
    let mut private = ChatMessage::chat("pau", &format!("{room}/Ana"), &format!("p1-{tag}"), "out", "Pau", &secret, crate::store::now_unix(), "sending");
    private.kind = KIND_PRIVATE.into();
    say(&pau_db, &pau, private, vec![]);
    let (adb, conversation, id) = (ana_db.clone(), format!("{room}/Pau"), format!("p1-{tag}"));
    wait_until("Ana gets it privately", move || history(&adb.lock().unwrap(), "ana", &conversation, 50).unwrap().iter().any(|m| m.id == id)).await;
    let got = history(&ana_db.lock().unwrap(), "ana", &format!("{room}/Pau"), 50).unwrap();
    assert_eq!((got[0].kind.as_str(), got[0].sender.as_str(), got[0].direction.as_str()), (KIND_PRIVATE, "Pau", "in"));
    assert!(!history(&ana_db.lock().unwrap(), "ana", &room, 50).unwrap().iter().any(|m| m.body == secret), "not in the room");
    let listed = conversations(&ana_db.lock().unwrap(), "ana").unwrap();
    assert!(listed.iter().any(|c| c.conversation == format!("{room}/Pau") && c.room.as_deref() == Some(room.as_str())));
    let saw = ana.saw();
    let wanted = secret.clone();
    wait_until("a private popup", move || saw(&|n, d| n == "chat.notify" && d["body"] == wanted && d["kind"] == "private")).await;

    // Ana answers privately; the server takes it and Pau has it apart too.
    let answer = format!("Recibido {tag}");
    let mut reply = ChatMessage::chat("ana", &format!("{room}/Pau"), &format!("p2-{tag}"), "out", "Ana", &answer, crate::store::now_unix(), "sending");
    reply.kind = KIND_PRIVATE.into();
    say(&ana_db, &ana, reply, vec![]);
    let (pdb, conversation, id) = (pau_db.clone(), format!("{room}/Ana"), format!("p2-{tag}"));
    wait_until("Pau gets the answer", move || {
        history(&pdb.lock().unwrap(), "pau", &conversation, 50).unwrap().iter().any(|m| m.id == id && m.sender == "Ana" && m.direction == "in")
    })
    .await;
    let (adb, id) = (ana_db.clone(), format!("p2-{tag}"));
    wait_until("accepted", move || outgoing(&adb.lock().unwrap(), "ana", &id).unwrap().state == "accepted").await;
    assert!(!history(&pau_db.lock().unwrap(), "pau", &room, 50).unwrap().iter().any(|m| m.body == answer));

    // Leaving keeps the private conversation to read; the room's talk goes.
    ana.tx.send(xmpp::Command::Leave { room: room.clone(), nick: "Ana".into() }).unwrap();
    leave_room(&ana_db.lock().unwrap(), "ana", &room).unwrap();
    assert!(conversations(&ana_db.lock().unwrap(), "ana").unwrap().iter().any(|c| c.conversation == format!("{room}/Pau")));
    assert!(history(&ana_db.lock().unwrap(), "ana", &room, 50).unwrap().is_empty());
    for w in [ana, pau] {
        w.tx.send(xmpp::Command::Stop).unwrap();
        w.task.await.unwrap();
    }
}
