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

use anyhow::{anyhow, Context, Result};
use url::Url;

use super::xml::{parse_multistatus, DavResponse};
use crate::contacts::person::{people_from_vcards, Person};

/// One request to a DAV server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DavRequest {
    pub method: &'static str,
    pub url: String,
    /// The `Depth` header, which decides whether children are included.
    pub depth: Option<&'static str>,
    pub body: Option<String>,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
    /// Where the request ended up, which is not where it started when the
    /// server redirected — and `.well-known/carddav` exists to redirect.
    pub url: String,
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
    Ok(url.join("/.well-known/carddav")?.to_string())
}

/// Resolve an href from a response against the URL it came from.
fn resolve(base: &str, href: &str) -> Result<String> {
    Ok(Url::parse(base)?.join(href.trim())?.to_string())
}

/// A name for a book the server did not name.
fn name_from_url(url: &str) -> String {
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
fn propfind(
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
                    principal = resolve(&from, href)?;
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
                        home = resolve(&from, href)?;
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
            let url = resolve(&from, &response.href)?;
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
pub fn fetch_book(transport: &dyn Transport, book_url: &str) -> Result<Vec<Person>> {
    let reply = transport.send(&DavRequest {
        method: "REPORT",
        url: book_url.to_string(),
        depth: Some("1"),
        body: Some(REPORT_CARDS.to_string()),
    })?;

    if reply.status == 401 || reply.status == 403 {
        return Err(anyhow!("the server refused those credentials"));
    }

    if reply.status < 300 {
        let responses = parse_multistatus(&reply.body)?;
        let cards: Vec<u8> = responses
            .iter()
            .filter_map(|response| response.prop("address-data"))
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes();
        let people = people_from_vcards(&cards);
        if !people.is_empty() || !responses.is_empty() {
            return Ok(people);
        }
    }

    fetch_book_one_at_a_time(transport, book_url)
}

/// The long way: ask what is in the book, then fetch each card.
fn fetch_book_one_at_a_time(transport: &dyn Transport, book_url: &str) -> Result<Vec<Person>> {
    let (responses, from) = propfind(transport, book_url, "1", PROP_HREFS)?;
    let mut people = Vec::new();

    for response in responses {
        // The collection lists itself; it is not one of its own cards.
        if response.href.trim_end_matches('/') == Url::parse(book_url)?.path().trim_end_matches('/') {
            continue;
        }
        if response.resource_types.iter().any(|kind| kind == "collection") {
            continue;
        }
        let url = resolve(&from, &response.href)?;
        let reply = transport.send(&DavRequest {
            method: "GET",
            url,
            depth: None,
            body: None,
        })?;
        if reply.status >= 300 {
            // One card that will not come is not a reason to lose the book.
            continue;
        }
        people.extend(people_from_vcards(reply.body.as_bytes()));
    }

    Ok(people)
}
