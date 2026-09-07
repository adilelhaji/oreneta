//! Reading vCards.
//!
//! Every source of contacts in this app speaks vCard or something shaped like
//! it, so this is the one place that turns those bytes into people. It is
//! written to survive real address books rather than the examples in the
//! specification: servers still hand out vCard 2.1 with quoted-printable
//! names, Apple writes grouped properties, Google writes `item1.EMAIL`, and
//! plenty of exporters fold lines in the middle of a UTF-8 character.
//!
//! The rule throughout is that a card which cannot be fully understood still
//! yields the parts that were. A `PHOTO` this cannot decode must not cost the
//! reader the person's name and address.

/// One parsed property line: `group.NAME;PARAM=value:the value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Property {
    /// The `item1` in `item1.EMAIL`, empty when there was none.
    pub group: String,
    /// Upper-cased, so callers compare against one spelling.
    pub name: String,
    /// Parameters, names upper-cased, in the order written.
    pub params: Vec<(String, String)>,
    /// The value, unescaped and decoded — what a single-value property means.
    pub value: String,
    /// The value decoded but *not* unescaped.
    ///
    /// Structured properties such as `N` and `ADR` are several values in one,
    /// separated by semicolons, and a component containing a semicolon escapes
    /// it precisely so it is not a separator. Unescaping before splitting
    /// destroys exactly that distinction, so a reader of those fields needs
    /// the value as written and unescapes each component itself.
    pub raw: String,
}

impl Property {
    /// The values of one parameter, split on commas as the format allows.
    pub fn param(&self, name: &str) -> Vec<String> {
        self.params
            .iter()
            .filter(|(key, _)| key == name)
            .flat_map(|(_, value)| value.split(','))
            .map(|part| part.trim().to_string())
            .filter(|part| !part.is_empty())
            .collect()
    }

    /// The `TYPE` values, lower-cased.
    ///
    /// vCard 2.1 writes bare types — `EMAIL;WORK:` rather than
    /// `EMAIL;TYPE=WORK:` — so a parameter with no name of its own counts as
    /// one. Address books in the wild are full of both.
    pub fn types(&self) -> Vec<String> {
        self.params
            .iter()
            .filter(|(key, _)| key == "TYPE" || key.is_empty())
            .flat_map(|(_, value)| value.split(','))
            .map(|part| part.trim().to_lowercase())
            .filter(|part| !part.is_empty())
            .collect()
    }
}

/// Undo the line folding a vCard uses to keep lines short.
///
/// A continuation is a line starting with a space or a tab, and the marker is
/// dropped rather than kept. Done on bytes rather than on characters because a
/// fold is allowed to fall inside a multi-byte character, and splitting the
/// text into `char`s first would already have replaced it with U+FFFD.
fn unfold(input: &[u8]) -> Vec<Vec<u8>> {
    let mut lines: Vec<Vec<u8>> = Vec::new();
    for raw in input.split(|byte| *byte == b'\n') {
        let line = raw.strip_suffix(b"\r").unwrap_or(raw);
        match line.first() {
            Some(b' ' | b'\t') if !lines.is_empty() => {
                lines.last_mut().expect("checked").extend_from_slice(&line[1..]);
            }
            _ => lines.push(line.to_vec()),
        }
    }
    lines
}

/// Split a property line into its name part and its value part.
///
/// The first colon outside a quoted parameter ends the name. Quoting matters:
/// `TEL;TYPE="work,voice":+1` has a colon-free value but a comma inside quotes,
/// and a URL value has colons of its own that are not separators.
fn split_at_value(line: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some((&line[..index], &line[index + 1..])),
            _ => {}
        }
    }
    None
}

/// Split on a separator that is ignored inside quotes.
fn split_unquoted(input: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            _ if ch == separator && !quoted => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    parts.push(current);
    parts
}

/// Strip the quotes a parameter value may be wrapped in.
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

/// Undo the backslash escaping of a value: `\n`, `\,`, `\;`, `\\`.
pub fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            // An unknown escape keeps the character it escaped rather than
            // both: a stray backslash is a mistake, not content.
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Decode quoted-printable, which vCard 2.1 uses for anything non-ASCII.
///
/// Bytes rather than text, because the result is only UTF-8 if the card said
/// so; the caller decides how to read it.
fn decode_quoted_printable(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'=' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        // A trailing `=` is a soft line break: it joins, contributing nothing.
        let hex = bytes.get(index + 1..index + 3);
        match hex.and_then(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
        }) {
            Some(byte) => {
                out.push(byte);
                index += 3;
            }
            None => {
                // Not a valid escape. Kept as written rather than dropped:
                // an `=` in a note is somebody's text.
                out.push(b'=');
                index += 1;
            }
        }
    }
    out
}

/// Read the properties of a card, in the order they appear.
///
/// `BEGIN`, `END` and `VERSION` come through like anything else; a caller that
/// cares can look at them, and dropping them here would mean this could not be
/// used to tell one card's bounds from another's.
pub fn parse_properties(input: &[u8]) -> Vec<Property> {
    let mut properties = Vec::new();

    for line in unfold(input) {
        // Read as UTF-8 where possible and as Latin-1 otherwise, which is what
        // a vCard 2.1 without a charset almost always is. Neither can fail, so
        // a card with one bad byte still yields its other properties.
        let text = match String::from_utf8(line.clone()) {
            Ok(text) => text,
            Err(_) => line.iter().map(|byte| *byte as char).collect(),
        };
        if text.trim().is_empty() {
            continue;
        }
        let Some((head, raw_value)) = split_at_value(&text) else {
            continue;
        };

        let mut parts = split_unquoted(head, ';').into_iter();
        let Some(name_part) = parts.next() else {
            continue;
        };
        let (group, name) = match name_part.split_once('.') {
            Some((group, name)) => (group.trim().to_string(), name.trim().to_string()),
            None => (String::new(), name_part.trim().to_string()),
        };
        if name.is_empty() {
            continue;
        }

        let params: Vec<(String, String)> = parts
            .map(|part| match part.split_once('=') {
                Some((key, value)) => (key.trim().to_uppercase(), unquote(value)),
                // A bare parameter, as vCard 2.1 writes types. Kept with an
                // empty name so `types()` can find it.
                None => (String::new(), part.trim().to_string()),
            })
            .collect();

        let encoded = params.iter().any(|(key, value)| {
            key == "ENCODING" && value.eq_ignore_ascii_case("QUOTED-PRINTABLE")
        });
        let (value, raw) = if encoded {
            let bytes = decode_quoted_printable(raw_value);
            let charset = params
                .iter()
                .find(|(key, _)| key == "CHARSET")
                .map(|(_, value)| value.to_ascii_lowercase())
                .unwrap_or_default();
            // Quoted-printable carries no backslash escaping of its own, so
            // the decoded bytes are both the value and the raw form.
            let decoded: String = if charset.starts_with("iso-8859") || charset == "windows-1252" {
                bytes.iter().map(|byte| *byte as char).collect()
            } else {
                match String::from_utf8(bytes.clone()) {
                    Ok(text) => text,
                    Err(_) => bytes.iter().map(|byte| *byte as char).collect(),
                }
            };
            (decoded.clone(), decoded)
        } else {
            (unescape(raw_value), raw_value.to_string())
        };

        properties.push(Property {
            group,
            name: name.to_uppercase(),
            params,
            value,
            raw,
        });
    }

    properties
}

/// Split a stream that may hold several cards into one property list each.
pub fn split_cards(input: &[u8]) -> Vec<Vec<Property>> {
    let mut cards = Vec::new();
    let mut current: Vec<Property> = Vec::new();
    let mut depth = 0usize;

    for property in parse_properties(input) {
        match property.name.as_str() {
            "BEGIN" if property.value.eq_ignore_ascii_case("VCARD") => {
                depth += 1;
                if depth == 1 {
                    current = Vec::new();
                    continue;
                }
            }
            "END" if property.value.eq_ignore_ascii_case("VCARD") => {
                depth = depth.saturating_sub(1);
                if depth == 0 && !current.is_empty() {
                    cards.push(std::mem::take(&mut current));
                }
                continue;
            }
            _ => {}
        }
        if depth > 0 {
            current.push(property);
        }
    }

    // A card whose END never arrived is still a card. Truncation is a bad
    // reason to lose somebody.
    if !current.is_empty() {
        cards.push(current);
    }
    cards
}
