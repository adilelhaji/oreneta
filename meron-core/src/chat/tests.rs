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
    ana.send(xmpp::Command::Send { conversation: "pau@chat.test".into(), id: id.clone(), body: "Hola Pau".into(), group: false, file: None }).unwrap();
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
    ana.send(xmpp::Command::Send { conversation: "pau@chat.test".into(), id: id2.clone(), body: "¿Estás?".into(), group: false, file: None }).unwrap();
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

/// Waits (off the reactor) for an event that matches; panics after 20 s.
async fn wait_event(session: &Session, what: &'static str, matches: impl Fn(&str, &serde_json::Value) -> bool + Send + 'static) -> serde_json::Value {
    let events = session.events.clone();
    tokio::task::spawn_blocking(move || {
        let events = events.lock().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            if let Ok((name, detail)) = events.recv_timeout(std::time::Duration::from_millis(200)) {
                assert_ne!(detail["state"], "error", "{name}: {detail}");
                if matches(&name, &detail) {
                    return detail;
                }
            }
        }
        panic!("never saw: {what}");
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
        .send(xmpp::Command::Send { conversation: room.into(), id: id.into(), body: body.into(), group: true, file: None })
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
    let options = xmpp::Options { room_password: Arc::new(|_| None), file_roots: vec![ca.clone()] };
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
