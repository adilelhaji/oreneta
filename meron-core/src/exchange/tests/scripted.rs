//! A scripted Exchange server for the ADR-0058 tests: one step per request,
//! in order. Like `serve_soap`, and also able to take a request and close the
//! connection without answering, which is how a lost answer looks from here.

use std::io::{Read as _, Write as _};

/// What the server does with one request.
pub enum Step {
    /// Answers with this SOAP body.
    Reply(String),
    /// Reads the request and hangs up without a word.
    Drop,
}

/// Serves `steps`, one per request, then stops. Returns the URL and a handle
/// yielding every request received, dropped ones included.
pub fn serve(steps: Vec<Step>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for step in steps {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let (header_end, content_length) = loop {
                let n = stream.read(&mut chunk).expect("read");
                request.extend_from_slice(&chunk[..n]);
                if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..pos]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (pos + 4, length);
                }
            };
            while request.len() < header_end + content_length {
                let n = stream.read(&mut chunk).expect("read body");
                request.extend_from_slice(&chunk[..n]);
            }
            requests.push(String::from_utf8_lossy(&request).into_owned());
            match step {
                Step::Reply(body) => {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/xml; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    stream.write_all(response.as_bytes()).expect("write");
                }
                Step::Drop => drop(stream),
            }
        }
        requests
    });
    (format!("http://{addr}"), handle)
}

/// A client for the scripted server at `url`.
pub fn client(url: String) -> crate::exchange::EwsClient {
    crate::exchange::EwsClient::new(crate::exchange::EwsConfig {
        url,
        username: "u".to_string(),
        password: "p".to_string(),
        target_mailbox: String::new(),
        proxy: crate::proxy::ProxyChoice::Direct,
    })
}

/// A success answer to `operation` carrying `payload` in its one message.
pub fn ok(operation: &str, payload: &str) -> String {
    envelope(&format!(
        r#"<m:{operation}Response><m:ResponseMessages><m:{operation}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{payload}</m:{operation}ResponseMessage></m:ResponseMessages></m:{operation}Response>"#
    ))
}

/// A SOAP envelope around `body`, with the two Exchange namespaces bound.
pub fn envelope(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Header/>
  <s:Body>{body}</s:Body>
</s:Envelope>"#
    )
}

/// An error answer to `operation`, as Exchange reports one item it refused.
pub fn error_response(operation: &str, code: &str, text: &str) -> String {
    envelope(&format!(
        r#"<m:{operation}Response><m:ResponseMessages><m:{operation}ResponseMessage ResponseClass="Error"><m:MessageText>{text}</m:MessageText><m:ResponseCode>{code}</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey></m:{operation}ResponseMessage></m:ResponseMessages></m:{operation}Response>"#
    ))
}
