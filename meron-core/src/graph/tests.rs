use super::*;
use serde_json::json;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Instant,
};

fn grant(scope: &str) -> Grant {
    Grant::new(
        "account-a",
        "fixture-token",
        scope,
        chrono::Utc::now().timestamp() + 3600,
    )
    .unwrap()
}
fn client() -> Client {
    Client::new(grant("Mail.Read"), crate::proxy::ProxyChoice::Direct)
}
fn folder(id: &str) -> ResourceId {
    ResourceId::new("account-a", ResourceKind::Folder, id).unwrap()
}
fn message(id: &str) -> ResourceId {
    ResourceId::new("account-a", ResourceKind::Message, id).unwrap()
}
fn wire_folder(id: &str) -> serde_json::Value {
    json!({"id":id,"displayName":"Bandeja de entrada","childFolderCount":1,
        "unreadItemCount":2,"totalItemCount":3,"futureField":"ignored"})
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buf = [0; 1024];
    while !bytes.windows(4).any(|s| s == b"\r\n\r\n") && bytes.len() < 65536 {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
        }
    }
    // POST fixtures must consume the complete form before closing the socket.
    // Otherwise Windows may reset the connection with unread request bytes,
    // replacing the intended OAuth response with a sporadic transport failure.
    if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
        let header_end = end + 4;
        let length = String::from_utf8_lossy(&bytes[..end])
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
            .unwrap_or(0);
        assert!(length <= 65536, "fixture request body exceeds bound");
        while bytes.len() < header_end + length {
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0, "incomplete fixture request body");
            bytes.extend_from_slice(&buf[..n]);
        }
    }
    String::from_utf8(bytes).unwrap()
}

pub(super) struct Fixture {
    pub(super) base: Url,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    pub(super) fn new(responses: impl FnOnce(&Url) -> Vec<(u16, String, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = Url::parse(&format!("http://{}/v1.0/", listener.local_addr().unwrap())).unwrap();
        let replies = responses(&base);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let received = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut replies = replies.into_iter();
            while !stopping.load(Ordering::SeqCst) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Windows inherits the listener's nonblocking mode;
                        // otherwise an early WouldBlock truncates the request.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        let mut request = read_request(&mut stream);
                        if request.starts_with("CONNECT ") {
                            // ureq HTTP proxies establish a tunnel, even for
                            // this fixture's plaintext HTTP target.
                            stream
                                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                                .unwrap();
                            request.push_str(&read_request(&mut stream));
                        }
                        received.lock().unwrap().push(request);
                        if let Some((status, headers, body)) = replies.next() {
                            let response = format!(
                                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                                body.len()
                            );
                            // A bounded client may intentionally close an oversized response.
                            let _ = stream.write_all(response.as_bytes());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("loopback listener: {e}"),
                }
            }
        });
        Self {
            base,
            requests,
            stop,
            handle: Some(handle),
        }
    }
    fn client(&self) -> Client {
        let mut client = client();
        // Test-only origin injection. Production cannot choose an HTTP endpoint.
        client.base = self.base.clone();
        client
    }
    pub(super) fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.take().unwrap().join().unwrap();
    }
}
fn ok(value: serde_json::Value) -> (u16, String, String) {
    (200, String::new(), value.to_string())
}

#[test]
fn grant_requires_actual_graph_scopes_and_unexpired_token() {
    for scope in [
        "Mail.Read",
        "Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Read",
        "openid offline_access Mail.Read",
    ] {
        assert!(grant(scope).authorize(true).is_ok(), "{scope}");
    }
    assert!(grant("Mail.ReadBasic").authorize(false).is_ok());
    for scope in [
        "",
        "Mail.ReadBasic",
        "Mail.Send",
        "mail.read",
        "Mail.Read.All",
        "Mail.Read.Shared",
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://evil.example/Mail.Read",
    ] {
        assert_eq!(
            grant(scope).authorize(true).unwrap_err().kind,
            ErrorKind::ConsentRequired,
            "{scope}"
        );
    }
    let expired = Grant::new("a", "token", "Mail.Read", 1).unwrap();
    assert_eq!(
        expired.authorize(true).unwrap_err().kind,
        ErrorKind::Reauthenticate
    );
    for token in ["", " token", "a\r\nX-Secret: foo", "☃"] {
        assert_eq!(
            Grant::new("a", token, "Mail.Read", i64::MAX)
                .err()
                .unwrap()
                .kind,
            ErrorKind::InvalidInput
        );
    }
    assert!(Grant::new("", "token", "Mail.Read", i64::MAX).is_err());
}

#[test]
fn identity_is_case_sensitive_account_and_kind_qualified_and_segment_encoded() {
    assert_ne!(folder("Aa"), folder("aa"));
    assert_ne!(folder("Aa"), message("Aa"));
    assert_ne!(
        folder("Aa"),
        ResourceId::new("other", ResourceKind::Folder, "Aa").unwrap()
    );
    for invalid in ["", " ", ".", "..", "a\nb"] {
        assert!(ResourceId::new("a", ResourceKind::Folder, invalid).is_err());
    }
    assert!(ResourceId::new("a", ResourceKind::Folder, &"x".repeat(2049)).is_err());
    let url = client().route(&["me", "messages", "A/+?=%#B"]);
    assert_eq!(url.path(), "/v1.0/me/messages/A%2F+%3F=%25%23B");
    assert!(url.query().is_none());
    assert!(url.fragment().is_none());
}

#[test]
fn next_links_cannot_escape_origin_version_mailbox_or_collection() {
    let client = client();
    let path = "/v1.0/me/mailFolders";
    let good = "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=a%2Bb%3D";
    assert_eq!(client.validate_link(good, path).unwrap().as_str(), good);
    for bad in [
        "http://graph.microsoft.com/v1.0/me/mailFolders",
        "https://graph.microsoft.com.evil.test/v1.0/me/mailFolders",
        "https://graph.microsoft.com:444/v1.0/me/mailFolders",
        "https://user@graph.microsoft.com/v1.0/me/mailFolders",
        "https://graph.microsoft.com/v1.0/me/mailFolders#secret",
        "https://graph.microsoft.com/beta/me/mailFolders",
        "https://graph.microsoft.com/v1.0/users/other/mailFolders",
        "https://graph.microsoft.com/v1.0/me/messages",
        "https://graph.microsoft.com/v1.0/me/mailFolders/other/childFolders",
        "/v1.0/me/mailFolders?$skip=1",
        "//graph.microsoft.com/v1.0/me/mailFolders",
        "https://graph.microsoft.com\\@evil.test/v1.0/me/mailFolders",
        "https://graph.microsoft.com/v1.0/me/mailFolders\n",
    ] {
        assert_eq!(
            client.validate_link(bad, path).unwrap_err().kind,
            ErrorKind::InvalidResponse,
            "{bad}"
        );
    }
}

#[test]
fn documented_odata_link_spellings_preserve_exact_opaque_folder_identity() {
    let client = client();
    let collection = "/v1.0/me/mailFolders/A%2F+=/messages/delta";
    for path in [
        "/v1.0/me/mailfolders('A%2F%2B%3D')/messages/delta",
        "/v1.0/me/mailfolders/A%2F%2B%3D/messages/delta",
    ] {
        assert!(
            client
                .validate_link(
                    &format!("https://graph.microsoft.com{path}?$skiptoken=opaque"),
                    collection
                )
                .is_ok(),
            "{path}"
        );
    }
    for path in [
        "/v1.0/me/mailfolders('a%2F+=')/messages/delta",
        "/v1.0/me/mailfolders('A%2F+=')/childFolders",
        "/v1.0/me/mailfolders('A%2F+=')/messages/delta/other",
        "/v1.0/me/mailfolders('A'unescaped')/messages/delta",
    ] {
        assert!(
            client
                .validate_link(&format!("https://graph.microsoft.com{path}"), collection)
                .is_err(),
            "{path}"
        );
    }
    assert_eq!(
        collection_key("/v1.0/me/mailfolders('it''s')/messages"),
        collection_key("/v1.0/me/mailFolders/it's/messages")
    );
}

#[test]
fn root_folder_paging_preserves_provider_link_and_auth_headers() {
    let fixture = Fixture::new(|base| {
        vec![
            ok(
                json!({"value":[wire_folder("A")],"@odata.nextLink":format!("{base}me/mailFolders?$skiptoken=a%2Bb%3D")}),
            ),
            ok(json!({"value":[wire_folder("B")]})),
        ]
    });
    let client = fixture.client();
    let first = client.folders(None, None).unwrap();
    assert_eq!(first.items[0].fields.display_name, "Bandeja de entrada");
    assert_eq!(first.items[0].fields.unread_item_count, 2);
    assert_eq!(first.items[0].id, folder("A"));
    assert_eq!(
        first.checkpoint.as_ref().unwrap().kind(),
        CheckpointKind::NextPage
    );
    assert!(!format!("{:?}", first.checkpoint).contains("skiptoken"));
    let second = client.folders(None, first.checkpoint.as_ref()).unwrap();
    assert_eq!(second.items[0].id, folder("B"));
    assert!(second.checkpoint.is_none());
    let requests = fixture.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("GET /v1.0/me/mailFolders?%24top=100 "));
    assert!(requests[1].starts_with("GET /v1.0/me/mailFolders?$skiptoken=a%2Bb%3D "));
    for request in requests {
        let request = request.to_ascii_lowercase();
        assert!(request.contains("authorization: bearer fixture-token\r\n"));
        assert!(request.contains("prefer: idtype=\"immutableid\", odata.maxpagesize=100\r\n"));
    }
}

#[test]
fn child_folder_requires_scope_and_is_not_implicitly_a_full_tree() {
    let fixture = Fixture::new(|_| vec![ok(json!({"value":[wire_folder("child")]}))]);
    let mut client = fixture.client();
    client.grant = grant("Mail.ReadBasic");
    let page = client.folders(Some(&folder("A/+=")), None).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].fields.child_folder_count, 1);
    assert_eq!(fixture.requests().len(), 1); // no recursive traversal or truncation claim
    assert!(fixture.requests()[0].starts_with("GET /v1.0/me/mailFolders/A%2F+=/childFolders?"));
    assert_eq!(
        client.messages(&folder("A"), None).unwrap_err().kind,
        ErrorKind::ConsentRequired
    );
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn explicit_account_proxy_is_used_instead_of_direct_origin() {
    let origin = Fixture::new(|_| vec![]);
    let proxy = Fixture::new(|_| vec![ok(json!({"value":[]}))]);
    let mut client = origin.client();
    client.proxy = crate::proxy::ProxyChoice::Custom(crate::proxy::ProxyConfig {
        kind: crate::proxy::ProxyKind::Http,
        host: "127.0.0.1".into(),
        port: proxy.base.port().unwrap(),
        username: String::new(),
        password: String::new(),
    });
    let result = client.folders(None, None);
    assert!(
        result.is_ok(),
        "{result:?}; origin {:?}; proxy {:?}",
        origin.requests(),
        proxy.requests()
    );
    assert!(result.unwrap().items.is_empty());
    assert!(origin.requests().is_empty());
    assert_eq!(proxy.requests().len(), 1);
    assert!(proxy.requests()[0].starts_with("CONNECT "));
    assert!(proxy.requests()[0].contains("GET /v1.0/me/mailFolders?"));
}

#[test]
fn cross_account_and_wrong_resource_kind_are_rejected_before_network() {
    let client = client();
    let foreign = ResourceId::new("other", ResourceKind::Folder, "same").unwrap();
    assert_eq!(
        client.folders(Some(&foreign), None).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    assert_eq!(
        client.messages(&foreign, None).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    assert_eq!(
        client.message(&folder("id")).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    assert_eq!(
        client.messages(&message("id"), None).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
}

#[test]
fn checkpoints_cannot_cross_accounts_folders_or_delta_and_list_routes() {
    let fixture = Fixture::new(|base| {
        vec![ok(json!({"value":[],
        "@odata.nextLink":format!("{base}me/mailFolders/A/messages?$skiptoken=secret")}))]
    });
    let client = fixture.client();
    let page = client.messages(&folder("A"), None).unwrap();
    let cursor = page.checkpoint.as_ref();
    assert_eq!(
        client.messages(&folder("B"), cursor).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    assert_eq!(
        client.message_delta(&folder("A"), cursor).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    let mut other = fixture.client();
    other.grant.account = "other".into();
    let other_folder = ResourceId::new("other", ResourceKind::Folder, "A").unwrap();
    assert_eq!(
        other.messages(&other_folder, cursor).unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn delta_preserves_sparse_changes_tombstones_and_round_boundary() {
    let fixture = Fixture::new(|base| {
        vec![
            ok(
                json!({"value":[{"id":"a","isRead":true},{"id":"b","@removed":{"reason":"deleted"}}],
            "@odata.nextLink":format!("{base}me/mailfolders('A')/messages/delta?$skiptoken=next")}),
            ),
            ok(
                json!({"value":[],"@odata.deltaLink":format!("{base}me/mailFolders/A/messages/delta?$deltatoken=final")}),
            ),
            ok(json!({"value":[{"id":"c","subject":"new","isRead":false}],
            "@odata.deltaLink":format!("{base}me/mailFolders/A/messages/delta?$deltatoken=final")})),
        ]
    });
    let client = fixture.client();
    let first = client.message_delta(&folder("A"), None).unwrap();
    assert_eq!(first.items[0].fields.is_read, Some(true));
    assert!(first.items[0].fields.subject.is_none());
    assert_eq!(
        first.items[1].fields.removed.as_ref().unwrap().reason,
        "deleted"
    );
    assert!(first.items[1].fields.is_read.is_none());
    assert_eq!(
        first.checkpoint.as_ref().unwrap().kind(),
        CheckpointKind::NextPage
    );
    let second = client
        .message_delta(&folder("A"), first.checkpoint.as_ref())
        .unwrap();
    assert_eq!(
        second.checkpoint.as_ref().unwrap().kind(),
        CheckpointKind::Delta
    );
    let third = client
        .message_delta(&folder("A"), second.checkpoint.as_ref())
        .unwrap();
    assert_eq!(third.items[0].fields.is_read, Some(false));
    let requests = fixture.requests();
    assert!(requests[0].starts_with("GET /v1.0/me/mailFolders/A/messages/delta HTTP/"));
    assert!(requests[1].contains("?$skiptoken=next "));
    assert!(requests[1].starts_with("GET /v1.0/me/mailfolders('A')/messages/delta?"));
    assert!(requests[2].contains("?$deltatoken=final "));
}

#[test]
fn message_read_retains_content_etag_and_immutable_identity_without_marking_read() {
    let fixture = Fixture::new(|_| {
        vec![ok(json!({"id":"M/+", "@odata.etag":"W/\"version\"",
        "subject":"Hola", "isRead":false,"body":{"contentType":"html","content":"<script>untrusted</script>"},
        "from":{"emailAddress":{"name":"Sender","address":"sender@example.test"}},
        "toRecipients":[{"emailAddress":{"address":"recipient@example.test"}}]}))]
    });
    let item = fixture.client().message(&message("M/+")).unwrap();
    assert_eq!(item.id, message("M/+"));
    assert_eq!(item.fields.etag.as_deref(), Some("W/\"version\""));
    assert_eq!(item.fields.is_read, Some(false));
    assert_eq!(
        item.fields.body.unwrap().content,
        "<script>untrusted</script>"
    );
    assert_eq!(item.fields.to_recipients.unwrap().len(), 1);
    assert_eq!(fixture.requests().len(), 1);
    assert!(fixture.requests()[0].starts_with("GET /v1.0/me/messages/M%2F+ "));
}

#[test]
fn message_identity_mismatch_is_not_accepted() {
    let fixture = Fixture::new(|_| vec![ok(json!({"id":"different"}))]);
    assert_eq!(
        fixture
            .client()
            .message(&message("requested"))
            .unwrap_err()
            .kind,
        ErrorKind::InvalidResponse
    );
}

#[test]
fn malformed_empty_partial_and_oversized_responses_are_not_successful_empty_snapshots() {
    for body in [
        "{}".into(),
        "null".into(),
        "not-json secret".into(),
        json!({"value":[{"id":"x"}]}).to_string(),
        json!({"value":[wire_folder("")]}).to_string(),
        json!({"value":vec![wire_folder("x"); MAX_ITEMS + 1]}).to_string(),
        "x".repeat(MAX_BODY as usize + 1),
    ] {
        let fixture = Fixture::new(|_| vec![(200, String::new(), body)]);
        let error = fixture.client().folders(None, None).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidResponse);
        assert!(!format!("{error:?} {error}").contains("secret"));
    }
}

#[test]
fn invalid_links_and_impossible_delta_shapes_fail_the_whole_page() {
    for shape in 0..6 {
        let fixture = Fixture::new(|base| {
            let url = format!("{base}me/mailFolders/A/messages/delta");
            let value = match shape {
                0 => json!({"value":[], "@odata.nextLink":"https://evil.example/steal"}),
                1 => json!({"value":[], "@odata.nextLink":url, "@odata.deltaLink":url}),
                2 => json!({"value":[]}), // delta must terminate with a checkpoint
                3 => json!({"value":[], "@odata.nextLink":url}), // immediate pagination loop
                4 => json!({"value":[], "@odata.deltaLink":""}),
                _ => {
                    json!({"value":[], "@odata.deltaLink":format!("{base}me/mailFolders/other/messages/delta")})
                }
            };
            vec![ok(value)]
        });
        assert_eq!(
            fixture
                .client()
                .message_delta(&folder("A"), None)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidResponse,
            "shape {shape}"
        );
        assert_eq!(fixture.requests().len(), 1);
    }
}

#[test]
fn status_errors_are_typed_sanitized_and_never_retried_or_redirected() {
    for (status, expected) in [
        (204, ErrorKind::InvalidResponse),
        (302, ErrorKind::InvalidResponse),
        (400, ErrorKind::InvalidResponse),
        (401, ErrorKind::Reauthenticate),
        (403, ErrorKind::AccessDenied),
        (404, ErrorKind::NotFound),
        (409, ErrorKind::Conflict),
        (410, ErrorKind::ResyncRequired),
        (412, ErrorKind::Conflict),
        (429, ErrorKind::Throttled),
        (500, ErrorKind::Unavailable),
        (503, ErrorKind::Unavailable),
    ] {
        let fixture = Fixture::new(|base| {
            vec![(
                status,
                format!("Retry-After: 17\r\nLocation: {base}me/mailFolders\r\n"),
                "secret provider text fixture-token".into(),
            )]
        });
        let err = fixture.client().folders(None, None).unwrap_err();
        assert_eq!(err.kind, expected, "{status}");
        assert_eq!(err.status, Some(status));
        assert_eq!(
            err.retry_after_seconds,
            if status == 429 || status >= 500 {
                Some(17)
            } else {
                None
            }
        );
        assert!(!format!("{err:?} {err}").contains("secret"));
        assert!(!format!("{err:?} {err}").contains("fixture-token"));
        assert_eq!(fixture.requests().len(), 1);
    }
}

#[test]
fn retry_after_handles_seconds_and_http_dates_without_shortening_provider_delay() {
    let now = chrono::DateTime::parse_from_rfc2822("Wed, 09 Sep 2026 09:00:00 GMT")
        .unwrap()
        .timestamp();
    assert_eq!(retry_after(" 17 ", now), Some(17));
    assert_eq!(retry_after("864000", now), Some(864000));
    assert_eq!(retry_after("Wed, 09 Sep 2026 09:01:00 GMT", now), Some(60));
    assert_eq!(retry_after("Wed, 09 Sep 2026 08:00:00 GMT", now), Some(0));
    for invalid in ["", "-1", "1.5", "secret", "9999999999999999999999999999"] {
        assert_eq!(retry_after(invalid, now), None);
    }
}

#[test]
fn transport_failure_does_not_expose_request_url_or_token() {
    // Accepted connection closes without an HTTP response; no race for a
    // recently released ephemeral port with concurrently running fixtures.
    let fixture = Fixture::new(|_| vec![]);
    let err = fixture.client().folders(None, None).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Transport);
    assert!(!format!("{err:?} {err}").contains(fixture.base.as_str()));
    assert!(!format!("{err:?} {err}").contains("fixture-token"));
}
