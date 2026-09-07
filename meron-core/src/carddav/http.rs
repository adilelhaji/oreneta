//! The transport the app uses: HTTP over `ureq`, through the app-wide proxy.

use std::time::Duration;

use anyhow::{Context, Result};

use super::client::{DavRequest, HttpReply, Transport};

const TIMEOUT: Duration = Duration::from_secs(30);

/// A DAV server reached over HTTP with a username and password.
pub struct UreqTransport {
    pub username: String,
    pub password: String,
}

impl Transport for UreqTransport {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        let agent = crate::proxy::agent()?;
        let mut builder = ureq::http::Request::builder()
            .method(request.method)
            .uri(&request.url)
            .header("Content-Type", "application/xml; charset=utf-8")
            .header("Accept", "application/xml, text/xml, text/vcard, */*");
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
            .build();
        let mut response = agent
            .run(configured)
            .with_context(|| format!("{} {}", request.method, request.url))?;

        let status = response.status().as_u16();
        // Where the request ended up after redirects — `.well-known` exists to
        // redirect, and hrefs in the answer are relative to *here*.
        let url = ureq::ResponseExt::get_uri(&response).to_string();
        let body = response
            .body_mut()
            .read_to_string()
            .with_context(|| format!("read {} {}", request.method, request.url))?;
        Ok(HttpReply { status, body, url })
    }
}
