use super::*;

fn report(raw: &str) -> Option<Report> {
    report_of(&mailparse::parse_mail(raw.as_bytes()).unwrap())
}

/// A report wrapped the way servers send them: a part for a person, the
/// machine-readable part, then the original (or its headers).
fn wrap(report_type: &str, status_type: &str, fields: &str, returned_type: &str, returned: &str) -> String {
    format!(
        "From: Mail Delivery System <MAILER-DAEMON@mx.example.net>\r\nTo: ana@example.com\r\n\
         Subject: Undelivered Mail Returned to Sender\r\nMessage-ID: <report-1@mx.example.net>\r\n\
         Date: Tue, 13 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\n\
         Content-Type: multipart/report; report-type={report_type};\r\n boundary=\"B\"\r\n\r\n\
         --B\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nThis is the mail system at host mx.example.net.\r\n\r\n\
         --B\r\nContent-Type: {status_type}\r\n\r\n{fields}\r\n\
         --B\r\nContent-Type: {returned_type}\r\n\r\n{returned}\r\n--B--\r\n"
    )
}

const ORIGINAL: &str = "Return-Path: <ana@example.com>\r\nFrom: Ana <ana@example.com>\r\nTo: bob@example.net\r\n\
Subject: Plan\r\nMessage-ID: <Plan-1@Example.com>\r\nDate: Tue, 13 Oct 2026 09:59:00 +0000\r\n\r\nHello Bob\r\n";

// ---- Delivery status notifications (RFC 3464) ----------------------------------

/// Postfix, a recipient that does not exist (the commonest bounce).
const POSTFIX_FAILED: &str = "Reporting-MTA: dns; mx.example.net\r\nX-Postfix-Queue-ID: 4BzX1Y2Z3\r\n\
X-Postfix-Sender: rfc822; ana@example.com\r\nArrival-Date: Tue, 13 Oct 2026 09:59:01 +0000 (UTC)\r\n\r\n\
Final-Recipient: rfc822; nobody@example.net\r\nOriginal-Recipient: rfc822;nobody@example.net\r\nAction: failed\r\n\
Status: 5.1.1\r\nRemote-MTA: dns; mail.example.net\r\n\
Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.net>:\r\n    Recipient address rejected: User unknown in virtual mailbox table\r\n";

#[test]
fn a_failed_delivery_says_who_with_its_status_code_and_the_server_words() {
    let found = report(&wrap("delivery-status", "message/delivery-status", POSTFIX_FAILED, "message/rfc822", ORIGINAL)).unwrap();
    assert_eq!(found.kind, Kind::Delivery);
    assert_eq!(found.original_message_id, "Plan-1@Example.com");
    assert_eq!(
        found.recipients,
        vec![RecipientReport {
            recipient: "nobody@example.net".into(),
            outcome: Outcome::Failed,
            status: "5.1.1".into(),
            diagnostic: "550 5.1.1 <nobody@example.net>: Recipient address rejected: User unknown in virtual mailbox table".into(),
        }]
    );
}

#[test]
fn a_delayed_delivery_is_read_from_returned_headers_only() {
    // Gmail's delay notice returns only the headers of the original.
    let fields = "Reporting-MTA: dns; googlemail.com\r\nArrival-Date: Tue, 13 Oct 2026 02:44:39 -0700 (PDT)\r\n\r\n\
Final-Recipient: rfc822; bob@slow.example\r\nAction: delayed\r\nStatus: 4.4.1\r\n\
Diagnostic-Code: smtp; The recipient server did not accept our requests to connect.\r\n\
Last-Attempt-Date: Tue, 13 Oct 2026 03:12:01 -0700 (PDT)\r\nWill-Retry-Until: Thu, 15 Oct 2026 02:44:40 -0700 (PDT)\r\n";
    let headers = "From: ana@example.com\r\nTo: bob@slow.example\r\nSubject: Plan\r\nMessage-ID: <plan-2@example.com>\r\n";
    let found = report(&wrap("delivery-status", "message/delivery-status", fields, "text/rfc822-headers", headers)).unwrap();
    assert_eq!(found.original_message_id, "plan-2@example.com");
    assert_eq!(found.recipients[0].outcome, Outcome::Delayed);
    assert_eq!(found.recipients[0].status, "4.4.1");
    assert_eq!(found.recipients[0].diagnostic, "The recipient server did not accept our requests to connect.");
}

#[test]
fn a_success_notice_names_the_recipient_as_the_sender_addressed_them() {
    // Postfix with NOTIFY=SUCCESS: the address was rewritten on the way.
    let fields = "Reporting-MTA: dns; mx.example.net\r\n\r\n\
Final-Recipient: rfc822; bob@mail.example.net\r\nOriginal-Recipient: rfc822;Bob@Example.net\r\n\
Action: delivered\r\nStatus: 2.0.0\r\nRemote-MTA: dns; mail.example.net\r\nDiagnostic-Code: smtp; 250 2.0.0 Ok: queued as 9F2B\r\n";
    let found = report(&wrap("delivery-status", "message/delivery-status", fields, "text/rfc822-headers", ORIGINAL)).unwrap();
    assert_eq!(found.recipients[0].recipient, "bob@example.net");
    assert_eq!(found.recipients[0].outcome, Outcome::Delivered);
    assert_eq!(found.recipients[0].status, "2.0.0");
}

#[test]
fn every_recipient_of_one_report_is_read_and_relayed_is_neither_delivered_nor_failed() {
    let fields = "Reporting-MTA: dns; mx.example.net\r\n\r\n\
Final-Recipient: rfc822; carol@example.org\r\nAction: delivered\r\nStatus: 2.0.0\r\n\r\n\
Final-Recipient: rfc822; dan@legacy.example\r\nAction: relayed\r\nStatus: 2.0.0\r\n\r\n\
Final-Recipient: rfc822; list@example.org\r\nAction: expanded\r\nStatus: 2.0.0\r\n\r\n\
Final-Recipient: rfc822; eve@example.org\r\nAction: failed\r\nStatus: 5.2.2\r\nDiagnostic-Code: smtp; 552 5.2.2 Mailbox full\r\n";
    let found = report(&wrap("delivery-status", "message/delivery-status", fields, "message/rfc822", ORIGINAL)).unwrap();
    let outcomes: Vec<(&str, Outcome)> = found.recipients.iter().map(|r| (r.recipient.as_str(), r.outcome)).collect();
    assert_eq!(
        outcomes,
        vec![
            ("carol@example.org", Outcome::Delivered),
            ("dan@legacy.example", Outcome::Relayed),
            ("list@example.org", Outcome::Relayed),
            ("eve@example.org", Outcome::Failed),
        ]
    );
}

#[test]
fn an_exchange_online_report_is_read_from_its_machine_part() {
    // Exchange Online's NDR: HTML for people, the status, the original.
    let fields = "Reporting-MTA: dns;AM0PR01MB0001.eurprd01.prod.outlook.com\r\n\
Received-From-MTA: dns;AM0PR01MB0002.eurprd01.prod.outlook.com\r\nArrival-Date: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\n\
Final-Recipient: rfc822;nobody@contoso.example\r\nAction: failed\r\nStatus: 5.1.10\r\n\
Diagnostic-Code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup\r\n";
    let found = report(&wrap("delivery-status", "message/delivery-status", fields, "message/rfc822", ORIGINAL)).unwrap();
    assert_eq!(found.recipients[0].status, "5.1.10");
    assert!(found.recipients[0].diagnostic.starts_with("550 5.1.10 RESOLVER.ADR.RecipientNotFound;"));
}

#[test]
fn an_internationalized_report_is_read_too() {
    // RFC 6533: the global variants, with a UTF-8 address.
    let fields = "Reporting-MTA: dns; mx.example.net\r\n\r\nFinal-Recipient: utf-8; José@Ejemplo.es\r\nAction: failed\r\nStatus: 5.1.1\r\n";
    let headers = "Subject: Plan\r\nMessage-ID: <plan-3@example.com>\r\n";
    let found = report(&wrap("delivery-status", "message/global-delivery-status", fields, "message/global-headers", headers)).unwrap();
    assert_eq!(found.recipients[0].recipient, "josé@ejemplo.es");
    assert_eq!(found.original_message_id, "plan-3@example.com");
}

// ---- Message disposition notifications (RFC 8098) --------------------------------

/// Thunderbird's read receipt.
const THUNDERBIRD_MDN: &str = "Reporting-UA: example.net; Thunderbird 128.3.0\r\nFinal-Recipient: rfc822;bob@example.net\r\n\
Original-Message-ID: <Plan-1@Example.com>\r\nDisposition: manual-action/MDN-sent-manually; displayed\r\n";

#[test]
fn a_read_receipt_says_it_was_displayed_and_names_the_message() {
    let found = report(&wrap("disposition-notification", "message/disposition-notification", THUNDERBIRD_MDN, "text/rfc822-headers", ORIGINAL)).unwrap();
    assert_eq!(found.kind, Kind::Disposition);
    assert_eq!(found.original_message_id, "Plan-1@Example.com");
    assert_eq!(found.recipients[0].recipient, "bob@example.net");
    assert_eq!(found.recipients[0].outcome, Outcome::Displayed);
}

#[test]
fn a_read_receipt_without_original_message_id_is_linked_by_the_returned_headers() {
    // Outlook's automatic receipt, with the headers of the original only.
    let fields = "Reporting-UA: EX01.contoso.example; Microsoft Exchange Server\r\nOriginal-Recipient: rfc822;bob@contoso.example\r\n\
Final-Recipient: rfc822;bob@contoso.example\r\nDisposition: automatic-action/MDN-sent-automatically; displayed\r\n";
    let found = report(&wrap("disposition-notification", "message/disposition-notification", fields, "text/rfc822-headers", ORIGINAL)).unwrap();
    assert_eq!(found.original_message_id, "Plan-1@Example.com");
    assert_eq!(found.recipients[0].outcome, Outcome::Displayed);
}

#[test]
fn handled_without_being_shown_is_not_displayed_and_obsolete_answers_are_not_read() {
    for kind in ["deleted", "dispatched", "processed"] {
        let fields = THUNDERBIRD_MDN.replace("; displayed", &format!("; {kind}"));
        let found = report(&wrap("disposition-notification", "message/disposition-notification", &fields, "text/rfc822-headers", ORIGINAL)).unwrap();
        assert_eq!(found.recipients[0].outcome, Outcome::NotDisplayed, "{kind}");
    }
    // RFC 3798's modifiers still read as their type.
    let modified = THUNDERBIRD_MDN.replace("; displayed", "; displayed/warning");
    assert_eq!(
        report(&wrap("disposition-notification", "message/disposition-notification", &modified, "text/rfc822-headers", ORIGINAL)).unwrap().recipients[0].outcome,
        Outcome::Displayed
    );
    for obsolete in ["denied", "failed", "something-new"] {
        let fields = THUNDERBIRD_MDN.replace("; displayed", &format!("; {obsolete}"));
        assert_eq!(report(&wrap("disposition-notification", "message/disposition-notification", &fields, "text/rfc822-headers", ORIGINAL)), None, "{obsolete}");
    }
}

// ---- Malformed and not reports ---------------------------------------------------

#[test]
fn malformed_reports_are_not_read_and_stay_ordinary_messages() {
    // No machine-readable part.
    assert_eq!(report(&wrap("delivery-status", "text/plain", POSTFIX_FAILED, "message/rfc822", ORIGINAL)), None);
    // A part with no recipient block (no Action).
    assert_eq!(report(&wrap("delivery-status", "message/delivery-status", "Reporting-MTA: dns; mx.example.net\r\n", "message/rfc822", ORIGINAL)), None);
    // An action nobody defined.
    let odd = POSTFIX_FAILED.replace("Action: failed", "Action: exploded");
    assert_eq!(report(&wrap("delivery-status", "message/delivery-status", &odd, "message/rfc822", ORIGINAL)), None);
    // A recipient block without a recipient.
    assert_eq!(report(&wrap("delivery-status", "message/delivery-status", "Action: failed\r\nStatus: 5.1.1\r\n", "message/rfc822", ORIGINAL)), None);
    // An MDN without its disposition.
    let bare = "Final-Recipient: rfc822;bob@example.net\r\nOriginal-Message-ID: <Plan-1@Example.com>\r\n";
    assert_eq!(report(&wrap("disposition-notification", "message/disposition-notification", bare, "text/rfc822-headers", ORIGINAL)), None);
    // A report type this does not read.
    assert_eq!(report(&wrap("x-unknown", "message/delivery-status", POSTFIX_FAILED, "message/rfc822", ORIGINAL)), None);
    // Plain mail, and a bounce forwarded inside another message.
    assert_eq!(report(ORIGINAL), None);
    let forwarded = format!(
        "From: ana@example.com\r\nSubject: Fwd: bounce\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"F\"\r\n\r\n--F\r\nContent-Type: text/plain\r\n\r\nLook\r\n--F\r\n{}\r\n--F--\r\n",
        wrap("delivery-status", "message/delivery-status", POSTFIX_FAILED, "message/rfc822", ORIGINAL)
    );
    assert_eq!(report(&forwarded), None);
}

#[test]
fn bad_fields_are_left_empty_rather_than_guessed() {
    let fields = format!(
        "Reporting-MTA: dns; mx.example.net\r\n\r\nFinal-Recipient: rfc822; nobody@example.net\r\nAction: failed\r\n\
         Status: five.one.one\r\nDiagnostic-Code: smtp; 550 \u{7}bell {}\r\n",
        "x".repeat(2000)
    );
    let found = report(&wrap("delivery-status", "message/delivery-status", &fields, "text/plain", "no headers here")).unwrap();
    assert_eq!(found.recipients[0].status, "");
    assert!(!found.recipients[0].diagnostic.contains('\u{7}'));
    assert_eq!(found.recipients[0].diagnostic.chars().count(), MAX_TEXT);
    // Nothing names the original: readable, but it links to nothing.
    assert_eq!(found.original_message_id, "");
    assert_eq!(status_code("4.7.0 (extra)"), "4.7.0");
    assert_eq!(status_code("6.1.1"), "");
    assert_eq!(status_code("5.1"), "");
}

// ---- Kept per sent message, and linked to it ---------------------------------------

const ACCOUNT: &str = "ana@example.com";

fn db() -> rusqlite::Connection {
    let conn = crate::store::open_at(":memory:").unwrap();
    let folder = |name: &str, role: Option<&str>| crate::imap::Folder {
        name: name.into(),
        delimiter: Some("/".into()),
        special_use: role.map(str::to_string),
        ..Default::default()
    };
    crate::store::upsert_folders(&conn, ACCOUNT, &[folder("INBOX", None), folder("Sent", Some("sent"))]).unwrap();
    conn
}
fn one(recipient: &str, outcome: Outcome, kind: Kind, id: &str) -> Report {
    Report {
        kind,
        original_message_id: id.into(),
        recipients: vec![RecipientReport { recipient: recipient.into(), outcome, status: String::new(), diagnostic: String::new() }],
    }
}
fn outcome_of(conn: &rusqlite::Connection, account: &str, id: &str) -> Vec<(String, Outcome)> {
    outcomes(conn, account, id).unwrap().into_iter().map(|s| (s.recipient, s.outcome)).collect()
}

#[test]
fn a_final_word_replaces_a_delay_and_is_never_replaced_by_one() {
    let conn = db();
    record(&conn, ACCOUNT, &one("bob@example.net", Outcome::Delayed, Kind::Delivery, "<P@x>"), 100).unwrap();
    assert_eq!(outcome_of(&conn, ACCOUNT, "p@x"), vec![("bob@example.net".into(), Outcome::Delayed)]);
    // Delivered, even with an earlier date than the delay notice.
    record(&conn, ACCOUNT, &one("bob@example.net", Outcome::Delivered, Kind::Delivery, "p@x"), 90).unwrap();
    assert_eq!(outcome_of(&conn, ACCOUNT, "<P@X>"), vec![("bob@example.net".into(), Outcome::Delivered)]);
    record(&conn, ACCOUNT, &one("bob@example.net", Outcome::Delayed, Kind::Delivery, "p@x"), 200).unwrap();
    assert_eq!(outcome_of(&conn, ACCOUNT, "p@x"), vec![("bob@example.net".into(), Outcome::Delivered)]);
    // Recording the same report again changes nothing.
    record(&conn, ACCOUNT, &one("bob@example.net", Outcome::Delivered, Kind::Delivery, "p@x"), 90).unwrap();
    assert_eq!(outcomes(&conn, ACCOUNT, "p@x").unwrap().len(), 1);
    // A read report is kept beside the delivery one, not over it.
    record(&conn, ACCOUNT, &one("bob@example.net", Outcome::Displayed, Kind::Disposition, "p@x"), 300).unwrap();
    assert_eq!(outcomes(&conn, ACCOUNT, "p@x").unwrap().len(), 2);
}

#[test]
fn a_report_naming_no_message_is_not_kept_and_reports_stay_with_their_account() {
    let conn = db();
    record(&conn, ACCOUNT, &one("bob@example.net", Outcome::Failed, Kind::Delivery, ""), 1).unwrap();
    let count: i64 = conn.query_row("SELECT count(*) FROM delivery_reports", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    record(&conn, "other@example.org", &one("bob@example.net", Outcome::Failed, Kind::Delivery, "p@x"), 1).unwrap();
    assert!(outcomes(&conn, ACCOUNT, "p@x").unwrap().is_empty());
    assert_eq!(outcome_of(&conn, "other@example.org", "p@x").len(), 1);
    assert!(outcomes(&conn, ACCOUNT, "").unwrap().is_empty());
}

#[test]
fn a_report_is_linked_to_its_sent_message_and_one_matching_nothing_stays_a_normal_message() {
    let conn = db();
    let sent = crate::parse::parse_message(ORIGINAL.as_bytes(), None);
    crate::store::save_cached_message(&conn, ACCOUNT, "Sent", 1, &sent).unwrap();
    let bounce = wrap("delivery-status", "message/delivery-status", POSTFIX_FAILED, "message/rfc822", ORIGINAL);
    let parsed = crate::parse::parse_message(bounce.as_bytes(), None);
    assert!(parsed.report.is_some());
    assert_eq!(parsed.receipt, None, "a report is never answered");
    crate::store::save_cached_message(&conn, ACCOUNT, "INBOX", 7, &parsed).unwrap();
    // The sent message now has what the report said.
    let linked = outcomes(&conn, ACCOUNT, &sent.message_id).unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!((linked[0].outcome, linked[0].status.as_str()), (Outcome::Failed, "5.1.1"));
    assert_eq!(linked[0].reported_at, parsed.date);
    // The report itself is still an ordinary cached message, with what it says.
    let cached = crate::store::get_cached_message(&conn, ACCOUNT, "INBOX", 7).unwrap().unwrap();
    assert_eq!(cached.report, parsed.report);
    assert_eq!(cached.subject, "Undelivered Mail Returned to Sender");

    // A report about a message nobody here sent links to nothing else.
    let stranger = bounce.replace("Plan-1@Example.com", "someone-else@example.org");
    let parsed = crate::parse::parse_message(stranger.as_bytes(), None);
    crate::store::save_cached_message(&conn, ACCOUNT, "INBOX", 8, &parsed).unwrap();
    assert_eq!(outcomes(&conn, ACCOUNT, &sent.message_id).unwrap().len(), 1);
    assert!(crate::store::get_cached_message(&conn, ACCOUNT, "INBOX", 8).unwrap().is_some());

    // A read receipt this account sent (in Sent) is not one it received.
    let ours = wrap("disposition-notification", "message/disposition-notification", THUNDERBIRD_MDN, "text/rfc822-headers", ORIGINAL)
        .replace("Plan-1@Example.com", "theirs@example.net");
    crate::store::save_cached_message(&conn, ACCOUNT, "Sent", 9, &crate::parse::parse_message(ours.as_bytes(), None)).unwrap();
    assert!(outcomes(&conn, ACCOUNT, "theirs@example.net").unwrap().is_empty());
}
