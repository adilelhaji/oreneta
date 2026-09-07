//! Sending CardDAV requests over HTTP.
//!
//! Thin on purpose: everything that decides anything lives in `client`, which
//! is tested against canned answers. What is here is the part that needs a
//! network, and the two things about it that are easy to get wrong.
//!
//! The first is the methods. `PROPFIND` and `REPORT` are not among the verbs a
//! convenience API offers, so requests are built by hand.
//!
//! The second is redirects, and they matter more than they look. Discovery
//! starts at `/.well-known/carddav`, whose entire purpose is to redirect, and
//! an HTTP client following that on the client's behalf may quietly turn the
//! PROPFIND into a GET — which is what browsers do and what the specification
//! says a DAV client must not accept. So they are followed here, by hand, with
//! the method and body kept, and the URL that was finally reached is reported
//! back: hrefs in the answer are relative to where the answer came from, not
//! to where the question was asked.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use std::time::Duration;

use super::client::{DavRequest, HttpReply, Transport};

const TIMEOUT: Duration = Duration::from_secs(30);
/// Enough for a provider that redirects a couple of times, few enough that a
/// server pointing at itself stops rather than spins.
const MAX_REDIRECTS: usize = 5;

/// An HTTP transport that signs in with a username and password.
pub struct HttpTransport {
    authorization: String,
}

impl HttpTransport {
    pub fn new(username: &str, password: &str) -> Self {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("{username}:{password}").as_bytes());
        Self {
            authorization: format!("Basic {encoded}"),
        }
    }
}

impl Transport for HttpTransport {
    fn send(&self, request: &DavRequest) -> Result<HttpReply> {
        let agent = crate::proxy::agent()?;
        let mut url = request.url.clone();

        for _ in 0..=MAX_REDIRECTS {
            let mut builder = ureq::http::Request::builder()
                .method(request.method)
                .uri(&url)
                .header("Authorization", &self.authorization)
                .header("User-Agent", "Oreneta");
            if let Some(depth) = request.depth {
                builder = builder.header("Depth", depth);
            }
            if request.body.is_some() {
                builder = builder.header("Content-Type", "application/xml; charset=utf-8");
            }

            let http_request = builder
                .body(request.body.clone().unwrap_or_default())
                .with_context(|| format!("build {} {url}", request.method))?;

            let configured = agent
                .configure_request(http_request)
                // Statuses are answers here, not failures: a 401 means the
                // credentials were refused and a 404 means the path is not
                // there, and both are things to report rather than throw.
                .http_status_as_error(false)
                .timeout_global(Some(TIMEOUT))
                // Followed below instead, keeping the method and the body.
                .max_redirects(0)
                .build();

            let mut response = match agent.run(configured) {
                Ok(response) => response,
                Err(error) => return Err(anyhow!("{} {url}: {error}", request.method)),
            };

            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                if location.is_empty() {
                    return Err(anyhow!("{} {url}: redirected to nowhere", request.method));
                }
                url = url::Url::parse(&url)?.join(&location)?.to_string();
                continue;
            }

            let body = response
                .body_mut()
                .read_to_string()
                .with_context(|| format!("read {} {url}", request.method))?;
            return Ok(HttpReply { status, body, url });
        }

        Err(anyhow!("{} {}: too many redirects", request.method, request.url))
    }
}
