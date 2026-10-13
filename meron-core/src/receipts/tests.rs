use super::*;

fn mail(headers: &str) -> Vec<u8> {
    format!("{headers}\r\n\r\nBody\r\n").into_bytes()
}

fn request(headers: &str) -> Option<ReceiptRequest> {
    let raw = mail(headers);
    request_of(&mailparse::parse_mail(&raw).unwrap())
}

const ASKING: &str = "Return-Path: <ana@example.com>\r\nFrom: Ana <ana@example.com>\r\nTo: me@example.org\r\n\
Message-ID: <m1@example.com>\r\nSubject: Hi\r\nDisposition-Notification-To: Ana <Ana@Example.com>";

// ---- Reading the request ------------------------------------------------------

#[test]
fn a_message_without_the_header_asks_for_nothing() {
    assert_eq!(request("From: ana@example.com\r\nSubject: Hi"), None);
}

#[test]
fn the_request_names_where_the_receipt_goes_and_the_return_path() {
    let found = request(ASKING).expect("asks");
    assert_eq!(found.notify_to, vec!["ana@example.com".to_string()]);
    assert_eq!(found.return_path, "ana@example.com");
    assert!(!found.list);
    assert_eq!(caution(&found), None);
}

#[test]
fn list_mail_is_recognised_by_its_headers() {
    let found = request(&format!("{ASKING}\r\nList-Id: <team.lists.example.com>")).unwrap();
    assert!(found.list);
    let bulk = request(&format!("{ASKING}\r\nPrecedence: bulk")).unwrap();
    assert!(bulk.list);
}

#[test]
fn a_report_is_never_answered() {
    let raw = format!(
        "{ASKING}\r\nContent-Type: multipart/report; report-type=disposition-notification; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n"
    );
    assert_eq!(request_of(&mailparse::parse_mail(raw.as_bytes()).unwrap()), None);
}

#[test]
fn an_unusable_address_is_no_request() {
    assert_eq!(request("From: ana@example.com\r\nDisposition-Notification-To: nobody"), None);
}

#[test]
fn the_original_recipient_field_is_kept_for_the_report() {
    let found = request(&format!("{ASKING}\r\nOriginal-Recipient: rfc822;me@example.org")).unwrap();
    assert_eq!(found.original_recipient, "rfc822;me@example.org");
}

// ---- Deciding -------------------------------------------------------------------

fn plain() -> ReceiptRequest {
    ReceiptRequest {
        notify_to: vec!["ana@example.com".into()],
        return_path: "bounces@example.com".into(),
        list: false,
        original_recipient: String::new(),
    }
}

#[test]
fn nothing_requested_is_nothing_to_do() {
    assert_eq!(decide(Policy::Always, None, "m1@x", false, None), Verdict::NotRequested);
}

#[test]
fn ask_is_the_default_and_asks() {
    assert_eq!(Policy::default(), Policy::Ask);
    assert_eq!(Policy::parse("something new"), Policy::Ask);
    assert_eq!(decide(Policy::Ask, Some(&plain()), "m1@x", false, None), Verdict::Ask(None));
}

#[test]
fn always_sends_when_nothing_makes_it_unsafe() {
    assert_eq!(decide(Policy::Always, Some(&plain()), "m1@x", false, None), Verdict::SendAutomatically);
}

#[test]
fn never_neither_asks_nor_sends() {
    assert_eq!(decide(Policy::Never, Some(&plain()), "m1@x", false, None), Verdict::Silent(Silence::Never));
}

#[test]
fn list_mail_is_never_answered_automatically() {
    let list = ReceiptRequest { list: true, ..plain() };
    assert_eq!(decide(Policy::Always, Some(&list), "m1@x", false, None), Verdict::Ask(Some(Caution::MailingList)));
}

#[test]
fn a_receipt_to_another_domain_than_the_return_path_is_asked_first() {
    let elsewhere = ReceiptRequest { notify_to: vec!["track@tracker.example".into()], ..plain() };
    assert_eq!(
        decide(Policy::Always, Some(&elsewhere), "m1@x", false, None),
        Verdict::Ask(Some(Caution::AddressMismatch))
    );
    // No return path to compare with is no better.
    let unknown = ReceiptRequest { return_path: String::new(), ..plain() };
    assert_eq!(caution(&unknown), Some(Caution::AddressMismatch));
    // One of several addresses elsewhere is enough.
    let several = ReceiptRequest { notify_to: vec!["ana@example.com".into(), "x@other.example".into()], ..plain() };
    assert_eq!(caution(&several), Some(Caution::AddressMismatch));
}

#[test]
fn junk_is_never_answered_nor_asked_about() {
    assert_eq!(decide(Policy::Always, Some(&plain()), "m1@x", true, None), Verdict::Silent(Silence::Junk));
    assert_eq!(decide(Policy::Ask, Some(&plain()), "m1@x", true, None), Verdict::Silent(Silence::Junk));
}

#[test]
fn an_answered_request_is_not_asked_again() {
    for policy in [Policy::Ask, Policy::Always, Policy::Never] {
        assert_eq!(
            decide(policy, Some(&plain()), "m1@x", false, Some(Answer::Declined)),
            Verdict::Answered(Answer::Declined)
        );
        assert_eq!(decide(policy, Some(&plain()), "m1@x", true, Some(Answer::Sent)), Verdict::Answered(Answer::Sent));
    }
}

#[test]
fn a_message_without_an_id_is_left_alone() {
    assert_eq!(decide(Policy::Always, Some(&plain()), "  ", false, None), Verdict::Silent(Silence::Unidentified));
}

#[test]
fn the_policy_is_read_from_settings() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    assert_eq!(policy(&conn), Policy::Ask);
    crate::store::setting_set(&conn, POLICY_SETTING, &serde_json::json!("always")).unwrap();
    assert_eq!(policy(&conn), Policy::Always);
    crate::store::setting_set(&conn, POLICY_SETTING, &serde_json::json!("never")).unwrap();
    assert_eq!(policy(&conn), Policy::Never);
}

// ---- Remembering ------------------------------------------------------------------

#[test]
fn an_answer_is_claimed_once_and_remembered() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    assert_eq!(answered(&conn, "acc", "<M1@x>").unwrap(), None);
    assert!(claim(&conn, "acc", "<M1@x>", Answer::Declined, 10).unwrap());
    // The same message, however its id is written, is not claimed twice.
    assert!(!claim(&conn, "acc", "m1@x", Answer::Sent, 11).unwrap());
    assert_eq!(answered(&conn, "acc", "m1@x").unwrap(), Some(Answer::Declined));
    // Another account's copy is its own question.
    assert_eq!(answered(&conn, "other", "m1@x").unwrap(), None);
    release(&conn, "acc", "m1@x").unwrap();
    assert_eq!(answered(&conn, "acc", "m1@x").unwrap(), None);
    assert!(claim(&conn, "acc", "", Answer::Sent, 12).is_err());
}

#[test]
fn answers_go_with_the_account() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    claim(&conn, "acc", "m1@x", Answer::Sent, 10).unwrap();
    crate::store::delete_account(&conn, "acc").unwrap();
    assert_eq!(answered(&conn, "acc", "m1@x").unwrap(), None);
}

// ---- The report ------------------------------------------------------------------------

fn mdn<'a>(to: &'a [String], mode: Mode) -> Mdn<'a> {
    Mdn {
        from_name: "Zoë Ñandú",
        from_addr: "me@example.org",
        to,
        original_message_id: "<M1@example.com>",
        original_subject: "Presupuesto de diseño",
        original_recipient: "",
        mode,
    }
}

#[test]
fn a_manual_receipt_is_a_disposition_notification_report() {
    let to = vec!["ana@example.com".to_string()];
    let raw = build_mdn(&mdn(&to, Mode::Manual)).unwrap();
    let parsed = mailparse::parse_mail(&raw).unwrap();
    assert_eq!(parsed.ctype.mimetype, "multipart/report");
    assert_eq!(parsed.ctype.params.get("report-type").map(String::as_str), Some("disposition-notification"));
    assert_eq!(parsed.subparts.len(), 2);
    assert_eq!(parsed.subparts[0].ctype.mimetype, "text/plain");
    assert!(parsed.subparts[0].get_body().unwrap().contains("me@example.org"));

    let notification = &parsed.subparts[1];
    assert_eq!(notification.ctype.mimetype, "message/disposition-notification");
    let fields = String::from_utf8(notification.get_body_raw().unwrap()).unwrap();
    assert!(fields.contains("Reporting-UA: Oreneta\r\n"), "{fields}");
    assert!(fields.contains("Final-Recipient: rfc822;me@example.org\r\n"), "{fields}");
    assert!(fields.contains("Original-Message-ID: <M1@example.com>\r\n"), "{fields}");
    assert!(fields.contains("Disposition: manual-action/MDN-sent-manually; displayed\r\n"), "{fields}");
    assert!(!fields.contains("Original-Recipient"), "only echoed when the message had one: {fields}");

    // Threaded to the original, addressed to the request, from the reader.
    assert_eq!(parsed.headers.get_first_value("In-Reply-To").as_deref(), Some("<M1@example.com>"));
    assert_eq!(parsed.headers.get_first_value("To").as_deref(), Some("<ana@example.com>"));
    // A person's click is not an automatic reply.
    assert_eq!(parsed.headers.get_first_value("Auto-Submitted"), None);
}

#[test]
fn an_automatic_receipt_says_so_and_is_marked_auto_replied() {
    let to = vec!["ana@example.com".to_string()];
    let raw = build_mdn(&Mdn { original_recipient: "rfc822;Me@Example.org", ..mdn(&to, Mode::Automatic) }).unwrap();
    let parsed = mailparse::parse_mail(&raw).unwrap();
    let fields = String::from_utf8(parsed.subparts[1].get_body_raw().unwrap()).unwrap();
    assert!(fields.contains("Disposition: automatic-action/MDN-sent-automatically; displayed\r\n"), "{fields}");
    assert!(fields.contains("Original-Recipient: rfc822;Me@Example.org\r\n"), "{fields}");
    assert_eq!(parsed.headers.get_first_value("Auto-Submitted").as_deref(), Some("auto-replied"));
}

#[test]
fn non_ascii_names_and_subjects_are_encoded_not_sent_raw() {
    let to = vec!["ana@example.com".to_string()];
    let raw = build_mdn(&mdn(&to, Mode::Manual)).unwrap();
    // On the wire: 7-bit, with encoded words for the name and the subject.
    assert!(raw.is_ascii(), "{}", String::from_utf8_lossy(&raw));
    let parsed = mailparse::parse_mail(&raw).unwrap();
    assert_eq!(
        parsed.headers.get_first_value("Subject").as_deref(),
        Some("Read: Presupuesto de diseño")
    );
    assert!(parsed.headers.get_first_value("From").unwrap().contains("Zoë Ñandú"));
    // The notification itself is never quoted-printable or base64.
    let encoding = parsed.subparts[1].headers.get_first_value("Content-Transfer-Encoding").unwrap();
    assert_eq!(encoding, "7bit");
}

#[test]
fn long_fields_fold_at_whitespace() {
    let folded = field("Original-Recipient", &format!("rfc822;{} tail", "a".repeat(80)));
    assert!(folded.lines().all(|line| line.len() <= 998));
    assert!(folded.contains("\r\n tail"), "{folded:?}");
    let short = field("Disposition", "manual-action/MDN-sent-manually; displayed");
    assert_eq!(short, "Disposition: manual-action/MDN-sent-manually; displayed\r\n");
    // A long subject folds in the header too, and still reads back whole.
    let to = vec!["ana@example.com".to_string()];
    let subject = "palabra ".repeat(20);
    let raw = build_mdn(&Mdn { original_subject: &subject, ..mdn(&to, Mode::Manual) }).unwrap();
    let text = String::from_utf8(raw.clone()).unwrap();
    assert!(text.lines().all(|line| line.len() <= 78), "{text}");
    let parsed = mailparse::parse_mail(&raw).unwrap();
    assert_eq!(parsed.headers.get_first_value("Subject").unwrap(), format!("Read: {}", subject.trim()));
}

#[test]
fn a_receipt_needs_a_message_to_name_and_an_address() {
    let to = vec!["ana@example.com".to_string()];
    assert!(build_mdn(&Mdn { original_message_id: "", ..mdn(&to, Mode::Manual) }).is_err());
    assert!(build_mdn(&mdn(&[], Mode::Manual)).is_err());
}

#[test]
fn the_parsed_message_carries_the_request() {
    let raw = mail(ASKING);
    let message = crate::parse::parse_message(&raw, None);
    assert_eq!(message.receipt.map(|r| r.notify_to), Some(vec!["ana@example.com".to_string()]));
    let plain = crate::parse::parse_message(&mail("From: a@b.c\r\nSubject: x"), None);
    assert!(plain.receipt.is_none());
}

#[test]
fn the_request_survives_the_message_cache() {
    let conn = crate::store::open_in_memory_for_test().unwrap();
    let message = crate::parse::parse_message(&mail(ASKING), None);
    crate::store::save_cached_message(&conn, "acc", "INBOX", 7, &message).unwrap();
    let cached = crate::store::get_cached_message(&conn, "acc", "INBOX", 7).unwrap().expect("cached");
    assert_eq!(cached.receipt, message.receipt);
    assert!(cached.receipt.is_some());
}
