//! The transport the app uses: HTTP over `ureq`, through the route of the
//! account it belongs to (its own proxy, direct, or the app-wide one).

use std::time::Duration;

use anyhow::{Context, Result};

use super::client::{DavRequest, HttpReply, Transport};

const TIMEOUT: Duration = Duration::from_secs(30);

/// A DAV server reached over HTTP with a username and password.
pub struct UreqTransport {
    pub username: String,
    pub password: String,
    /// The route of the account this server is kept under (#193). A server
    /// kept under no account follows the app-wide proxy.
    pub proxy: crate::proxy::ProxyChoice,
}

impl Transport for UreqTransport {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        let agent = self.proxy.agent()?;
        let content_type = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.as_str())
            .unwrap_or("application/xml; charset=utf-8");
        let mut builder = ureq::http::Request::builder()
            .method(request.method)
            .uri(&request.url)
            .header("Content-Type", content_type)
            .header("Accept", "application/xml, text/xml, text/vcard, */*");
        for (name, value) in &request.headers {
            if !name.eq_ignore_ascii_case("content-type") {
                builder = builder.header(*name, value);
            }
        }
        if !self.username.is_empty() {
            let credentials = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                format!("{}:{}", self.username, self.password),
            );
            builder = builder.header("Authorization", format!("Basic {credentials}"));
        }
        if let Some(depth) = request.depth {
            builder = builder.header("Depth", depth);
        }
        let built = builder
            .body(request.body.clone().unwrap_or_default())
            .context("build DAV request")?;

        let configured = agent
            .configure_request(built)
            // PROPFIND and REPORT are WebDAV's, not HTTP's, and ureq refuses
            // them unless told they are meant. They are.
            .allow_non_standard_methods(true)
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            // The password is set on the request, and a redirect is the
            // server choosing where it goes next. It is never forwarded on
            // one; a redirected request that needs it is answered 401 and
            // reported, rather than sent to a host nobody checked (#28).
            // ureq's default, stated so it cannot change under us.
            .redirect_auth_headers(ureq::config::RedirectAuthHeaders::Never)
            .build();
        let mut response = agent
            .run(configured)
            .with_context(|| format!("{} {}", request.method, request.url))?;

        let status = response.status().as_u16();
        // Where the request ended up after redirects — `.well-known` exists to
        // redirect, and hrefs in the answer are relative to *here*.
        let url = ureq::ResponseExt::get_uri(&response).to_string();
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response
            .body_mut()
            .read_to_string()
            .with_context(|| format!("read {} {}", request.method, request.url))?;
        Ok(HttpReply { status, body, url, etag })
    }
}
