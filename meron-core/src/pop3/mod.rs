//! POP3 accounts (#97, ADR-0035).
//!
//! POP3 only hands out a mailbox's messages; it keeps no folders, flags or
//! threads. So a POP3 account is read like the local archive (ADR-0014): its
//! messages live in this database, in its own Inbox, and everything else is
//! done here. Sending goes through the account's SMTP server as usual.
//!
//! - **Identity:** a message is known by its server's UIDL. A server that
//!   renumbers its UIDLs would hand everything out again, so each message's
//!   bytes are also hashed and a message already here is never stored twice.
//! - **Nothing deleted unasked:** messages stay on the server unless the
//!   person chooses otherwise (after some days, or when deleted here). A
//!   deletion takes effect only when the session ends cleanly (`QUIT`); a
//!   connection lost before that deletes nothing, and it is tried again.
//! - **Nothing half-stored:** a message is stored only once its download is
//!   complete; a broken download leaves nothing and is fetched again.
//! - **No password in clear:** implicit TLS or STLS, or the password is not
//!   sent.

use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pop3_seen (
    account TEXT NOT NULL,
    uidl TEXT NOT NULL,
    hash TEXT NOT NULL,
    uid INTEGER,
    fetched_at INTEGER NOT NULL,
    deleted_on_server INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account, uidl)
);
CREATE INDEX IF NOT EXISTS pop3_seen_hash ON pop3_seen(account, hash);
CREATE TABLE IF NOT EXISTS pop3_policy (
    account TEXT PRIMARY KEY,
    policy TEXT NOT NULL DEFAULT 'keep',
    days INTEGER NOT NULL DEFAULT 0
);
";

/// Where downloaded mail goes.
pub const INBOX: &str = "INBOX";
/// A message larger than this is refused rather than kept in memory whole.
pub const MAX_MESSAGE_BYTES: usize = crate::archive::MAX_MESSAGE_BYTES;

// ---- Policy --------------------------------------------------------------------------

/// When messages are deleted from the server. Keeping them is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "policy", rename_all = "camelCase")]
pub enum Retention {
    Keep,
    /// Deleted from the server this many days after they were downloaded.
    AfterDays { days: u32 },
    /// Deleted from the server once deleted here.
    WhenDeletedHere,
}

pub fn retention(conn: &Connection, account: &str) -> Result<Retention> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT policy, days FROM pop3_policy WHERE account = ?1",
            [account],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        Some((p, d)) if p == "days" && d > 0 => Retention::AfterDays { days: d as u32 },
        Some((p, _)) if p == "deleted" => Retention::WhenDeletedHere,
        _ => Retention::Keep,
    })
}

/// Whether anything was ever downloaded for `account`. A first download
/// brings the server's backlog, which is not new mail to announce (#270);
/// an Inbox emptied by the person afterwards is not a first download.
pub fn has_downloaded(conn: &Connection, account: &str) -> Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM pop3_seen WHERE account = ?1 LIMIT 1", params![account], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn set_retention(conn: &Connection, account: &str, retention: Retention) -> Result<()> {
    let (policy, days) = match retention {
        Retention::Keep => ("keep", 0),
        Retention::AfterDays { days } => {
            ensure!(days >= 1, "at least one day");
            ("days", days as i64)
        }
        Retention::WhenDeletedHere => ("deleted", 0),
    };
    conn.execute(
        "INSERT INTO pop3_policy(account, policy, days) VALUES(?1, ?2, ?3)
         ON CONFLICT(account) DO UPDATE SET policy = ?2, days = ?3",
        params![account, policy, days],
    )?;
    Ok(())
}

// ---- The protocol ----------------------------------------------------------------------

pub struct Client<S> {
    io: BufReader<S>,
}

#[derive(Debug, Default, Clone)]
pub struct Capabilities {
    pub stls: bool,
    pub uidl: bool,
    pub user: bool,
    pub sasl: Vec<String>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Client<S> {
    /// Reads the greeting.
    pub async fn open(stream: S) -> Result<Self> {
        let mut client = Client { io: BufReader::new(stream) };
        client.status().await.context("the POP3 server's greeting")?;
        Ok(client)
    }

    pub fn into_inner(self) -> S {
        self.io.into_inner()
    }

    async fn line(&mut self) -> Result<String> {
        let mut line = String::new();
        let n = tokio::time::timeout(std::time::Duration::from_secs(60), self.io.read_line(&mut line))
            .await
            .map_err(|_| anyhow!("the POP3 server stopped answering"))??;
        ensure!(n > 0, "the POP3 server closed the connection");
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }

    async fn status(&mut self) -> Result<String> {
        let line = self.line().await?;
        if let Some(rest) = line.strip_prefix("+OK") {
            Ok(rest.trim().to_string())
        } else {
            bail!("the POP3 server refused: {}", line.strip_prefix("-ERR").unwrap_or(&line).trim())
        }
    }

    async fn send(&mut self, command: &str) -> Result<()> {
        let stream = self.io.get_mut();
        stream.write_all(command.as_bytes()).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
        Ok(())
    }

    async fn command(&mut self, command: &str) -> Result<String> {
        self.send(command).await?;
        self.status().await
    }

    /// A multi-line answer, dot-unstuffed, up to `limit` bytes. Anything not
    /// ending in the terminating dot is an error: a cut answer is not used.
    async fn multiline(&mut self, limit: usize) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        loop {
            let mut raw = Vec::new();
            let n = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                self.io.read_until(b'\n', &mut raw),
            )
            .await
            .map_err(|_| anyhow!("the POP3 server stopped sending"))??;
            ensure!(n > 0 && raw.ends_with(b"\n"), "the download was cut off");
            let line = raw.strip_suffix(b"\r\n").or_else(|| raw.strip_suffix(b"\n")).unwrap_or(&raw);
            if line == b"." {
                return Ok(out);
            }
            let line = line.strip_prefix(b".").unwrap_or(line);
            ensure!(out.len() + line.len() + 2 <= limit, "the message is too large to download");
            out.extend_from_slice(line);
            out.extend_from_slice(b"\r\n");
        }
    }

    pub async fn capabilities(&mut self) -> Result<Capabilities> {
        let mut caps = Capabilities::default();
        if self.command("CAPA").await.is_err() {
            // An old server without CAPA: assume the basics.
            caps.uidl = true;
            caps.user = true;
            return Ok(caps);
        }
        let text = String::from_utf8_lossy(&self.multiline(64 * 1024).await?).to_string();
        for line in text.lines() {
            let mut words = line.split_whitespace();
            match words.next().map(str::to_ascii_uppercase).as_deref() {
                Some("STLS") => caps.stls = true,
                Some("UIDL") => caps.uidl = true,
                Some("USER") => caps.user = true,
                Some("SASL") => caps.sasl = words.map(str::to_ascii_uppercase).collect(),
                _ => {}
            }
        }
        Ok(caps)
    }

    pub async fn stls(&mut self) -> Result<()> {
        self.command("STLS").await.map(|_| ())
    }

    pub async fn login(&mut self, user: &str, password: &str) -> Result<()> {
        ensure!(!user.contains(['\r', '\n']) && !password.contains(['\r', '\n']), "invalid characters");
        self.command(&format!("USER {user}")).await?;
        self.command(&format!("PASS {password}"))
            .await
            .map_err(|_| anyhow!("the POP3 server did not accept the user name and password"))?;
        Ok(())
    }

    /// Every message's number and UIDL.
    pub async fn uidls(&mut self) -> Result<Vec<(u32, String)>> {
        self.command("UIDL").await?;
        let text = String::from_utf8_lossy(&self.multiline(16 * 1024 * 1024).await?).to_string();
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let mut parts = l.split_whitespace();
                let n = parts.next().and_then(|n| n.parse().ok()).context("a UIDL line without a number")?;
                let uidl = parts.next().context("a UIDL line without an id")?.to_string();
                Ok((n, uidl))
            })
            .collect()
    }

    /// Every message's number and size.
    pub async fn sizes(&mut self) -> Result<HashMap<u32, usize>> {
        self.command("LIST").await?;
        let text = String::from_utf8_lossy(&self.multiline(16 * 1024 * 1024).await?).to_string();
        Ok(text
            .lines()
            .filter_map(|l| {
                let mut parts = l.split_whitespace();
                Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
            })
            .collect())
    }

    pub async fn retr(&mut self, n: u32) -> Result<Vec<u8>> {
        self.command(&format!("RETR {n}")).await?;
        self.multiline(MAX_MESSAGE_BYTES + 64 * 1024).await
    }

    pub async fn dele(&mut self, n: u32) -> Result<()> {
        self.command(&format!("DELE {n}")).await.map(|_| ())
    }

    /// Ends the session; only now does the server delete what was marked.
    pub async fn quit(&mut self) -> Result<()> {
        self.command("QUIT").await.map(|_| ())
    }
}

/// Connects and signs in, over TLS from the start or after STLS. A server
/// offering neither is not sent the password.
pub async fn connect(creds: &crate::imap::Creds) -> Result<Client<crate::tls::Stream>> {
    let proxy = creds.proxy.resolve()?;
    let pin = creds.cert_pin.as_deref();
    let mut client = if creds.tls && !creds.starttls {
        Client::open(crate::tls::connect_stream(&creds.host, creds.port, true, proxy.as_ref(), pin).await?).await?
    } else {
        let tcp = crate::tls::open_socket(&creds.host, creds.port, proxy.as_ref()).await?;
        let mut plain = Client::open(crate::tls::Stream::Plain(tcp)).await?;
        let caps = plain.capabilities().await?;
        if !caps.stls {
            bail!("the POP3 server does not offer TLS, so the password is not sent to it");
        }
        plain.stls().await?;
        let crate::tls::Stream::Plain(tcp) = plain.into_inner() else { unreachable!() };
        Client::open_after_tls(crate::tls::Stream::Tls(Box::new(
            crate::tls::upgrade_to_tls(&creds.host, tcp, pin).await?,
        )))
    };
    client.login(&creds.user, &creds.password).await?;
    Ok(client)
}

/// Speaks POP3 up to the STLS upgrade and hands back the raw socket, for the
/// certificate probe (see [`crate::tls::probe`]); nothing of the sign-in is
/// ever sent over it.
pub(crate) async fn starttls_socket(tcp: tokio::net::TcpStream) -> Result<tokio::net::TcpStream> {
    let mut plain = Client::open(crate::tls::Stream::Plain(tcp)).await?;
    plain.stls().await.context("STLS")?;
    match plain.into_inner() {
        crate::tls::Stream::Plain(tcp) => Ok(tcp),
        crate::tls::Stream::Tls(_) => bail!("STLS requested on an already-TLS stream"),
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> Client<S> {
    /// After STLS there is no new greeting.
    pub(crate) fn open_after_tls(stream: S) -> Self {
        Client { io: BufReader::new(stream) }
    }
}

/// The lock one account's downloads take turns on.
pub fn account_lock(account: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
        std::sync::OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(account.to_string())
        .or_default()
        .clone()
}

// ---- Fetching ----------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct FetchSummary {
    pub downloaded: usize,
    /// Messages the server listed under a new UIDL that were already here.
    pub already_here: usize,
    /// Messages refused: not mail, or too large.
    pub skipped: usize,
    pub deleted_on_server: usize,
}

fn hash(raw: &[u8]) -> String {
    Sha256::digest(raw).iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads what is new, then deletes from the server what the retention
/// policy says, if anything. Messages stored before an error stay stored.
pub async fn fetch<S: AsyncRead + AsyncWrite + Unpin>(
    db: &std::sync::Mutex<Connection>,
    account: &str,
    client: &mut Client<S>,
    now: i64,
    media_root: &std::path::Path,
) -> Result<FetchSummary> {
    let mut summary = FetchSummary::default();
    let listed = client.uidls().await?;
    let sizes = client.sizes().await?;
    let (known, hashes): (HashSet<String>, HashSet<String>) = {
        let conn = db.lock().unwrap();
        crate::store::ensure_folder(&conn, account, INBOX)?;
        let mut stmt = conn.prepare("SELECT uidl, hash FROM pop3_seen WHERE account = ?1")?;
        let rows = stmt
            .query_map([account], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (rows.iter().map(|r| r.0.clone()).collect(), rows.into_iter().map(|r| r.1).collect())
    };
    let mut hashes = hashes;
    for (n, uidl) in &listed {
        if known.contains(uidl) {
            continue;
        }
        if sizes.get(n).is_some_and(|size| *size > MAX_MESSAGE_BYTES) {
            summary.skipped += 1;
            continue;
        }
        let raw = client.retr(*n).await?;
        let digest = hash(&raw);
        let conn = db.lock().unwrap();
        if hashes.contains(&digest) || stored_already(&conn, account, &raw, &digest)? {
            // The server renumbered it: already here, never stored twice.
            conn.execute(
                "INSERT OR IGNORE INTO pop3_seen(account, uidl, hash, uid, fetched_at) VALUES(?1, ?2, ?3, NULL, ?4)",
                params![account, uidl, digest, now],
            )?;
            summary.already_here += 1;
            continue;
        }
        if !crate::archive::looks_like_message(&raw) {
            // Recorded so it is not fetched on every check; left on the server.
            conn.execute(
                "INSERT OR IGNORE INTO pop3_seen(account, uidl, hash, uid, fetched_at) VALUES(?1, ?2, ?3, NULL, ?4)",
                params![account, uidl, digest, now],
            )?;
            summary.skipped += 1;
            continue;
        }
        let uid = crate::archive::store_message(&conn, account, INBOX, &raw, false, false, media_root)?;
        conn.execute(
            "INSERT OR REPLACE INTO pop3_seen(account, uidl, hash, uid, fetched_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![account, uidl, digest, uid, now],
        )?;
        hashes.insert(digest);
        summary.downloaded += 1;
    }

    // What the person chose to delete from the server, if anything.
    let doomed = {
        let conn = db.lock().unwrap();
        to_delete(&conn, account, &listed, now)?
    };
    for (n, _) in &doomed {
        client.dele(*n).await?;
    }
    // Only a clean end makes the deletions real; then they are recorded.
    client.quit().await?;
    if !doomed.is_empty() {
        let conn = db.lock().unwrap();
        for (_, uidl) in &doomed {
            conn.execute(
                "UPDATE pop3_seen SET deleted_on_server = 1 WHERE account = ?1 AND uidl = ?2",
                params![account, uidl],
            )?;
        }
        summary.deleted_on_server = doomed.len();
    }
    Ok(summary)
}

/// Whether this exact message is already stored in the account, though not
/// noted as downloaded (the app stopped between storing and noting it):
/// found by its Message-ID, confirmed by its bytes.
fn stored_already(conn: &Connection, account: &str, raw: &[u8], digest: &str) -> Result<bool> {
    let id = crate::imap::header_fields(crate::archive::header_block(raw)).message_id;
    if id.is_empty() {
        return Ok(false);
    }
    let mut stmt = conn.prepare(
        "SELECT a.raw FROM archive_messages a
           JOIN messages m ON m.account = a.account AND m.folder = a.folder AND m.uid = a.uid
          WHERE a.account = ?1 AND lower(json_extract(m.json, '$.message_id')) = lower(?2)",
    )?;
    let rows = stmt.query_map(params![account, id], |r| r.get::<_, Vec<u8>>(0))?;
    for row in rows {
        if hash(&row?) == digest {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The listed messages the policy says to delete from the server now.
fn to_delete(conn: &Connection, account: &str, listed: &[(u32, String)], now: i64) -> Result<Vec<(u32, String)>> {
    let policy = retention(conn, account)?;
    if policy == Retention::Keep {
        return Ok(Vec::new());
    }
    let present = if policy == Retention::WhenDeletedHere { present_hashes(conn, account)? } else { HashSet::new() };
    let mut out = Vec::new();
    for (n, uidl) in listed {
        let row: Option<(Option<i64>, i64, String)> = conn
            .query_row(
                "SELECT uid, fetched_at, hash FROM pop3_seen WHERE account = ?1 AND uidl = ?2",
                params![account, uidl],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        // Only what was safely stored here: never something only on the server.
        let Some((Some(_), fetched_at, hash)) = row else { continue };
        let delete = match policy {
            Retention::Keep => false,
            Retention::AfterDays { days } => now - fetched_at >= days as i64 * 86_400,
            Retention::WhenDeletedHere => !present.contains(&hash),
        };
        if delete {
            out.push((*n, uidl.clone()));
        }
    }
    Ok(out)
}

/// The messages this account still holds, by hash, outside its Trash: a
/// message moved to another folder is kept; one in Trash or gone is deleted.
fn present_hashes(conn: &Connection, account: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT raw FROM archive_messages WHERE account = ?1 AND folder <> ?2")?;
    let rows = stmt.query_map(params![account, crate::archive::TRASH], |r| r.get::<_, Vec<u8>>(0))?;
    rows.map(|raw| Ok(hash(&raw?))).collect()
}

#[cfg(test)]
mod tests;
