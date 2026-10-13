//! Contact groups as address books store them (ADR-0052).
//!
//! A CardDAV book has no folders: a group is one more card, and it names
//! its members by their UIDs. There are two ways of writing that in use:
//!
//! - vCard 4 (RFC 6350): `KIND:group` and one `MEMBER:urn:uuid:<uid>` per
//!   person;
//! - Apple's, for vCard 3.0, which has no `KIND`: `X-ADDRESSBOOKSERVER-KIND:group`
//!   and `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<uid>`. iCloud, macOS Contacts,
//!   Nextcloud and most servers that store 3.0 cards speak this one.
//!
//! Both are read. A change is written in the way the card already uses, and
//! like a person's card (ADR-0012) an edit starts from the server's copy and
//! touches only the lines whose meaning changed: a member this app cannot
//! resolve (a `mailto:` member, a UID of a card in another book) and every
//! field it does not know go back exactly as they came.

use anyhow::Result;

use super::vcard::{parse_properties, split_cards, unescape, Property};
use super::vcard_write::{escape, join, rev, unfold};

/// How a group card says it is a group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupStyle {
    /// `KIND:group` and `MEMBER` (vCard 4).
    Vcard4,
    /// `X-ADDRESSBOOKSERVER-KIND:group` and `X-ADDRESSBOOKSERVER-MEMBER` (3.0).
    Apple,
}

impl GroupStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupStyle::Vcard4 => "vcard4",
            GroupStyle::Apple => "apple",
        }
    }

    pub fn parse(value: &str) -> Option<GroupStyle> {
        match value {
            "vcard4" => Some(GroupStyle::Vcard4),
            "apple" => Some(GroupStyle::Apple),
            _ => None,
        }
    }

    fn member_property(self) -> &'static str {
        match self {
            GroupStyle::Vcard4 => "MEMBER",
            GroupStyle::Apple => "X-ADDRESSBOOKSERVER-MEMBER",
        }
    }
}

/// One group card as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCard {
    pub uid: String,
    pub name: String,
    /// The UIDs of the members named by `urn:uuid:`, in the card's order.
    /// Members named any other way stay in the card but are not listed here.
    pub members: Vec<String>,
    pub style: GroupStyle,
}

fn is_kind_group(property: &Property) -> bool {
    matches!(property.name.as_str(), "KIND" | "X-ADDRESSBOOKSERVER-KIND")
        && property.value.trim().eq_ignore_ascii_case("group")
}

/// Whether a card describes a group rather than somebody.
pub fn is_group(properties: &[Property]) -> bool {
    properties.iter().any(is_kind_group)
}

/// The UID a member value names, when it names one by `urn:uuid:`.
///
/// Apple and RFC 6350 both use the URN; a bare value is a UID too in some
/// exports, so a value with no scheme at all is taken as one. A `mailto:` or
/// any other URI is a member this app keeps but cannot resolve.
pub fn member_uid(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() > 9 && value[..9].eq_ignore_ascii_case("urn:uuid:") {
        let uid = value[9..].trim();
        return (!uid.is_empty()).then(|| uid.to_string());
    }
    if value.is_empty() || value.contains(':') {
        return None;
    }
    Some(value.to_string())
}

/// The value a member is written with.
pub fn member_value(uid: &str) -> String {
    format!("urn:uuid:{uid}")
}

/// Read one card as a group, if it is one.
pub fn group_from_properties(properties: &[Property]) -> Option<GroupCard> {
    let kind = properties.iter().find(|property| is_kind_group(property))?;
    let style = if kind.name == "KIND" { GroupStyle::Vcard4 } else { GroupStyle::Apple };
    let mut group = GroupCard { uid: String::new(), name: String::new(), members: Vec::new(), style };
    let mut structured = String::new();
    for property in properties {
        match property.name.as_str() {
            "UID" => group.uid = property.value.trim().to_string(),
            "FN" if group.name.is_empty() => group.name = property.value.trim().to_string(),
            // Apple writes the group's name as the family name too.
            "N" if structured.is_empty() => {
                structured = property.raw.split(';').next().map(unescape).unwrap_or_default().trim().to_string()
            }
            "MEMBER" | "X-ADDRESSBOOKSERVER-MEMBER" => {
                if let Some(uid) = member_uid(&property.value) {
                    if !group.members.contains(&uid) {
                        group.members.push(uid);
                    }
                }
            }
            _ => {}
        }
    }
    if group.name.is_empty() {
        group.name = structured;
    }
    Some(group)
}

/// Every group in a stream of cards.
pub fn groups_from_vcards(input: &[u8]) -> Vec<GroupCard> {
    split_cards(input).iter().filter_map(|properties| group_from_properties(properties)).collect()
}

/// The `VERSION` a card declares, empty when it declares none.
pub fn card_version(properties: &[Property]) -> String {
    properties
        .iter()
        .find(|property| property.name == "VERSION")
        .map(|property| property.value.trim().to_string())
        .unwrap_or_default()
}

/// The style a new group in a book should use: the one its groups already
/// use; otherwise vCard 4 when its cards are 4.0, else Apple's for 3.0.
pub fn style_for_book(group_styles: &[GroupStyle], card_versions: &[String]) -> GroupStyle {
    if let Some(style) = group_styles.first() {
        return *style;
    }
    if card_versions.iter().any(|version| version.starts_with('4')) {
        GroupStyle::Vcard4
    } else {
        GroupStyle::Apple
    }
}

/// A new group card.
pub fn new_group_card(name: &str, uid: &str, members: &[String], style: GroupStyle) -> String {
    let mut lines = vec!["BEGIN:VCARD".to_string()];
    match style {
        GroupStyle::Vcard4 => {
            lines.push("VERSION:4.0".to_string());
            lines.push("KIND:group".to_string());
        }
        GroupStyle::Apple => lines.push("VERSION:3.0".to_string()),
    }
    lines.push(format!("UID:{}", escape(uid)));
    lines.push(format!("FN:{}", escape(name)));
    // 3.0 requires N; Apple puts the group's name in it.
    if style == GroupStyle::Apple {
        lines.push(format!("N:{};;;;", escape(name)));
        lines.push("X-ADDRESSBOOKSERVER-KIND:group".to_string());
    }
    for uid in members {
        lines.push(format!("{}:{}", style.member_property(), member_value(uid)));
    }
    lines.push("END:VCARD".to_string());
    join(&lines)
}

/// The group card as the server holds it with its name set to `name`, the
/// members in `add` added and those in `remove` taken out. Everything else —
/// unknown fields, members this app cannot resolve, the order of the lines —
/// is kept.
pub fn patch_group_card(raw: &str, name: &str, add: &[String], remove: &[String], now: i64) -> Result<String> {
    let Some(card) = split_cards(raw.as_bytes()).into_iter().next() else {
        anyhow::bail!("the server's copy of this group is not a vCard");
    };
    let Some(before) = group_from_properties(&card) else {
        anyhow::bail!("the server's copy of this card is not a group any more");
    };
    let name_changed = before.name != name;
    // Added in the way the card already names its members, which for a card
    // with members of both kinds is the kind its KIND line says.
    let member_property = before.style.member_property();

    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut had_fn = false;
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
                if !had_fn {
                    out.push(format!("FN:{}", escape(name)));
                }
                for uid in add {
                    if !seen.contains(uid) && !remove.contains(uid) {
                        out.push(format!("{member_property}:{}", member_value(uid)));
                        seen.push(uid.clone());
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
        match property.name.as_str() {
            "FN" if !had_fn => {
                had_fn = true;
                out.push(if name_changed { format!("FN:{}", escape(name)) } else { line });
            }
            "N" if name_changed => {
                // Only the part that held the name changes.
                let rest = property.raw.split_once(';').map(|(_, rest)| rest).unwrap_or(";;;");
                out.push(format!("N:{};{rest}", escape(name)));
            }
            "MEMBER" | "X-ADDRESSBOOKSERVER-MEMBER" => match member_uid(&property.value) {
                Some(uid) if remove.contains(&uid) => {}
                Some(uid) => {
                    // The same member twice is still one member.
                    if !seen.contains(&uid) {
                        seen.push(uid);
                        out.push(line);
                    }
                }
                None => out.push(line),
            },
            "REV" => out.push(format!("REV:{}", rev(now))),
            _ => out.push(line),
        }
    }
    Ok(join(&out))
}
