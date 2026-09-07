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
    mail.headers.get_first_value("List-Id").is_some() || mail.headers.get_first_value("List-Unsubscribe").is_some()
}

/// The address-local-part convention ("noreply@…", "no-reply@…",
/// "donotreply@…") that near-universally means nobody reads what is sent
/// there. A heuristic, not a protocol — but one broadly enough relied on
/// that skipping it would mean confidently auto-replying into the void.
fn looks_like_noreply_address(addr: &str) -> bool {
    let local = addr.split('@').next().unwrap_or(addr).to_ascii_lowercase();
    let local: String = local.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    local == "noreply" || local == "donotreply"
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
}
