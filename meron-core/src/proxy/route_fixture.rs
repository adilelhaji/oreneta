//! Local servers for tests that ask which route a request took (#193).
//!
//! [`Recorder::origin`] stands in for the server a protocol talks to;
//! [`Recorder::proxy`] is an HTTP proxy in front of it. The proxy really
//! tunnels, so a test that points the app-wide setting at it does not break
//! the other tests running at the same time: their requests still arrive.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, RwLockWriteGuard};

use super::{set_global, ProxyChoice, ProxyConfig, ProxyKind, TEST_GLOBAL_LOCK};

/// A local server that remembers the first line of every request it gets.
pub(crate) struct Recorder {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Recorder {
    /// A server that answers every request `200` with an empty body.
    pub fn origin() -> Self {
        Self::start(false)
    }

    /// An HTTP proxy that tunnels `CONNECT host:port` to that address.
    pub fn proxy() -> Self {
        Self::start(true)
    }

    fn start(tunnels: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let record = record.clone();
                std::thread::spawn(move || {
                    let _ = if tunnels { tunnel(stream, &record) } else { answer(stream, &record) };
                });
            }
        });
        Recorder { port, seen }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:<port>`, no trailing slash.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The first line of every request so far, e.g. `POST /EWS HTTP/1.1`.
    pub fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    /// Whether a request line mentions `needle`.
    pub fn saw(&self, needle: &str) -> bool {
        self.requests().iter().any(|line| line.contains(needle))
    }

    /// The account setting that sends connections through this proxy.
    pub fn as_account_proxy(&self) -> ProxyChoice {
        ProxyChoice::Custom(self.as_config())
    }

    pub fn as_config(&self) -> ProxyConfig {
        ProxyConfig {
            kind: ProxyKind::Http,
            host: "127.0.0.1".into(),
            port: self.port,
            username: String::new(),
            password: String::new(),
        }
    }
}

/// Reads one request head and any body, returning its first line.
fn read_request(stream: &TcpStream) -> std::io::Result<String> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(first.trim_end().to_string())
}

fn answer(mut stream: TcpStream, record: &Mutex<Vec<String>>) -> std::io::Result<()> {
    let line = read_request(&stream)?;
    record.lock().unwrap().push(line);
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
}

fn tunnel(mut client: TcpStream, record: &Mutex<Vec<String>>) -> std::io::Result<()> {
    let line = read_request(&client)?;
    record.lock().unwrap().push(line.clone());
    let target = line.split_whitespace().nth(1).unwrap_or_default().to_string();
    let Ok(server) = TcpStream::connect(&target) else {
        return client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    };
    client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
    let (mut from_client, mut to_server) = (client.try_clone()?, server.try_clone()?);
    let upstream = std::thread::spawn(move || {
        let _ = std::io::copy(&mut from_client, &mut to_server);
        let _ = to_server.shutdown(Shutdown::Write);
    });
    let (mut from_server, mut to_client) = (server, client);
    let _ = std::io::copy(&mut from_server, &mut to_client);
    let _ = to_client.shutdown(Shutdown::Write);
    let _ = upstream.join();
    Ok(())
}

/// Holds the test lock and leaves the app-wide proxy off when dropped, even
/// if an assertion fails, so no later test inherits a broken proxy.
pub(crate) struct GlobalSlot(#[allow(dead_code)] RwLockWriteGuard<'static, ()>);

impl GlobalSlot {
    pub fn take() -> Self {
        GlobalSlot(TEST_GLOBAL_LOCK.write().unwrap_or_else(|err| err.into_inner()))
    }
}

impl Drop for GlobalSlot {
    fn drop(&mut self) {
        set_global(None);
    }
}

/// The questions asked of every protocol (#193): an account with its own proxy
/// uses it, whatever the app-wide setting; an account set to direct ignores
/// the app-wide proxy; an account with no setting of its own follows it.
///
/// `request` sends one request to the given origin under the given account
/// route. Whatever the server answers is of no interest here, only where the
/// request went.
pub(crate) fn check_account_routes(request: impl Fn(&str, ProxyChoice)) {
    let _slot = GlobalSlot::take();
    let at = |origin: &Recorder| format!("127.0.0.1:{}", origin.port());

    // Its own proxy, with the app-wide proxy off: through it.
    let (origin, own) = (Recorder::origin(), Recorder::proxy());
    request(&origin.url(), own.as_account_proxy());
    assert!(own.saw(&format!("CONNECT {}", at(&origin))), "own proxy: {:?}", own.requests());
    assert!(!origin.requests().is_empty(), "the request still reaches its server");

    // Its own proxy, with another app-wide proxy set: the account's, not that one.
    let (origin, own, app) = (Recorder::origin(), Recorder::proxy(), Recorder::proxy());
    set_global(Some(app.as_config()));
    request(&origin.url(), own.as_account_proxy());
    assert!(own.saw(&format!("CONNECT {}", at(&origin))), "own proxy: {:?}", own.requests());
    assert!(!app.saw(&at(&origin)), "app-wide proxy: {:?}", app.requests());

    // Direct, with an app-wide proxy set: straight to the server.
    let (origin, app) = (Recorder::origin(), Recorder::proxy());
    set_global(Some(app.as_config()));
    request(&origin.url(), ProxyChoice::Direct);
    assert!(!origin.requests().is_empty(), "direct: the server was reached");
    assert!(!app.saw(&at(&origin)), "direct: app-wide proxy {:?}", app.requests());

    // No setting of its own, with an app-wide proxy set: through that one.
    let (origin, app) = (Recorder::origin(), Recorder::proxy());
    set_global(Some(app.as_config()));
    request(&origin.url(), ProxyChoice::Global);
    assert!(app.saw(&format!("CONNECT {}", at(&origin))), "global: {:?}", app.requests());
    assert!(!origin.requests().is_empty(), "global: the request still reaches its server");

    // No setting of its own, no app-wide proxy: straight to the server.
    set_global(None);
    let origin = Recorder::origin();
    request(&origin.url(), ProxyChoice::Global);
    assert!(!origin.requests().is_empty(), "global, off: the server was reached");
}
