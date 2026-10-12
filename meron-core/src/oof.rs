//! Client-side out-of-office auto-reply: deciding *whether* an arriving
//! message should get one.
//!
//! This exists only for accounts with no server-side equivalent — plain
//! IMAP/SMTP has no standard vacation-responder mechanism the way Exchange
//! does. An Exchange account configures the server's own Automatic Replies
//! instead (through the EWS `GetUserOofSettings`/`SetUserOofSettings`
//! operations) and never reaches this module: the server sends the reply
//! itself, reliably, whether or not Oreneta is even running. This module's
//! decision only takes effect while Oreneta is open — there is nothing this
//! app can do about that for a protocol with no server-side auto-responder,
//! which the interface must say plainly rather than let the reader believe
//! they are covered when the app is closed.
//!
//! *Sending* the reply (building the MIME, handing it to SMTP) lives in
//! [`crate::smtp::send_oof_reply`]; this module only answers "should
//! something reply to this message at all" — a question worth keeping
//! separate because getting it wrong either way is a real problem: too
//! eager, and two auto-responders answer each other forever, or a mailing
//! list gets a reply meant for one person; too cautious, and the feature
//! quietly does nothing.

use mailparse::{MailHeaderMap as _, ParsedMail};

/// Whether a message is the kind nothing should auto-reply to: another
/// auto-responder, a mailing list, bulk mail. Replying to any of these is a
/// real failure mode, not a cosmetic one — two auto-responders answering
/// each other loop forever, and a reply-all to a list reaches everyone
/// subscribed to it, not just whoever actually wrote in. RFC 3834 defines
/// `Auto-Submitted` for exactly this case; `Precedence` and the `List-*`
/// headers are older but just as broadly respected.
pub fn looks_automated(mail: &ParsedMail) -> bool {
    if let Some(value) = mail.headers.get_first_value("Auto-Submitted") {
        if !value.trim().eq_ignore_ascii_case("no") {
            return true;
        }
    }
    if let Some(value) = mail.headers.get_first_value("Precedence") {
        let value = value.trim().to_ascii_lowercase();
        if value == "bulk" || value == "list" || value == "junk" {
            return true;
        }
    }
    // Outlook's own "do not auto-reply to this" (also used by Exchange for
    // its notifications): OOF or All suppresses out-of-office replies.
    if let Some(value) = mail.headers.get_first_value("X-Auto-Response-Suppress") {
        if value
            .split(',')
            .map(|token| token.trim().to_ascii_lowercase())
            .any(|token| token == "oof" || token == "all")
        {
            return true;
        }
    }
    looks_like_bounce(mail)
        || ["List-Id", "List-Unsubscribe", "List-Post"]
            .iter()
            .any(|header| mail.headers.get_first_value(header).is_some())
}

/// A delivery report (bounce). A null reverse path is how a bounce says it
/// must not be answered (RFC 3834 §2); answering a bounce of our own reply
/// would start a loop with the server that produced it.
fn looks_like_bounce(mail: &ParsedMail) -> bool {
    if let Some(path) = mail.headers.get_first_value("Return-Path") {
        let path = path.trim();
        if path == "<>" || path.is_empty() {
            return true;
        }
    }
    mail.ctype.mimetype.eq_ignore_ascii_case("multipart/report")
}

/// The address-local-part conventions ("noreply@…", "no-reply@…",
/// "donotreply@…", and the delivery-system senders "MAILER-DAEMON@…" and
/// "postmaster@…") that near-universally mean nobody reads what is sent
/// there. A heuristic, not a protocol — but one broadly enough relied on
/// that skipping it would mean confidently auto-replying into the void.
fn looks_like_noreply_address(addr: &str) -> bool {
    let local = addr.split('@').next().unwrap_or(addr).to_ascii_lowercase();
    let local: String = local.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    local == "noreply" || local == "donotreply" || local == "mailerdaemon" || local == "postmaster"
}

/// Whether an out-of-office reply should go out for this arriving message,
/// from `from_addr`, to an account whose own address is `own_address`.
pub fn should_reply(mail: &ParsedMail, from_addr: &str, own_address: &str) -> bool {
    let from_addr = from_addr.trim();
    if from_addr.is_empty() {
        return false;
    }
    // Never reply to ourselves: the surest way to start a loop, and it can
    // only mean a message we sent came back to us (a mailing list echo, a
    // misconfigured forward).
    if from_addr.eq_ignore_ascii_case(own_address.trim()) {
        return false;
    }
    if looks_like_noreply_address(from_addr) {
        return false;
    }
    !looks_automated(mail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(headers: &str) -> Vec<u8> {
        format!("{headers}\r\n\r\nBody\r\n").into_bytes()
    }

    #[test]
    fn an_ordinary_message_gets_a_reply() {
        let raw = parsed("From: ana@example.com\r\nTo: me@example.com\r\nSubject: Hi");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(should_reply(&mail, "ana@example.com", "me@example.com"));
    }

    #[test]
    fn never_replies_to_itself() {
        let raw = parsed("From: me@example.com\r\nTo: someone@example.com\r\nSubject: Hi");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(!should_reply(&mail, "me@example.com", "me@example.com"));
        assert!(!should_reply(&mail, "ME@Example.com", "me@example.com"));
    }

    #[test]
    fn does_not_reply_to_another_auto_responder() {
        let raw = parsed("From: ana@example.com\r\nAuto-Submitted: auto-replied\r\nSubject: Out of office");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(!should_reply(&mail, "ana@example.com", "me@example.com"));
    }

    #[test]
    fn an_explicit_auto_submitted_no_is_still_a_real_message() {
        let raw = parsed("From: ana@example.com\r\nAuto-Submitted: no\r\nSubject: Hi");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(should_reply(&mail, "ana@example.com", "me@example.com"));
    }

    #[test]
    fn does_not_reply_to_bulk_or_list_mail() {
        for header in ["Precedence: bulk", "Precedence: list", "Precedence: junk"] {
            let raw = parsed(&format!("From: newsletter@example.com\r\n{header}\r\nSubject: News"));
            let mail = mailparse::parse_mail(&raw).unwrap();
            assert!(!should_reply(&mail, "newsletter@example.com", "me@example.com"));
        }
    }

    #[test]
    fn does_not_reply_to_a_mailing_list() {
        let raw = parsed("From: list@example.com\r\nList-Id: <announce.example.com>\r\nSubject: Update");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(!should_reply(&mail, "list@example.com", "me@example.com"));
    }

    #[test]
    fn does_not_reply_to_a_noreply_address() {
        let raw = parsed("From: no-reply@example.com\r\nSubject: Receipt");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(!should_reply(&mail, "no-reply@example.com", "me@example.com"));
    }

    // #48: bounces and suppression requests.

    #[test]
    fn does_not_reply_to_a_bounce() {
        // A null reverse path is how a bounce says "do not answer me"
        // (RFC 3834 §2): answering a bounce of our own reply is a loop.
        let null_path = parsed("Return-Path: <>\r\nFrom: ana@example.com\r\nSubject: Undeliverable");
        let mail = mailparse::parse_mail(&null_path).unwrap();
        assert!(!should_reply(&mail, "ana@example.com", "me@example.com"));
        for daemon in ["MAILER-DAEMON@example.com", "postmaster@example.com"] {
            let raw = parsed(&format!("From: {daemon}\r\nSubject: Delivery Status Notification"));
            let mail = mailparse::parse_mail(&raw).unwrap();
            assert!(!should_reply(&mail, daemon, "me@example.com"), "{daemon}");
        }
        let report = parsed("From: ana@example.com\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=x\r\nSubject: Returned mail");
        let mail = mailparse::parse_mail(&report).unwrap();
        assert!(!should_reply(&mail, "ana@example.com", "me@example.com"));
    }

    #[test]
    fn respects_a_request_to_suppress_automatic_replies() {
        for value in ["OOF", "All", "DR, RN, NRN, OOF, AutoReply"] {
            let raw = parsed(&format!("From: ana@example.com\r\nX-Auto-Response-Suppress: {value}\r\nSubject: Hi"));
            let mail = mailparse::parse_mail(&raw).unwrap();
            assert!(!should_reply(&mail, "ana@example.com", "me@example.com"), "{value}");
        }
        // Suppressing only read receipts still gets an out-of-office reply.
        let raw = parsed("From: ana@example.com\r\nX-Auto-Response-Suppress: RN, NRN\r\nSubject: Hi");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(should_reply(&mail, "ana@example.com", "me@example.com"));
    }

    #[test]
    fn does_not_reply_to_a_list_identified_only_by_list_post() {
        let raw = parsed("From: ana@example.com\r\nList-Post: <mailto:team@lists.example.com>\r\nSubject: Hi");
        let mail = mailparse::parse_mail(&raw).unwrap();
        assert!(!should_reply(&mail, "ana@example.com", "me@example.com"));
    }
}
