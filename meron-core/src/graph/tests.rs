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
    assert!(requests[0].starts_with("GET /v1.0/me/mailFolders/A/messages/delta?"));
    assert!(requests[0].contains("%24select="));
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
    assert!(!item.fields.is_report());
    assert_eq!(item.id, message("M/+"));
    assert_eq!(item.fields.etag.as_deref(), Some("W/\"version\""));
    assert_eq!(item.fields.is_read, Some(false));
    assert_eq!(
        item.fields.body.unwrap().content,
        "<script>untrusted</script>"
    );
    assert_eq!(item.fields.to_recipients.unwrap().len(), 1);
    assert_eq!(fixture.requests().len(), 1);
    // Only the item class is expanded, to tell a report from a message (#210).
    assert!(
        fixture.requests()[0].starts_with(
            "GET /v1.0/me/messages/M%2F+?$expand=singleValueExtendedProperties($filter=id%20eq%20%27String%200x001A%27) "
        ),
        "{}",
        fixture.requests()[0]
    );
}

/// #210: Exchange files delivery and read reports under `REPORT.*` item
/// classes; anything else, or no class at all, is an ordinary message.
#[test]
fn a_report_is_recognised_by_its_item_class() {
    let fields = |class: &str| -> MessageFields {
        serde_json::from_value(json!({"singleValueExtendedProperties":[{"id":"String 0x1a","value":class}]})).unwrap()
    };
    for class in ["REPORT.IPM.Note.NDR", "REPORT.IPM.Note.DR", "Report.IPM.Note.IPNRN", "REPORT.IPM.Note.IPNNRN"] {
        assert!(fields(class).is_report(), "{class}");
    }
    for class in ["IPM.Note", "IPM.Schedule.Meeting.Request", "IPM.Note.REPORT", ""] {
        assert!(!fields(class).is_report(), "{class}");
    }
    let unknown: MessageFields = serde_json::from_value(json!({})).unwrap();
    assert!(!unknown.is_report());
    let other: MessageFields =
        serde_json::from_value(json!({"singleValueExtendedProperties":[{"id":"String 0x0037","value":"REPORT.x"}]})).unwrap();
    assert!(!other.is_report());
    let spelled: MessageFields =
        serde_json::from_value(json!({"singleValueExtendedProperties":[{"id":"String 0x001A","value":"REPORT.IPM.Note.NDR"}]})).unwrap();
    assert!(spelled.is_report());
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

// ---- #141: message writes ----

fn writer(fixture: &Fixture, scope: &str) -> Client {
    let mut client = Client::new(grant(scope), crate::proxy::ProxyChoice::Direct);
    client.base = fixture.base.clone();
    client
}
fn body_of(request: &str) -> serde_json::Value {
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    serde_json::from_str(body).unwrap_or(serde_json::Value::Null)
}

#[test]
fn a_read_only_grant_sends_no_write_at_all() {
    let fixture = Fixture::new(|_| vec![]);
    let client = writer(&fixture, "Mail.Read");
    for result in [
        client.set_read(&message("M1"), true),
        client.set_flag(&message("M1"), true),
        client.delete_message(&message("M1")),
        client.move_message(&message("M1"), &folder("F2")).map(|_| ()),
        client.copy_message(&message("M1"), &folder("F2")).map(|_| ()),
    ] {
        assert_eq!(result.unwrap_err().kind, ErrorKind::ConsentRequired);
    }
    assert!(fixture.requests().is_empty());
}

#[test]
fn read_state_and_flag_are_absolute_patches_with_immutable_ids() {
    let fixture = Fixture::new(|_| {
        vec![
            ok(json!({"id":"M/1","isRead":true})),
            (204, String::new(), String::new()),
        ]
    });
    let client = writer(&fixture, "Mail.ReadWrite");
    client.set_read(&message("M/1"), true).unwrap();
    client.set_flag(&message("M/1"), false).unwrap();
    let requests = fixture.requests();
    assert!(requests[0].starts_with("PATCH /v1.0/me/messages/M%2F1 "), "{}", requests[0]);
    assert!(requests[0].to_ascii_lowercase().contains("authorization: bearer fixture-token"));
    assert!(requests[0].to_ascii_lowercase().contains("prefer: idtype=\"immutableid\""));
    assert_eq!(body_of(&requests[0]), json!({"isRead": true}));
    assert_eq!(body_of(&requests[1]), json!({"flag": {"flagStatus": "notFlagged"}}));
}

#[test]
fn a_patch_confirming_another_message_is_not_a_confirmation() {
    let fixture = Fixture::new(|_| vec![ok(json!({"id":"OTHER"}))]);
    let error = writer(&fixture, "Mail.ReadWrite").set_read(&message("M1"), false).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidResponse);
}

#[test]
fn move_and_copy_post_the_destination_and_return_the_reported_id() {
    let fixture = Fixture::new(|_| {
        vec![
            (201, String::new(), json!({"id":"M1","parentFolderId":"F2"}).to_string()),
            (201, String::new(), json!({"id":"COPY","parentFolderId":"F2"}).to_string()),
        ]
    });
    let client = writer(&fixture, "Mail.ReadWrite");
    assert_eq!(client.move_message(&message("M1"), &folder("F2")).unwrap(), message("M1"));
    assert_eq!(client.copy_message(&message("M1"), &folder("F2")).unwrap(), message("COPY"));
    let requests = fixture.requests();
    assert!(requests[0].starts_with("POST /v1.0/me/messages/M1/move "));
    assert!(requests[1].starts_with("POST /v1.0/me/messages/M1/copy "));
    assert_eq!(body_of(&requests[0]), json!({"destinationId": "F2"}));
}

#[test]
fn a_move_reported_into_another_folder_is_rejected() {
    let fixture = Fixture::new(|_| vec![(201, String::new(), json!({"id":"M1","parentFolderId":"ELSEWHERE"}).to_string())]);
    let error = writer(&fixture, "Mail.ReadWrite")
        .move_message(&message("M1"), &folder("F2"))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidResponse);
}

#[test]
fn delete_is_a_delete_with_no_content() {
    let fixture = Fixture::new(|_| vec![(204, String::new(), String::new())]);
    writer(&fixture, "Mail.ReadWrite").delete_message(&message("M1")).unwrap();
    assert!(fixture.requests()[0].starts_with("DELETE /v1.0/me/messages/M1 "));
}

#[test]
fn write_errors_keep_their_category_and_retry_delay() {
    let cases = [
        (401, ErrorKind::Reauthenticate),
        (403, ErrorKind::AccessDenied),
        (404, ErrorKind::NotFound),
        (409, ErrorKind::Conflict),
        (412, ErrorKind::Conflict),
        (429, ErrorKind::Throttled),
        (503, ErrorKind::Unavailable),
    ];
    let fixture = Fixture::new(|_| {
        cases
            .iter()
            .map(|(status, _)| (*status, "Retry-After: 30\r\n".to_string(), "{\"error\":{\"message\":\"secret mail text\"}}".to_string()))
            .collect()
    });
    let client = writer(&fixture, "Mail.ReadWrite");
    for (status, kind) in cases {
        let error = client.set_read(&message("M1"), true).unwrap_err();
        assert_eq!((error.kind, error.status), (kind, Some(status)));
        let expected = matches!(kind, ErrorKind::Throttled | ErrorKind::Unavailable).then_some(30);
        assert_eq!(error.retry_after_seconds, expected);
        assert!(!error.to_string().contains("secret"));
    }
}

#[test]
fn a_connection_lost_after_sending_is_uncertain_and_not_repeated() {
    // No reply: the fixture reads the request and closes the socket.
    let fixture = Fixture::new(|_| vec![]);
    let error = writer(&fixture, "Mail.ReadWrite")
        .move_message(&message("M1"), &folder("F2"))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Uncertain);
    assert_eq!(fixture.requests().len(), 1, "a move whose outcome is unknown is sent once");
}

#[test]
fn writes_never_follow_a_redirect() {
    let fixture = Fixture::new(|base| vec![(307, format!("Location: {base}me/messages/M2\r\n"), String::new())]);
    let error = writer(&fixture, "Mail.ReadWrite").set_flag(&message("M1"), true).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidResponse);
    assert_eq!(fixture.requests().len(), 1);
}

#[test]
fn a_write_for_another_account_is_refused_before_sending() {
    let fixture = Fixture::new(|_| vec![]);
    let other = ResourceId::new("account-b", ResourceKind::Message, "M1").unwrap();
    let error = writer(&fixture, "Mail.ReadWrite").set_read(&other, true).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert!(fixture.requests().is_empty());
}

// ---- #142: attachments ----

#[test]
fn the_whole_message_is_read_as_mime_with_a_read_grant() {
    let raw = "Subject: Report\r\n\r\nbody";
    let fixture = Fixture::new(|_| vec![(200, String::new(), raw.to_string())]);
    let client = writer(&fixture, "Mail.Read");
    assert_eq!(client.message_mime(&message("M/1")).unwrap(), raw.as_bytes());
    let request = &fixture.requests()[0];
    assert!(request.starts_with("GET /v1.0/me/messages/M%2F1/$value "), "{request}");
}

#[test]
fn a_message_over_the_bound_is_too_large_and_nothing_is_kept() {
    let fixture = Fixture::new(|_| vec![(200, String::new(), "x".repeat(64))]);
    let client = writer(&fixture, "Mail.Read");
    let url = client.route(&["me", "messages", "M1", "$value"]);
    let error = client.get_bytes(&url, "*/*", 16).unwrap_err();
    assert_eq!(error.kind, ErrorKind::TooLarge);
}

#[test]
fn attachments_are_listed_without_bytes_and_links_are_recognised() {
    let fixture = Fixture::new(|_| {
        vec![ok(json!({"value":[
            {"@odata.type":"#microsoft.graph.fileAttachment","name":"q3.pdf","contentType":"application/pdf","size":10,"isInline":false},
            {"@odata.type":"#microsoft.graph.referenceAttachment","name":"Plan.xlsx","contentType":null,"size":0,"isInline":false,"sourceUrl":"https://contoso.sharepoint.com/secret"}
        ]}))]
    });
    let listed = writer(&fixture, "Mail.Read").attachments(&message("M1")).unwrap();
    assert_eq!(listed.iter().map(|a| a.is_link()).collect::<Vec<_>>(), vec![false, true]);
    let request = &fixture.requests()[0];
    assert!(request.starts_with("GET /v1.0/me/messages/M1/attachments?"), "{request}");
    assert!(request.contains("%24select=name%2CcontentType%2Csize%2CisInline"), "{request}");
    // Only the one request: a link is never followed.
    assert_eq!(fixture.requests().len(), 1);
}

// ---- #143: sending ----

#[test]
fn sending_posts_the_mime_base64_encoded_and_202_is_accepted() {
    use base64::Engine as _;
    let raw = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n\r\nHello";
    let fixture = Fixture::new(|_| vec![(202, String::new(), String::new())]);
    writer(&fixture, "Mail.Read Mail.Send").send_mime(raw).unwrap();
    let request = &fixture.requests()[0];
    assert!(request.starts_with("POST /v1.0/me/sendMail "), "{request}");
    assert!(request.to_ascii_lowercase().contains("content-type: text/plain"));
    let body = request.split("\r\n\r\n").nth(1).unwrap();
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(body).unwrap(), raw);
}

#[test]
fn a_grant_without_mail_send_sends_nothing() {
    let fixture = Fixture::new(|_| vec![]);
    let error = writer(&fixture, "Mail.ReadWrite").send_mime(b"x").unwrap_err();
    assert_eq!(error.kind, ErrorKind::ConsentRequired);
    assert!(fixture.requests().is_empty());
}

#[test]
fn a_message_over_the_request_bound_is_refused_before_sending() {
    let fixture = Fixture::new(|_| vec![]);
    let big = vec![b'a'; MAX_SEND_REQUEST];
    let error = writer(&fixture, "Mail.Send").send_mime(&big).unwrap_err();
    assert_eq!(error.kind, ErrorKind::TooLarge);
    assert!(fixture.requests().is_empty());
}

#[test]
fn send_refusals_keep_their_category_and_a_lost_answer_is_uncertain() {
    let fixture = Fixture::new(|_| {
        vec![
            (403, String::new(), String::new()),
            (429, "Retry-After: 20\r\n".to_string(), String::new()),
            (504, String::new(), String::new()),
        ]
    });
    let client = writer(&fixture, "Mail.Send");
    assert_eq!(client.send_mime(b"x").unwrap_err().kind, ErrorKind::AccessDenied);
    let throttled = client.send_mime(b"x").unwrap_err();
    assert_eq!((throttled.kind, throttled.retry_after_seconds), (ErrorKind::Throttled, Some(20)));
    assert_eq!(client.send_mime(b"x").unwrap_err().kind, ErrorKind::Unavailable);
    // No reply at all: sent once, outcome unknown.
    let silent = Fixture::new(|_| vec![]);
    assert_eq!(writer(&silent, "Mail.Send").send_mime(b"x").unwrap_err().kind, ErrorKind::Uncertain);
    assert_eq!(silent.requests().len(), 1);
}

// ---- #210: folder moves and delivery receipts ----

#[test]
fn a_folder_move_posts_the_destination_and_returns_the_reported_id() {
    let fixture = Fixture::new(|_| vec![(201, String::new(), json!({"id":"F/1","parentFolderId":"P2","displayName":"Work"}).to_string())]);
    let moved = writer(&fixture, "Mail.ReadWrite").move_folder(&folder("F/1"), &folder("P2")).unwrap();
    assert_eq!(moved, folder("F/1"));
    let request = &fixture.requests()[0];
    assert!(request.starts_with("POST /v1.0/me/mailFolders/F%2F1/move "), "{request}");
    assert!(request.to_ascii_lowercase().contains("prefer: idtype=\"immutableid\""));
    assert_eq!(body_of(request), json!({"destinationId": "P2"}));
}

/// A success that does not say the folder is where it was sent is no
/// confirmation, and no refusal either: it may have moved (#210).
#[test]
fn a_folder_move_answered_with_an_unexpected_success_is_uncertain_not_refused() {
    let fixture = Fixture::new(|_| {
        vec![
            (201, String::new(), json!({"id":"F1","parentFolderId":"ELSEWHERE"}).to_string()),
            (201, String::new(), json!({"id":"F1"}).to_string()),
            (204, String::new(), String::new()),
            (202, String::new(), String::new()),
            (201, String::new(), "not json".to_string()),
        ]
    });
    let client = writer(&fixture, "Mail.ReadWrite");
    for _ in 0..5 {
        assert_eq!(client.move_folder(&folder("F1"), &folder("P2")).unwrap_err().kind, ErrorKind::Uncertain);
    }
    // A refusal stays a refusal.
    let refused = Fixture::new(|_| vec![(400, String::new(), String::new())]);
    let error = writer(&refused, "Mail.ReadWrite").move_folder(&folder("F1"), &folder("P2")).unwrap_err();
    assert_eq!((error.kind, error.status), (ErrorKind::InvalidResponse, Some(400)));
}

#[test]
fn a_folder_move_is_refused_without_changes_and_across_accounts_before_sending() {
    let fixture = Fixture::new(|_| vec![]);
    let error = writer(&fixture, "Mail.Read Mail.Send").move_folder(&folder("F1"), &folder("P2")).unwrap_err();
    assert_eq!(error.kind, ErrorKind::ConsentRequired);
    let other = ResourceId::new("account-b", ResourceKind::Folder, "P2").unwrap();
    let error = writer(&fixture, "Mail.ReadWrite").move_folder(&folder("F1"), &other).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    // A message id is not a folder id.
    let error = writer(&fixture, "Mail.ReadWrite").move_folder(&message("F1"), &folder("P2")).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert!(fixture.requests().is_empty());
}

#[test]
fn a_folder_move_keeps_its_error_category_and_a_lost_answer_is_uncertain_and_sent_once() {
    let fixture = Fixture::new(|_| {
        vec![
            (403, String::new(), String::new()),
            (409, String::new(), String::new()),
            (429, "Retry-After: 12\r\n".to_string(), String::new()),
        ]
    });
    let client = writer(&fixture, "Mail.ReadWrite");
    assert_eq!(client.move_folder(&folder("F1"), &folder("P2")).unwrap_err().kind, ErrorKind::AccessDenied);
    assert_eq!(client.move_folder(&folder("F1"), &folder("P2")).unwrap_err().kind, ErrorKind::Conflict);
    let throttled = client.move_folder(&folder("F1"), &folder("P2")).unwrap_err();
    assert_eq!((throttled.kind, throttled.retry_after_seconds), (ErrorKind::Throttled, Some(12)));
    let silent = Fixture::new(|_| vec![]);
    let error = writer(&silent, "Mail.ReadWrite").move_folder(&folder("F1"), &folder("P2")).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Uncertain);
    assert_eq!(silent.requests().len(), 1, "a folder move whose outcome is unknown is sent once");
}

#[test]
fn a_delivery_receipt_is_a_draft_from_the_mime_marked_then_sent() {
    use base64::Engine as _;
    let raw = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\nMessage-ID: <m1@example.com>\r\n\r\nHello";
    let fixture = Fixture::new(|_| {
        vec![
            (201, String::new(), json!({"id":"D/1","isDraft":true}).to_string()),
            ok(json!({"id":"D/1","isDeliveryReceiptRequested":true})),
            (202, String::new(), String::new()),
        ]
    });
    let client = writer(&fixture, "Mail.ReadWrite Mail.Send");
    let draft = client.create_mime_draft(raw).unwrap();
    assert_eq!(draft, message("D/1"));
    client.request_delivery_receipt(&draft).unwrap();
    client.send_draft(&draft).unwrap();
    let requests = fixture.requests();
    assert!(requests[0].starts_with("POST /v1.0/me/messages "), "{}", requests[0]);
    assert!(requests[0].to_ascii_lowercase().contains("content-type: text/plain"));
    assert!(requests[0].to_ascii_lowercase().contains("prefer: idtype=\"immutableid\""));
    let body = requests[0].split("\r\n\r\n").nth(1).unwrap();
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(body).unwrap(), raw);
    assert!(requests[1].starts_with("PATCH /v1.0/me/messages/D%2F1 "), "{}", requests[1]);
    assert_eq!(body_of(&requests[1]), json!({"isDeliveryReceiptRequested": true}));
    assert!(requests[2].starts_with("POST /v1.0/me/messages/D%2F1/send "), "{}", requests[2]);
    assert_eq!(requests[2].split("\r\n\r\n").nth(1), Some(""), "the send carries no body");
}

#[test]
fn a_delivery_receipt_draft_needs_changes_and_respects_the_request_bound() {
    let fixture = Fixture::new(|_| vec![]);
    // Sending alone cannot make the draft the request lives on.
    assert_eq!(writer(&fixture, "Mail.Read Mail.Send").create_mime_draft(b"x").unwrap_err().kind, ErrorKind::ConsentRequired);
    // Changes alone cannot send it.
    assert_eq!(writer(&fixture, "Mail.ReadWrite").send_draft(&message("D1")).unwrap_err().kind, ErrorKind::ConsentRequired);
    let big = vec![b'a'; MAX_SEND_REQUEST];
    assert_eq!(writer(&fixture, "Mail.ReadWrite Mail.Send").create_mime_draft(&big).unwrap_err().kind, ErrorKind::TooLarge);
    assert!(fixture.requests().is_empty());
}

/// #29: once a send reached Microsoft, only a refusal says it did not go.
/// Any other success than 202, or one that cannot be read, may have gone.
#[test]
fn a_send_answered_with_an_unexpected_success_is_uncertain_not_refused() {
    let fixture = Fixture::new(|_| {
        vec![
            (200, String::new(), String::new()),
            (201, String::new(), "{}".to_string()),
            (200, String::new(), String::new()),
            (400, String::new(), String::new()),
        ]
    });
    let client = writer(&fixture, "Mail.ReadWrite Mail.Send");
    assert_eq!(client.send_draft(&message("D1")).unwrap_err().kind, ErrorKind::Uncertain);
    assert_eq!(client.send_draft(&message("D1")).unwrap_err().kind, ErrorKind::Uncertain);
    assert_eq!(client.send_mime(b"x").unwrap_err().kind, ErrorKind::Uncertain);
    assert_eq!(client.send_mime(b"x").unwrap_err().kind, ErrorKind::InvalidResponse);
    assert_eq!(fixture.requests().len(), 4, "nothing is sent twice");
}

#[test]
fn reports_in_a_folder_are_found_by_their_item_class() {
    let fixture = Fixture::new(|_| vec![ok(json!({"value":[{"id":"R1"},{"id":"R2"}]}))]);
    let found = writer(&fixture, "Mail.Read").report_ids(&folder("F/1"), 20).unwrap();
    assert_eq!(found, vec![message("R1"), message("R2")]);
    let request = &fixture.requests()[0];
    assert!(request.starts_with("GET /v1.0/me/mailFolders/F%2F1/messages?$select=id&$top=20&$filter=singleValueExtendedProperties/any(ep:ep/id%20eq%20%27String%200x001A%27%20and%20(ep/value%20eq%20%27REPORT.IPM.Note.NDR%27"), "{request}");
    assert!(request.contains("REPORT.IPM.Note.IPNRN"), "{request}");
    // A read-basic grant does not read messages.
    let none = Fixture::new(|_| vec![]);
    assert_eq!(writer(&none, "Mail.ReadBasic").report_ids(&folder("F1"), 20).unwrap_err().kind, ErrorKind::ConsentRequired);
    assert!(none.requests().is_empty());
}

#[test]
fn a_draft_send_keeps_its_category_and_a_lost_answer_is_uncertain_and_sent_once() {
    let fixture = Fixture::new(|_| vec![(403, String::new(), String::new()), (503, String::new(), String::new())]);
    let client = writer(&fixture, "Mail.ReadWrite Mail.Send");
    assert_eq!(client.send_draft(&message("D1")).unwrap_err().kind, ErrorKind::AccessDenied);
    assert_eq!(client.send_draft(&message("D1")).unwrap_err().kind, ErrorKind::Unavailable);
    let silent = Fixture::new(|_| vec![]);
    assert_eq!(writer(&silent, "Mail.ReadWrite Mail.Send").send_draft(&message("D1")).unwrap_err().kind, ErrorKind::Uncertain);
    assert_eq!(silent.requests().len(), 1);
}

// ---- #201: a proxy setting that cannot be used ----

#[test]
fn a_proxy_setting_that_cannot_be_used_is_a_proxy_error_and_not_retried() {
    // The account's own proxy, half filled in: refused before anything is
    // sent, and said to be that setting rather than a transport failure.
    let origin = Fixture::new(|_| vec![]);
    let mut client = origin.client();
    client.proxy = crate::proxy::ProxyChoice::from_json(&json!({ "mode": "socks5", "host": "proxy.example" }));
    let own = client.folders(None, None).unwrap_err();
    assert_eq!(own.kind, ErrorKind::AccountProxyUnusable);
    assert_eq!(own.to_string(), "Microsoft Graph: proxy setting unusable (account)");
    assert_eq!(own.retry_after_seconds, None);

    // Following an app-wide proxy that cannot be used names that one.
    let app = {
        let _slot = crate::proxy::route_fixture::GlobalSlot::take();
        crate::proxy::publish_global(&json!({ "mode": "http", "port": 3128 }));
        client.proxy = crate::proxy::ProxyChoice::Global;
        client.folders(None, None).unwrap_err()
    };
    assert_eq!(app.kind, ErrorKind::AppProxyUnusable);
    assert_eq!(app.to_string(), "Microsoft Graph: proxy setting unusable (app)");
    assert!(origin.requests().is_empty(), "nothing was sent");

    // Neither is retried as a passing network failure, even under words
    // that would otherwise read as one.
    for err in [own, app] {
        let wrapped = anyhow::Error::new(err).context("sync INBOX: timed out");
        assert!(!crate::engine::is_transient_sync_error(&wrapped), "{wrapped:#}");
    }
}

#[test]
fn a_proxy_server_the_http_client_cannot_use_is_a_proxy_error_too() {
    // A port typed into the server field: ureq cannot be pointed at it, so
    // nothing is sent and the setting is named, not "Transport" (#201).
    let origin = Fixture::new(|_| vec![]);
    let mut client = origin.client();
    let pasted = crate::proxy::ProxyConfig {
        kind: crate::proxy::ProxyKind::Http,
        host: "proxy.corp:3128".into(),
        port: 3128,
        username: String::new(),
        password: String::new(),
    };
    client.proxy = crate::proxy::ProxyChoice::Custom(pasted.clone());
    assert_eq!(client.folders(None, None).unwrap_err().kind, ErrorKind::AccountProxyUnusable);
    let app = {
        let _slot = crate::proxy::route_fixture::GlobalSlot::take();
        crate::proxy::set_global(Some(pasted));
        client.proxy = crate::proxy::ProxyChoice::Global;
        client.folders(None, None).unwrap_err()
    };
    assert_eq!(app.kind, ErrorKind::AppProxyUnusable);
    assert!(origin.requests().is_empty(), "nothing was sent");
}
