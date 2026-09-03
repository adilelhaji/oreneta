//! Reading the XML a WebDAV server answers with.
//!
//! Not a WebDAV implementation: just enough to pull the handful of facts
//! CardDAV needs out of a `multistatus`, written to survive the servers that
//! exist rather than the ones the specification describes.
//!
//! Everything matches on local names with the namespace prefix thrown away.
//! Prefixes are the server's choice — `d:`, `D:`, `dav:`, none at all — and a
//! client that expects one of them works against one server and no others.

use anyhow::Result;
use quick_xml::events::Event;
use quick_xml::Reader;

/// One `<response>` from a `multistatus`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DavResponse {
    /// The thing this is about.
    pub href: String,
    /// The HTTP status of the propstat this came from, when one was given.
    pub status: String,
    /// Text-valued properties, by local name, last one winning.
    pub props: Vec<(String, String)>,
    /// The `resourcetype` children, by local name: "collection", "addressbook".
    pub resource_types: Vec<String>,
    /// Hrefs nested inside a property, by that property's local name.
    ///
    /// `current-user-principal` and `addressbook-home-set` both answer with an
    /// href inside them rather than with text, which is why these are apart
    /// from `props`.
    pub prop_hrefs: Vec<(String, String)>,
}

impl DavResponse {
    /// A text property by local name.
    pub fn prop(&self, name: &str) -> Option<&str> {
        self.props
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// The first href nested in a property.
    pub fn prop_href(&self, name: &str) -> Option<&str> {
        self.prop_hrefs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Whether the server called this an address book.
    pub fn is_addressbook(&self) -> bool {
        self.resource_types.iter().any(|kind| kind == "addressbook")
    }

    /// Whether the propstat this came from said the properties were not found.
    ///
    /// A server answers a PROPFIND for four properties with several propstats,
    /// one per status, and the 404 one lists what it does not have. Reading
    /// those as facts would mean treating "no such property" as an answer.
    pub fn is_missing(&self) -> bool {
        self.status.contains(" 404") || self.status.contains(" 403")
    }
}

/// The local name of an element, with any namespace prefix dropped.
fn local_name(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    match text.rsplit_once(':') {
        Some((_, name)) => name.to_ascii_lowercase(),
        None => text.to_ascii_lowercase(),
    }
}

/// Read a `multistatus` body into one entry per `<response>`.
///
/// A body that is not XML at all, or that is XML and not a multistatus, yields
/// nothing rather than an error: a server answering an unexpected page to a
/// PROPFIND has told us it does not support what was asked, and the caller
/// handles "nothing here" already.
pub fn parse_multistatus(body: &str) -> Result<Vec<DavResponse>> {
    let mut reader = Reader::from_str(body);
    let config = reader.config_mut();
    config.trim_text(true);
    config.check_end_names = false;

    let mut responses: Vec<DavResponse> = Vec::new();
    // The element path, so a `href` inside `current-user-principal` is told
    // apart from the `href` that names the response itself.
    let mut path: Vec<String> = Vec::new();
    let mut current: Option<DavResponse> = None;
    let mut text = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(element)) => {
                let name = local_name(element.name().as_ref());
                if name == "response" {
                    current = Some(DavResponse::default());
                }
                if name == "resourcetype" {
                    // Its children are the answer, and they are empty elements.
                }
                path.push(name);
                text.clear();
            }
            Ok(Event::Empty(element)) => {
                let name = local_name(element.name().as_ref());
                // `<collection/>` and `<addressbook/>` inside a resourcetype.
                if path.last().map(String::as_str) == Some("resourcetype") {
                    if let Some(response) = current.as_mut() {
                        response.resource_types.push(name);
                    }
                }
            }
            Ok(Event::Text(chunk)) => {
                // Entities become the characters they stand for: a display
                // name written `Ana &amp; Marc` is one the reader typed with
                // an ampersand in it.
                match chunk.unescape() {
                    Ok(value) => text.push_str(value.as_ref()),
                    Err(_) => text.push_str(&String::from_utf8_lossy(chunk.as_ref())),
                }
            }
            Ok(Event::CData(chunk)) => {
                text.push_str(&String::from_utf8_lossy(chunk.as_ref()));
            }
            Ok(Event::End(element)) => {
                let name = local_name(element.name().as_ref());
                let value = std::mem::take(&mut text);

                if let Some(response) = current.as_mut() {
                    match name.as_str() {
                        "href" => {
                            // Which href this is depends on what encloses it.
                            let parent = path
                                .iter()
                                .rev()
                                .nth(1)
                                .cloned()
                                .unwrap_or_default();
                            let trimmed = value.trim().to_string();
                            if parent == "response" {
                                if response.href.is_empty() {
                                    response.href = trimmed;
                                }
                            } else if !parent.is_empty() && !trimmed.is_empty() {
                                response.prop_hrefs.push((parent, trimmed));
                            }
                        }
                        "status" => response.status = value.trim().to_string(),
                        "response" => {
                            let finished = current.take().expect("checked");
                            if !finished.href.is_empty() || !finished.props.is_empty() {
                                responses.push(finished);
                            }
                        }
                        // Anything else with text directly under a prop.
                        _ => {
                            let inside_prop = path.iter().rev().nth(1).map(String::as_str) == Some("prop");
                            if inside_prop && !value.trim().is_empty() {
                                response.props.push((name.clone(), value.trim().to_string()));
                            }
                        }
                    }
                }

                path.pop();
            }
            _ => {}
        }
    }

    Ok(responses)
}
