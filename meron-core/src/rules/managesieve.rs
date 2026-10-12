//! A ManageSieve client (RFC 5804), for the reader's rules on the server
//! (#94, ADR-0027).
//!
//! Only the script Oreneta writes ([`super::sieve::SCRIPT_NAME`]) is ever
//! written or removed. A copy changed on the server since Oreneta wrote it is
//! not overwritten without the person saying so, and another active script
//! (the person's own, or another client's) is never deactivated: Sieve runs
//! one script at a time, and silently switching theirs off would stop rules
//! nobody here can see.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::sieve::SCRIPT_NAME;

pub const PORT: u16 = 4190;

/// One token of a response line.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Atom(String),
    Text(String),
}

impl Token {
    fn text(&self) -> &str {
        match self {
            Token::Atom(s) | Token::Text(s) => s,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub ok: bool,
    /// The response code in parentheses, upper-cased, e.g. "NONEXISTENT".
    pub code: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub sieve: Vec<String>,
    pub sasl: Vec<String>,
    pub starttls: bool,
    pub implementation: String,
}

pub struct Session<S> {
    io: BufReader<S>,
}

pub fn script_hash(script: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, script.as_bytes());
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn literal(text: &str) -> String {
    format!("{{{}+}}\r\n{}", text.len(), text)
}

impl<S: AsyncRead + AsyncWrite + Unpin> Session<S> {
    /// Reads the greeting (the server's capabilities).
    pub async fn open(stream: S) -> Result<(Self, Capabilities)> {
        let mut session = Session { io: BufReader::new(stream) };
        let caps = session.capabilities_reply().await?;
        Ok((session, caps))
    }

    pub fn into_inner(self) -> S {
        self.io.into_inner()
    }

    async fn line(&mut self) -> Result<String> {
        let mut line = String::new();
        let read = self.io.read_line(&mut line).await?;
        if read == 0 {
            bail!("the Sieve server closed the connection");
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }

    /// One line as tokens, literals read in full.
    async fn tokens(&mut self) -> Result<Vec<Token>> {
        let mut line = self.line().await?;
        let mut out = Vec::new();
        loop {
            let mut chars = line.char_indices().peekable();
            let mut literal_len: Option<usize> = None;
            while let Some((i, c)) = chars.next() {
                match c {
                    ' ' => {}
                    '"' => {
                        let mut text = String::new();
                        let mut escaped = false;
                        for (_, c) in chars.by_ref() {
                            match (escaped, c) {
                                (false, '\\') => escaped = true,
                                (false, '"') => break,
                                (_, c) => {
                                    text.push(c);
                                    escaped = false;
                                }
                            }
                        }
                        out.push(Token::Text(text));
                    }
                    '{' => {
                        let end = line[i..].find('}').map(|e| i + e).context("a broken literal")?;
                        let n = line[i + 1..end].trim_end_matches('+').parse::<usize>().context("a broken literal")?;
                        literal_len = Some(n);
                        break;
                    }
                    '(' => {
                        let end = line[i..].find(')').map(|e| i + e).unwrap_or(line.len() - 1);
                        out.push(Token::Atom(line[i..=end].to_string()));
                        while chars.peek().is_some_and(|(j, _)| *j <= end) {
                            chars.next();
                        }
                    }
                    _ => {
                        let end = line[i..].find(' ').map(|e| i + e).unwrap_or(line.len());
                        out.push(Token::Atom(line[i..end].to_string()));
                        while chars.peek().is_some_and(|(j, _)| *j < end) {
                            chars.next();
                        }
                    }
                }
            }
            match literal_len {
                Some(n) => {
                    let mut bytes = vec![0u8; n];
                    self.io.read_exact(&mut bytes).await?;
                    out.push(Token::Text(String::from_utf8(bytes).context("a script that is not UTF-8")?));
                    // The rest of the line after the literal.
                    line = self.line().await?;
                    if line.is_empty() {
                        return Ok(out);
                    }
                }
                None => return Ok(out),
            }
        }
    }

    /// Data lines up to the closing OK/NO/BYE.
    async fn reply(&mut self) -> Result<(Vec<Vec<Token>>, Reply)> {
        let mut data = Vec::new();
        loop {
            let tokens = self.tokens().await?;
            let head = tokens.first().map(|t| t.text().to_ascii_uppercase()).unwrap_or_default();
            if matches!(tokens.first(), Some(Token::Atom(_))) && matches!(head.as_str(), "OK" | "NO" | "BYE") {
                let mut code = String::new();
                let mut text = String::new();
                for token in &tokens[1..] {
                    match token {
                        Token::Atom(a) if a.starts_with('(') => {
                            code = a.trim_matches(['(', ')']).split_whitespace().next().unwrap_or("").to_ascii_uppercase()
                        }
                        other => text = other.text().to_string(),
                    }
                }
                return Ok((data, Reply { ok: head == "OK", code, text }));
            }
            data.push(tokens);
        }
    }

    async fn send(&mut self, command: &str) -> Result<()> {
        let stream = self.io.get_mut();
        stream.write_all(command.as_bytes()).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
        Ok(())
    }

    async fn command(&mut self, command: &str) -> Result<(Vec<Vec<Token>>, Reply)> {
        self.send(command).await?;
        self.reply().await
    }

    async fn ok(&mut self, command: &str, what: &str) -> Result<Vec<Vec<Token>>> {
        let (data, reply) = self.command(command).await?;
        if !reply.ok {
            bail!("the Sieve server refused to {what}: {}", reply.text);
        }
        Ok(data)
    }

    async fn capabilities_reply(&mut self) -> Result<Capabilities> {
        let (data, reply) = self.reply().await?;
        if !reply.ok {
            bail!("the Sieve server is not available: {}", reply.text);
        }
        let mut caps = Capabilities::default();
        for line in data {
            let name = line.first().map(|t| t.text().to_ascii_uppercase()).unwrap_or_default();
            let value = line.get(1).map(|t| t.text().to_string()).unwrap_or_default();
            match name.as_str() {
                "SIEVE" => caps.sieve = value.split_whitespace().map(str::to_lowercase).collect(),
                "SASL" => caps.sasl = value.split_whitespace().map(str::to_ascii_uppercase).collect(),
                "STARTTLS" => caps.starttls = true,
                "IMPLEMENTATION" => caps.implementation = value,
                _ => {}
            }
        }
        Ok(caps)
    }

    /// Asks to begin TLS; the caller upgrades the stream and calls
    /// [`Session::open`] again on it, which reads the new capabilities.
    pub async fn starttls(&mut self) -> Result<()> {
        self.ok("STARTTLS", "begin TLS").await.map(|_| ())
    }

    pub async fn authenticate_plain(&mut self, user: &str, password: &str) -> Result<()> {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("\0{user}\0{password}"));
        let (_, reply) = self.command(&format!("AUTHENTICATE \"PLAIN\" {}", quoted(&token))).await?;
        if !reply.ok {
            bail!("the Sieve server did not accept the account's password: {}", reply.text);
        }
        Ok(())
    }

    /// The scripts on the server, and which one is active.
    pub async fn list(&mut self) -> Result<Vec<(String, bool)>> {
        let data = self.ok("LISTSCRIPTS", "list scripts").await?;
        Ok(data
            .into_iter()
            .filter_map(|line| {
                let name = line.first()?.text().to_string();
                let active = line.get(1).is_some_and(|t| t.text().eq_ignore_ascii_case("ACTIVE"));
                Some((name, active))
            })
            .collect())
    }

    pub async fn get(&mut self, name: &str) -> Result<Option<String>> {
        let (data, reply) = self.command(&format!("GETSCRIPT {}", quoted(name))).await?;
        if !reply.ok {
            if reply.code == "NONEXISTENT" {
                return Ok(None);
            }
            bail!("the Sieve server would not hand over the script: {}", reply.text);
        }
        Ok(data.into_iter().flatten().find_map(|t| match t {
            Token::Text(text) => Some(text),
            Token::Atom(_) => None,
        }))
    }

    /// Asks the server whether it accepts a script, without storing it.
    pub async fn check(&mut self, script: &str) -> Result<()> {
        let (_, reply) = self.command(&format!("CHECKSCRIPT {}", literal(script))).await?;
        if !reply.ok {
            bail!("the server does not accept the script: {}", reply.text);
        }
        Ok(())
    }

    pub async fn put(&mut self, name: &str, script: &str) -> Result<()> {
        self.ok(&format!("PUTSCRIPT {} {}", quoted(name), literal(script)), "store the script").await.map(|_| ())
    }

    pub async fn set_active(&mut self, name: &str) -> Result<()> {
        self.ok(&format!("SETACTIVE {}", quoted(name)), "switch scripts").await.map(|_| ())
    }

    pub async fn delete(&mut self, name: &str) -> Result<()> {
        self.ok(&format!("DELETESCRIPT {}", quoted(name)), "remove the script").await.map(|_| ())
    }

    pub async fn logout(&mut self) -> Result<()> {
        let _ = self.command("LOGOUT").await;
        Ok(())
    }
}

/// Where Oreneta's script stands on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub capabilities: Capabilities,
    /// "none", "current" (as Oreneta last wrote it) or "changedElsewhere".
    pub ours: String,
    pub ours_active: bool,
    /// Another script that is active, which Oreneta never switches off.
    pub other_active: Option<String>,
}

pub async fn status<S: AsyncRead + AsyncWrite + Unpin>(
    session: &mut Session<S>,
    capabilities: Capabilities,
    last_hash: Option<&str>,
) -> Result<Status> {
    let scripts = session.list().await?;
    let ours = match session.get(SCRIPT_NAME).await? {
        None => "none",
        Some(script) if Some(script_hash(&script).as_str()) == last_hash => "current",
        Some(_) => "changedElsewhere",
    };
    Ok(Status {
        capabilities,
        ours: ours.to_string(),
        ours_active: scripts.iter().any(|(n, a)| *a && n == SCRIPT_NAME),
        other_active: scripts.into_iter().find(|(n, a)| *a && n != SCRIPT_NAME).map(|(n, _)| n),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum Pushed {
    /// Stored; active unless another script is.
    #[serde(rename_all = "camelCase")]
    Stored { hash: String, active: bool, other_active: Option<String> },
    /// The copy on the server was changed since Oreneta wrote it: shown, not
    /// overwritten, until the person says so.
    #[serde(rename_all = "camelCase")]
    ChangedElsewhere { on_server: String },
}

pub async fn push<S: AsyncRead + AsyncWrite + Unpin>(
    session: &mut Session<S>,
    script: &str,
    last_hash: Option<&str>,
    overwrite: bool,
) -> Result<Pushed> {
    if let Some(on_server) = session.get(SCRIPT_NAME).await? {
        if Some(script_hash(&on_server).as_str()) != last_hash && !overwrite {
            return Ok(Pushed::ChangedElsewhere { on_server });
        }
    }
    session.check(script).await?;
    session.put(SCRIPT_NAME, script).await?;
    let scripts = session.list().await?;
    let other_active = scripts.iter().find(|(n, a)| *a && n != SCRIPT_NAME).map(|(n, _)| n.clone());
    let active = other_active.is_none();
    if active && !scripts.iter().any(|(n, a)| *a && n == SCRIPT_NAME) {
        session.set_active(SCRIPT_NAME).await?;
    }
    Ok(Pushed::Stored { hash: script_hash(script), active, other_active })
}

/// Takes Oreneta's script off the server, leaving every other script as it
/// is. Returns whether there was one.
pub async fn remove<S: AsyncRead + AsyncWrite + Unpin>(session: &mut Session<S>) -> Result<bool> {
    let scripts = session.list().await?;
    let Some((_, active)) = scripts.iter().find(|(n, _)| n == SCRIPT_NAME) else { return Ok(false) };
    if *active {
        session.set_active("").await?;
    }
    session.delete(SCRIPT_NAME).await?;
    Ok(true)
}

/// Opens an authenticated session to an account's Sieve server: the IMAP
/// host on port 4190, TLS before anything else (implicit is not used by
/// ManageSieve, so STARTTLS), and the account's own password. Nothing is
/// sent in the clear: a server without STARTTLS is refused.
pub async fn connect(creds: &crate::imap::Creds) -> Result<(Session<crate::tls::Stream>, Capabilities)> {
    let proxy = creds.proxy.resolve();
    let cert_pin = creds.cert_pin.as_deref();
    if creds.password.is_empty() {
        bail!("this account signs in without a password, which ManageSieve cannot use");
    }
    let tcp = crate::tls::open_socket(&creds.host, PORT, proxy.as_ref())
        .await
        .with_context(|| format!("{} does not answer on the Sieve port ({PORT})", creds.host))?;
    let (mut plain, caps) = Session::open(tcp).await?;
    if !caps.starttls {
        bail!("the Sieve server does not offer TLS, so the password is not sent to it");
    }
    plain.starttls().await?;
    let tls = crate::tls::upgrade_to_tls(&creds.host, plain.into_inner(), cert_pin).await?;
    let (mut session, caps) = Session::open(crate::tls::Stream::Tls(Box::new(tls))).await?;
    if !caps.sasl.iter().any(|m| m == "PLAIN") {
        return Err(anyhow!("the Sieve server does not take a password (no PLAIN sign-in)"));
    }
    session.authenticate_plain(&creds.user, &creds.password).await?;
    Ok((session, caps))
}

#[cfg(test)]
mod tests;
