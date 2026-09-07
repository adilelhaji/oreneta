//! Reading what someone typed into the search box.
//!
//! A search is a sentence with a few named parts — `from:ann invoice` — and
//! everything downstream needs the same reading of it: the local index, the
//! live IMAP search, and the interface that shows what is being searched for.
//! Parsing it once here is what stops those three drifting into three slightly
//! different answers to the same question.
//!
//! Anything that is not a recognised operator stays free text, deliberately.
//! `http://example.com/a:b` is a thing people paste into a search box, and a
//! parser that swallowed `example.com/a` as an unknown field would lose it.

use serde::Serialize;

#[cfg(test)]
mod tests;

/// A field a term can be matched against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    From,
    To,
    Subject,
}

/// What a message must be for, beyond the words in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Flag {
    Unread,
    Read,
    Starred,
    HasAttachment,
}

/// One typed search, as the box was read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Words with no operator, joined as one phrase — the search as it always
    /// was when nobody types an operator at all.
    pub text: String,
    /// Terms per field. Several of one field mean *any of them*: someone who
    /// writes `from:ann from:bob` means either, and reading it as "both" would
    /// answer nothing, every time, for a query that looks perfectly sensible.
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub subject: Vec<String>,
    pub flags: Vec<Flag>,
    /// A local label's name, resolved to an id by the caller that knows them.
    pub label: Option<String>,
    /// Unix seconds; `after` is inclusive of the day, `before` exclusive.
    pub after: Option<i64>,
    pub before: Option<i64>,
}

impl Query {
    /// Whether this asks for anything at all.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
            && self.from.is_empty()
            && self.to.is_empty()
            && self.subject.is_empty()
            && self.flags.is_empty()
            && self.label.is_none()
            && self.after.is_none()
            && self.before.is_none()
    }

    /// Whether anything here has to be answered from the local store.
    ///
    /// Labels live only in this install, so a search naming one cannot be
    /// pushed to a server: the server would answer without it and quietly
    /// return the wrong set.
    pub fn needs_local_only(&self) -> bool {
        self.label.is_some()
    }

    /// Whether a server's answer still needs narrowing here before it is shown.
    ///
    /// A local label is one reason. So is `has:attachment` on a server that is
    /// not Gmail: IMAP has no key for it, so the server answers a wider
    /// question than was asked and the difference has to be made up locally.
    pub fn needs_local_check(&self, gmail: bool) -> bool {
        self.label.is_some() || (!gmail && self.flags.contains(&Flag::HasAttachment))
    }

    pub fn terms_for(&self, field: Field) -> &[String] {
        match field {
            Field::From => &self.from,
            Field::To => &self.to,
            Field::Subject => &self.subject,
        }
    }
}

/// Splits a query into words, keeping quoted runs whole.
///
/// `from:"Ann Example" invoice` is three characters of syntax away from being
/// unusable, so the quotes have to survive being attached to an operator.
fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in input.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// A `YYYY-MM-DD` day as Unix seconds at UTC midnight.
///
/// Only this one shape. A search box that guessed at `03/04` would be reading
/// a different day for an American and a European, and being wrong about
/// which mail someone is shown is not worth the convenience.
fn parse_day(value: &str) -> Option<i64> {
    let mut parts = value.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days since the epoch, by the civil-calendar algorithm the store already
    // uses for IMAP dates (Howard Hinnant's `days_from_civil`).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400)
}

/// Reads a search box.
///
/// Unknown operators, and anything with a colon that is not one, fall through
/// to the free text — where a URL, a time, or a Message-ID belongs.
pub fn parse(input: &str) -> Query {
    let mut query = Query::default();
    let mut words: Vec<String> = Vec::new();

    for token in tokenize(input) {
        let Some((name, value)) = token.split_once(':') else {
            words.push(token);
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            // `from:` with nothing after it is someone mid-thought, not a
            // search for everything from nobody.
            continue;
        }
        let lowered = name.to_ascii_lowercase();
        match lowered.as_str() {
            "from" => query.from.push(value.to_string()),
            "to" => query.to.push(value.to_string()),
            "subject" => query.subject.push(value.to_string()),
            "label" => query.label = Some(value.to_string()),
            "has" if value.eq_ignore_ascii_case("attachment") => {
                query.flags.push(Flag::HasAttachment)
            }
            "is" if value.eq_ignore_ascii_case("unread") => query.flags.push(Flag::Unread),
            "is" if value.eq_ignore_ascii_case("read") => query.flags.push(Flag::Read),
            "is" if value.eq_ignore_ascii_case("starred") => query.flags.push(Flag::Starred),
            "after" | "since" => match parse_day(value) {
                Some(at) => query.after = Some(at),
                // An unreadable date is kept as text rather than dropped: the
                // reader gets no results and can see why, instead of getting
                // every message and wondering what happened to their filter.
                None => words.push(token.clone()),
            },
            "before" | "until" => match parse_day(value) {
                Some(at) => query.before = Some(at),
                None => words.push(token.clone()),
            },
            _ => words.push(token.clone()),
        }
    }

    query.text = words.join(" ");
    query
}

/// What the search box is asking for, in words, for the interface to show.
///
/// So a reader who typed something with a typo can see how it was read — the
/// difference between a search that found nothing and a search that was
/// understood differently from how it was meant.
pub fn describe(query: &Query) -> Vec<String> {
    let mut parts = Vec::new();
    if !query.text.is_empty() {
        parts.push(format!("text:{}", query.text));
    }
    for (label, terms) in [
        ("from", &query.from),
        ("to", &query.to),
        ("subject", &query.subject),
    ] {
        if !terms.is_empty() {
            parts.push(format!("{label}:{}", terms.join("|")));
        }
    }
    for flag in &query.flags {
        parts.push(
            match flag {
                Flag::Unread => "is:unread",
                Flag::Read => "is:read",
                Flag::Starred => "is:starred",
                Flag::HasAttachment => "has:attachment",
            }
            .to_string(),
        );
    }
    if let Some(label) = &query.label {
        parts.push(format!("label:{label}"));
    }
    if let Some(at) = query.after {
        parts.push(format!("after:{at}"));
    }
    if let Some(at) = query.before {
        parts.push(format!("before:{at}"));
    }
    parts
}
