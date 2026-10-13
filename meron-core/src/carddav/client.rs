//! Finding an address book on a server and reading it.
//!
//! The awkward part of CardDAV is not the format, it is getting from what a
//! person types — an email address, a host name, a URL somebody sent them —
//! to the collection their contacts are actually in. That is three or four
//! requests through a chain of properties, each of which real servers get
//! subtly differently, and it is the part worth having under test.
//!
//! So the requests go through a [`Transport`]. In the app that is HTTP; in the
//! tests it is a table of canned answers, which is how the chain can be
//! exercised against the shapes servers really return without a server.

use anyhow::{anyhow, bail, Context, Result};
use url::Url;

use super::xml::{parse_multistatus, parse_multistatus_complete, DavResponse};
use crate::contacts::person::{people_from_vcards, Person};

/// One request to a DAV server.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DavRequest {
    pub method: &'static str,
    pub url: String,
    /// The `Depth` header, which decides whether children are included.
    pub depth: Option<&'static str>,
    pub body: Option<String>,
    /// Further headers: `If-Match` / `If-None-Match` on a write, and the
    /// `Content-Type` of a card (XML is assumed otherwise).
    pub headers: Vec<(&'static str, String)>,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
    /// Where the request ended up, which is not where it started when the
    /// server redirected — and `.well-known/carddav` exists to redirect.
    pub url: String,
    /// The `ETag` header, when the server sent one: the version of a card.
    pub etag: Option<String>,
}

/// Somewhere to send DAV requests.
pub trait Transport {
    fn send(&self, request: &DavRequest) -> Result<HttpReply>;
}

/// One address book on a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressBook {
    /// Absolute URL of the collection.
    pub url: String,
    /// What the server calls it, or a name derived from the URL.
    pub name: String,
    /// The server's cheap "has anything changed" token, when it offers one.
    pub ctag: String,
}

const PROP_PRINCIPAL: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;

const PROP_HOME_SET: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><card:addressbook-home-set/></d:prop></d:propfind>"#;

const PROP_BOOKS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><d:resourcetype/><d:displayname/><cs:getctag/></d:prop></d:propfind>"#;

const REPORT_CARDS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>"#;

const PROP_HREFS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>"#;

/// Turn what someone typed into somewhere to start looking.
///
/// An email address means the domain it is at; a bare host means that host
/// over TLS. Both then go to `.well-known/carddav`, which exists precisely so
/// that a person does not have to know their provider's DAV path. A full URL
/// is taken as given: somebody who pasted one knows better than this does.
pub fn starting_point(input: &str) -> Result<String> {
    starting_point_for(input, "/.well-known/carddav")
}

/// [`starting_point`] for another DAV service: CalDAV starts at
/// `.well-known/caldav`.
pub fn starting_point_for(input: &str, well_known: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("no server given"));
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let parsed = Url::parse(trimmed).context("that does not look like a URL")?;
        return Ok(parsed.to_string());
    }
    let host = match trimmed.rsplit_once('@') {
        Some((_, domain)) => domain,
        None => trimmed,
    };
    // Only the host part: a typed "example.com/dav" keeps its path.
    let url = Url::parse(&format!("https://{host}")).context("that does not look like a server")?;
    Ok(url.join(well_known)?.to_string())
}

/// Resolve an href from a response against the URL it came from.
pub(crate) fn resolve(base: &str, href: &str) -> Result<String> {
    Ok(Url::parse(base)?.join(href.trim())?.to_string())
}

/// Whether the reader's password may go from `from` to `to`.
///
/// Every request carries it, so following a server's href is handing the
/// password to wherever the href points. Never from HTTPS down to plain
/// HTTP, where anyone on the way can read it; and to another host only over
/// HTTPS, which is how providers that split DAV across hosts (iCloud's
/// numbered partitions) are reached at all. A plain-HTTP server — a local
/// one, typed in by the reader — keeps its own origin and no other.
pub fn credentials_may_follow(from: &str, to: &str) -> bool {
    let (Ok(from), Ok(to)) = (Url::parse(from), Url::parse(to)) else {
        return false;
    };
    if from.scheme() == "https" && to.scheme() != "https" {
        return false;
    }
    if from.origin() == to.origin() {
        return true;
    }
    to.scheme() == "https"
}

/// Resolve an href and check the password may follow it there.
pub(crate) fn resolve_trusted(base: &str, href: &str) -> Result<String> {
    let url = resolve(base, href)?;
    if !credentials_may_follow(base, &url) {
        let host = Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        return Err(anyhow!(
            "the server pointed somewhere the password must not go ({host}); nothing was sent there"
        ));
    }
    Ok(url)
}

/// Whether two URLs name the same origin: scheme, host and port.
pub(crate) fn same_origin(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// Why a book could not be read in full. The caller keeps the last complete
/// copy rather than replacing it with part of one.
fn incomplete(failed: &[String], total: usize) -> anyhow::Error {
    let first = failed.first().cloned().unwrap_or_default();
    anyhow!(
        "{} of {} contacts could not be read (first: {first}); the last complete copy is kept",
        failed.len(),
        total
    )
}

/// Whether a response is the book itself rather than one of its cards.
pub(crate) fn is_the_book(response: &DavResponse, book_url: &str) -> bool {
    let Ok(book) = Url::parse(book_url) else {
        return false;
    };
    let href = response.href.trim();
    let path = Url::parse(href).map(|url| url.path().to_string()).unwrap_or_else(|_| href.to_string());
    path.trim_end_matches('/') == book.path().trim_end_matches('/')
}

/// A name for a book the server did not name.
pub(crate) fn name_from_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|segments| segments.filter(|part| !part.is_empty()).next_back().map(str::to_string))
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Contacts".to_string())
}

/// Send a PROPFIND and read the responses out of it.
pub(crate) fn propfind(
    transport: &dyn Transport,
    url: &str,
    depth: &'static str,
    body: &str,
) -> Result<(Vec<DavResponse>, String)> {
    let reply = transport.send(&DavRequest {
        method: "PROPFIND",
        url: url.to_string(),
        depth: Some(depth),
        body: Some(body.to_string()),
        ..Default::default()
    })?;
    if reply.status == 401 || reply.status == 403 {
        return Err(anyhow!("the server refused those credentials"));
    }
    Ok((parse_multistatus(&reply.body)?, reply.url))
}

/// Find the address books a server holds for whoever is signing in.
///
/// Each step falls back rather than failing: a server that does not answer the
/// principal question may still answer the home-set one, and a URL that is
/// itself a collection needs neither. The one thing that is never done is
/// inventing a path — a book that was not found is reported as not found.
pub fn discover(transport: &dyn Transport, input: &str) -> Result<Vec<AddressBook>> {
    let start = starting_point(input)?;

    // Steps below fall back rather than failing, which would otherwise turn a
    // refused password into "no address book was found" — sending the reader
    // to look for their contacts when the problem is their credentials. The
    // refusal is kept and reported if nothing is found.
    let mut refusal: Option<anyhow::Error> = None;
    let mut remember = |error: anyhow::Error| {
        if refusal.is_none() {
            refusal = Some(error);
        }
    };

    // 1. Who am I, as far as this server is concerned.
    let mut principal = String::new();
    match propfind(transport, &start, "0", PROP_PRINCIPAL) {
        Ok((responses, from)) => {
            for response in &responses {
                if let Some(href) = response.prop_href("current-user-principal") {
                    // An href the password may not follow is a step that
                    // found nothing; the reason is kept for the report.
                    match resolve_trusted(&from, href) {
                        Ok(url) => principal = url,
                        Err(error) => remember(error),
                    }
                    break;
                }
            }
        }
        Err(error) => remember(error),
    }

    // 2. Where their books live. Asked of the principal when there is one, and
    //    of the starting point otherwise — some servers answer either.
    let mut home = String::new();
    for candidate in [principal.as_str(), start.as_str()] {
        if candidate.is_empty() {
            continue;
        }
        match propfind(transport, candidate, "0", PROP_HOME_SET) {
            Ok((responses, from)) => {
                for response in &responses {
                    if let Some(href) = response.prop_href("addressbook-home-set") {
                        // An href the password may not follow is a step that
                        // found nothing; the reason is kept for the report.
                        match resolve_trusted(&from, href) {
                            Ok(url) => home = url,
                            Err(error) => remember(error),
                        }
                        break;
                    }
                }
            }
            Err(error) => remember(error),
        }
        if !home.is_empty() {
            break;
        }
    }

    // 3. The books themselves.
    let mut books = Vec::new();
    let listing_root = if home.is_empty() { start.clone() } else { home };
    match propfind(transport, &listing_root, "1", PROP_BOOKS) {
        Err(error) => remember(error),
        Ok((responses, from)) => for response in responses {
            if !response.is_addressbook() {
                continue;
            }
            // A book the password may not follow to is not offered: adding
            // it would send the password there on the first read.
            let Ok(url) = resolve_trusted(&from, &response.href) else {
                continue;
            };
            books.push(AddressBook {
                name: response
                    .prop("displayname")
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| name_from_url(&url)),
                ctag: response.prop("getctag").unwrap_or_default().to_string(),
                url,
            });
        },
    }

    if books.is_empty() {
        return Err(refusal.unwrap_or_else(|| anyhow!("no address book was found on that server")));
    }
    // Two collections can answer with the same URL when a home set lists
    // itself; the reader should see one book, not two of the same.
    books.dedup_by(|a, b| a.url == b.url);
    Ok(books)
}

/// Read every card in a book.
///
/// Asked for in one REPORT, which is what the format is for. A server that
/// will not answer that is asked the long way instead — list the cards, then
/// fetch them — because some deployments disable the report and their owners
/// still have contacts.
///
/// All or nothing (#28). A card the server failed to send, an answer cut off
/// part-way, a vCard that does not parse, or a card on a host the password
/// must not go to: each makes this an error naming what was missed, and the
/// caller keeps the copy it has. A book that is genuinely empty is an empty
/// success. What is never returned is part of a book presented as all of it,
/// because the caller replaces the local book with whatever this returns.
pub fn fetch_book(transport: &dyn Transport, book_url: &str) -> Result<Vec<Person>> {
    let reply = transport.send(&DavRequest {
        method: "REPORT",
        url: book_url.to_string(),
        depth: Some("1"),
        body: Some(REPORT_CARDS.to_string()),
        ..Default::default()
    })?;

    if reply.status == 401 || reply.status == 403 {
        return Err(anyhow!("the server refused those credentials"));
    }

    if reply.status < 300 {
        let responses = parse_multistatus_complete(&reply.body)?;
        let mut cards: Vec<u8> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        let mut total = 0usize;
        for response in responses.iter().filter(|response| !is_the_book(response, book_url)) {
            total += 1;
            let readable = response
                .prop("address-data")
                .filter(|data| !crate::contacts::vcard::split_cards(data.as_bytes()).is_empty());
            match readable {
                Some(data) => {
                    cards.extend_from_slice(data.as_bytes());
                    cards.push(b'\n');
                }
                None => failed.push(format!(
                    "{} {}",
                    response.href,
                    if response.status.is_empty() { "sent no card" } else { response.status.as_str() }
                )),
            }
        }
        if !failed.is_empty() {
            return Err(incomplete(&failed, total));
        }
        return Ok(people_from_vcards(&cards));
    }

    fetch_book_one_at_a_time(transport, book_url)
}

/// The long way: ask what is in the book, then fetch each card.
fn fetch_book_one_at_a_time(transport: &dyn Transport, book_url: &str) -> Result<Vec<Person>> {
    let reply = transport.send(&DavRequest {
        method: "PROPFIND",
        url: book_url.to_string(),
        depth: Some("1"),
        body: Some(PROP_HREFS.to_string()),
        ..Default::default()
    })?;
    if reply.status == 401 || reply.status == 403 {
        return Err(anyhow!("the server refused those credentials"));
    }
    if reply.status >= 300 {
        return Err(anyhow!("the server would not list the address book (HTTP {})", reply.status));
    }
    let responses = parse_multistatus_complete(&reply.body)?;
    let from = reply.url;

    let mut people = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut total = 0usize;
    for response in responses {
        // The collection lists itself; it is not one of its own cards.
        if is_the_book(&response, book_url) {
            continue;
        }
        if response.resource_types.iter().any(|kind| kind == "collection") {
            continue;
        }
        total += 1;
        let url = resolve(&from, &response.href)?;
        // A card is fetched from the book's own origin and nowhere else: an
        // href elsewhere is not one of this book's cards, and following it
        // would hand the password to whoever it names.
        if !same_origin(&url, book_url) {
            return Err(anyhow!(
                "the address book listed a card on another server ({}); nothing was sent there and the last complete copy is kept",
                Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
            ));
        }
        let reply = transport.send(&DavRequest {
            method: "GET",
            url,
            depth: None,
            body: None,
            ..Default::default()
        })?;
        if reply.status == 401 || reply.status == 403 {
            return Err(anyhow!("the server refused those credentials"));
        }
        if reply.status >= 300 {
            failed.push(format!("{} HTTP {}", response.href, reply.status));
            continue;
        }
        if crate::contacts::vcard::split_cards(reply.body.as_bytes()).is_empty() {
            failed.push(format!("{} is not a vCard", response.href));
            continue;
        }
        people.extend(people_from_vcards(reply.body.as_bytes()));
    }
    if !failed.is_empty() {
        return Err(incomplete(&failed, total));
    }

    Ok(people)
}

// ---- Writing (ADR-0012) ---------------------------------------------------

/// One card as read from a book: who it describes, where it lives and the
/// version it was read at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub person: Person,
    /// Absolute URL of the card.
    pub href: String,
    /// The server's ETag for it, empty when the server gave none.
    pub etag: String,
}

/// One group card as read from a book (ADR-0052).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEntry {
    pub group: crate::contacts::groups::GroupCard,
    pub href: String,
    pub etag: String,
}

/// Everything in a book: its people, its groups, and the vCard versions its
/// cards are written in (which decide how a new group is written).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BookContents {
    pub cards: Vec<Card>,
    pub groups: Vec<GroupEntry>,
    pub versions: Vec<String>,
}

impl BookContents {
    fn add(&mut self, data: &str, href: &str, etag: &str) {
        for properties in crate::contacts::vcard::split_cards(data.as_bytes()) {
            let version = crate::contacts::groups::card_version(&properties);
            if !version.is_empty() && !self.versions.contains(&version) {
                self.versions.push(version);
            }
            if let Some(group) = crate::contacts::groups::group_from_properties(&properties) {
                self.groups.push(GroupEntry { group, href: href.to_string(), etag: etag.to_string() });
                continue;
            }
            let person = crate::contacts::person::person_from_properties(&properties);
            if person.is_useful() {
                self.cards.push(Card { person, href: href.to_string(), etag: etag.to_string() });
            }
        }
    }
}

/// The book's cards with their URLs and versions. All or nothing, like
/// [`fetch_book`], which is this without the URLs.
pub fn fetch_cards(transport: &dyn Transport, book_url: &str) -> Result<Vec<Card>> {
    fetch_book_contents(transport, book_url).map(|contents| contents.cards)
}

/// The book's people and groups with their URLs and versions. All or nothing.
pub fn fetch_book_contents(transport: &dyn Transport, book_url: &str) -> Result<BookContents> {
    let reply = transport.send(&DavRequest {
        method: "REPORT",
        url: book_url.to_string(),
        depth: Some("1"),
        body: Some(REPORT_CARDS.to_string()),
        ..Default::default()
    })?;
    if reply.status == 401 || reply.status == 403 {
        return Err(anyhow!("the server refused those credentials"));
    }
    if reply.status >= 300 {
        // No REPORT: list, then fetch one at a time.
        return fetch_cards_one_at_a_time(transport, book_url);
    }
    let responses = parse_multistatus_complete(&reply.body)?;
    let mut contents = BookContents::default();
    let mut failed: Vec<String> = Vec::new();
    let mut total = 0usize;
    for response in responses.iter().filter(|response| !is_the_book(response, book_url)) {
        total += 1;
        let data = response
            .prop("address-data")
            .filter(|data| !crate::contacts::vcard::split_cards(data.as_bytes()).is_empty());
        let Some(data) = data else {
            failed.push(format!(
                "{} {}",
                response.href,
                if response.status.is_empty() { "sent no card" } else { response.status.as_str() }
            ));
            continue;
        };
        let href = resolve(&reply.url, &response.href)?;
        let etag = response.prop("getetag").unwrap_or_default().to_string();
        contents.add(data, &href, &etag);
    }
    if !failed.is_empty() {
        return Err(incomplete(&failed, total));
    }
    Ok(contents)
}

fn fetch_cards_one_at_a_time(transport: &dyn Transport, book_url: &str) -> Result<BookContents> {
    let reply = transport.send(&DavRequest {
        method: "PROPFIND",
        url: book_url.to_string(),
        depth: Some("1"),
        body: Some(PROP_HREFS.to_string()),
        ..Default::default()
    })?;
    if reply.status == 401 || reply.status == 403 {
        return Err(anyhow!("the server refused those credentials"));
    }
    if reply.status >= 300 {
        return Err(anyhow!("the server would not list the address book (HTTP {})", reply.status));
    }
    let responses = parse_multistatus_complete(&reply.body)?;
    let mut contents = BookContents::default();
    let mut failed: Vec<String> = Vec::new();
    let mut total = 0usize;
    for response in responses {
        if is_the_book(&response, book_url) || response.resource_types.iter().any(|kind| kind == "collection") {
            continue;
        }
        total += 1;
        let url = resolve(&reply.url, &response.href)?;
        match get_card(transport, book_url, &url)? {
            Some((body, etag)) => {
                let etag = if etag.is_empty() { response.prop("getetag").unwrap_or_default().to_string() } else { etag };
                contents.add(&body, &url, &etag);
            }
            None => failed.push(format!("{} could not be read", response.href)),
        }
    }
    if !failed.is_empty() {
        return Err(incomplete(&failed, total));
    }
    Ok(contents)
}

/// Whether this account may write to the book, as the server says in
/// `current-user-privilege-set`. `None` when it does not say.
pub fn book_writable(transport: &dyn Transport, book_url: &str) -> Result<Option<bool>> {
    let reply = transport.send(&DavRequest {
        method: "PROPFIND",
        url: book_url.to_string(),
        depth: Some("0"),
        body: Some(PROP_PRIVILEGES.to_string()),
        ..Default::default()
    })?;
    if reply.status >= 300 {
        return Ok(None);
    }
    let responses = parse_multistatus(&reply.body)?;
    let privileges: Vec<&String> = responses.iter().flat_map(|response| response.privileges.iter()).collect();
    if privileges.is_empty() {
        return Ok(None);
    }
    Ok(Some(privileges.iter().any(|p| matches!(p.as_str(), "write" | "write-content" | "all"))))
}

const PROP_PRIVILEGES: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>"#;

/// The outcome of a conditional write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    /// Done. The card's new ETag, when the server sent one.
    Saved { etag: Option<String> },
    /// The card is not at the version the write was made from (HTTP 412),
    /// or, for a new card, its URL is already taken. Nothing was written.
    Conflict,
}

/// One card and its ETag, or `None` when it is not there (any more).
pub fn get_card(transport: &dyn Transport, book_url: &str, card_url: &str) -> Result<Option<(String, String)>> {
    guard_origin(book_url, card_url)?;
    let reply = transport.send(&DavRequest {
        method: "GET",
        url: card_url.to_string(),
        ..Default::default()
    })?;
    match reply.status {
        401 | 403 => Err(anyhow!("the server refused those credentials")),
        404 | 410 => Ok(None),
        status if status >= 300 => Err(anyhow!("the server would not send the card (HTTP {status})")),
        _ => Ok(Some((reply.body, reply.etag.unwrap_or_default()))),
    }
}

/// Writes a card: over the version `if_match` names, or, with `None`, only
/// if nothing is at that URL yet.
pub fn put_card(
    transport: &dyn Transport,
    book_url: &str,
    card_url: &str,
    card: &str,
    if_match: Option<&str>,
) -> Result<Written> {
    guard_origin(book_url, card_url)?;
    let condition = match if_match {
        Some(etag) if !etag.is_empty() => ("If-Match", etag.to_string()),
        // A card whose version was never known cannot be written over: that
        // would overwrite whatever is there without having seen it.
        Some(_) => bail!("this contact's version on the server is not known yet; sync the address book and try again"),
        None => ("If-None-Match", "*".to_string()),
    };
    let reply = transport.send(&DavRequest {
        method: "PUT",
        url: card_url.to_string(),
        body: Some(card.to_string()),
        headers: vec![("Content-Type", "text/vcard; charset=utf-8".to_string()), condition],
        ..Default::default()
    })?;
    match reply.status {
        412 => Ok(Written::Conflict),
        401 | 403 => Err(anyhow!("the server refused to change this address book")),
        status if status >= 300 => Err(anyhow!("the server did not save the contact (HTTP {status})")),
        _ => Ok(Written::Saved { etag: reply.etag }),
    }
}

/// Deletes a card if it is still at the version `etag` names. One that is
/// already gone counts as deleted.
pub fn delete_card(transport: &dyn Transport, book_url: &str, card_url: &str, etag: &str) -> Result<Written> {
    guard_origin(book_url, card_url)?;
    if etag.is_empty() {
        bail!("this contact's version on the server is not known yet; sync the address book and try again");
    }
    let reply = transport.send(&DavRequest {
        method: "DELETE",
        url: card_url.to_string(),
        headers: vec![("If-Match", etag.to_string())],
        ..Default::default()
    })?;
    match reply.status {
        412 => Ok(Written::Conflict),
        404 | 410 => Ok(Written::Saved { etag: None }),
        401 | 403 => Err(anyhow!("the server refused to change this address book")),
        status if status >= 300 => Err(anyhow!("the server did not delete the contact (HTTP {status})")),
        _ => Ok(Written::Saved { etag: None }),
    }
}

/// A card is written only on the book's own server: the password goes nowhere
/// else (#28).
fn guard_origin(book_url: &str, card_url: &str) -> Result<()> {
    if !same_origin(card_url, book_url) {
        bail!("that contact is not on this address book's server; nothing was sent");
    }
    Ok(())
}
