//! Microsoft Graph v1.0 read boundary (ADR-0004). Blocking: async hosts must
//! use spawn_blocking. Not yet connected to account setup or the mail pool.
//! No token exchange, persistence, automatic retries or protocol fallback.

use serde::{Deserialize, de::DeserializeOwned};
use std::{collections::HashSet, fmt, time::Duration};
use url::Url;

const API: &str = "https://graph.microsoft.com/v1.0/";
const MAX_BODY: u64 = 4 * 1024 * 1024;
const MAX_ITEMS: usize = 1000;
const TIMEOUT: Duration = Duration::from_secs(30);

pub mod auth;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidInput,
    Reauthenticate,
    ConsentRequired,
    AccessDenied,
    NotFound,
    Conflict,
    Throttled,
    ResyncRequired,
    Unavailable,
    InvalidResponse,
    Transport,
}

/// Only locally generated categories; never provider text, URLs or tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl Error {
    fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            status: None,
            retry_after_seconds: None,
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Microsoft Graph: {:?}", self.kind)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ResourceKind {
    Folder,
    Message,
}

/// Deliberately not convertible to a local UID or unqualified cached key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ResourceId {
    account: String,
    kind: ResourceKind,
    opaque: String,
}
impl ResourceId {
    pub fn new(account: &str, kind: ResourceKind, opaque: &str) -> Result<Self> {
        if !valid_id(account) || !valid_id(opaque) {
            return Err(Error::new(ErrorKind::InvalidInput));
        }
        Ok(Self {
            account: account.into(),
            kind,
            opaque: opaque.into(),
        })
    }
    pub fn account(&self) -> &str {
        &self.account
    }
    pub fn kind(&self) -> ResourceKind {
        self.kind
    }
    pub fn opaque(&self) -> &str {
        &self.opaque
    }
}
fn valid_id(s: &str) -> bool {
    !s.trim().is_empty()
        && s.len() <= 2048
        && s != "."
        && s != ".."
        && !s.chars().any(char::is_control)
}

/// The OAuth integration must supply the provider-returned Graph scopes and
/// verified account binding, not requested scopes or an Outlook-resource token.
/// No Debug/Serialize implementation: grants must never cross UI/log boundaries.
pub struct Grant {
    account: String,
    token: String,
    scopes: HashSet<String>,
    expires_at: i64,
}
impl Grant {
    pub fn new(account: &str, token: &str, granted_scopes: &str, expires_at: i64) -> Result<Self> {
        if !valid_id(account)
            || token.is_empty()
            || token.len() > 32768
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._~+/=".contains(&c))
        {
            return Err(Error::new(ErrorKind::InvalidInput));
        }
        let scopes = granted_scopes
            .split_ascii_whitespace()
            .map(|s| {
                s.strip_prefix("https://graph.microsoft.com/")
                    .unwrap_or(s)
                    .to_owned()
            })
            .collect();
        Ok(Self {
            account: account.into(),
            token: token.into(),
            scopes,
            expires_at,
        })
    }
    fn authorize(&self, full_mail: bool) -> Result<()> {
        if self.expires_at <= chrono::Utc::now().timestamp() {
            return Err(Error::new(ErrorKind::Reauthenticate));
        }
        if self.scopes.contains("Mail.Read")
            || self.scopes.contains("Mail.ReadWrite")
            || (!full_mail && self.scopes.contains("Mail.ReadBasic"))
        {
            Ok(())
        } else {
            Err(Error::new(ErrorKind::ConsentRequired))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointKind {
    NextPage,
    Delta,
}

/// In-memory only in X1. Not accepted from arbitrary frontend strings. URL may
/// contain sensitive provider state; Debug intentionally redacts it.
#[derive(Clone)]
pub struct Checkpoint {
    account: String,
    collection: String,
    url: String,
    kind: CheckpointKind,
}
impl Checkpoint {
    pub fn kind(&self) -> CheckpointKind {
        self.kind
    }
}
impl fmt::Debug for Checkpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Checkpoint")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct Page<T> {
    pub items: Vec<T>,
    /// NextPage continues this round; Delta finishes a round and starts its next
    /// one only AFTER the consumer durably applies every page in that round.
    pub checkpoint: Option<Checkpoint>,
}

#[derive(Debug)]
pub struct Folder {
    pub id: ResourceId,
    pub fields: FolderFields,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFields {
    pub display_name: String,
    pub parent_folder_id: Option<String>,
    pub child_folder_count: u32,
    pub unread_item_count: u32,
    pub total_item_count: u32,
}

#[derive(Debug)]
pub struct Message {
    pub id: ResourceId,
    pub fields: MessageFields,
}
/// Delta responses may contain just changed fields. None is absent/unknown,
/// never a request to clear a cached value. Tombstones contain only id/removed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageFields {
    #[serde(rename = "@odata.etag")]
    pub etag: Option<String>,
    #[serde(rename = "@removed")]
    pub removed: Option<Removed>,
    pub parent_folder_id: Option<String>,
    pub conversation_id: Option<String>,
    pub internet_message_id: Option<String>,
    pub subject: Option<String>,
    pub received_date_time: Option<String>,
    pub is_read: Option<bool>,
    pub is_draft: Option<bool>,
    pub has_attachments: Option<bool>,
    pub from: Option<Recipient>,
    pub to_recipients: Option<Vec<Recipient>>,
    pub cc_recipients: Option<Vec<Recipient>>,
    pub body: Option<Body>,
}
#[derive(Debug, Deserialize)]
pub struct Removed {
    pub reason: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipient {
    pub email_address: EmailAddress,
}
#[derive(Debug, Deserialize)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}
/// Raw Graph HTML is untrusted: consumers must use the existing sanitizer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub content_type: String,
    pub content: String,
}

#[derive(Deserialize)]
struct WireItem<T> {
    id: String,
    #[serde(flatten)]
    fields: T,
}
#[derive(Deserialize)]
struct WirePage<T> {
    value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    next: Option<String>,
    #[serde(rename = "@odata.deltaLink")]
    delta: Option<String>,
}

pub struct Client {
    grant: Grant,
    proxy: crate::proxy::ProxyChoice,
    base: Url,
}
impl Client {
    pub fn new(grant: Grant, proxy: crate::proxy::ProxyChoice) -> Self {
        Self {
            grant,
            proxy,
            base: Url::parse(API).expect("static Graph URL"),
        }
    }

    /// Root folders only, or immediate children of the specified folder.
    /// Consumers must explicitly traverse children; this is not a full tree.
    pub fn folders(
        &self,
        parent: Option<&ResourceId>,
        checkpoint: Option<&Checkpoint>,
    ) -> Result<Page<Folder>> {
        self.grant.authorize(false)?;
        let mut url = self.route(&["me", "mailFolders"]);
        if let Some(id) = parent {
            self.require_id(id, ResourceKind::Folder)?;
            url.path_segments_mut()
                .unwrap()
                .push(&id.opaque)
                .push("childFolders");
        }
        let page: Page<WireItem<FolderFields>> = self.page(url, checkpoint, false)?;
        Ok(Page {
            items: page
                .items
                .into_iter()
                .map(|item| {
                    Ok(Folder {
                        id: self.response_id(ResourceKind::Folder, &item.id)?,
                        fields: item.fields,
                    })
                })
                .collect::<Result<_>>()?,
            checkpoint: page.checkpoint,
        })
    }

    pub fn messages(
        &self,
        folder: &ResourceId,
        checkpoint: Option<&Checkpoint>,
    ) -> Result<Page<Message>> {
        self.message_page(folder, checkpoint, false)
    }
    pub fn message_delta(
        &self,
        folder: &ResourceId,
        checkpoint: Option<&Checkpoint>,
    ) -> Result<Page<Message>> {
        self.message_page(folder, checkpoint, true)
    }
    fn message_page(
        &self,
        folder: &ResourceId,
        checkpoint: Option<&Checkpoint>,
        delta: bool,
    ) -> Result<Page<Message>> {
        self.grant.authorize(true)?;
        self.require_id(folder, ResourceKind::Folder)?;
        let mut url = self.route(&["me", "mailFolders", &folder.opaque, "messages"]);
        if delta {
            url.path_segments_mut().unwrap().push("delta");
        }
        let page: Page<WireItem<MessageFields>> = self.page(url, checkpoint, delta)?;
        Ok(Page {
            items: page
                .items
                .into_iter()
                .map(|item| {
                    Ok(Message {
                        id: self.response_id(ResourceKind::Message, &item.id)?,
                        fields: item.fields,
                    })
                })
                .collect::<Result<_>>()?,
            checkpoint: page.checkpoint,
        })
    }

    /// GET does not mark the message as read.
    pub fn message(&self, id: &ResourceId) -> Result<Message> {
        self.grant.authorize(true)?;
        self.require_id(id, ResourceKind::Message)?;
        let url = self.route(&["me", "messages", &id.opaque]);
        let item: WireItem<MessageFields> = self.get(&url)?;
        if item.id != id.opaque {
            return Err(Error::new(ErrorKind::InvalidResponse));
        }
        Ok(Message {
            id: id.clone(),
            fields: item.fields,
        })
    }

    fn route(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .extend(segments);
        url
    }
    fn require_id(&self, id: &ResourceId, kind: ResourceKind) -> Result<()> {
        if id.account != self.grant.account || id.kind != kind {
            return Err(Error::new(ErrorKind::InvalidInput));
        }
        Ok(())
    }
    fn response_id(&self, kind: ResourceKind, id: &str) -> Result<ResourceId> {
        ResourceId::new(&self.grant.account, kind, id)
            .map_err(|_| Error::new(ErrorKind::InvalidResponse))
    }
    fn page<T: DeserializeOwned>(
        &self,
        mut start: Url,
        checkpoint: Option<&Checkpoint>,
        delta: bool,
    ) -> Result<Page<T>> {
        let collection = start.path().to_string();
        let url = if let Some(cursor) = checkpoint {
            if cursor.account != self.grant.account
                || cursor.collection != collection
                || (!delta && cursor.kind == CheckpointKind::Delta)
            {
                return Err(Error::new(ErrorKind::InvalidInput));
            }
            self.validate_link(&cursor.url, &collection)?
        } else {
            // Delta uses its documented page-size preference instead of $top.
            if !delta {
                start.query_pairs_mut().append_pair("$top", "100");
            }
            start
        };
        let page: WirePage<T> = self.get(&url)?;
        if page.value.len() > MAX_ITEMS
            || (page.next.is_some() && page.delta.is_some())
            || (!delta && page.delta.is_some())
            || (delta && page.next.is_none() && page.delta.is_none())
        {
            return Err(Error::new(ErrorKind::InvalidResponse));
        }
        let checkpoint = match (page.next, page.delta) {
            (Some(link), None) => Some((link, CheckpointKind::NextPage)),
            (None, Some(link)) => Some((link, CheckpointKind::Delta)),
            _ => None,
        }
        .map(|(link, kind)| {
            self.validate_link(&link, &collection)?;
            if kind == CheckpointKind::NextPage
                && self.validate_link(&link, &collection)?.query() == url.query()
            {
                return Err(Error::new(ErrorKind::InvalidResponse));
            }
            Ok(Checkpoint {
                account: self.grant.account.clone(),
                collection,
                url: link,
                kind,
            })
        })
        .transpose()?;
        Ok(Page {
            items: page.value,
            checkpoint,
        })
    }
    fn validate_link(&self, raw: &str, collection: &str) -> Result<Url> {
        let invalid = || Error::new(ErrorKind::InvalidResponse);
        if raw.len() > 32768 || raw.chars().any(|c| c.is_control() || c == '\\') {
            return Err(invalid());
        }
        let url = Url::parse(raw).map_err(|_| invalid())?;
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || collection_key(url.path()).is_none()
            || collection_key(url.path()) != collection_key(collection)
        {
            return Err(invalid());
        }
        Ok(url)
    }
    fn get<T: DeserializeOwned>(&self, url: &Url) -> Result<T> {
        // Explicit per-account route, resolved per call so proxy changes apply.
        let agent = match self.proxy.resolve() {
            Some(proxy) => crate::proxy::agent_for(Some(&proxy))
                .map_err(|_| Error::new(ErrorKind::Transport))?,
            // ureq's defaults read HTTP_PROXY. An explicitly resolved direct
            // route must not silently inherit a process-environment proxy.
            None => ureq::Agent::new_with_config(ureq::Agent::config_builder().proxy(None).build()),
        };
        let mut response = agent
            .get(url.as_str())
            .header("Authorization", &format!("Bearer {}", self.grant.token))
            .header("Accept", "application/json")
            .header("Prefer", "IdType=\"ImmutableId\", odata.maxpagesize=100")
            .config()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .call()
            .map_err(|_| Error::new(ErrorKind::Transport))?;
        let status = response.status().as_u16();
        if status != 200 {
            // Do not read an error body: it may contain user content or secrets.
            let retry = response
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| retry_after(v, chrono::Utc::now().timestamp()));
            return Err(status_error(status, retry));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_vec()
            .map_err(|_| Error::new(ErrorKind::InvalidResponse))?;
        serde_json::from_slice(&bytes).map_err(|_| Error::new(ErrorKind::InvalidResponse))
    }
}

/// Graph documents both /mailFolders/{id} and /mailfolders('{id}') links.
/// Normalize only those known collection spellings, never opaque ID case.
/// Split before percent-decoding so an escaped slash stays inside one ID.
fn collection_key(path: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = path
        .split('/')
        .map(|s| {
            percent_encoding::percent_decode_str(s)
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned())
        })
        .collect::<Option<_>>()?;
    if parts.len() < 4 || parts[0] != "" || parts[1] != "v1.0" || parts[2] != "me" {
        return None;
    }
    let mut tail = parts[3..].to_vec();
    let first = tail.first()?;
    if first
        .get(..13)
        .is_some_and(|p| p.eq_ignore_ascii_case("mailfolders('"))
    {
        let literal = first.get(13..)?.strip_suffix("')")?;
        // OData string literals escape a quote by doubling it.
        let mut id = String::new();
        let mut chars = literal.chars();
        while let Some(c) = chars.next() {
            if c == '\'' && chars.next() != Some('\'') {
                return None;
            }
            id.push(c);
        }
        tail.splice(0..1, ["mailFolders".into(), id]);
    }
    if !tail[0].eq_ignore_ascii_case("mailFolders") {
        return None;
    }
    tail[0] = "mailFolders".into();
    match tail.len() {
        1 => Some(tail),
        3 | 4 if valid_id(&tail[1]) => {
            if tail[2].eq_ignore_ascii_case("childFolders") && tail.len() == 3 {
                tail[2] = "childFolders".into();
            } else if tail[2].eq_ignore_ascii_case("messages") {
                tail[2] = "messages".into();
                if tail.len() == 4 {
                    if !tail[3].eq_ignore_ascii_case("delta") {
                        return None;
                    }
                    tail[3] = "delta".into();
                }
            } else {
                return None;
            }
            Some(tail)
        }
        _ => None,
    }
}

fn status_error(status: u16, retry: Option<u64>) -> Error {
    let kind = match status {
        401 => ErrorKind::Reauthenticate,
        403 => ErrorKind::AccessDenied,
        404 => ErrorKind::NotFound,
        409 | 412 => ErrorKind::Conflict,
        410 => ErrorKind::ResyncRequired,
        429 => ErrorKind::Throttled,
        500..=599 => ErrorKind::Unavailable,
        _ => ErrorKind::InvalidResponse,
    };
    Error {
        kind,
        status: Some(status),
        retry_after_seconds: if matches!(kind, ErrorKind::Throttled | ErrorKind::Unavailable) {
            retry
        } else {
            None
        },
    }
}
fn retry_after(value: &str, now: i64) -> Option<u64> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()) {
        return value.parse().ok();
    }
    let date = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .timestamp();
    Some(date.saturating_sub(now).max(0) as u64)
}

#[cfg(test)]
mod tests;
