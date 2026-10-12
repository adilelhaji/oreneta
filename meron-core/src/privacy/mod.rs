//! Tracking protection with EasyPrivacy (#107, ADR-0029).
//!
//! The network rules of a pinned EasyPrivacy snapshot, matched against every
//! address a message would fetch on its own: images, backgrounds and CSS. A
//! blocked address is never requested; the reader is told how many were
//! blocked and by which rule. Links are left alone: following one is the
//! reader's own act. Nothing here ever contacts a tracker, and the list is
//! only replaced when the person asks, from a fixed source, after it is
//! checked; a failed update keeps the list there was.
//!
//! Only the rule syntax that can apply to mail content is read. Cosmetic
//! rules, regular expressions and options that change requests rather than
//! block them are skipped, and so is any rule limited to a website (mail has
//! none): skipping only ever means not blocking something, never blocking
//! more than the list says.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use anyhow::{bail, Result};
use serde::Serialize;

#[cfg(test)]
mod tests;

/// The snapshot shipped with the app (see README.md for its provenance).
pub const BUNDLED: &str = include_str!("easyprivacy.txt");
/// Where an update may come from, and nowhere else.
pub const UPDATE_URL: &str = "https://easylist.to/easylist/easyprivacy.txt";
/// Bounds on a list that is accepted at all.
pub const MAX_LIST_BYTES: usize = 16 * 1024 * 1024;
pub const MIN_RULES: usize = 1000;

/// What blocked an address: the rule as written, and the list's version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Blocked {
    pub url: String,
    pub rule: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Lit(String),
    Star,
    /// `^`: one separator character, or the end of the address.
    Sep,
}

#[derive(Debug, Clone)]
struct Rule {
    text: String,
    host_anchor: bool,
    start_anchor: bool,
    end_anchor: bool,
    tokens: Vec<Token>,
    important: bool,
}

#[derive(Debug, Default)]
pub struct FilterSet {
    pub version: String,
    pub title: String,
    rules: Vec<Rule>,
    blocks_by_host: HashMap<String, Vec<u32>>,
    blocks_generic: Vec<u32>,
    allows_by_host: HashMap<String, Vec<u32>>,
    allows_generic: Vec<u32>,
}

/// The request types a rule names, and whether an image (all mail fetches
/// are images or media, which EasyPrivacy files under image) is one of them.
fn applies_to_mail(options: &str) -> Option<bool> {
    let mut important = false;
    let mut types = Vec::new();
    let mut negated_types = Vec::new();
    for option in options.split(',').map(str::trim).filter(|o| !o.is_empty()) {
        let (negated, name) = match option.strip_prefix('~') {
            Some(rest) => (true, rest),
            None => (false, option),
        };
        let (name, value) = name.split_once('=').unwrap_or((name, ""));
        match name.to_ascii_lowercase().as_str() {
            "image" | "media" | "other" | "ping" | "beacon" | "xmlhttprequest" | "xhr" | "script" | "stylesheet" | "css"
            | "subdocument" | "frame" | "font" | "object" | "websocket" | "document" | "doc" | "popup" => {
                if negated {
                    negated_types.push(name.to_ascii_lowercase());
                } else {
                    types.push(name.to_ascii_lowercase());
                }
            }
            "third-party" | "3p" if !negated => {}
            // A first-party-only rule: mail has no first party.
            "third-party" | "3p" | "first-party" | "1p" => return None,
            "domain" | "from" => {
                // Limited to some websites: never a mail message. Only
                // exclusions (`~site`) leave it applying everywhere else.
                if value.split('|').any(|d| !d.starts_with('~')) {
                    return None;
                }
            }
            "match-case" => {}
            "important" => important = true,
            // Anything that rewrites, redirects or otherwise does more than
            // block is skipped.
            _ => return None,
        }
    }
    let image_ok = (types.is_empty() || types.iter().any(|t| t == "image" || t == "media" || t == "other"))
        && !negated_types.iter().any(|t| t == "image");
    image_ok.then_some(important)
}

fn tokens_of(pattern: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut literal = String::new();
    for c in pattern.chars() {
        match c {
            '*' | '^' => {
                if !literal.is_empty() {
                    tokens.push(Token::Lit(std::mem::take(&mut literal)));
                }
                tokens.push(if c == '*' { Token::Star } else { Token::Sep });
            }
            c => literal.extend(c.to_lowercase()),
        }
    }
    if !literal.is_empty() {
        tokens.push(Token::Lit(literal));
    }
    tokens
}

/// The host a `||host...` rule is about, for the index.
fn anchored_host(tokens: &[Token]) -> Option<String> {
    match tokens.first() {
        Some(Token::Lit(lit)) => {
            let host: String = lit.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
            let host = host.trim_end_matches('.').to_string();
            (!host.is_empty() && host.contains('.')).then_some(host)
        }
        _ => None,
    }
}

fn parse_rule(line: &str) -> Option<(bool, Rule)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
        return None;
    }
    // Cosmetic and scriptlet rules hide page elements; mail has no page.
    if ["##", "#@#", "#?#", "#$#", "#%#", "#+js"].iter().any(|m| line.contains(m)) {
        return None;
    }
    let (exception, body) = match line.strip_prefix("@@") {
        Some(rest) => (true, rest),
        None => (false, line),
    };
    // Regular-expression rules are skipped.
    if body.starts_with('/') && body.len() > 1 && body[1..].contains('/') && !body.starts_with("//") {
        return None;
    }
    let (pattern, options) = match body.rfind('$') {
        Some(at) if !body[at + 1..].contains('/') => (&body[..at], &body[at + 1..]),
        _ => (body, ""),
    };
    let important = applies_to_mail(options)?;
    let (host_anchor, rest) = match pattern.strip_prefix("||") {
        Some(rest) => (true, rest),
        None => (false, pattern),
    };
    let (start_anchor, rest) = match (!host_anchor).then(|| rest.strip_prefix('|')).flatten() {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let (end_anchor, rest) = match rest.strip_suffix('|') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let tokens = tokens_of(rest);
    // A rule of nothing but wildcards would match every address.
    if !tokens.iter().any(|t| matches!(t, Token::Lit(l) if l.len() >= 3)) && !host_anchor {
        return None;
    }
    if tokens.is_empty() {
        return None;
    }
    Some((exception, Rule { text: line.to_string(), host_anchor, start_anchor, end_anchor, tokens, important }))
}

fn is_separator(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '%'))
}

fn match_from(tokens: &[Token], url: &str, at: usize, end_anchor: bool) -> bool {
    let Some((first, rest)) = tokens.split_first() else {
        return !end_anchor || at == url.len();
    };
    match first {
        Token::Lit(lit) => url[at..].starts_with(lit.as_str()) && match_from(rest, url, at + lit.len(), end_anchor),
        Token::Sep => {
            if at == url.len() {
                return match_from(rest, url, at, end_anchor);
            }
            let c = url[at..].chars().next().expect("not at the end");
            is_separator(c) && match_from(rest, url, at + c.len_utf8(), end_anchor)
        }
        Token::Star => {
            let mut i = at;
            loop {
                if match_from(rest, url, i, end_anchor) {
                    return true;
                }
                match url[i..].chars().next() {
                    Some(c) => i += c.len_utf8(),
                    None => return false,
                }
            }
        }
    }
}

/// Where in the address a `||` rule may start: the host, or any of its
/// parent domains.
fn host_starts(url: &str) -> Vec<usize> {
    let Some(scheme_end) = url.find("://") else { return Vec::new() };
    let start = scheme_end + 3;
    let host_end = url[start..].find(|c: char| matches!(c, '/' | '?' | '#' | ':')).map(|e| start + e).unwrap_or(url.len());
    let mut starts = vec![start];
    for (i, c) in url[start..host_end].char_indices() {
        if c == '.' {
            starts.push(start + i + 1);
        }
    }
    starts
}

impl Rule {
    fn matches(&self, url: &str) -> bool {
        if self.host_anchor {
            return host_starts(url).into_iter().any(|at| match_from(&self.tokens, url, at, self.end_anchor));
        }
        if self.start_anchor {
            return match_from(&self.tokens, url, 0, self.end_anchor);
        }
        // Start where the first literal could, rather than everywhere.
        match self.tokens.first() {
            Some(Token::Lit(lit)) => url.match_indices(lit.as_str()).any(|(at, _)| match_from(&self.tokens, url, at, self.end_anchor)),
            _ => (0..=url.len()).filter(|i| url.is_char_boundary(*i)).any(|at| match_from(&self.tokens, url, at, self.end_anchor)),
        }
    }
}

fn host_of(url: &str) -> &str {
    let Some(scheme_end) = url.find("://") else { return "" };
    let rest = &url[scheme_end + 3..];
    let end = rest.find(|c: char| matches!(c, '/' | '?' | '#' | ':')).unwrap_or(rest.len());
    let host = &rest[..end];
    host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host)
}

impl FilterSet {
    pub fn parse(text: &str) -> Self {
        let mut set = FilterSet::default();
        for line in text.lines() {
            if let Some(version) = line.strip_prefix("! Version:") {
                set.version = version.trim().to_string();
                continue;
            }
            if let Some(title) = line.strip_prefix("! Title:") {
                set.title = title.trim().to_string();
                continue;
            }
            let Some((exception, rule)) = parse_rule(line) else { continue };
            let index = set.rules.len() as u32;
            let host = rule.host_anchor.then(|| anchored_host(&rule.tokens)).flatten();
            let (by_host, generic) = if exception {
                (&mut set.allows_by_host, &mut set.allows_generic)
            } else {
                (&mut set.blocks_by_host, &mut set.blocks_generic)
            };
            match host {
                Some(host) => by_host.entry(host).or_default().push(index),
                None => generic.push(index),
            }
            set.rules.push(rule);
        }
        set
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    fn first_match<'a>(&'a self, url: &str, by_host: &HashMap<String, Vec<u32>>, generic: &[u32]) -> Option<&'a Rule> {
        let host = host_of(url);
        let mut candidates: Vec<u32> = Vec::new();
        let mut rest = host;
        loop {
            if let Some(list) = by_host.get(rest) {
                candidates.extend(list);
            }
            match rest.split_once('.') {
                Some((_, parent)) if parent.contains('.') => rest = parent,
                _ => break,
            }
        }
        candidates.extend(generic);
        candidates.into_iter().map(|i| &self.rules[i as usize]).find(|rule| rule.matches(url))
    }

    /// The rule that blocks an address, unless an exception lets it through.
    pub fn blocking_rule(&self, url: &str) -> Option<&str> {
        let lower = url.trim().to_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//")) {
            return None;
        }
        let lower = if lower.starts_with("//") { format!("https:{lower}") } else { lower };
        let block = self.first_match(&lower, &self.blocks_by_host, &self.blocks_generic)?;
        if !block.important && self.first_match(&lower, &self.allows_by_host, &self.allows_generic).is_some() {
            return None;
        }
        Some(&block.text)
    }
}

// ---- Per-message exceptions ----------------------------------------------------

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tracker_exceptions (
  account    TEXT NOT NULL,
  message_id TEXT NOT NULL,   -- lower case, no angle brackets
  PRIMARY KEY (account, message_id)
);
";

fn exception_key(message_id: &str) -> String {
    message_id.trim().trim_start_matches('<').trim_end_matches('>').to_lowercase()
}

/// Whether trackers are blocked in this message: always, unless the person
/// let this one message load them. A message without a Message-ID cannot be
/// excepted, so it is always protected.
pub fn protects(conn: &rusqlite::Connection, account: &str, message_id: &str) -> bool {
    let key = exception_key(message_id);
    if key.is_empty() {
        return true;
    }
    !conn
        .prepare("SELECT 1 FROM tracker_exceptions WHERE account = ?1 AND message_id = ?2")
        .and_then(|mut stmt| stmt.exists(rusqlite::params![account, key]))
        .unwrap_or(false)
}

/// Lets one message load what the list blocks, or takes that back.
pub fn set_exception(conn: &rusqlite::Connection, account: &str, message_id: &str, allow: bool) -> Result<()> {
    let key = exception_key(message_id);
    if key.is_empty() {
        bail!("this message has no Message-ID, so it cannot be told apart from others");
    }
    if allow {
        conn.execute(
            "INSERT OR IGNORE INTO tracker_exceptions(account, message_id) VALUES(?1, ?2)",
            rusqlite::params![account, key],
        )?;
    } else {
        conn.execute(
            "DELETE FROM tracker_exceptions WHERE account = ?1 AND message_id = ?2",
            rusqlite::params![account, key],
        )?;
    }
    Ok(())
}

// ---- Which list is in use ----------------------------------------------------

fn active() -> &'static RwLock<Option<Arc<FilterSet>>> {
    static ACTIVE: OnceLock<RwLock<Option<Arc<FilterSet>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| RwLock::new(None))
}

/// The list in use: an update the person fetched, when there is a valid one
/// on disk, else the bundled snapshot. Parsed once.
pub fn current() -> Arc<FilterSet> {
    if let Some(set) = active().read().unwrap().as_ref() {
        return set.clone();
    }
    let mut slot = active().write().unwrap();
    if let Some(set) = slot.as_ref() {
        return set.clone();
    }
    let set = Arc::new(
        stored_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| validate(&text).ok())
            .unwrap_or_else(|| FilterSet::parse(BUNDLED)),
    );
    *slot = Some(set.clone());
    set
}

fn stored_path() -> Option<std::path::PathBuf> {
    Some(crate::store::app_dir().join("filters").join("easyprivacy.txt"))
}

/// Whether a downloaded list is one to use: the right list, of a sane size,
/// with enough rules that read.
pub fn validate(text: &str) -> Result<FilterSet> {
    if text.len() > MAX_LIST_BYTES {
        bail!("the list is larger than any EasyPrivacy list ({} MB)", MAX_LIST_BYTES / 1024 / 1024);
    }
    if !text.trim_start().starts_with("[Adblock Plus") {
        bail!("this is not a filter list");
    }
    let set = FilterSet::parse(text);
    if set.title != "EasyPrivacy" {
        bail!("this is not EasyPrivacy");
    }
    if set.rule_count() < MIN_RULES {
        bail!("the list has too few rules to be complete ({})", set.rule_count());
    }
    Ok(set)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInfo {
    pub title: String,
    pub version: String,
    pub rules: usize,
    /// "bundled" or "updated".
    pub source: String,
}

pub fn info() -> ListInfo {
    let set = current();
    let updated = stored_path().is_some_and(|p| p.exists());
    ListInfo {
        title: set.title.clone(),
        version: set.version.clone(),
        rules: set.rule_count(),
        source: if updated { "updated" } else { "bundled" }.into(),
    }
}

/// Installs a list fetched by the caller (only ever from [`UPDATE_URL`]):
/// checked first, written beside the old one and renamed over it, then made
/// the one in use. Any failure leaves the list there was.
pub fn install(text: &str, dir: &std::path::Path) -> Result<ListInfo> {
    let set = validate(text)?;
    std::fs::create_dir_all(dir)?;
    let part = dir.join("easyprivacy.txt.part");
    std::fs::write(&part, text)?;
    std::fs::rename(&part, dir.join("easyprivacy.txt"))?;
    let info = ListInfo { title: set.title.clone(), version: set.version.clone(), rules: set.rule_count(), source: "updated".into() };
    *active().write().unwrap() = Some(Arc::new(set));
    Ok(info)
}

/// Goes back to the bundled snapshot.
pub fn reset(dir: &std::path::Path) -> Result<()> {
    let path = dir.join("easyprivacy.txt");
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    *active().write().unwrap() = Some(Arc::new(FilterSet::parse(BUNDLED)));
    Ok(())
}

pub fn filters_dir() -> Result<std::path::PathBuf> {
    Ok(crate::store::app_dir().join("filters"))
}

// ---- Rewriting a message's fetches ---------------------------------------------

/// An image that loads nothing: what a blocked image becomes.
pub const BLANK_IMAGE: &str = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/// Undoes CSS escapes (`\68` or `\h`), so an escaped address is read as the
/// browser would read it.
fn css_unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let mut hex = String::new();
        while hex.len() < 6 && chars.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
            hex.push(chars.next().expect("peeked"));
        }
        if hex.is_empty() {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            if chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
            if let Some(decoded) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                out.push(decoded);
            }
        }
    }
    out
}

/// Replaces the addresses a style sheet would fetch that the list blocks.
pub fn rewrite_css(css: &str, set: &FilterSet, blocked: &mut Vec<Blocked>) -> String {
    let lower = css.to_ascii_lowercase();
    let mut out = String::with_capacity(css.len());
    let mut i = 0;
    while i < css.len() {
        let next_url = lower[i..].find("url(").map(|p| (i + p, 4));
        let next_import = lower[i..].find("@import").map(|p| (i + p, 7));
        let Some((at, skip)) = [next_url, next_import].into_iter().flatten().min_by_key(|(p, _)| *p) else {
            out.push_str(&css[i..]);
            break;
        };
        out.push_str(&css[i..at + skip]);
        let mut j = at + skip;
        while j < css.len() && css[j..].starts_with(char::is_whitespace) {
            j += 1;
        }
        // `@import url(...)`: the `url(` that follows is read on its own.
        if skip == 7 && css[j..].to_ascii_lowercase().starts_with("url(") {
            out.push_str(&css[at + skip..j]);
            i = j;
            continue;
        }
        let quote = css[j..].chars().next().filter(|c| *c == '"' || *c == '\'');
        let (value_start, value_end, after) = match quote {
            Some(q) => {
                let start = j + 1;
                let end = css[start..].find(q).map(|e| start + e).unwrap_or(css.len());
                (start, end, (end + 1).min(css.len()))
            }
            None => {
                let end = css[j..].find(|c: char| c == ')' || c == ';' || c.is_whitespace()).map(|e| j + e).unwrap_or(css.len());
                (j, end, end)
            }
        };
        out.push_str(&css[j..value_start]);
        let value = css_unescape(&css[value_start..value_end]);
        match set.blocking_rule(&value) {
            Some(rule) => {
                blocked.push(Blocked { url: value, rule: rule.to_string() });
                out.push_str("data:,");
            }
            None => out.push_str(&css[value_start..value_end]),
        }
        out.push_str(&css[value_end..after]);
        i = after.max(at + skip);
    }
    out
}

/// A `srcset` without the candidates the list blocks.
pub fn rewrite_srcset(srcset: &str, set: &FilterSet, blocked: &mut Vec<Blocked>) -> String {
    srcset
        .split(',')
        .filter(|candidate| {
            let url = candidate.split_whitespace().next().unwrap_or("");
            match set.blocking_rule(url) {
                Some(rule) => {
                    blocked.push(Blocked { url: url.to_string(), rule: rule.to_string() });
                    false
                }
                None => true,
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}
