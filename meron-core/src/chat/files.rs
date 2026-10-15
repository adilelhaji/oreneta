//! Files in chat (ADR-0044): sending one with HTTP File Upload (XEP-0363)
//! and its link as an out-of-band URL (XEP-0066), and saving one received.
//!
//! - The upload service is found on the person's server (disco), and its own
//!   size limit is checked before a single byte goes out.
//! - Files go up and come down over HTTPS only, through the app's proxy; a
//!   redirect is never followed, so a link cannot send us elsewhere.
//! - Nothing received is fetched on its own: only when the person saves it.

use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_xmpp::parsers::{disco::DiscoInfoResult, http_upload, message::Message, oob::Oob};

pub const UPLOAD_NS: &str = "urn:xmpp:http:upload:0";

/// The largest file saved from a link, whatever the server says.
pub const MAX_DOWNLOAD: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum FileError {
    /// The person's server offers no file upload.
    NoService,
    /// Larger than the server accepts; nothing was sent.
    TooLarge { size: u64, max: u64 },
    /// Only HTTPS links are used.
    NotHttps,
    Cancelled,
    /// The upload service said no to the slot.
    Refused { detail: String },
    Failed { status: u16 },
    Network { detail: String },
    File { detail: String },
    /// The connection to the chat server went while asking.
    Disconnected,
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoService => write!(f, "the chat server does not accept files"),
            Self::TooLarge { size, max } => {
                write!(f, "the file is {size} bytes; the chat server accepts up to {max}, so nothing was sent")
            }
            Self::NotHttps => write!(f, "only secure (https) links are used for files"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Refused { detail } => write!(f, "the chat server refused the file: {detail}"),
            Self::Failed { status } => write!(f, "the file server answered {status}"),
            Self::Network { detail } | Self::File { detail } => write!(f, "{detail}"),
            Self::Disconnected => write!(f, "the connection to the chat server went; nothing was sent"),
        }
    }
}

impl std::error::Error for FileError {}

/// Refuses any link that is not plain HTTPS to a host: no other scheme, no
/// credentials in it.
pub fn https_only(link: &str) -> Result<url::Url, FileError> {
    let parsed = url::Url::parse(link.trim()).map_err(|_| FileError::NotHttps)?;
    if parsed.scheme() != "https" || parsed.host_str().is_none_or(str::is_empty) {
        return Err(FileError::NotHttps);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(FileError::NotHttps);
    }
    Ok(parsed)
}

/// A file's name from its link: the last part of the path, decoded, with
/// nothing that could reach outside a folder.
pub fn file_name_of(link: &str) -> String {
    let last = url::Url::parse(link)
        .ok()
        .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
        .unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(&last).decode_utf8_lossy().to_string();
    let clean: String = decoded
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') || c.is_control() { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() { "file".into() } else { clean.chars().take(200).collect() }
}

// ---- The upload service -----------------------------------------------------------

/// From a disco#info answer: `Some(limit)` when the entity is an upload
/// service (the limit is its own, when it states one).
pub fn upload_service(info: &DiscoInfoResult) -> Option<Option<u64>> {
    if !info.features.contains(UPLOAD_NS) {
        return None;
    }
    let max = info
        .extensions
        .iter()
        .filter(|form| form.form_type() == Some(UPLOAD_NS))
        .flat_map(|form| form.fields.iter())
        .find(|field| field.var.as_deref() == Some("max-file-size"))
        .and_then(|field| field.values.first())
        .and_then(|v| v.trim().parse::<u64>().ok());
    Some(max)
}

/// Before asking for a slot: a file larger than the service accepts is
/// refused here, so it is never sent.
pub fn check_size(size: u64, max: Option<u64>) -> Result<(), FileError> {
    match max {
        Some(max) if size > max => Err(FileError::TooLarge { size, max }),
        _ => Ok(()),
    }
}

pub fn slot_request(name: &str, size: u64) -> http_upload::SlotRequest {
    http_upload::SlotRequest { filename: name.to_string(), size, content_type: None }
}

/// Where to put a file and where it will be read from.
#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub put: String,
    pub headers: Vec<(String, String)>,
    pub get: String,
}

/// The service's answer to a slot request; both links must be HTTPS.
pub fn parse_slot(slot: http_upload::SlotResult) -> Result<Slot, FileError> {
    https_only(&slot.put.url)?;
    https_only(&slot.get.url)?;
    Ok(Slot {
        put: slot.put.url,
        // Only Authorization, Cookie and Expires can come through (the
        // parser accepts no others), and none may span lines.
        headers: slot
            .put
            .headers
            .into_iter()
            .map(|h| (h.name.as_str().to_string(), h.value.replace(['\r', '\n'], "")))
            .collect(),
        get: slot.get.url,
    })
}

// ---- Links in messages ------------------------------------------------------------

/// The out-of-band link a message carries, if any.
pub fn link_of(message: &Message) -> Option<String> {
    message
        .payloads
        .iter()
        .find_map(|p| Oob::try_from(p.clone()).ok())
        .map(|oob| oob.url.trim().to_string())
        .filter(|url| !url.is_empty())
}

pub fn with_link(mut message: Message, url: &str) -> Message {
    message.payloads.push(Oob { url: url.to_string(), desc: None }.into());
    message
}

// ---- HTTP -------------------------------------------------------------------------

/// The agent for files: the app's proxy, and the usual roots unless a test
/// trusts its own (PEM) authority instead.
pub fn agent(extra_roots: &[Vec<u8>]) -> anyhow::Result<ureq::Agent> {
    let mut config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        // A link never sends us elsewhere, to plain HTTP least of all.
        .max_redirects(0);
    if let Some(proxy) = crate::proxy::global()? {
        config = config.proxy(Some(crate::proxy::scoped_ureq_proxy(&proxy, crate::proxy::ProxyScope::App)?));
    }
    if !extra_roots.is_empty() {
        let mut certs = Vec::new();
        for pem in extra_roots {
            certs.push(ureq::tls::Certificate::from_pem(pem)?);
        }
        config = config.tls_config(
            ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::new_with_certs(&certs)).build(),
        );
    }
    Ok(ureq::Agent::new_with_config(config.build()))
}

/// Counts what goes through and stops when cancelled.
struct Watched<'a, R> {
    inner: R,
    done: u64,
    cancel: &'a AtomicBool,
    progress: &'a mut dyn FnMut(u64),
}

impl<R: Read> Read for Watched<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        let n = self.inner.read(buf)?;
        self.done += n as u64;
        (self.progress)(self.done);
        Ok(n)
    }
}

/// Puts the file in its slot. A cancelled upload stops sending; the service
/// drops what it got and its slot expires.
pub fn put(
    agent: &ureq::Agent,
    slot: &Slot,
    file: &std::path::Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(), FileError> {
    https_only(&slot.put)?;
    let size = std::fs::metadata(file).map_err(|e| FileError::File { detail: e.to_string() })?.len();
    let reader = std::fs::File::open(file).map_err(|e| FileError::File { detail: e.to_string() })?;
    let mut watched = Watched { inner: reader, done: 0, cancel, progress };
    let mut request = agent
        .put(&slot.put)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", &size.to_string());
    for (name, value) in &slot.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    match request.send(ureq::SendBody::from_reader(&mut watched)) {
        Ok(response) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) { Ok(()) } else { Err(FileError::Failed { status }) }
        }
        Err(_) if cancel.load(Ordering::Relaxed) => Err(FileError::Cancelled),
        Err(e) => Err(FileError::Network { detail: e.to_string() }),
    }
}

/// Saves a received file where the person chose, over HTTPS only. It is
/// written beside the target first, so a failed download leaves nothing
/// half-written under the chosen name.
pub fn download(agent: &ureq::Agent, link: &str, dest: &std::path::Path) -> Result<u64, FileError> {
    let url = https_only(link)?;
    let mut response = agent.get(url.as_str()).call().map_err(|e| FileError::Network { detail: e.to_string() })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(FileError::Failed { status });
    }
    let partial = dest.with_extension(format!(
        "{}part",
        dest.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()
    ));
    let written = (|| -> std::io::Result<u64> {
        let mut out = std::fs::File::create(&partial)?;
        let mut reader = response.body_mut().with_config().limit(MAX_DOWNLOAD).reader();
        let n = std::io::copy(&mut reader, &mut out)?;
        out.flush()?;
        out.sync_all()?;
        Ok(n)
    })();
    match written {
        Ok(n) => {
            std::fs::rename(&partial, dest).map_err(|e| FileError::File { detail: e.to_string() })?;
            Ok(n)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(FileError::Network { detail: e.to_string() })
        }
    }
}
