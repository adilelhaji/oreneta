//! Hand-written EWS requests, for what the `ews` crate does not model:
//! distribution lists and tasks (ADR-0058).
//!
//! The crate gives every item one `Message` shape, which has no members, due
//! dates or task status, and its operations serialize only what that shape
//! holds. These few operations are written out here instead, and their
//! answers read with the same rule the WebDAV reader follows: elements by
//! local name, whatever prefix the server chose.

use anyhow::{bail, Context as _, Result};
use quick_xml::events::Event;
use quick_xml::Reader;

/// One element of an answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Node {
    /// The local name, prefix dropped, case kept.
    pub name: String,
    pub attrs: Vec<(String, String)>,
    /// The element's own text, unescaped.
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    /// The first child named `name`.
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|child| child.name == name)
    }

    /// Every child named `name`, in order.
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |child| child.name == name)
    }

    /// Following `names` one child at a time.
    pub fn path(&self, names: &[&str]) -> Option<&Node> {
        names.iter().try_fold(self, |node, name| node.child(name))
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// A child's text, trimmed; `None` when there is no such child.
    pub fn text_of(&self, name: &str) -> Option<&str> {
        self.child(name).map(|child| child.text.trim())
    }
}

fn local(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    match text.rsplit_once(':') {
        Some((_, name)) => name.to_string(),
        None => text.into_owned(),
    }
}

fn element(start: &quick_xml::events::BytesStart, decoder: quick_xml::encoding::Decoder) -> Result<Node> {
    let mut attrs = Vec::new();
    for attr in start.attributes() {
        let attr = attr.context("an attribute of the Exchange answer could not be read")?;
        let key = local(attr.key.as_ref());
        let value = attr.decode_and_unescape_value(decoder).context("an attribute of the Exchange answer could not be read")?;
        attrs.push((key, value.into_owned()));
    }
    Ok(Node { name: local(start.name().as_ref()), attrs, ..Default::default() })
}

/// Reads a whole document. The answer is a node holding its top elements.
pub fn parse(xml: &[u8]) -> Result<Node> {
    let mut reader = Reader::from_reader(xml);
    let mut stack = vec![Node::default()];
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf).context("the Exchange answer is not XML")? {
            Event::Start(start) => stack.push(element(&start, reader.decoder())?),
            Event::Empty(start) => {
                let node = element(&start, reader.decoder())?;
                stack.last_mut().expect("root").children.push(node);
            }
            Event::End(_) => {
                let node = stack.pop().expect("open element");
                let Some(parent) = stack.last_mut() else { bail!("the Exchange answer closes more than it opens") };
                parent.children.push(node);
            }
            Event::Text(text) => {
                let text = text.unescape().context("the Exchange answer has text that cannot be read")?;
                stack.last_mut().expect("root").text.push_str(&text);
            }
            Event::CData(data) => {
                stack.last_mut().expect("root").text.push_str(&String::from_utf8_lossy(&data));
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if stack.len() != 1 {
        bail!("the Exchange answer ends before it is complete");
    }
    Ok(stack.pop().expect("root"))
}

/// Text made safe inside an element or a double-quoted attribute.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Characters XML 1.0 cannot carry at all are left out rather
            // than sent to be refused.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// A complete request around one operation element written with the `m:`
/// (messages) and `t:` (types) prefixes. The schema version is the one every
/// other request of this backend names.
pub fn request(operation: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header><soap:Body>{operation}</soap:Body></soap:Envelope>"#
    )
}

/// What the server said about one item it refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawError {
    /// The response code, `ErrorIrresolvableConflict` and the like.
    pub code: String,
    pub text: String,
}

impl std::fmt::Display for RawError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "response code {}: {}", self.code, self.text)
    }
}

impl std::error::Error for RawError {}

/// The response messages of `operation`'s answer, in order: each one the
/// message itself, or the error the server gave for that item. A SOAP fault
/// (the whole request refused) fails.
pub fn messages(document: &Node, operation: &str) -> Result<Vec<std::result::Result<Node, RawError>>> {
    let body = document.path(&["Envelope", "Body"]).context("the Exchange answer has no SOAP body")?;
    if let Some(fault) = body.child("Fault") {
        let code = fault
            .path(&["detail", "ResponseCode"])
            .map(|code| code.text.trim().to_string())
            .unwrap_or_default();
        let text = fault.text_of("faultstring").unwrap_or_default();
        bail!("Exchange refused the request: {code} {text}");
    }
    let response = body
        .child(&format!("{operation}Response"))
        .with_context(|| format!("the Exchange answer is not a {operation} answer"))?;
    let list = response.child("ResponseMessages").context("the Exchange answer has no response messages")?;
    Ok(list
        .children
        .iter()
        .map(|message| match message.attr("ResponseClass") {
            Some("Error") => Err(RawError {
                code: message.text_of("ResponseCode").unwrap_or_default().to_string(),
                text: message.text_of("MessageText").unwrap_or_default().to_string(),
            }),
            _ => Ok(message.clone()),
        })
        .collect())
}

/// The one message of an operation on one item, its error raised.
pub fn single(document: &Node, operation: &str) -> Result<Node> {
    let mut all = messages(document, operation)?;
    if all.len() != 1 {
        bail!("expected 1 EWS response message, got {}", all.len());
    }
    all.remove(0).map_err(|error| anyhow::Error::new(error).context("EWS reported an operation error"))
}

/// The error code of a failed operation, if the failure was the server's
/// verdict on the item (rather than the connection, or the answer).
pub fn error_code(error: &anyhow::Error) -> Option<&str> {
    error.chain().find_map(|cause| cause.downcast_ref::<RawError>()).map(|raw| raw.code.as_str())
}

/// An item reference, with its change key when there is one.
pub fn item_id(id: &str, change_key: Option<&str>) -> String {
    match change_key.filter(|key| !key.is_empty()) {
        Some(key) => format!(r#"<t:ItemId Id="{}" ChangeKey="{}"/>"#, escape(id), escape(key)),
        None => format!(r#"<t:ItemId Id="{}"/>"#, escape(id)),
    }
}

/// A well-known folder, addressed at `target_mailbox` when the account works
/// on a shared mailbox (as `distinguished_folder_id` does for the crate's
/// requests).
pub fn distinguished(id: &str, target_mailbox: &str) -> String {
    let mailbox = target_mailbox.trim();
    if mailbox.is_empty() {
        format!(r#"<t:DistinguishedFolderId Id="{id}"/>"#)
    } else {
        format!(
            r#"<t:DistinguishedFolderId Id="{id}"><t:Mailbox><t:EmailAddress>{}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>"#,
            escape(mailbox)
        )
    }
}

impl super::EwsClient {
    /// Sends one hand-written operation and reads the answer.
    pub(crate) fn call_raw(&self, operation: &str) -> Result<Node> {
        let answer = self.post_soap(request(operation).as_bytes())?;
        parse(&answer).inspect_err(|_| {
            super::ews_debug(&format!(
                "server response: {}",
                String::from_utf8_lossy(&answer).chars().take(900).collect::<String>()
            ))
        })
    }
}
