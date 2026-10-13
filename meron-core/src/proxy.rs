//! Outbound proxy support: HTTP CONNECT and SOCKS5 for the mail sockets, and
//! the matching `ureq` agent for the blocking HTTP paths (feeds, OAuth token
//! exchange, avatars, changelog).
//!
//! Two levels of configuration. A single app-wide proxy lives in the `settings`
//! table under [`SETTING_KEY`] and is mirrored into a process-global slot
//! ([`set_global`]) so socket code deep in the IMAP/SMTP stack can reach it
//! without threading a DB handle through every call. Each account then carries a
//! [`ProxyChoice`]: inherit the global one (the default), force a direct
//! connection, or use its own proxy.
//!
//! A proxy that was chosen but cannot be used (a mode with no host or port, an
//! unknown mode, a setting that could not be read) is an error, never "no
//! proxy": the person asked for their traffic to go through it, so nothing
//! connects directly in its place (#192). [`global`] and
//! [`ProxyChoice::resolve`] return that error, and every caller passes it on.
//!
//! Hostnames are always resolved by the proxy, never locally: SOCKS5 gets the
//! domain address type and HTTP CONNECT gets `host:port`. A proxy that leaks
//! every mail server's name to the local resolver would defeat the point of
//! routing the traffic through it at all.

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::sync::RwLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Settings-table key holding the app-wide proxy (see [`parse_global`]).
pub const SETTING_KEY: &str = "proxy";

/// How to speak to the proxy server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyKind {
    /// HTTP CONNECT tunnel (RFC 7231 §4.3.6).
    Http,
    /// SOCKS5 (RFC 1928) with optional username/password auth (RFC 1929).
    Socks5,
}

impl ProxyKind {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "http" => Some(ProxyKind::Http),
            "socks5" => Some(ProxyKind::Socks5),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            ProxyKind::Http => "http",
            ProxyKind::Socks5 => "socks5",
        }
    }
}

/// A resolved proxy endpoint. Empty `username` means no authentication.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl ProxyConfig {
    fn from_json(v: &Value) -> Option<Self> {
        let kind = ProxyKind::parse(v["mode"].as_str().unwrap_or(""))?;
        let host = v["host"].as_str().unwrap_or("").trim().to_string();
        let port = v["port"].as_u64().unwrap_or(0) as u16;
        // A half-filled form is not a proxy. Treating it as one would silently
        // send every connection to port 0 on the empty host.
        if host.is_empty() || port == 0 {
            return None;
        }
        Some(ProxyConfig {
            kind,
            host,
            port,
            username: v["username"].as_str().unwrap_or("").to_string(),
            password: v["password"].as_str().unwrap_or("").to_string(),
        })
    }

    fn to_json(&self) -> Value {
        json!({
            "mode": self.kind.as_str(),
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "password": self.password,
        })
    }

    /// `host:port`, for logs and CONNECT targets.
    fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// What an individual account does about proxying.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum ProxyChoice {
    /// Follow the app-wide setting. The default, and what every pre-existing
    /// account deserializes to.
    #[default]
    Global,
    /// Ignore the app-wide setting and connect directly.
    Direct,
    /// This account's own proxy.
    Custom(ProxyConfig),
    /// An own proxy that cannot be used: a mode with no host or port, or an
    /// unknown mode. Kept as stored so the settings show it as entered, and
    /// refused by [`resolve`](Self::resolve) rather than replaced by another
    /// route (#192).
    Unusable(Value),
}

impl ProxyChoice {
    pub fn from_json(v: &Value) -> Self {
        match v["mode"].as_str().unwrap_or("global") {
            "direct" => ProxyChoice::Direct,
            "global" => ProxyChoice::Global,
            // Anything else is a proxy kind; one that cannot be used is kept,
            // and refused when the account connects.
            _ => ProxyConfig::from_json(v)
                .map_or_else(|| ProxyChoice::Unusable(v.clone()), ProxyChoice::Custom),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            ProxyChoice::Global => json!({ "mode": "global" }),
            ProxyChoice::Direct => json!({ "mode": "direct" }),
            ProxyChoice::Custom(cfg) => cfg.to_json(),
            ProxyChoice::Unusable(v) => v.clone(),
        }
    }

    /// The proxy this account connects through: `None` for a direct
    /// connection, an error when the chosen proxy (its own or the app-wide
    /// one) cannot be used.
    pub fn resolve(&self) -> Result<Option<ProxyConfig>> {
        match self {
            ProxyChoice::Global => global(),
            ProxyChoice::Direct => Ok(None),
            ProxyChoice::Custom(cfg) => Ok(Some(cfg.clone())),
            ProxyChoice::Unusable(v) => Err(unusable(v, "this account's proxy")),
        }
    }
}

/// Why a stored proxy setting cannot be used.
fn unusable(v: &Value, whose: &str) -> anyhow::Error {
    match v.get("mode").and_then(Value::as_str) {
        Some("http" | "socks5") => anyhow!("{whose} is incomplete (host or port missing)"),
        Some(other) => anyhow!("{whose} has an unknown mode {other:?}"),
        None => anyhow!("{whose} has no mode"),
    }
}

/// The app-wide proxy as published: off, a proxy, or a proxy that was chosen
/// but cannot be used, with the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
enum GlobalProxy {
    Off,
    On(ProxyConfig),
    Unusable(String),
}

static GLOBAL: RwLock<GlobalProxy> = RwLock::new(GlobalProxy::Off);

fn publish(state: GlobalProxy) {
    // A poisoned lock still holds the last state; overwrite it all the same.
    let mut slot = GLOBAL.write().unwrap_or_else(|err| err.into_inner());
    *slot = state;
}

/// Publish the app-wide proxy from its stored setting. Called once at engine
/// start, and again whenever the setting is saved. A setting that cannot be
/// used is published as such, so connections fail instead of going direct.
///
/// Existing pooled IMAP sessions and IDLE watchers keep their current sockets;
/// the new setting takes effect as those reconnect.
pub fn publish_global(v: &Value) {
    publish(match strict_global(v) {
        Ok(None) => GlobalProxy::Off,
        Ok(Some(cfg)) => GlobalProxy::On(cfg),
        Err(err) => GlobalProxy::Unusable(format!("{err:#}")),
    });
}

/// Publish a known proxy, or none, for callers that already hold a resolved
/// configuration (and tests).
pub fn set_global(cfg: Option<ProxyConfig>) {
    publish(cfg.map_or(GlobalProxy::Off, GlobalProxy::On));
}

/// Serializes the tests that write the process-global slot; the default test
/// runner is multi-threaded, and a stray publish from another test would make
/// assertions about the global flaky.
#[cfg(test)]
pub(crate) static TEST_GLOBAL_LOCK: RwLock<()> = RwLock::new(());

/// The app-wide proxy: `None` when it is off, an error when one was chosen
/// but cannot be used.
pub fn global() -> Result<Option<ProxyConfig>> {
    match &*GLOBAL.read().unwrap_or_else(|err| err.into_inner()) {
        GlobalProxy::Off => Ok(None),
        GlobalProxy::On(cfg) => Ok(Some(cfg.clone())),
        GlobalProxy::Unusable(reason) => Err(anyhow!("{reason}")),
    }
}

/// Load the persisted app-wide proxy into the process-global slot.
pub fn load_global(conn: &rusqlite::Connection) -> Result<()> {
    // Every engine/init in this process republishes from its own store. Tests
    // build many of those against throwaway databases, so hold the shared lock
    // to stay out of the way of a test asserting on the global.
    #[cfg(test)]
    let _serialize = TEST_GLOBAL_LOCK
        .read()
        .unwrap_or_else(|err| err.into_inner());
    publish_from_store(conn)
}

/// [`load_global`] without the test lock, for a test that already holds it.
fn publish_from_store(conn: &rusqlite::Connection) -> Result<()> {
    match crate::store::settings_get(conn, &[SETTING_KEY.to_string()]) {
        Ok(stored) => {
            publish_global(&stored[SETTING_KEY]);
            Ok(())
        }
        // Not knowing whether a proxy was chosen is not knowing that none
        // was: hold every connection until the setting can be read.
        Err(err) => {
            publish(GlobalProxy::Unusable(format!(
                "the proxy setting could not be read: {err:#}"
            )));
            Err(err)
        }
    }
}

/// The app-wide proxy read strictly, for callers outside the core (the Go
/// bridge) that must fail closed: "off" or no setting is `None`, a usable
/// proxy is `Some`, and a proxy mode with a missing host or port, or an unknown
/// mode, is an error instead of a silent direct connection.
pub fn strict_global(v: &Value) -> Result<Option<ProxyConfig>> {
    match v.get("mode").and_then(Value::as_str).unwrap_or("off") {
        "off" | "" => Ok(None),
        "http" | "socks5" => ProxyConfig::from_json(v)
            .map(Some)
            .ok_or_else(|| unusable(v, "the proxy setting")),
        _ => Err(unusable(v, "the proxy setting")),
    }
}

/// The proxy one outbound HTTP request should use, as JSON for the Go bridge:
/// `{"proxy": null}` for a direct connection, otherwise
/// `{"proxy": {"mode","host","port","username","password"}}`. With an account
/// it follows that account's choice (inherit, direct or its own; an unknown
/// account inherits); without one
/// it is the app-wide setting, read from the store so it never lags a save.
pub fn route_json(conn: &rusqlite::Connection, account: Option<&str>) -> Result<Value> {
    let global = || -> Result<Option<ProxyConfig>> {
        let stored = crate::store::settings_get(conn, &[SETTING_KEY.to_string()])?;
        strict_global(&stored[SETTING_KEY])
    };
    let route = match account {
        None => global()?,
        // An account that is not stored yet (its avatar is fetched while it
        // is being added) gets the default choice: the app-wide proxy.
        Some(id) => match crate::store::load_account(conn, id)?.map(|c| c.proxy) {
            None | Some(ProxyChoice::Global) => global()?,
            Some(choice) => choice.resolve()?,
        },
    };
    Ok(json!({ "proxy": route.map(|cfg| cfg.to_json()) }))
}

/// Open a TCP connection to `host:port` *through* `proxy`.
///
/// The socket to the proxy itself is made with the ordinary connect path, so it
/// inherits the per-address timeouts and slow-DNS logging.
pub async fn connect_through(proxy: &ProxyConfig, host: &str, port: u16) -> Result<TcpStream> {
    connect_through_with_timeout(proxy, host, port, std::time::Duration::from_secs(15)).await
}

async fn connect_through_with_timeout(
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
    handshake_timeout: std::time::Duration,
) -> Result<TcpStream> {
    let mut tcp = crate::imap::connect_tcp(&proxy.host, proxy.port)
        .await
        .with_context(|| format!("connect to proxy {}", proxy.endpoint()))?;
    let handshake = tokio::time::timeout(handshake_timeout, async {
        match proxy.kind {
            ProxyKind::Http => http_connect(&mut tcp, proxy, host, port).await,
            ProxyKind::Socks5 => socks5_connect(&mut tcp, proxy, host, port).await,
        }
    })
    .await
    .map_err(|_| anyhow!("proxy handshake timed out"))?;
    handshake.with_context(|| {
        format!(
            "{} proxy {} to {host}:{port}",
            proxy.kind.as_str(),
            proxy.endpoint()
        )
    })?;
    Ok(tcp)
}

// ---- HTTP CONNECT -----------------------------------------------------------

async fn http_connect(
    tcp: &mut TcpStream,
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<()> {
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !proxy.username.is_empty() {
        use base64::Engine as _;
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", proxy.username, proxy.password));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    tcp.write_all(req.as_bytes())
        .await
        .context("send CONNECT")?;
    tcp.flush().await.context("send CONNECT")?;

    // Read until the blank line ending the response head. Bounded, so a proxy
    // that answers with an endless header stream can't be used to exhaust
    // memory here.
    const MAX_HEAD: usize = 8 * 1024;
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD {
            return Err(anyhow!("response head too large"));
        }
        let n = tcp.read(&mut byte).await.context("read CONNECT response")?;
        if n == 0 {
            return Err(anyhow!("proxy closed the connection"));
        }
        head.push(byte[0]);
    }

    let status_line = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    // "HTTP/1.1 200 Connection established"
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("malformed response: {status_line:?}"))?;
    match code {
        200..=299 => Ok(()),
        407 => Err(anyhow!("proxy authentication required")),
        _ => Err(anyhow!("proxy refused: {status_line}")),
    }
}

// ---- SOCKS5 -----------------------------------------------------------------

const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_AUTH_NONE: u8 = 0x00;
const SOCKS5_AUTH_USERPASS: u8 = 0x02;
const SOCKS5_AUTH_UNACCEPTABLE: u8 = 0xFF;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_ADDR_IPV4: u8 = 0x01;
const SOCKS5_ADDR_DOMAIN: u8 = 0x03;
const SOCKS5_ADDR_IPV6: u8 = 0x04;

async fn socks5_connect(
    tcp: &mut TcpStream,
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<()> {
    let authenticating = !proxy.username.is_empty();
    // Offer user/pass only when we have credentials, so an open proxy doesn't
    // see a method it would have to reject.
    let greeting: Vec<u8> = if authenticating {
        vec![SOCKS5_VERSION, 2, SOCKS5_AUTH_NONE, SOCKS5_AUTH_USERPASS]
    } else {
        vec![SOCKS5_VERSION, 1, SOCKS5_AUTH_NONE]
    };
    tcp.write_all(&greeting).await.context("send greeting")?;
    tcp.flush().await.context("send greeting")?;

    let mut reply = [0u8; 2];
    tcp.read_exact(&mut reply)
        .await
        .context("read method selection")?;
    if reply[0] != SOCKS5_VERSION {
        return Err(anyhow!("not a SOCKS5 proxy (version {})", reply[0]));
    }
    match reply[1] {
        SOCKS5_AUTH_NONE => {}
        SOCKS5_AUTH_USERPASS if authenticating => socks5_userpass(tcp, proxy).await?,
        SOCKS5_AUTH_UNACCEPTABLE => {
            return Err(anyhow!(if authenticating {
                "proxy rejected the offered authentication methods"
            } else {
                "proxy requires authentication"
            }));
        }
        method => return Err(anyhow!("unsupported authentication method {method:#04x}")),
    }

    // CONNECT with the domain address type: the proxy resolves, we don't.
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        return Err(anyhow!("hostname too long for SOCKS5"));
    }
    let mut request = vec![
        SOCKS5_VERSION,
        SOCKS5_CMD_CONNECT,
        0x00, // reserved
        SOCKS5_ADDR_DOMAIN,
        host_bytes.len() as u8,
    ];
    request.extend_from_slice(host_bytes);
    request.extend_from_slice(&port.to_be_bytes());
    tcp.write_all(&request).await.context("send connect")?;
    tcp.flush().await.context("send connect")?;

    let mut head = [0u8; 4];
    tcp.read_exact(&mut head).await.context("read connect")?;
    if head[0] != SOCKS5_VERSION {
        return Err(anyhow!("not a SOCKS5 proxy (version {})", head[0]));
    }
    if head[1] != 0x00 {
        return Err(anyhow!("{}", socks5_error(head[1])));
    }
    // Drain the bound address so the stream starts at the tunnelled payload.
    let addr_len = match head[3] {
        SOCKS5_ADDR_IPV4 => 4,
        SOCKS5_ADDR_IPV6 => 16,
        SOCKS5_ADDR_DOMAIN => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await.context("read bound host")?;
            len[0] as usize
        }
        other => return Err(anyhow!("unknown address type {other:#04x} in reply")),
    };
    let mut rest = vec![0u8; addr_len + 2]; // address + port
    tcp.read_exact(&mut rest).await.context("read bound addr")?;
    Ok(())
}

async fn socks5_userpass(tcp: &mut TcpStream, proxy: &ProxyConfig) -> Result<()> {
    let user = proxy.username.as_bytes();
    let pass = proxy.password.as_bytes();
    if user.len() > 255 || pass.len() > 255 {
        return Err(anyhow!("proxy credentials too long"));
    }
    let mut msg = vec![0x01, user.len() as u8]; // sub-negotiation version 1
    msg.extend_from_slice(user);
    msg.push(pass.len() as u8);
    msg.extend_from_slice(pass);
    tcp.write_all(&msg).await.context("send credentials")?;
    tcp.flush().await.context("send credentials")?;

    let mut reply = [0u8; 2];
    tcp.read_exact(&mut reply)
        .await
        .context("read auth reply")?;
    if reply[1] != 0x00 {
        return Err(anyhow!("proxy rejected the credentials"));
    }
    Ok(())
}

fn socks5_error(code: u8) -> &'static str {
    match code {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown SOCKS5 failure",
    }
}

// ---- Blocking HTTP ----------------------------------------------------------

/// A `ureq` agent honouring the app-wide proxy. Every outbound HTTP call in the
/// core goes through this so feed fetches, avatar downloads and OAuth token
/// exchanges don't quietly bypass a configured proxy.
///
/// Built per call rather than cached: the setting can change at runtime, and
/// these requests are network-bound anyway.
pub fn agent() -> Result<ureq::Agent> {
    agent_for(global()?.as_ref())
}

/// Build an HTTP agent for a resolved account route. `None` is deliberately
/// direct; callers that want the app-wide route should use [`agent`].
pub fn agent_for(cfg: Option<&ProxyConfig>) -> Result<ureq::Agent> {
    let Some(cfg) = cfg else {
        return Ok(ureq::Agent::new_with_defaults());
    };
    Ok(ureq::Agent::new_with_config(
        ureq::Agent::config_builder().proxy(Some(ureq_proxy(cfg)?)).build(),
    ))
}

/// The proxy as ureq takes it, for callers that configure their own agent.
pub fn ureq_proxy(cfg: &ProxyConfig) -> Result<ureq::Proxy> {
    let protocol = match cfg.kind {
        ProxyKind::Http => ureq::ProxyProtocol::Http,
        // Socks5h: the proxy resolves the hostname, matching the mail path.
        ProxyKind::Socks5 => ureq::ProxyProtocol::Socks5h,
    };
    // ureq accepts a URI authority here, so an IPv6 literal needs brackets.
    // Keep the stored/raw host unchanged for Tokio's resolver.
    let http_host = match cfg.host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(_)) => format!("[{}]", cfg.host),
        _ => cfg.host.clone(),
    };
    let mut builder = ureq::Proxy::builder(protocol)
        .host(&http_host)
        .port(cfg.port);
    if !cfg.username.is_empty() {
        builder = builder.username(&cfg.username).password(&cfg.password);
    }
    builder
        .build()
        .with_context(|| format!("invalid proxy {}", cfg.endpoint()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn socks5(host: &str, port: u16) -> ProxyConfig {
        ProxyConfig {
            kind: ProxyKind::Socks5,
            host: host.to_string(),
            port,
            username: String::new(),
            password: String::new(),
        }
    }

    #[test]
    fn account_choice_defaults_to_global() {
        assert_eq!(ProxyChoice::from_json(&json!({})), ProxyChoice::Global);
        assert_eq!(ProxyChoice::from_json(&Value::Null), ProxyChoice::Global);
        assert_eq!(
            ProxyChoice::from_json(&json!({ "mode": "direct" })),
            ProxyChoice::Direct
        );
    }

    #[test]
    fn account_choice_round_trips_a_custom_proxy() {
        let choice = ProxyChoice::Custom(ProxyConfig {
            kind: ProxyKind::Http,
            host: "gateway.corp".into(),
            port: 3128,
            username: "u".into(),
            password: "p".into(),
        });
        assert_eq!(ProxyChoice::from_json(&choice.to_json()), choice);
    }

    #[test]
    fn a_half_filled_account_proxy_is_kept_and_refused_not_replaced() {
        // Host without port, port without host, and an unknown scheme are not
        // proxies; nor are they "use the app's proxy" or "connect directly".
        for stored in [
            json!({ "mode": "socks5", "host": "h" }),
            json!({ "mode": "http", "port": 1080 }),
            json!({ "mode": "ftp", "host": "h", "port": 21 }),
        ] {
            let choice = ProxyChoice::from_json(&stored);
            assert_eq!(choice, ProxyChoice::Unusable(stored.clone()));
            // Kept as entered, so the settings show what is wrong.
            assert_eq!(choice.to_json(), stored);
            let err = choice.resolve().unwrap_err().to_string();
            assert!(err.starts_with("this account's proxy"), "{err}");
        }
    }

    #[test]
    fn custom_proxy_wins_over_global_and_direct_disables_it() {
        let _guard = TEST_GLOBAL_LOCK
            .write()
            .unwrap_or_else(|err| err.into_inner());
        set_global(Some(socks5("global.example", 1080)));
        let custom = ProxyConfig {
            kind: ProxyKind::Http,
            host: "account.example".into(),
            port: 8080,
            username: String::new(),
            password: String::new(),
        };
        assert_eq!(
            ProxyChoice::Custom(custom.clone()).resolve().unwrap(),
            Some(custom.clone())
        );
        assert_eq!(ProxyChoice::Direct.resolve().unwrap(), None);
        assert_eq!(
            ProxyChoice::Global.resolve().unwrap(),
            Some(socks5("global.example", 1080))
        );
        set_global(None);
        assert_eq!(ProxyChoice::Global.resolve().unwrap(), None);
    }

    #[test]
    fn an_unusable_app_proxy_refuses_every_connection_instead_of_going_direct() {
        let _guard = TEST_GLOBAL_LOCK
            .write()
            .unwrap_or_else(|err| err.into_inner());
        for stored in [
            json!({ "mode": "socks5", "host": "h" }),
            json!({ "mode": "http", "port": 3128 }),
            json!({ "mode": "ftp", "host": "h", "port": 21 }),
        ] {
            publish_global(&stored);
            let err = global().unwrap_err().to_string();
            assert!(err.starts_with("the proxy setting"), "{err}");
            assert!(agent().is_err(), "no HTTP agent, direct or otherwise");
            assert!(ProxyChoice::Global.resolve().is_err(), "accounts that follow it are refused too");
            // An account's own choice is its own.
            assert_eq!(ProxyChoice::Direct.resolve().unwrap(), None);
        }

        // Off, or nothing saved, is a direct connection.
        publish_global(&json!({ "mode": "off", "host": "h", "port": 1 }));
        assert_eq!(global().unwrap(), None);
        assert!(agent().is_ok());
        publish_global(&Value::Null);
        assert_eq!(global().unwrap(), None);

        publish_global(&json!({ "mode": "socks5", "host": "h", "port": 1080 }));
        assert_eq!(global().unwrap(), Some(socks5("h", 1080)));
        set_global(None);
    }

    #[test]
    fn a_proxy_setting_that_cannot_be_read_holds_every_connection() {
        let _guard = TEST_GLOBAL_LOCK
            .write()
            .unwrap_or_else(|err| err.into_inner());
        set_global(None);
        // A store without the settings table: the setting cannot be read.
        // (`load_global` itself takes the lock this test holds.)
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        assert!(publish_from_store(&conn).is_err());
        let err = global().unwrap_err().to_string();
        assert!(err.starts_with("the proxy setting could not be read"), "{err}");
        assert!(agent().is_err());

        // Once it can be read, what it says applies.
        crate::store::run_migrations(&conn).unwrap();
        publish_from_store(&conn).unwrap();
        assert_eq!(global().unwrap(), None);
        set_global(None);
    }

    /// Accept one connection, run `handler` against it, and hand back what the
    /// client wrote so the request bytes can be asserted on.
    async fn with_proxy_server<F>(handler: F) -> (u16, tokio::task::JoinHandle<Vec<u8>>)
    where
        F: FnOnce(Vec<u8>) -> Vec<u8> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Read the first request, reply, then echo back everything read.
            let mut buf = vec![0u8; 512];
            let n = sock.read(&mut buf).await.unwrap();
            buf.truncate(n);
            let reply = handler(buf.clone());
            sock.write_all(&reply).await.unwrap();
            sock.flush().await.unwrap();
            buf
        });
        (port, task)
    }

    #[tokio::test]
    async fn socks5_sends_the_hostname_for_the_proxy_to_resolve() {
        // Two-step handshake: method selection, then the CONNECT reply.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            sock.read_exact(&mut greeting).await.unwrap();
            sock.write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_NONE])
                .await
                .unwrap();
            let mut head = [0u8; 5];
            sock.read_exact(&mut head).await.unwrap();
            let mut host = vec![0u8; head[4] as usize + 2];
            sock.read_exact(&mut host).await.unwrap();
            sock.write_all(&[
                SOCKS5_VERSION,
                0x00,
                0x00,
                SOCKS5_ADDR_IPV4,
                0,
                0,
                0,
                0,
                0,
                0,
            ])
            .await
            .unwrap();
            (greeting.to_vec(), head.to_vec(), host)
        });

        connect_through(&socks5("127.0.0.1", port), "imap.example.com", 993)
            .await
            .unwrap();

        let (greeting, head, host) = server.await.unwrap();
        assert_eq!(greeting, vec![SOCKS5_VERSION, 1, SOCKS5_AUTH_NONE]);
        assert_eq!(head[1], SOCKS5_CMD_CONNECT);
        assert_eq!(
            head[3], SOCKS5_ADDR_DOMAIN,
            "hostname must not be pre-resolved"
        );
        assert_eq!(&host[..host.len() - 2], b"imap.example.com");
        assert_eq!(&host[host.len() - 2..], &993u16.to_be_bytes());
    }

    #[tokio::test]
    async fn socks5_surfaces_a_refusal() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            sock.read_exact(&mut greeting).await.unwrap();
            sock.write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_NONE])
                .await
                .unwrap();
            let mut buf = [0u8; 256];
            let _ = sock.read(&mut buf).await.unwrap();
            sock.write_all(&[
                SOCKS5_VERSION,
                0x05,
                0x00,
                SOCKS5_ADDR_IPV4,
                0,
                0,
                0,
                0,
                0,
                0,
            ])
            .await
            .unwrap();
        });

        let err = connect_through(&socks5("127.0.0.1", port), "imap.example.com", 993)
            .await
            .unwrap_err();
        assert!(
            format!("{err:#}").contains("connection refused"),
            "unexpected error: {err:#}"
        );
    }

    #[tokio::test]
    async fn socks5_requires_credentials_when_the_proxy_asks_for_them() {
        let (port, _server) =
            with_proxy_server(|_req| vec![SOCKS5_VERSION, SOCKS5_AUTH_UNACCEPTABLE]).await;
        let err = connect_through(&socks5("127.0.0.1", port), "imap.example.com", 993)
            .await
            .unwrap_err();
        assert!(
            format!("{err:#}").contains("requires authentication"),
            "unexpected error: {err:#}"
        );
    }

    #[tokio::test]
    async fn http_connect_tunnels_and_authenticates() {
        let (port, server) =
            with_proxy_server(|_req| b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec()).await;
        let proxy = ProxyConfig {
            kind: ProxyKind::Http,
            host: "127.0.0.1".into(),
            port,
            username: "user".into(),
            password: "pass".into(),
        };
        connect_through(&proxy, "smtp.example.com", 587)
            .await
            .unwrap();

        let req = String::from_utf8(server.await.unwrap()).unwrap();
        assert!(
            req.starts_with("CONNECT smtp.example.com:587 HTTP/1.1\r\n"),
            "{req:?}"
        );
        // base64("user:pass")
        assert!(
            req.contains("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"),
            "{req:?}"
        );
    }

    #[tokio::test]
    async fn http_connect_reports_a_rejection() {
        let (port, _server) = with_proxy_server(|_req| {
            b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n".to_vec()
        })
        .await;
        let proxy = ProxyConfig {
            kind: ProxyKind::Http,
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            password: String::new(),
        };
        let err = connect_through(&proxy, "smtp.example.com", 587)
            .await
            .unwrap_err();
        assert!(
            format!("{err:#}").contains("proxy authentication required"),
            "unexpected error: {err:#}"
        );
    }

    #[tokio::test]
    async fn proxy_handshake_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        });
        let proxy = ProxyConfig {
            kind: ProxyKind::Http,
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            password: String::new(),
        };

        let err = connect_through_with_timeout(
            &proxy,
            "imap.example.com",
            993,
            std::time::Duration::from_millis(25),
        )
        .await
        .unwrap_err();
        assert!(
            format!("{err:#}").contains("proxy handshake timed out"),
            "unexpected error: {err:#}"
        );
        server.abort();
    }

    #[test]
    fn ipv6_http_proxy_builds_and_invalid_proxy_does_not_fall_back_to_direct() {
        let ipv6 = ProxyConfig {
            kind: ProxyKind::Http,
            host: "::1".into(),
            port: 8080,
            username: String::new(),
            password: String::new(),
        };
        assert!(agent_for(Some(&ipv6)).is_ok());

        let invalid = ProxyConfig {
            host: "bad\nhost".into(),
            ..ipv6
        };
        assert!(agent_for(Some(&invalid)).is_err());
    }

    #[test]
    fn strict_global_fails_closed_on_an_unusable_setting() {
        assert_eq!(strict_global(&Value::Null).unwrap(), None);
        assert_eq!(
            strict_global(&json!({ "mode": "off", "host": "h", "port": 1 })).unwrap(),
            None
        );
        assert_eq!(
            strict_global(&json!({ "mode": "socks5", "host": "h", "port": 1080 })).unwrap(),
            Some(socks5("h", 1080))
        );
        assert!(strict_global(&json!({ "mode": "http", "host": "h" })).is_err());
        assert!(strict_global(&json!({ "mode": "socks5", "port": 1080 })).is_err());
        assert!(strict_global(&json!({ "mode": "ftp", "host": "h", "port": 1 })).is_err());
    }
}
