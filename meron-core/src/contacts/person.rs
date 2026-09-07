//! Turning a card's properties into a person.
//!
//! Separate from the parsing so the two can be wrong independently: the parser
//! is about a file format, this is about what an address book means. Google,
//! Exchange and a hand-typed contact all end up as one of these too, which is
//! the point — the rest of the app knows about people, not about vCard.

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::vcard::{unescape, Property};

/// One address on a person, with whatever the card called it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAddress {
    /// Lower-cased: it is the identity two sources are matched on.
    pub addr: String,
    /// "work", "home", or whatever the book said. Empty when it said nothing.
    pub label: String,
}

/// One telephone number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneNumber {
    pub number: String,
    pub label: String,
}

/// A picture of somebody, in whichever of the two shapes a card can carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum Photo {
    /// The bytes, with the type the card claimed (empty when it claimed none).
    Bytes { mime: String, data: Vec<u8> },
    /// Somewhere to fetch it from.
    Url(String),
}

/// Somebody in an address book.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    /// The book's own identifier for them, used so a re-sync updates in place.
    pub uid: String,
    pub name: String,
    pub organisation: String,
    pub note: String,
    pub emails: Vec<EmailAddress>,
    pub phones: Vec<PhoneNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photo: Option<Photo>,
}

impl Person {
    /// Whether there is enough here to be worth keeping.
    ///
    /// A card with neither a name nor an address is a row that can never be
    /// found, shown or written to. Storing it would only make the book longer.
    pub fn is_useful(&self) -> bool {
        !self.name.trim().is_empty() || !self.emails.is_empty()
    }
}

/// Apple writes its own labels wrapped in a marker: `_$!<Work>!$_`.
fn strip_apple_label(value: &str) -> String {
    let trimmed = value.trim();
    trimmed
        .strip_prefix("_$!<")
        .and_then(|rest| rest.strip_suffix(">!$_"))
        .unwrap_or(trimmed)
        .to_string()
}

/// The label for a property: what the book called it, in the reader's words.
///
/// A grouped property may have its real name in a sibling `X-ABLabel`, which
/// is how Apple and anything speaking to iCloud writes "Work" or a custom
/// label. That wins over the generic TYPE, because it is the more specific
/// thing somebody actually typed.
fn label_for(property: &Property, all: &[Property]) -> String {
    if !property.group.is_empty() {
        let sibling = all.iter().find(|other| {
            other.group == property.group && other.name == "X-ABLABEL" && !other.value.trim().is_empty()
        });
        if let Some(sibling) = sibling {
            return strip_apple_label(&sibling.value);
        }
    }
    // "pref" and "internet" say how to use the address, not what it is for.
    property
        .types()
        .into_iter()
        .find(|kind| !matches!(kind.as_str(), "pref" | "internet" | "voice"))
        .unwrap_or_default()
}

/// Build a name out of the structured `N` field: family;given;middle;prefix;suffix.
///
/// Only reached when the card has no `FN`, which is required from vCard 3.0 on
/// but routinely missing from what 2.1 exporters produce.
fn name_from_structured(value: &str) -> String {
    // Split on unescaped semicolons, then unescape each component: a surname
    // containing a semicolon is escaped precisely so it is not a separator.
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ';' => parts.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    parts.push(current);
    let field = |index: usize| parts.get(index).map(|part| unescape(part)).unwrap_or_default();

    // Prefix, given, middle, family, suffix — the order somebody is addressed
    // in, which is not the order the field stores them in.
    [field(3), field(1), field(2), field(0), field(4)]
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Read a photo property, whichever way the card chose to carry one.
fn photo_from(property: &Property) -> Option<Photo> {
    let value = property.value.trim();
    if value.is_empty() {
        return None;
    }

    let declared_mime = || {
        property
            .param("TYPE")
            .into_iter()
            .find(|kind| !kind.eq_ignore_ascii_case("pref"))
            .map(|kind| {
                if kind.contains('/') {
                    kind.to_lowercase()
                } else {
                    format!("image/{}", kind.to_lowercase())
                }
            })
            .unwrap_or_default()
    };

    // vCard 4.0: the whole thing is a data URI.
    if let Some(rest) = value.strip_prefix("data:") {
        let (meta, payload) = rest.split_once(',')?;
        if !meta.contains("base64") {
            return None;
        }
        let mime = meta.split(';').next().unwrap_or_default().to_lowercase();
        let data = base64::engine::general_purpose::STANDARD
            .decode(payload.trim().replace(['\r', '\n', ' '], ""))
            .ok()?;
        return Some(Photo::Bytes { mime, data });
    }

    // vCard 2.1 and 3.0: an ENCODING parameter and bare base64.
    let encoded = property.params.iter().any(|(key, value)| {
        key == "ENCODING" && (value.eq_ignore_ascii_case("b") || value.eq_ignore_ascii_case("base64"))
    });
    if encoded {
        let data = base64::engine::general_purpose::STANDARD
            .decode(value.replace(['\r', '\n', ' '], ""))
            .ok()?;
        return Some(Photo::Bytes {
            mime: declared_mime(),
            data,
        });
    }

    // Otherwise it is somewhere to fetch it from — but only over http(s). A
    // card is a file from elsewhere, and `file:` in one is either a mistake or
    // an attempt to make this app read a local path on its behalf.
    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(Photo::Url(value.to_string()));
    }
    None
}

/// Read one card's properties as a person.
///
/// Everything is optional. A card with only an address becomes a person with
/// only an address, because that is what the book holds and inventing the rest
/// would be worse than showing what is there.
pub fn person_from_properties(properties: &[Property]) -> Person {
    let mut person = Person::default();
    let mut structured_name = String::new();
    let mut seen: Vec<String> = Vec::new();

    for property in properties {
        match property.name.as_str() {
            "UID" => person.uid = property.value.trim().to_string(),
            "FN" if person.name.is_empty() => person.name = property.value.trim().to_string(),
            "N" if structured_name.is_empty() => structured_name = property.raw.clone(),
            "ORG" if person.organisation.is_empty() => {
                // ORG is a hierarchy — company;department — and the first part
                // is the answer to "who do they work for".
                person.organisation = property
                    .value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string();
            }
            "NOTE" if person.note.is_empty() => person.note = property.value.trim().to_string(),
            "EMAIL" => {
                let addr = property.value.trim().to_lowercase();
                // A card may list the same address twice under two labels; it
                // is still one way to reach them.
                if !addr.is_empty() && !seen.contains(&addr) {
                    seen.push(addr.clone());
                    person.emails.push(EmailAddress {
                        addr,
                        label: label_for(property, properties),
                    });
                }
            }
            "TEL" => {
                let number = property.value.trim().to_string();
                if !number.is_empty() {
                    person.phones.push(PhoneNumber {
                        number,
                        label: label_for(property, properties),
                    });
                }
            }
            "PHOTO" if person.photo.is_none() => person.photo = photo_from(property),
            _ => {}
        }
    }

    if person.name.is_empty() && !structured_name.is_empty() {
        person.name = name_from_structured(&structured_name);
    }
    // Still nothing to call them by: the address is a name of sorts, and it is
    // better than a blank row in a list.
    if person.name.is_empty() {
        if let Some(first) = person.emails.first() {
            person.name = first.addr.clone();
        }
    }

    person
}

/// Read a stream of cards as people, keeping only those worth keeping.
pub fn people_from_vcards(input: &[u8]) -> Vec<Person> {
    super::vcard::split_cards(input)
        .iter()
        .map(|properties| person_from_properties(properties))
        .filter(Person::is_useful)
        .collect()
}
