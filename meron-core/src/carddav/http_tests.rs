//! The DAV transport carries CardDAV and CalDAV alike (address books, calendars
//! and task lists), so its route is what decides where all of them connect.

use super::client::{DavRequest, Transport};
use super::http::UreqTransport;

// #193: the account's own route, not only the app-wide one.
#[test]
fn dav_follows_the_route_of_its_account() {
    crate::proxy::route_fixture::check_account_routes(|origin, proxy| {
        let transport = UreqTransport {
            username: "u".to_string(),
            password: "p".to_string(),
            proxy,
        };
        let _ = transport.send(&DavRequest {
            method: "PROPFIND",
            url: format!("{origin}/dav/"),
            depth: Some("0"),
            body: Some("<propfind xmlns=\"DAV:\"/>".to_string()),
            headers: Vec::new(),
        });
    });
}

#[test]
fn a_dav_server_with_an_unusable_account_proxy_is_not_contacted() {
    let origin = crate::proxy::route_fixture::Recorder::origin();
    let transport = UreqTransport {
        username: "u".to_string(),
        password: "p".to_string(),
        proxy: crate::proxy::ProxyChoice::from_json(&serde_json::json!({ "mode": "socks5", "host": "proxy.example" })),
    };
    let err = transport
        .send(&DavRequest {
            method: "PROPFIND",
            url: format!("{}/dav/", origin.url()),
            depth: Some("0"),
            body: None,
            headers: Vec::new(),
        })
        .unwrap_err();
    assert!(format!("{err:#}").contains("this account's proxy is incomplete"), "{err:#}");
    assert!(origin.requests().is_empty(), "the server was never contacted");
}
