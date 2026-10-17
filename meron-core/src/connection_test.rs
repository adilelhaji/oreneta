//! The connection test of the manual IMAP/POP3/SMTP setup (#269).
//!
//! Checks the incoming server (IMAP or POP3) and the outgoing one (SMTP) one
//! step at a time — name lookup, TCP connection, TLS, sign-in — and reports
//! every step, so the account dialog can say which one failed and offer what
//! to change. Both servers are tested at once and independently: a refused
//! submission port does not hide what the incoming server answered.
//!
//! Nothing is stored here: no account row, no secret, no certificate pin.
//! The password goes only to the server being tested, over the security the
//! account would use, and never into a log or into the report. The SMTP test
//! signs in and leaves; it never names a sender or a recipient.

use anyhow::{Context, Result, anyhow, ensure};
use async_smtp::authentication::{Credentials, Mechanism};
use async_smtp::error::Error as SmtpError;
use async_smtp::{SmtpClient, SmtpTransport};
use serde::Serialize;
use serde_json::Value;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::net::TcpStream;

use crate::proxy::{ProxyChoice, ProxyConfig, UnusableProxy};
use crate::tls::{Stream, UntrustedCertificate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Imap,
    Pop3,
    Smtp,
}

/// How the connection is protected, as the account dialog names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    Tls,
    Starttls,
    None,
}

impl Security {
    /// The same reading of the two flags the transports make: STARTTLS wins,
    /// then implicit TLS, and neither is a plaintext connection.
    fn from_flags(tls: bool, starttls: bool) -> Self {
        if starttls {
            Security::Starttls
        } else if tls {
            Security::Tls
        } else {
            Security::None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Dns,
    Tcp,
    Tls,
    Auth,
}

const STEPS: [Step; 4] = [Step::Dns, Step::Tcp, Step::Tls, Step::Auth];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Failed,
    /// Not applicable to this connection; `kind` says why.
    Skipped,
    /// An earlier step failed, so this one was never tried.
    NotRun,
}

/// Why a step failed or was skipped. The dialog chooses its advice from this,
/// never from the server's wording, which is kept only as `detail`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The server name does not resolve.
    NameNotFound,
    /// Something answered at that address, but nothing listens on the port.
    Refused,
    /// No route to the address, or the connection was reset.
    Unreachable,
    Timeout,
    /// The proxy setting the connection follows cannot be used, or the proxy
    /// refused the connection.
    Proxy,
    /// The TLS handshake failed for a reason other than the certificate: the
    /// port usually speaks plaintext (or STARTTLS) instead.
    NotTls,
    /// The server's certificate does not validate.
    Certificate,
    /// The server does not offer STARTTLS, or refused it.
    StarttlsUnsupported,
    /// The server sent no greeting of the protocol being tested: the port is
    /// usually another protocol's, or expects TLS from the first byte.
    NoGreeting,
    /// POP3 never sends a password over a connection without TLS.
    PlaintextRefused,
    /// The server refused the user name and password.
    Rejected,
    /// DNS is left to the proxy, which resolves the name itself.
    ViaProxy,
    /// The connection is not encrypted, as chosen.
    NoEncryption,
    /// The SMTP server does not ask for authentication.
    AuthNotOffered,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepReport {
    pub step: Step,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    /// What was found or what the server or the system said, for the person
    /// to read. Never contains the password.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

impl StepReport {
    fn ok(step: Step, detail: impl Into<String>) -> Self {
        StepReport { step, status: Status::Ok, kind: None, detail: detail.into() }
    }

    fn failed(step: Step, kind: Kind, detail: impl Into<String>) -> Self {
        StepReport { step, status: Status::Failed, kind: Some(kind), detail: detail.into() }
    }

    fn skipped(step: Step, kind: Kind) -> Self {
        StepReport { step, status: Status::Skipped, kind: Some(kind), detail: String::new() }
    }

    fn not_run(step: Step) -> Self {
        StepReport { step, status: Status::NotRun, kind: None, detail: String::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerReport {
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub security: Security,
    /// No step failed. A skipped step (no encryption chosen, no
    /// authentication asked) does not fail the server.
    pub ok: bool,
    /// Always the four steps, in order.
    pub steps: Vec<StepReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub ok: bool,
    pub incoming: ServerReport,
    pub outgoing: ServerReport,
}

/// One server to test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub security: Security,
    /// The certificate the person accepted for this server, as in
    /// [`crate::tls`]; anything else still has to validate.
    pub cert_pin: Option<String>,
}

/// The sign-in both servers are tested with. Deliberately not `Debug`, so the
/// password cannot reach a log through a `{:?}`.
pub struct Login {
    pub user: String,
    pub password: String,
}

pub struct TestRequest {
    pub incoming: Server,
    pub outgoing: Server,
    pub login: Login,
    pub proxy: ProxyChoice,
}

impl TestRequest {
    /// Reads the parameters `account.connect` takes for a password or POP3
    /// account, so the dialog tests exactly what it would save. A missing
    /// password is left empty: the caller may fill in the stored one.
    pub fn from_params(p: &Value) -> Result<TestRequest> {
        let text = |key: &str| {
            p.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string()
        };
        let flag = |key: &str, default: bool| p.get(key).and_then(Value::as_bool).unwrap_or(default);
        let pin = |key: &str| {
            p.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|pin| !pin.is_empty())
                .map(str::to_ascii_lowercase)
        };
        let auth_type = text("auth_type");
        ensure!(
            auth_type.is_empty() || auth_type == "password" || auth_type == "pop3",
            "only password and POP3 accounts are tested this way"
        );
        let host = text("host");
        ensure!(!host.is_empty(), "incoming server required");
        let smtp_host = match text("smtp_host") {
            name if name.is_empty() => host.clone(),
            name => name,
        };
        let user = text("user");
        ensure!(!user.is_empty(), "user name required");
        Ok(TestRequest {
            incoming: Server {
                protocol: if auth_type == "pop3" { Protocol::Pop3 } else { Protocol::Imap },
                host,
                port: port_param(p, "port", 993)?,
                security: Security::from_flags(flag("tls", true), flag("starttls", false)),
                cert_pin: pin("cert_pin"),
            },
            outgoing: Server {
                protocol: Protocol::Smtp,
                host: smtp_host,
                port: port_param(p, "smtp_port", 587)?,
                security: Security::from_flags(flag("smtp_tls", true), flag("smtp_starttls", false)),
                cert_pin: pin("smtp_cert_pin"),
            },
            login: Login {
                user,
                password: p
                    .get("password")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            },
            proxy: ProxyChoice::from_json(p.get("proxy").unwrap_or(&Value::Null)),
        })
    }
}

fn port_param(p: &Value, key: &str, default: u16) -> Result<u16> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| anyhow!("invalid port for {key}")),
    }
}

/// How long each part may take. A server that never answers must not keep the
/// person waiting on the dialog for minutes.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub lookup: Duration,
    pub connect_attempt: Duration,
    pub connect: Duration,
    pub command: Duration,
    /// The whole test of one server.
    pub total: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            lookup: Duration::from_secs(10),
            connect_attempt: Duration::from_secs(5),
            connect: Duration::from_secs(15),
            command: Duration::from_secs(15),
            total: Duration::from_secs(45),
        }
    }
}

/// Tests both servers of `request`, at the same time.
pub async fn run(request: &TestRequest) -> Report {
    run_with_limits(request, Limits::default()).await
}

pub async fn run_with_limits(request: &TestRequest, limits: Limits) -> Report {
    // Resolved once: both servers take the route the account would take.
    let route = request.proxy.resolve().map_err(|err| format!("{err:#}"));
    let route = match &route {
        Ok(proxy) => Ok(proxy.as_ref()),
        Err(reason) => Err(reason.as_str()),
    };
    let (incoming, outgoing) = tokio::join!(
        test_server(&request.incoming, &request.login, route, limits),
        test_server(&request.outgoing, &request.login, route, limits),
    );
    Report { ok: incoming.ok && outgoing.ok, incoming, outgoing }
}

/// The proxy to go through (`Ok(None)` is a direct connection), or why the
/// chosen proxy cannot be used.
type Route<'a> = std::result::Result<Option<&'a ProxyConfig>, &'a str>;

async fn test_server(server: &Server, login: &Login, route: Route<'_>, limits: Limits) -> ServerReport {
    let mut steps = Vec::with_capacity(STEPS.len());
    let finished = tokio::time::timeout(limits.total, probe(server, login, route, limits, &mut steps)).await;
    if finished.is_err() {
        let step = STEPS.get(steps.len()).copied().unwrap_or(Step::Auth);
        steps.push(StepReport::failed(step, Kind::Timeout, "the test took too long"));
    }
    finish(server, steps)
}

/// Pads the steps an early failure left untried, so every report has all four.
fn finish(server: &Server, mut steps: Vec<StepReport>) -> ServerReport {
    for step in STEPS.iter().skip(steps.len()) {
        steps.push(StepReport::not_run(*step));
    }
    ServerReport {
        protocol: server.protocol,
        host: server.host.clone(),
        port: server.port,
        security: server.security,
        ok: !steps.iter().any(|s| s.status == Status::Failed),
        steps,
    }
}

async fn probe(server: &Server, login: &Login, route: Route<'_>, limits: Limits, steps: &mut Vec<StepReport>) {
    let Some(tcp) = reach(server, route, limits, steps).await else { return };
    let secured = match secure(server, tcp, limits).await {
        Ok((secured, report)) => {
            steps.push(report);
            secured
        }
        Err(report) => {
            steps.push(report);
            return;
        }
    };
    steps.push(sign_in(server, secured, login, limits).await);
}

// ---- DNS and TCP --------------------------------------------------------------------------

async fn reach(server: &Server, route: Route<'_>, limits: Limits, steps: &mut Vec<StepReport>) -> Option<TcpStream> {
    match route {
        Err(reason) => {
            steps.push(StepReport::not_run(Step::Dns));
            steps.push(StepReport::failed(Step::Tcp, Kind::Proxy, reason));
            None
        }
        Ok(Some(proxy)) => {
            steps.push(StepReport::skipped(Step::Dns, Kind::ViaProxy));
            match tokio::time::timeout(limits.connect, crate::proxy::connect_through(proxy, &server.host, server.port))
                .await
            {
                Ok(Ok(tcp)) => {
                    steps.push(StepReport::ok(Step::Tcp, "through the proxy"));
                    Some(tcp)
                }
                Ok(Err(err)) => {
                    let kind = if UnusableProxy::find(&err).is_some() { Kind::Proxy } else { tcp_kind(&err) };
                    steps.push(StepReport::failed(Step::Tcp, kind, format!("{err:#}")));
                    None
                }
                Err(_) => {
                    steps.push(StepReport::failed(Step::Tcp, Kind::Timeout, "the proxy did not connect in time"));
                    None
                }
            }
        }
        Ok(None) => {
            let addrs = match lookup(&server.host, server.port, limits).await {
                Ok(addrs) => {
                    let found = addrs.iter().map(|a| a.ip().to_string()).collect::<Vec<_>>().join(", ");
                    steps.push(StepReport::ok(Step::Dns, found));
                    addrs
                }
                Err(report) => {
                    steps.push(report);
                    return None;
                }
            };
            match connect_any(&addrs, limits).await {
                Ok((tcp, addr)) => {
                    steps.push(StepReport::ok(Step::Tcp, addr.to_string()));
                    Some(tcp)
                }
                Err(report) => {
                    steps.push(report);
                    None
                }
            }
        }
    }
}

async fn lookup(host: &str, port: u16, limits: Limits) -> std::result::Result<Vec<SocketAddr>, StepReport> {
    match tokio::time::timeout(limits.lookup, tokio::net::lookup_host((host, port))).await {
        Err(_) => Err(StepReport::failed(Step::Dns, Kind::Timeout, "the name lookup did not answer in time")),
        Ok(Err(err)) => Err(StepReport::failed(Step::Dns, Kind::NameNotFound, err.to_string())),
        Ok(Ok(addrs)) => {
            let addrs: Vec<SocketAddr> = addrs.collect();
            if addrs.is_empty() {
                Err(StepReport::failed(Step::Dns, Kind::NameNotFound, format!("no addresses for {host}")))
            } else {
                Ok(addrs)
            }
        }
    }
}

/// Tries each address in resolver order, as the transports do. A refusal from
/// any of them says more than a timeout from another: the host is up and the
/// port is closed.
async fn connect_any(addrs: &[SocketAddr], limits: Limits) -> std::result::Result<(TcpStream, SocketAddr), StepReport> {
    let started = tokio::time::Instant::now();
    let mut refused = None;
    let mut last = None;
    for addr in addrs {
        let left = limits.connect.saturating_sub(started.elapsed());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(limits.connect_attempt.min(left), TcpStream::connect(*addr)).await {
            Ok(Ok(tcp)) => return Ok((tcp, *addr)),
            Ok(Err(err)) if err.kind() == std::io::ErrorKind::ConnectionRefused => {
                refused = Some(format!("{addr}: {err}"));
            }
            Ok(Err(err)) => last = Some(StepReport::failed(Step::Tcp, io_kind(&err), format!("{addr}: {err}"))),
            Err(_) => {
                last = Some(StepReport::failed(Step::Tcp, Kind::Timeout, format!("{addr}: no answer in time")));
            }
        }
    }
    if let Some(detail) = refused {
        return Err(StepReport::failed(Step::Tcp, Kind::Refused, detail));
    }
    Err(last.unwrap_or_else(|| StepReport::failed(Step::Tcp, Kind::Timeout, "no address answered in time")))
}

fn io_kind(err: &std::io::Error) -> Kind {
    match err.kind() {
        std::io::ErrorKind::ConnectionRefused => Kind::Refused,
        std::io::ErrorKind::TimedOut => Kind::Timeout,
        _ => Kind::Unreachable,
    }
}

/// A proxied connection's failure: the proxy's own answers are text, so only
/// a typed I/O error says more than "the proxy could not connect".
fn tcp_kind(err: &anyhow::Error) -> Kind {
    err.chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        .map(io_kind)
        .unwrap_or(Kind::Proxy)
}

// ---- TLS --------------------------------------------------------------------------------

/// The connection after the TLS step, and whether the protocol's greeting has
/// already been read (STARTTLS reads it before upgrading; nothing follows).
struct Secured {
    stream: Stream,
    greeted: bool,
}

async fn secure(server: &Server, tcp: TcpStream, limits: Limits) -> std::result::Result<(Secured, StepReport), StepReport> {
    match server.security {
        Security::None if server.protocol == Protocol::Pop3 => Err(StepReport::failed(
            Step::Tls,
            Kind::PlaintextRefused,
            "the POP3 password is only sent over TLS",
        )),
        Security::None => Ok((
            Secured { stream: Stream::Plain(tcp), greeted: false },
            StepReport::skipped(Step::Tls, Kind::NoEncryption),
        )),
        Security::Tls => {
            let tls = handshake(server, tcp, limits).await?;
            Ok((Secured { stream: tls, greeted: false }, StepReport::ok(Step::Tls, "TLS")))
        }
        Security::Starttls => {
            let tcp = match server.protocol {
                Protocol::Imap => imap_starttls(tcp, limits).await?,
                Protocol::Pop3 => pop3_starttls(tcp, limits).await?,
                Protocol::Smtp => smtp_starttls(tcp, limits).await?,
            };
            let tls = handshake(server, tcp, limits).await?;
            Ok((Secured { stream: tls, greeted: true }, StepReport::ok(Step::Tls, "STARTTLS")))
        }
    }
}

async fn handshake(server: &Server, tcp: TcpStream, limits: Limits) -> std::result::Result<Stream, StepReport> {
    match tokio::time::timeout(
        limits.command,
        crate::tls::upgrade_to_tls(&server.host, tcp, server.cert_pin.as_deref()),
    )
    .await
    {
        Err(_) => Err(StepReport::failed(Step::Tls, Kind::Timeout, "the TLS handshake did not finish in time")),
        Ok(Ok(tls)) => Ok(Stream::Tls(Box::new(tls))),
        Ok(Err(err)) => Err(StepReport::failed(Step::Tls, handshake_kind(&err), format!("{err:#}"))),
    }
}

fn handshake_kind(err: &anyhow::Error) -> Kind {
    if err.downcast_ref::<UntrustedCertificate>().is_some() {
        Kind::Certificate
    } else if err.chain().any(|cause| cause.to_string() == "timed out") {
        Kind::Timeout
    } else if err.chain().any(|cause| cause.to_string().contains("invalid server name")) {
        Kind::Other
    } else {
        Kind::NotTls
    }
}

fn no_greeting(err: impl std::fmt::Display) -> StepReport {
    StepReport::failed(Step::Tls, Kind::NoGreeting, err.to_string())
}

fn starttls_refused(err: impl std::fmt::Display) -> StepReport {
    StepReport::failed(Step::Tls, Kind::StarttlsUnsupported, err.to_string())
}

async fn imap_greeting(client: &mut async_imap::Client<Stream>, limits: Limits) -> Result<()> {
    tokio::time::timeout(limits.command, async {
        client
            .read_response()
            .await
            .context("read IMAP greeting")?
            .context("server closed before greeting")?;
        Ok::<(), anyhow::Error>(())
    })
    .await
    .map_err(|_| anyhow!("the server sent no IMAP greeting in time"))?
}

async fn imap_starttls(tcp: TcpStream, limits: Limits) -> std::result::Result<TcpStream, StepReport> {
    let mut client = async_imap::Client::new(Stream::Plain(tcp));
    imap_greeting(&mut client, limits).await.map_err(|err| no_greeting(format!("{err:#}")))?;
    tokio::time::timeout(limits.command, async {
        client
            .run_command_and_check_ok("STARTTLS", None)
            .await
            .context("STARTTLS")?;
        Ok::<(), anyhow::Error>(())
    })
    .await
    .map_err(|_| starttls_refused("the server did not answer STARTTLS in time"))?
    .map_err(|err| starttls_refused(format!("{err:#}")))?;
    match client.into_inner() {
        Stream::Plain(tcp) => Ok(tcp),
        Stream::Tls(_) => Err(StepReport::failed(Step::Tls, Kind::Other, "STARTTLS on an already-TLS stream")),
    }
}

async fn pop3_starttls(tcp: TcpStream, limits: Limits) -> std::result::Result<TcpStream, StepReport> {
    let mut plain = tokio::time::timeout(limits.command, crate::pop3::Client::open(Stream::Plain(tcp)))
        .await
        .map_err(|_| no_greeting("the server sent no POP3 greeting in time"))?
        .map_err(|err| no_greeting(format!("{err:#}")))?;
    let caps = tokio::time::timeout(limits.command, plain.capabilities())
        .await
        .map_err(|_| starttls_refused("the server did not list its capabilities in time"))?
        .map_err(|err| starttls_refused(format!("{err:#}")))?;
    if !caps.stls {
        return Err(starttls_refused("the POP3 server does not offer STLS"));
    }
    tokio::time::timeout(limits.command, plain.stls())
        .await
        .map_err(|_| starttls_refused("the server did not answer STLS in time"))?
        .map_err(|err| starttls_refused(format!("{err:#}")))?;
    match plain.into_inner() {
        Stream::Plain(tcp) => Ok(tcp),
        Stream::Tls(_) => Err(StepReport::failed(Step::Tls, Kind::Other, "STLS on an already-TLS stream")),
    }
}

async fn smtp_starttls(tcp: TcpStream, limits: Limits) -> std::result::Result<TcpStream, StepReport> {
    let transport = tokio::time::timeout(
        limits.command,
        SmtpTransport::new(SmtpClient::new(), BufReader::new(Stream::Plain(tcp))),
    )
    .await
    .map_err(|_| no_greeting("the server sent no SMTP greeting in time"))?
    .map_err(|err| no_greeting(err.to_string()))?;
    let inner = tokio::time::timeout(limits.command, transport.starttls())
        .await
        .map_err(|_| starttls_refused("the server did not answer STARTTLS in time"))?
        .map_err(|err| starttls_refused(err.to_string()))?;
    match inner.into_inner() {
        Stream::Plain(tcp) => Ok(tcp),
        Stream::Tls(_) => Err(StepReport::failed(Step::Tls, Kind::Other, "STARTTLS on an already-TLS stream")),
    }
}

// ---- Sign-in ----------------------------------------------------------------------------

async fn sign_in(server: &Server, secured: Secured, login: &Login, limits: Limits) -> StepReport {
    match server.protocol {
        Protocol::Imap => imap_sign_in(secured, login, limits).await,
        Protocol::Pop3 => pop3_sign_in(secured.stream, secured.greeted, login, limits).await,
        Protocol::Smtp => smtp_sign_in(secured, login, limits).await,
    }
}

fn auth_no_greeting(err: impl std::fmt::Display) -> StepReport {
    StepReport::failed(Step::Auth, Kind::NoGreeting, err.to_string())
}

async fn imap_sign_in(secured: Secured, login: &Login, limits: Limits) -> StepReport {
    let mut client = async_imap::Client::new(secured.stream);
    if !secured.greeted
        && let Err(err) = imap_greeting(&mut client, limits).await
    {
        return auth_no_greeting(format!("{err:#}"));
    }
    match tokio::time::timeout(limits.command, client.login(&login.user, &login.password)).await {
        Err(_) => StepReport::failed(Step::Auth, Kind::Timeout, "the server did not answer the sign-in in time"),
        Ok(Err((err, _))) => {
            let kind = if matches!(err, async_imap::error::Error::No(_)) { Kind::Rejected } else { Kind::Other };
            StepReport::failed(Step::Auth, kind, err.to_string())
        }
        Ok(Ok(mut session)) => {
            let _ = tokio::time::timeout(Duration::from_secs(5), session.logout()).await;
            StepReport::ok(Step::Auth, "")
        }
    }
}

/// Generic over the stream so the sign-in can be tested without a certificate:
/// POP3 is only ever tested over TLS.
async fn pop3_sign_in<S>(stream: S, greeted: bool, login: &Login, limits: Limits) -> StepReport
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut client = if greeted {
        crate::pop3::Client::open_after_tls(stream)
    } else {
        match tokio::time::timeout(limits.command, crate::pop3::Client::open(stream)).await {
            Err(_) => return auth_no_greeting("the server sent no POP3 greeting in time"),
            Ok(Err(err)) => return auth_no_greeting(format!("{err:#}")),
            Ok(Ok(client)) => client,
        }
    };
    match tokio::time::timeout(limits.command, client.login(&login.user, &login.password)).await {
        Err(_) => StepReport::failed(Step::Auth, Kind::Timeout, "the server did not answer the sign-in in time"),
        Ok(Err(err)) => {
            let detail = format!("{err:#}");
            let kind = if detail.contains("did not accept") || detail.contains("refused") {
                Kind::Rejected
            } else {
                Kind::Other
            };
            StepReport::failed(Step::Auth, kind, detail)
        }
        Ok(Ok(())) => {
            let _ = tokio::time::timeout(Duration::from_secs(5), client.quit()).await;
            StepReport::ok(Step::Auth, "")
        }
    }
}

async fn smtp_sign_in(secured: Secured, login: &Login, limits: Limits) -> StepReport {
    // After STARTTLS there is no second greeting, but EHLO is said again.
    let client = if secured.greeted { SmtpClient::new().without_greeting() } else { SmtpClient::new() };
    let mut transport =
        match tokio::time::timeout(limits.command, SmtpTransport::new(client, BufReader::new(secured.stream))).await {
            Err(_) => return auth_no_greeting("the server sent no SMTP greeting in time"),
            Ok(Err(err)) => return auth_no_greeting(err.to_string()),
            Ok(Ok(transport)) => transport,
        };
    let credentials = Credentials::new(login.user.clone(), login.password.clone());
    // The same order and the same reading of a refusal as a real send (see
    // `smtp::transport`): 502/503/504 to every mechanism is a server that does
    // not take AUTH at all, which a send goes on without.
    let mut not_offered = true;
    let mut last = String::new();
    for mechanism in [Mechanism::Plain, Mechanism::Login] {
        match tokio::time::timeout(limits.command, transport.auth(mechanism, &credentials)).await {
            Err(_) => {
                return StepReport::failed(Step::Auth, Kind::Timeout, "the server did not answer the sign-in in time");
            }
            Ok(Ok(_)) => {
                let _ = tokio::time::timeout(Duration::from_secs(5), transport.quit()).await;
                return StepReport::ok(Step::Auth, "");
            }
            Ok(Err(err)) => {
                if !command_not_offered(&err) {
                    not_offered = false;
                }
                last = err.to_string();
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), transport.quit()).await;
    if not_offered {
        return StepReport::skipped(Step::Auth, Kind::AuthNotOffered);
    }
    StepReport::failed(Step::Auth, if last.is_empty() { Kind::Other } else { Kind::Rejected }, last)
}

fn command_not_offered(err: &SmtpError) -> bool {
    matches!(err, SmtpError::Permanent(resp) if resp.has_code(502) || resp.has_code(503) || resp.has_code(504))
}

#[cfg(test)]
mod tests;
