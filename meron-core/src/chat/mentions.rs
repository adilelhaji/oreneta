//! Mentions in group chats (ADR-0055).
//!
//! A mention is plain text: the nickname, usually after `@`, which is what
//! every client shows. When the person picked the nickname from the
//! suggestions, the message also carries a XEP-0372 reference to that
//! occupant, so clients that read references need not guess.
//!
//! An incoming message mentions us when its text has our nickname in the
//! room as a whole word (case-insensitive, any alphabet), or when it carries
//! a XEP-0372 mention of our address or of our place in the room.

use tokio_xmpp::parsers::jid::BareJid;
use tokio_xmpp::parsers::message::Message;
use tokio_xmpp::parsers::minidom::Element;

pub const NS_REFERENCE: &str = "urn:xmpp:reference:0";

/// A letter, digit or `_` continues a word; anything else ends one.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn same(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

/// Where `needle` first appears in `hay` as a whole word, ignoring case, in
/// characters (code points), end exclusive.
pub fn find_word(hay: &str, needle: &str) -> Option<(usize, usize)> {
    let needle: Vec<char> = needle.trim().chars().collect();
    if needle.is_empty() {
        return None;
    }
    let hay: Vec<char> = hay.chars().collect();
    if needle.len() > hay.len() {
        return None;
    }
    for start in 0..=hay.len() - needle.len() {
        let end = start + needle.len();
        if !hay[start..end].iter().zip(&needle).all(|(a, b)| same(*a, *b)) {
            continue;
        }
        // The nickname's own edges decide whether a boundary is needed: a
        // nickname ending in "." is not continued by what follows the dot.
        let before_ok = start == 0 || !is_word(hay[start - 1]) || !is_word(needle[0]);
        let after_ok = end == hay.len() || !is_word(hay[end]) || !is_word(needle[needle.len() - 1]);
        if before_ok && after_ok {
            return Some((start, end));
        }
    }
    None
}

/// Whether a message's text says this nickname as a whole word.
pub fn mentions_nick(body: &str, nick: &str) -> bool {
    find_word(body, nick).is_some()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The address an `xmpp:` reference points at, without its query.
fn reference_target(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("xmpp:")?;
    let rest = rest.split('?').next().unwrap_or(rest);
    Some(percent_decode(rest))
}

/// Whether the message carries a XEP-0372 mention of us: our own address,
/// or our place in this room (`room/nick`).
pub fn references_me(message: &Message, own: &BareJid, room: &BareJid, nick: &str) -> bool {
    let me = own.to_string().to_lowercase();
    let room = room.to_string().to_lowercase();
    let nick = nick.to_lowercase();
    message.payloads.iter().any(|p| {
        if !p.is("reference", NS_REFERENCE) || p.attr("type") != Some("mention") {
            return false;
        }
        let Some(target) = p.attr("uri").and_then(reference_target) else { return false };
        match target.split_once('/') {
            Some((bare, resource)) => bare.to_lowercase() == room && resource.to_lowercase() == nick,
            None => target.to_lowercase() == me,
        }
    })
}

/// Whether an incoming room message mentions us, by text or by reference.
pub fn is_mention(message: &Message, body: &str, own: &BareJid, room: &BareJid, nick: &str) -> bool {
    mentions_nick(body, nick) || references_me(message, own, room, nick)
}

/// XEP-0372 references for the nicknames the person picked: one per
/// nickname still found in the text, pointing at the occupant
/// (`xmpp:room/nick`), with `begin` (inclusive) and `end` (exclusive) in
/// characters. A nickname no longer in the text gets none.
pub fn references(room: &BareJid, body: &str, nicks: &[String]) -> Vec<Element> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for nick in nicks {
        let nick = nick.trim();
        if nick.is_empty() || !seen.insert(nick.to_string()) {
            continue;
        }
        let Some((begin, end)) = find_word(body, nick) else { continue };
        // The nickname is percent-encoded and an address has no quotes or
        // markup, so the attribute needs only the usual escaping to be safe.
        let uri = xml_escape(&format!("xmpp:{}/{}", room, percent_encode(nick)));
        let xml = format!("<reference xmlns='{NS_REFERENCE}' type='mention' uri='{uri}' begin='{begin}' end='{end}'/>");
        if let Ok(element) = xml.parse::<Element>() {
            out.push(element);
        }
    }
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('\'', "&apos;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}
