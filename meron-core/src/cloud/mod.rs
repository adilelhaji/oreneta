//! Sharing files by link from cloud storage (#108, ADR-0033).
//!
//! Nextcloud and ownCloud, over WebDAV for the upload and the OCS sharing API
//! for the link, with an app password kept in the system keychain. Nothing is
//! uploaded or shared except by the person's action; a link is view-only, and
//! what the server actually granted is checked against what was asked: a link
//! that came back more open than asked is withdrawn, not handed out.
//!
//! Dropbox, OneDrive and Google Drive need an OAuth registration owned by
//! Oreneta with each provider, which does not exist yet; they are listed as
//! unavailable rather than half-built.

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use url::Url;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS cloud_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    server TEXT NOT NULL,
    username TEXT NOT NULL,
    folder TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
";

/// Providers this build can use, and the ones it lists as unavailable.
pub const PROVIDERS: &[(&str, &str, bool)] = &[
    ("nextcloud", "Nextcloud", true),
    ("owncloud", "ownCloud", true),
    ("dropbox", "Dropbox", false),
    ("onedrive", "OneDrive", false),
    ("gdrive", "Google Drive", false),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CloudAccount {
    pub id: String,
    pub provider: String,
    pub name: String,
    /// The server's base address, e.g. `https://cloud.example.org`.
    pub server: String,
    pub username: String,
    /// Where uploads go, e.g. `Oreneta`.
    pub folder: String,
}

pub fn secret_key(id: &str) -> String {
    format!("cloud:{id}")
}

pub fn list(conn: &Connection) -> Result<Vec<CloudAccount>> {
    let mut stmt = conn.prepare(
        "SELECT id, provider, name, server, username, folder FROM cloud_accounts ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CloudAccount {
            id: r.get(0)?,
            provider: r.get(1)?,
            name: r.get(2)?,
            server: r.get(3)?,
            username: r.get(4)?,
            folder: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<CloudAccount> {
    list(conn)?.into_iter().find(|a| a.id == id).context("no such cloud storage")
}

/// Checks and stores an account; the password goes to the keychain, not here.
pub fn save(conn: &Connection, account: &CloudAccount, now: i64) -> Result<()> {
    ensure!(
        PROVIDERS.iter().any(|(id, _, usable)| *id == account.provider && *usable),
        "{} cannot be used yet",
        account.provider
    );
    base_url(&account.server)?;
    ensure!(!account.username.trim().is_empty(), "a user name is needed");
    ensure!(!account.id.trim().is_empty(), "an id is needed");
    let folder = clean_folder(&account.folder)?;
    conn.execute(
        "INSERT INTO cloud_accounts (id, provider, name, server, username, folder, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET provider = ?2, name = ?3, server = ?4, username = ?5, folder = ?6",
        params![
            account.id,
            account.provider,
            account.name.trim(),
            account.server.trim().trim_end_matches('/'),
            account.username.trim(),
            folder,
            now
        ],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM cloud_accounts WHERE id = ?1", [id])?;
    Ok(())
}

/// The server address, HTTPS only: an app password never travels in clear.
/// A loopback address is allowed for testing against a server on this machine.
pub fn base_url(server: &str) -> Result<Url> {
    let url = Url::parse(server.trim().trim_end_matches('/')).context("the server address is not valid")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]"));
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "the server address must use HTTPS"
    );
    Ok(url)
}

/// A folder path relative to the user's files: no `..`, no leading slash.
fn clean_folder(folder: &str) -> Result<String> {
    let parts: Vec<&str> = folder.split('/').map(str::trim).filter(|p| !p.is_empty()).collect();
    ensure!(!parts.iter().any(|p| *p == "." || *p == ".."), "the folder cannot go up");
    Ok(if parts.is_empty() { "Oreneta".into() } else { parts.join("/") })
}

fn encode(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn dav_url(account: &CloudAccount, path: &str) -> Result<String> {
    let base = base_url(&account.server)?;
    let path: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(encode).collect();
    Ok(format!(
        "{}/remote.php/dav/files/{}/{}",
        base.as_str().trim_end_matches('/'),
        encode(&account.username),
        path.join("/")
    ))
}

fn ocs_url(account: &CloudAccount, path: &str) -> Result<String> {
    Ok(format!("{}{path}", base_url(&account.server)?.as_str().trim_end_matches('/')))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum CloudError {
    /// The app password was refused or revoked.
    Revoked,
    /// The storage has no room for the file.
    Quota,
    Cancelled,
    /// The server gave a link other than the one asked for; it was withdrawn.
    PermissionMismatch { detail: String },
    /// The server does not allow links, or not the kind asked for.
    Unsupported { detail: String },
    Failed { status: u16, detail: String },
    Network { detail: String },
    File { detail: String },
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Revoked => write!(f, "the server refused the app password"),
            Self::Quota => write!(f, "the storage is full"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::PermissionMismatch { detail } => write!(f, "the link was not what was asked: {detail}"),
            Self::Unsupported { detail } => write!(f, "{detail}"),
            Self::Failed { status, detail } => write!(f, "the server answered {status}: {detail}"),
            Self::Network { detail } => write!(f, "{detail}"),
            Self::File { detail } => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for CloudError {}

fn status_error(status: u16, detail: &str) -> CloudError {
    match status {
        401 | 403 => CloudError::Revoked,
        507 => CloudError::Quota,
        _ => CloudError::Failed {
            status,
            detail: detail.chars().take(200).collect(),
        },
    }
}

/// The HTTP agent for cloud links, through the app-wide proxy. A proxy that is
/// configured but cannot be used is an error: falling back to a direct
/// connection would send the request (and the app password) around the proxy
/// the person chose.
fn agent() -> std::result::Result<ureq::Agent, CloudError> {
    agent_with(crate::proxy::global().as_ref())
}

fn agent_with(
    cfg: Option<&crate::proxy::ProxyConfig>,
) -> std::result::Result<ureq::Agent, CloudError> {
    crate::proxy::agent_for(cfg).map_err(|e| CloudError::Network {
        detail: format!("the proxy setting cannot be used: {e:#}"),
    })
}

fn auth(account: &CloudAccount, password: &str) -> String {
    use base64::Engine as _;
    let raw = format!("{}:{password}", account.username);
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
}

fn read_body(mut response: ureq::http::Response<ureq::Body>) -> (u16, String) {
    let status = response.status().as_u16();
    let mut text = String::new();
    let _ = response
        .body_mut()
        .as_reader()
        .take(1024 * 1024)
        .read_to_string(&mut text);
    (status, text)
}

fn request(
    method: &str,
    url: &str,
    account: &CloudAccount,
    password: &str,
    body: Option<(&str, String)>,
) -> std::result::Result<(u16, String), CloudError> {
    let agent = agent()?;
    let builder = ureq::http::Request::builder()
        .method(method)
        .uri(url)
        .header("Authorization", auth(account, password))
        .header("OCS-APIRequest", "true")
        .header("Accept", "application/json");
    let (content_type, body) = body.unwrap_or(("text/plain", String::new()));
    let request = builder
        .header("Content-Type", content_type)
        .body(body)
        .map_err(|e| CloudError::Network { detail: e.to_string() })?;
    let request = agent
        .configure_request(request)
        // MKCOL is WebDAV's, not HTTP's: ureq refuses it unless told.
        .allow_non_standard_methods(true)
        .http_status_as_error(false)
        // The app password is on the request; a redirect never carries it
        // to a host nobody checked (as for CardDAV, #28).
        .max_redirects(0)
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .build();
    let response = agent
        .run(request)
        .map_err(|e| CloudError::Network { detail: e.to_string() })?;
    Ok(read_body(response))
}

// ---- What the server allows ------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Capabilities {
    pub links: bool,
    pub password_enforced: bool,
    pub expiry_enforced: bool,
    /// The longest a link may last, when the server sets one.
    pub expiry_max_days: Option<u32>,
}

pub fn parse_capabilities(body: &str) -> std::result::Result<Capabilities, CloudError> {
    let v: Value = serde_json::from_str(body).map_err(|_| CloudError::Unsupported {
        detail: "the server did not describe what it allows".into(),
    })?;
    let public = &v["ocs"]["data"]["capabilities"]["files_sharing"]["public"];
    let expiry = &public["expire_date"];
    Ok(Capabilities {
        links: public["enabled"].as_bool().unwrap_or(false),
        password_enforced: public["password"]["enforced"].as_bool().unwrap_or(false),
        expiry_enforced: expiry["enforced"].as_bool().unwrap_or(false),
        expiry_max_days: if expiry["enabled"].as_bool().unwrap_or(false) {
            expiry["days"].as_u64().map(|d| d as u32)
        } else {
            None
        },
    })
}

pub fn capabilities(account: &CloudAccount, password: &str) -> std::result::Result<Capabilities, CloudError> {
    let url = ocs_url(account, "/ocs/v2.php/cloud/capabilities?format=json").map_err(|e| CloudError::Network {
        detail: e.to_string(),
    })?;
    let (status, body) = request("GET", &url, account, password, None)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    parse_capabilities(&body)
}

// ---- Uploading ---------------------------------------------------------------------

/// Counts what is read and stops when cancelled.
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

/// Uploads a file into the account's folder under a name not already taken,
/// and returns its path there. A cancelled or failed upload is removed.
pub fn upload(
    account: &CloudAccount,
    password: &str,
    file: &std::path::Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> std::result::Result<String, CloudError> {
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CloudError::File { detail: "the file has no name".into() })?
        .to_string();
    let size = std::fs::metadata(file)
        .map_err(|e| CloudError::File { detail: e.to_string() })?
        .len();
    let folder = clean_folder(&account.folder).map_err(|e| CloudError::File { detail: e.to_string() })?;
    let url = |path: &str| dav_url(account, path).map_err(|e| CloudError::Network { detail: e.to_string() });

    // Each level of the folder; one that exists answers 405.
    let mut so_far = String::new();
    for part in folder.split('/') {
        so_far = if so_far.is_empty() { part.to_string() } else { format!("{so_far}/{part}") };
        let (status, body) = request("MKCOL", &url(&so_far)?, account, password, None)?;
        if !(200..300).contains(&status) && status != 405 {
            return Err(status_error(status, &body));
        }
    }

    // Never over a file already there.
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.clone(), String::new()),
    };
    let mut target = format!("{folder}/{name}");
    for n in 2.. {
        let (status, body) = request("HEAD", &url(&target)?, account, password, None)?;
        match status {
            404 => break,
            200..=299 => target = format!("{folder}/{stem} ({n}){ext}"),
            _ => return Err(status_error(status, &body)),
        }
        if n > 100 {
            return Err(CloudError::File { detail: "too many files with this name".into() });
        }
    }

    let reader = std::fs::File::open(file).map_err(|e| CloudError::File { detail: e.to_string() })?;
    let watched = Watched { inner: reader, done: 0, cancel, progress };
    let put_url = url(&target)?;
    let result = agent()?
        .put(&put_url)
        .header("Authorization", &auth(account, password))
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", &size.to_string())
        .config()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .send(ureq::SendBody::from_reader(&mut { watched }));
    let outcome = match result {
        Ok(response) => {
            let (status, body) = read_body(response);
            if (200..300).contains(&status) {
                Ok(target.clone())
            } else {
                Err(status_error(status, &body))
            }
        }
        Err(_) if cancel.load(Ordering::Relaxed) => Err(CloudError::Cancelled),
        Err(e) => Err(CloudError::Network { detail: e.to_string() }),
    };
    if outcome.is_err() {
        // Best effort: nothing half-uploaded is left behind.
        let _ = request("DELETE", &put_url, account, password, None);
    }
    outcome
}

// ---- The link ------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
pub struct LinkRequest {
    /// Asked-for password; the server keeps it, this app does not.
    #[serde(default)]
    pub password: Option<String>,
    /// Last day the link works, `YYYY-MM-DD`.
    #[serde(default)]
    pub expires: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Link {
    pub id: String,
    pub url: String,
    pub path: String,
    /// What the server granted, read back: always view only here.
    pub view_only: bool,
    pub expires: Option<String>,
    pub password_protected: bool,
}

/// Creates a view-only link and checks the server gave exactly that. A link
/// that came back otherwise is deleted and reported.
pub fn share(
    account: &CloudAccount,
    password: &str,
    path: &str,
    want: &LinkRequest,
    caps: &Capabilities,
) -> std::result::Result<Link, CloudError> {
    if !caps.links {
        return Err(CloudError::Unsupported { detail: "this server does not allow links".into() });
    }
    let has_password = want.password.as_deref().is_some_and(|p| !p.is_empty());
    if caps.password_enforced && !has_password {
        return Err(CloudError::Unsupported { detail: "this server requires a password on links".into() });
    }
    if caps.expiry_enforced && want.expires.is_none() {
        return Err(CloudError::Unsupported { detail: "this server requires links to expire".into() });
    }
    if let Some(day) = &want.expires {
        chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .map_err(|_| CloudError::File { detail: "the expiry date is not valid".into() })?;
    }
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("path", &format!("/{path}"));
    form.append_pair("shareType", "3");
    form.append_pair("permissions", "1");
    if let Some(p) = want.password.as_deref().filter(|p| !p.is_empty()) {
        form.append_pair("password", p);
    }
    if let Some(day) = &want.expires {
        form.append_pair("expireDate", day);
    }
    let url = ocs_url(account, "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json")
        .map_err(|e| CloudError::Network { detail: e.to_string() })?;
    let (status, body) = request(
        "POST",
        &url,
        account,
        password,
        Some(("application/x-www-form-urlencoded", form.finish())),
    )?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| CloudError::Failed {
        status,
        detail: "the server's answer could not be read".into(),
    })?;
    let data = &v["ocs"]["data"];
    let id = match &data["id"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let link = Link {
        id: id.clone(),
        url: data["url"].as_str().unwrap_or_default().to_string(),
        path: path.to_string(),
        view_only: data["permissions"].as_u64() == Some(1),
        expires: data["expiration"].as_str().map(|s| s.chars().take(10).collect()),
        password_protected: data["password"].as_str().is_some_and(|s| !s.is_empty())
            || data["share_with"].as_str().is_some_and(|s| !s.is_empty()),
    };
    let mismatch = if !link.view_only {
        Some("it would let people change the file".to_string())
    } else if want.expires.is_some() && link.expires != want.expires {
        Some(format!(
            "it expires {} instead of {}",
            link.expires.as_deref().unwrap_or("never"),
            want.expires.as_deref().unwrap_or_default()
        ))
    } else if has_password && !link.password_protected {
        Some("it has no password".to_string())
    } else if link.url.is_empty() || !link.url.starts_with("https://") && base_url(&account.server).is_ok_and(|u| u.scheme() == "https") {
        Some("it has no secure address".to_string())
    } else {
        None
    };
    if let Some(detail) = mismatch {
        if !id.is_empty() {
            let _ = revoke(account, password, &id);
        }
        return Err(CloudError::PermissionMismatch { detail });
    }
    Ok(link)
}

/// Withdraws a link.
pub fn revoke(account: &CloudAccount, password: &str, id: &str) -> Result<()> {
    let url = ocs_url(account, &format!("/ocs/v2.php/apps/files_sharing/api/v1/shares/{}", encode(id)))?;
    let (status, body) = request("DELETE", &url, account, password, None).map_err(anyhow::Error::new)?;
    if !(200..300).contains(&status) {
        bail!(status_error(status, &body));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
