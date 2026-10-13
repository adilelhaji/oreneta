//! Writing vCards back to an address book (ADR-0012).
//!
//! An edit never rebuilds a card from what this app understands of it. A card
//! carries far more than a name, addresses and numbers — postal addresses,
//! birthdays, a photo, fields only one client reads — and regenerating it
//! would delete all of that on the server. So an edit starts from the card as
//! the server holds it and changes only the lines whose meaning changed;
//! every other line goes back exactly as it came.

use super::person::{person_from_properties, Person};
use super::vcard::{parse_properties, split_cards};

/// A new card for `person`, in vCard 3.0, which every CardDAV server takes.
pub fn new_card(person: &Person, uid: &str) -> String {
    let mut lines = vec![
        "BEGIN:VCARD".to_string(),
        "VERSION:3.0".to_string(),
        format!("UID:{}", escape(uid)),
        format!("FN:{}", escape(&person.name)),
        n_line(person),
    ];
    if !person.organisation.is_empty() {
        lines.push(format!("ORG:{}", escape(&person.organisation)));
    }
    for email in &person.emails {
        lines.push(labelled("EMAIL", &email.label, &email.addr));
    }
    for phone in &person.phones {
        lines.push(labelled("TEL", &phone.label, &phone.number));
    }
    if !person.note.is_empty() {
        lines.push(format!("NOTE:{}", escape(&person.note)));
    }
    lines.push("END:VCARD".to_string());
    join(&lines)
}

/// A card for exporting `person`, saying where it came from in a field other
/// apps ignore (ADR-0012): "local", "carddav", "google" or "exchange".
pub fn export_card(person: &Person, uid: &str, source: &str) -> String {
    let card = new_card(person, uid);
    let end = card.rfind("END:VCARD").unwrap_or(card.len());
    format!("{}X-ORENETA-SOURCE:{}\r\n{}", &card[..end], escape(source), &card[end..])
}

/// The card as the server holds it, with `person`'s fields written over the
/// ones that changed. Lines this app does not edit are kept as they were.
pub fn patch_card(raw: &str, person: &Person, now: i64) -> anyhow::Result<String> {
    let Some(card) = split_cards(raw.as_bytes()).into_iter().next() else {
        anyhow::bail!("the server's copy of this contact is not a vCard");
    };
    let before = person_from_properties(&card);
    let name_changed = before.name != person.name;
    let parts_changed = before.given != person.given || before.family != person.family;
    let org_changed = before.organisation != person.organisation;
    let note_changed = before.note != person.note;
    let keep_emails: Vec<String> = person.emails.iter().map(|e| e.addr.trim().to_lowercase()).collect();
    let keep_phones: Vec<String> = person.phones.iter().map(|p| digits(&p.number)).collect();

    let mut out: Vec<String> = Vec::new();
    let mut dropped_groups: Vec<String> = Vec::new();
    let mut seen_emails: Vec<String> = Vec::new();
    let mut seen_phones: Vec<String> = Vec::new();
    let mut had = (false, false, false); // FN, ORG, NOTE
    let mut had_n = false;
    let mut depth = 0usize;
    let mut done = false;

    for line in unfold(raw) {
        if done {
            out.push(line);
            continue;
        }
        let Some(property) = parse_properties(line.as_bytes()).into_iter().next() else {
            out.push(line);
            continue;
        };
        match property.name.as_str() {
            "BEGIN" if property.value.eq_ignore_ascii_case("VCARD") => {
                depth += 1;
                out.push(line);
                continue;
            }
            "END" if property.value.eq_ignore_ascii_case("VCARD") && depth == 1 => {
                // What is new goes in just before the card closes.
                if !had.0 {
                    out.push(format!("FN:{}", escape(&person.name)));
                }
                if !had_n && (!person.given.is_empty() || !person.family.is_empty()) {
                    out.push(n_line(person));
                }
                if !had.1 && !person.organisation.is_empty() {
                    out.push(format!("ORG:{}", escape(&person.organisation)));
                }
                if !had.2 && !person.note.is_empty() {
                    out.push(format!("NOTE:{}", escape(&person.note)));
                }
                for email in &person.emails {
                    if !seen_emails.contains(&email.addr.trim().to_lowercase()) {
                        out.push(labelled("EMAIL", &email.label, &email.addr));
                    }
                }
                for phone in &person.phones {
                    if !seen_phones.contains(&digits(&phone.number)) {
                        out.push(labelled("TEL", &phone.label, &phone.number));
                    }
                }
                out.push(line);
                depth = 0;
                done = true;
                continue;
            }
            _ => {}
        }
        if depth != 1 {
            out.push(line);
            continue;
        }
        let drop = |groups: &mut Vec<String>| {
            if !property.group.is_empty() {
                groups.push(property.group.to_lowercase());
            }
        };
        match property.name.as_str() {
            "FN" => {
                if had.0 {
                    continue;
                }
                had.0 = true;
                out.push(if name_changed { format!("FN:{}", escape(&person.name)) } else { line });
            }
            "N" if had_n => out.push(line),
            "N" => {
                had_n = true;
                out.push(if parts_changed {
                    patched_n(&property.raw, person)
                } else if name_changed {
                    // A new whole name with the same parts: the old parts no
                    // longer describe it, and splitting it would be a guess.
                    name_line(&person.name)
                } else {
                    line
                })
            }
            "ORG" => {
                if had.1 {
                    continue;
                }
                had.1 = true;
                if !org_changed {
                    out.push(line);
                } else if !person.organisation.is_empty() {
                    out.push(format!("ORG:{}", escape(&person.organisation)));
                }
            }
            "NOTE" => {
                if had.2 {
                    continue;
                }
                had.2 = true;
                if !note_changed {
                    out.push(line);
                } else if !person.note.is_empty() {
                    out.push(format!("NOTE:{}", escape(&person.note)));
                }
            }
            "EMAIL" => {
                let addr = property.value.trim().to_lowercase();
                if keep_emails.contains(&addr) && !seen_emails.contains(&addr) {
                    seen_emails.push(addr);
                    out.push(line);
                } else {
                    drop(&mut dropped_groups);
                }
            }
            "TEL" => {
                let number = digits(&property.value);
                if keep_phones.contains(&number) && !seen_phones.contains(&number) {
                    seen_phones.push(number);
                    out.push(line);
                } else {
                    drop(&mut dropped_groups);
                }
            }
            "REV" => out.push(format!("REV:{}", rev(now))),
            _ => out.push(line),
        }
    }

    // A label written beside a removed address (`item1.X-ABLabel`) goes too.
    let out: Vec<String> = out
        .into_iter()
        .filter(|line| match line.split_once('.') {
            Some((group, rest)) if !group.contains(':') && !group.contains(';') && !rest.is_empty() => {
                !dropped_groups.contains(&group.to_lowercase())
            }
            _ => true,
        })
        .collect();
    Ok(join(&out))
}

/// `N` for a person: family and given names when they are known apart,
/// otherwise the whole name as the given name.
fn n_line(person: &Person) -> String {
    if person.given.is_empty() && person.family.is_empty() {
        return name_line(&person.name);
    }
    format!("N:{};{};;;", escape(&person.family), escape(&person.given))
}

/// An existing `N` with its family and given names replaced, keeping the
/// middle names, prefixes and suffixes this app does not edit.
fn patched_n(raw: &str, person: &Person) -> String {
    if person.given.is_empty() && person.family.is_empty() {
        return name_line(&person.name);
    }
    let parts = super::person::structured_parts(raw);
    let rest: Vec<String> = (2..5).map(|index| parts.get(index).cloned().unwrap_or_default()).collect();
    format!("N:{};{};{}", escape(&person.family), escape(&person.given), rest.join(";"))
}

/// `N` from a single name: the whole of it as the given name. Splitting it
/// into family and given names would be a guess, and a wrong one for most of
/// the world's naming conventions.
fn name_line(name: &str) -> String {
    format!("N:;{};;;", escape(name))
}

fn labelled(property: &str, label: &str, value: &str) -> String {
    let label = label.trim();
    if !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        format!("{property};TYPE={}:{}", label.to_ascii_lowercase(), escape(value.trim()))
    } else {
        format!("{property}:{}", escape(value.trim()))
    }
}

/// A phone number as digits alone, so `+34 600 000 000` and `+34600000000`
/// are the same number.
fn digits(number: &str) -> String {
    number.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect()
}

pub(crate) fn rev(now: i64) -> String {
    chrono::DateTime::from_timestamp(now, 0)
        .unwrap_or_default()
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

/// Escapes a text value: backslash, comma, semicolon and line breaks.
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ',' => out.push_str("\\,"),
            ';' => out.push_str("\\;"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

/// Logical lines, continuations joined.
pub(crate) fn unfold(raw: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        match line.chars().next() {
            Some(' ' | '\t') if !lines.is_empty() => lines.last_mut().expect("checked").push_str(&line[1..]),
            _ if line.is_empty() => {}
            _ => lines.push(line.to_string()),
        }
    }
    lines
}

/// Lines folded at 75 octets, never inside a character, ended with CRLF.
pub(crate) fn join(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines {
        let mut width = 0;
        for ch in line.chars() {
            let size = ch.len_utf8();
            if width + size > 75 {
                out.push_str("\r\n ");
                width = 1;
            }
            out.push(ch);
            width += size;
        }
        out.push_str("\r\n");
    }
    out
}
