//! SMTP send path: build a MIME message with `mail-builder` and submit it over
//! `async-smtp` (the chatmail/Delta Chat SMTP stack), reusing the IMAP `Stream`
//! enum for plaintext or implicit-TLS transport.

use anyhow::{Context, Result};
use async_smtp::authentication::{Credentials, Mechanism};
use async_smtp::commands::{DataCommand, MailCommand, RcptCommand};
use async_smtp::error::Error as SmtpError;
use async_smtp::{EmailAddress, Envelope, SendableEmail, SmtpClient, SmtpTransport};
use base64::Engine as _;
use mail_builder::MessageBuilder;
use mail_builder::headers::content_type::ContentType;
use std::time::Duration;
use tokio::io::BufReader;

use crate::imap::{Creds, connect_stream};

/// Cap on each pre-DATA exchange (greeting, STARTTLS, AUTH). async-smtp has no
/// I/O timeouts of its own, so without these a connection that dies mid-command
/// hangs the send forever.
const SMTP_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// Cap on the DATA phase, sized for large attachments on slow uplinks.
const SMTP_DATA_TIMEOUT: Duration = Duration::from_secs(300);

async fn with_timeout<T>(
    limit: Duration,
    what: &str,
    fut: impl std::future::Future<Output = T>,
) -> Result<T> {
    tokio::time::timeout(limit, fut)
        .await
        .map_err(|_| anyhow::anyhow!("{what} timed out after {}s", limit.as_secs()))
}

/// Verify that the submission server presents a certificate we accept, without
/// authenticating or sending anything. Run when an account is saved, because
/// the IMAP validation next to it cannot speak for a second server that may
/// have a certificate of its own.
///
/// Only certificate failures are reported: an unreachable or fussy submission
/// server is left for the first real send, which is where it has always
/// surfaced, so saving an account does not start failing on servers that reject
/// probes.
pub async fn check_certificate(creds: &Creds) -> Result<()> {
    let host = if creds.smtp_host.is_empty() {
        creds.host.as_str()
    } else {
        creds.smtp_host.as_str()
    };
    let port = if creds.smtp_port == 0 {
        587
    } else {
        creds.smtp_port
    };
    let implicit_tls = creds.smtp_tls && !creds.smtp_starttls;
    if !implicit_tls && !creds.smtp_starttls {
        // Plaintext submission: no certificate to check.
        return Ok(());
    }
    let proxy = creds.proxy.resolve()?;
    let pin = creds.smtp_cert_pin.as_deref();
    let outcome = async {
        let tcp = crate::imap::open_socket(host, port, proxy.as_ref()).await?;
        let tcp = if creds.smtp_starttls {
            starttls_socket(tcp).await?
        } else {
            tcp
        };
        crate::imap::upgrade_to_tls(host, tcp, pin)
            .await
            .map(|_| ())
    }
    .await;
    match outcome {
        Ok(()) => Ok(()),
        Err(err) if is_cert_failure(&err) => Err(as_smtp_cert_error(err)),
        Err(err) => {
            crate::mlog!(
                crate::log::Level::Warn,
                "net",
                "smtp certificate check for {host}:{port} could not complete: {err:#}"
            );
            Ok(())
        }
    }
}

fn is_cert_failure(err: &anyhow::Error) -> bool {
    err.downcast_ref::<crate::tls::UntrustedCertificate>()
        .is_some()
}

/// Re-tag a certificate rejection with the submission server's marker. Both
/// servers hand back the same typed error, and the UI has to know which one to
/// probe and which pin to write.
fn as_smtp_cert_error(err: anyhow::Error) -> anyhow::Error {
    match err.downcast_ref::<crate::tls::UntrustedCertificate>() {
        Some(untrusted) => anyhow::anyhow!(
            "{}: {}",
            crate::tls::UNTRUSTED_SMTP_CERT_MARKER,
            untrusted.detail()
        ),
        None => err,
    }
}

/// Speak SMTP far enough to reach the STARTTLS upgrade and return the raw
/// socket. Used only by the certificate probe (see [`crate::tls::probe`]); no
/// credentials are ever sent over it.
pub(crate) async fn starttls_socket(tcp: tokio::net::TcpStream) -> Result<tokio::net::TcpStream> {
    let transport = with_timeout(
        SMTP_COMMAND_TIMEOUT,
        "smtp greeting",
        SmtpTransport::new(
            SmtpClient::new(),
            BufReader::new(crate::imap::Stream::Plain(tcp)),
        ),
    )
    .await?
    .context("smtp connect")?;
    let inner = with_timeout(SMTP_COMMAND_TIMEOUT, "smtp starttls", transport.starttls())
        .await?
        .context("SMTP STARTTLS")?;
    match inner.into_inner() {
        crate::imap::Stream::Plain(tcp) => Ok(tcp),
        crate::imap::Stream::Tls(_) => Err(anyhow::anyhow!(
            "STARTTLS requested on an already-TLS stream"
        )),
    }
}

#[derive(serde::Deserialize, Debug)]
pub struct AttachmentInput {
    pub filename: String,
    pub mime: String,
    pub data: String, // base64 encoded
    #[serde(default)]
    pub inline_id: String,
}

/// Split a comma-separated recipient string into trimmed, non-empty entries.
/// Commas inside a double-quoted display name (`"Doe, Jane" <j@x>`) or inside
/// the `<...>` address brackets don't split, so quoted contact names survive.
fn parse_addrs(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut in_brackets = false;
    for ch in raw.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            '<' if !in_quotes => {
                in_brackets = true;
                current.push(ch);
            }
            '>' if !in_quotes => {
                in_brackets = false;
                current.push(ch);
            }
            ',' if !in_quotes && !in_brackets => {
                let entry = current.trim();
                if !entry.is_empty() {
                    out.push(entry.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let entry = current.trim();
    if !entry.is_empty() {
        out.push(entry.to_string());
    }
    out
}

/// Split a `Name <addr>` (or bare `addr`) entry into its display name and
/// address. mail-builder's `From<&str> for Address` treats the entire input as
/// the email field — so passing `"Name <addr>"` produces a header like
/// `<Name <addr>>`, which receiving clients render as a malformed recipient
/// (display name "<Name >" with literal angle brackets). Splitting here keeps
/// the display name in `name` where it belongs.
fn split_name_addr(entry: &str) -> (String, String) {
    let trimmed = entry.trim();
    if let Some(start) = trimmed.find('<')
        && let Some(end_rel) = trimmed[start + 1..].find('>')
    {
        let name = trimmed[..start].trim();
        // Unwrap a quoted display name (`"Doe, Jane"`) and undo its escapes;
        // mail-builder re-encodes the raw name itself.
        let name = if name.len() >= 2 && name.starts_with('"') && name.ends_with('"') {
            name[1..name.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .trim()
                .to_string()
        } else {
            name.to_string()
        };
        let addr = trimmed[start + 1..start + 1 + end_rel].trim();
        return (name, addr.to_string());
    }
    (String::new(), trimmed.to_string())
}

/// What the sender asked to have done to a message before it goes, and with
/// which protocol.
///
/// Carries the keys rather than looking them up, so this module stays about
/// sending and the crypto module stays about cryptography. Two variants, not
/// a single struct with optional fields either way: which protocol protects
/// a message is decided once, by the caller (`perform_send`, automatically —
/// S/MIME when it can cover the sender and every recipient, OpenPGP
/// otherwise), and everything downstream of that decision uses exactly one
/// protocol's keys, never a mix.
pub enum Protection {
    Pgp {
        what: crate::crypto::pgp::Protect,
        signing_key: Option<sequoia_openpgp::Cert>,
        passphrase: Option<String>,
        recipients: Vec<sequoia_openpgp::Cert>,
        /// Every address the message is going to, for checking a key is held
        /// for each of them before anything is encrypted.
        recipient_addresses: Vec<String>,
    },
    Smime {
        what: crate::crypto::smime::Protect,
        identity: Option<crate::crypto::pkcs12::Identity>,
        recipients: Vec<x509_cert::Certificate>,
        recipient_addresses: Vec<String>,
    },
}

impl Protection {
    pub fn apply(&self, raw: &[u8]) -> Result<Vec<u8>> {
        match self {
            Protection::Pgp { what, signing_key, passphrase, recipients, recipient_addresses } => {
                crate::crypto::pgp::protect_message(
                    raw,
                    *what,
                    signing_key.as_ref(),
                    passphrase.as_deref(),
                    recipients,
                    recipient_addresses,
                )
                .map_err(|failure| match failure {
                    crate::crypto::pgp::ProtectFailure::NoSigningKey => {
                        anyhow::anyhow!("no OpenPGP key to sign with — import yours in settings")
                    }
                    crate::crypto::pgp::ProtectFailure::NeedsPassphrase => {
                        anyhow::anyhow!("your OpenPGP key needs its passphrase")
                    }
                    crate::crypto::pgp::ProtectFailure::NoRecipientKey { missing } => anyhow::anyhow!(
                        "no key here for {} — the message was not sent",
                        missing.join(", ")
                    ),
                    crate::crypto::pgp::ProtectFailure::Failed { message } => {
                        anyhow::anyhow!("the message could not be protected: {message}")
                    }
                })
            }
            Protection::Smime { what, identity, recipients, recipient_addresses } => {
                crate::crypto::smime::protect_message(raw, *what, identity.as_ref(), recipients, recipient_addresses)
                    .map_err(|failure| match failure {
                        crate::crypto::smime::ProtectFailure::NoRecipientKey { missing } => anyhow::anyhow!(
                            "no key here for {} — the message was not sent",
                            missing.join(", ")
                        ),
                        crate::crypto::smime::ProtectFailure::Failed { message } => {
                            anyhow::anyhow!("the message could not be protected: {message}")
                        }
                    })
            }
        }
    }
}

/// The MIME for a server that submits the message itself (Exchange, Microsoft
/// Graph). Blind recipients stay in the headers, because that is the only
/// place such a server reads them from (it strips them before delivery), and
/// signing or encryption is applied exactly as on the SMTP path: a message
/// meant to be protected never goes out in the clear.
#[allow(clippy::too_many_arguments)]
pub fn build_submission(
    sender_name: &str,
    from: &str,
    to: &str,
    cc: &str,
    bcc: &str,
    subject: &str,
    body: &str,
    html: &str,
    attachments: &[AttachmentInput],
    in_reply_to: &str,
    references: &str,
    reply_to: &str,
    message_id: &str,
    protect: Option<&Protection>,
    // Whether to ask for a read receipt (ADR-0048). Exchange and Graph read
    // the header from the MIME as they read everything else in it.
    read_receipt: bool,
) -> Result<Vec<u8>> {
    let raw = build_message(
        sender_name, from, to, cc, bcc, true, subject, body, html, attachments, in_reply_to, references, reply_to,
        message_id,
    )?;
    let raw = if read_receipt { with_read_receipt(raw, sender_name, from)? } else { raw };
    match protect {
        Some(protection) => protection.apply(&raw),
        None => Ok(raw),
    }
}

/// An attachment's Content-Type, its parameters written as parameters: an
/// invitation's answer goes as `text/calendar; method=REPLY`, and a mail
/// reader recognises it by that parameter (RFC 6047).
fn attachment_type(mime: &str) -> ContentType<'static> {
    let mut parts = mime.split(';');
    let base = parts.next().unwrap_or("application/octet-stream").trim();
    let mut content_type = ContentType::new(if base.is_empty() { "application/octet-stream".to_string() } else { base.to_string() });
    for part in parts {
        if let Some((key, value)) = part.split_once('=') {
            let (key, value) = (key.trim(), value.trim().trim_matches('"'));
            if !key.is_empty() && !value.is_empty() {
                content_type = content_type.attribute(key.to_ascii_lowercase(), value.to_string());
            }
        }
    }
    content_type
}

fn is_message_rfc822(mime: &str) -> bool {
    mime.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("message/rfc822")
}

/// Whether bytes can travel as a 7bit MIME part: ASCII without NULs, CR only
/// in CRLF, and no line over RFC 5322's 998 characters.
fn is_7bit_message(bytes: &[u8]) -> bool {
    let mut line = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            0 | 0x80..=0xff => return false,
            b'\r' => {
                if bytes.get(i + 1) != Some(&b'\n') {
                    return false;
                }
            }
            b'\n' => {
                if i == 0 || bytes[i - 1] != b'\r' {
                    return false;
                }
                line = 0;
                continue;
            }
            _ => {}
        }
        if b != b'\r' {
            line += 1;
            if line > 998 {
                return false;
            }
        }
    }
    true
}

pub fn build_message(
    sender_name: &str,
    from: &str,
    to: &str,
    cc: &str,
    bcc: &str,
    // Whether to write a `Bcc:` header into the MIME. True for copies we keep
    // (Sent, Drafts) so the sender can see who they blind-copied; false for the
    // copy transmitted to recipients, which must not leak the Bcc list (delivery
    // still reaches them via the SMTP envelope's RCPT TO).
    include_bcc: bool,
    subject: &str,
    body: &str,
    html: &str,
    attachments: &[AttachmentInput],
    in_reply_to: &str,
    references: &str,
    reply_to: &str,
    message_id: &str,
) -> Result<Vec<u8>> {
    let to_list = parse_addrs(to);
    let cc_list = parse_addrs(cc);
    let bcc_list = parse_addrs(bcc);
    let reply_to_list = parse_addrs(reply_to);
    let to_pairs: Vec<(String, String)> = to_list.iter().map(|s| split_name_addr(s)).collect();

    let mut builder = MessageBuilder::new()
        .from((sender_name, from))
        .to(to_pairs)
        .subject(subject);

    // Drafts pass a stable id so each autosave overwrites the same Message-ID,
    // letting the IMAP layer find and prune the prior copy. Sends pass "" and
    // let mail-builder mint a fresh one.
    if !message_id.trim().is_empty() {
        // Accept either bare `id@host` or `<id@host>`: mail-builder adds the
        // angle brackets itself, so a pre-bracketed id would emit `<<...>>`.
        builder = builder.message_id(bare_id(message_id));
    }

    if !reply_to_list.is_empty() {
        let reply_to_pairs: Vec<(String, String)> =
            reply_to_list.iter().map(|s| split_name_addr(s)).collect();
        builder = builder.reply_to(reply_to_pairs);
    }

    builder = if html.is_empty() {
        builder.text_body(body)
    } else {
        builder.html_body(html).text_body(body)
    };

    if !cc_list.is_empty() {
        let cc_pairs: Vec<(String, String)> = cc_list.iter().map(|s| split_name_addr(s)).collect();
        builder = builder.cc(cc_pairs);
    }

    if include_bcc && !bcc_list.is_empty() {
        let bcc_pairs: Vec<(String, String)> =
            bcc_list.iter().map(|s| split_name_addr(s)).collect();
        builder = builder.bcc(bcc_pairs);
    }

    let in_reply_to_bare = bare_id(in_reply_to);
    if !in_reply_to_bare.is_empty() {
        builder = builder.in_reply_to(in_reply_to_bare.as_str());
    }
    let refs_bare: Vec<String> = references
        .split_whitespace()
        .map(bare_id)
        .filter(|tok| !tok.is_empty())
        .collect();
    if !refs_bare.is_empty() {
        let refs_refs: Vec<&str> = refs_bare.iter().map(String::as_str).collect();
        builder = builder.references(refs_refs.as_slice());
    }

    for att in attachments {
        // A decode failure must fail the whole build: silently dropping the
        // attachment would send the message without its file and report success.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&att.data)
            .with_context(|| format!("decode attachment {:?}", att.filename))?;
        if !att.inline_id.trim().is_empty() {
            builder = builder.inline(&att.mime, att.inline_id.trim(), bytes);
        } else if is_message_rfc822(&att.mime) && is_7bit_message(&bytes) {
            // A forwarded original (ADR-0047). RFC 2046 §5.2.1 allows a
            // message/rfc822 part no encoding but 7bit, 8bit or binary, so the
            // original goes in as it is rather than base64, which mail-builder
            // would otherwise pick for any non-text part. An original that is
            // not 7-bit clean falls through to base64 below: this client
            // submits 7-bit only, and readers open either.
            let content_type = attachment_type(&att.mime).attribute("name", att.filename.clone());
            let part = mail_builder::mime::MimePart::new(content_type, bytes)
                .attachment(att.filename.clone())
                .transfer_encoding("7bit");
            builder.attachments.get_or_insert_with(Vec::new).push(part);
        } else {
            // The filename also goes on Content-Type's own "name" attribute,
            // not just Content-Disposition's "filename" — the older
            // convention some mail readers still look at instead. It also
            // means an attachment's Content-Type is never emitted with zero
            // parameters: a real IMAP server (confirmed against `maddy`,
            // the integration-test server) reports a bare, parameter-less
            // Content-Type in BODYSTRUCTURE as `()` rather than the `NIL`
            // RFC 3501 actually requires there, which every strict parser —
            // including the one this app's own IMAP client uses — rejects.
            let content_type = attachment_type(&att.mime).attribute("name", att.filename.clone());
            builder = builder.attachment(content_type, &att.filename, bytes);
        }
    }

    builder.write_to_vec().context("build MIME message")
}

#[allow(clippy::too_many_arguments)]
pub async fn send(
    creds: &Creds,
    from_addr: &str,
    sender_name: &str,
    to: &str,
    cc: &str,
    bcc: &str,
    subject: &str,
    body: &str,
    html: &str,
    attachments: &[AttachmentInput],
    in_reply_to: &str,
    references: &str,
    reply_to: &str,
    message_id: &str,
    protect: Option<&Protection>,
) -> Result<Vec<u8>> {
    send_with_receipts(
        creds, from_addr, sender_name, to, cc, bcc, subject, body, html, attachments, in_reply_to, references,
        reply_to, message_id, protect, Receipts::default(),
    )
    .await
    .map(|sent| sent.raw)
}

/// Receipts the sender asked for on one message (ADR-0048).
///
/// `read` writes `Disposition-Notification-To` (RFC 8098) naming the sender;
/// whether the recipient answers is entirely theirs. `delivery` asks the
/// submission server for delivery status notifications (RFC 3461), and only
/// when it says it offers them: otherwise the message goes without, and the
/// caller is told so it can say so.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Receipts {
    pub read: bool,
    pub delivery: bool,
}

/// What became of a delivery receipt request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryReceipt {
    /// Nobody asked for one.
    NotAsked,
    /// The server offers DSN and was asked for success and failure notices.
    Requested,
    /// Asked for, but the server does not offer DSN (or the protocol cannot
    /// carry the request): the message went without one.
    Unsupported,
}

impl DeliveryReceipt {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryReceipt::NotAsked => "none",
            DeliveryReceipt::Requested => "requested",
            DeliveryReceipt::Unsupported => "unsupported",
        }
    }
}

/// A message the server accepted: the copy to file in Sent, and what became
/// of a delivery receipt request.
#[derive(Debug)]
pub struct Sent {
    pub raw: Vec<u8>,
    pub delivery_receipt: DeliveryReceipt,
}

/// The message with `Disposition-Notification-To` naming the sender (RFC
/// 8098 §2.1), written ahead of the rest of the header. Applied to built
/// bytes, before any protection, so a signed message signs it too.
pub fn with_read_receipt(raw: Vec<u8>, sender_name: &str, from: &str) -> Result<Vec<u8>> {
    use mail_builder::headers::Header as _;
    use mail_builder::headers::address::Address;
    const NAME: &str = "Disposition-Notification-To: ";
    let name = sender_name.trim();
    let address = Address::new_address((!name.is_empty()).then(|| name.to_string()), from.trim().to_string());
    let mut out = NAME.as_bytes().to_vec();
    address.write_header(&mut out, NAME.len()).context("write Disposition-Notification-To")?;
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(&raw);
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub async fn send_with_receipts(
    creds: &Creds,
    from_addr: &str,
    sender_name: &str,
    to: &str,
    cc: &str,
    bcc: &str,
    subject: &str,
    body: &str,
    html: &str,
    attachments: &[AttachmentInput],
    in_reply_to: &str,
    references: &str,
    reply_to: &str,
    message_id: &str,
    // How to protect the message before it goes, when the sender asked for it.
    // Applied to the built bytes rather than woven through the builder: what
    // OpenPGP protects is a finished MIME entity, and a half-built one is not
    // the thing a recipient will verify.
    protect: Option<&Protection>,
    // Receipts the sender asked for (ADR-0048): a read receipt is a header in
    // the message, a delivery receipt is asked of the server in the envelope.
    receipts: Receipts,
) -> Result<Sent> {
    if creds.is_graph() { return crate::graph::mail::unsupported(); }
    if creds.is_local() { return crate::archive::unsupported("send mail"); }
    // Caller passes the chosen send-as address (primary or a verified alias),
    // already validated against the account; fall back to the IMAP login.
    let from = if from_addr.trim().is_empty() {
        creds.user.as_str()
    } else {
        from_addr.trim()
    };

    let to_list = parse_addrs(to);
    let cc_list = parse_addrs(cc);
    let bcc_list = parse_addrs(bcc);

    // Message-ID resolution. A caller-supplied id wins: the client generates it
    // up front so the optimistic bubble carries the real Message-ID and a quick
    // follow-up reply can thread against it before the Sent copy syncs back.
    // Otherwise, when there's a Bcc we build the message twice — the transmitted
    // copy omits the `Bcc:` header while the Sent copy keeps it — so both must
    // share an explicit Message-ID for replies to thread; without a Bcc we leave
    // it empty and let the SMTP library mint one.
    let message_id = {
        let provided = message_id.trim();
        if !provided.is_empty() {
            provided.to_string()
        } else if bcc_list.is_empty() {
            String::new()
        } else {
            let domain = from.rsplit('@').next().unwrap_or("localhost");
            format!("{}@{}", uuid::Uuid::new_v4(), domain)
        }
    };

    let raw = build_message(
        sender_name,
        from,
        to,
        cc,
        bcc,
        false,
        subject,
        body,
        html,
        attachments,
        in_reply_to,
        references,
        reply_to,
        &message_id,
    )?;

    let raw = if receipts.read { with_read_receipt(raw, sender_name, from)? } else { raw };

    // Protection goes on before anything touches the network. A failure here
    // stops the send: a message meant to be encrypted that went in the clear
    // is a worse outcome than one that did not go at all.
    let raw = match protect {
        Some(protection) => protection.apply(&raw)?,
        None => raw,
    };

    // SMTP envelope addresses must be bare ("addr@host"); MIME header entries
    // may carry a display name. The header form survives in `to_list`/`cc_list`
    // for the builder above; here we strip down to the address for RCPT TO.
    let recipients = envelope_recipients(&to_list, &cc_list, &bcc_list);
    let delivery_receipt = transport(creds, from, &recipients, &raw, receipts.delivery).await?;

    // Return the copy to file in Sent: identical to the transmitted message
    // unless there's a Bcc, in which case we rebuild with the `Bcc:` header (and
    // the same Message-ID) so the user's Sent folder records who they bcc'd.
    if bcc_list.is_empty() {
        Ok(Sent { raw, delivery_receipt })
    } else {
        let kept = build_message(
            sender_name,
            from,
            to,
            cc,
            bcc,
            true,
            subject,
            body,
            html,
            attachments,
            in_reply_to,
            references,
            reply_to,
            &message_id,
        )?;
        let kept = if receipts.read { with_read_receipt(kept, sender_name, from)? } else { kept };
        Ok(Sent { raw: kept, delivery_receipt })
    }
}

/// Connect, authenticate, and hand one already-built MIME message to the
/// SMTP server for exactly the recipients given — the wire mechanics shared
/// by every outgoing message this app sends over SMTP, whether composed by
/// the reader (`send`) or generated automatically (`send_oof_reply`).
async fn transport(
    creds: &Creds,
    from: &str,
    recipients: &[String],
    raw: &[u8],
    // Whether to ask for delivery status notifications (RFC 3461).
    want_dsn: bool,
) -> Result<DeliveryReceipt> {
    // Fall back to the IMAP host if SMTP settings were not provided.
    let host = if creds.smtp_host.is_empty() {
        creds.host.as_str()
    } else {
        creds.smtp_host.as_str()
    };
    let port = if creds.smtp_port == 0 {
        587
    } else {
        creds.smtp_port
    };

    // STARTTLS connects in cleartext, then upgrades after EHLO; implicit TLS
    // wraps the socket up front. smtp_starttls takes precedence over smtp_tls.
    let implicit_tls = creds.smtp_tls && !creds.smtp_starttls;
    let stream = connect_stream(
        host,
        port,
        implicit_tls,
        creds.proxy.resolve()?.as_ref(),
        creds.smtp_cert_pin.as_deref(),
    )
    .await
    .map_err(as_smtp_cert_error)?;
    let mut transport = with_timeout(
        SMTP_COMMAND_TIMEOUT,
        "smtp greeting",
        SmtpTransport::new(SmtpClient::new(), BufReader::new(stream)),
    )
    .await?
    .context("smtp connect")?;

    if creds.smtp_starttls {
        // `starttls()` issues the command and returns the raw stream to upgrade;
        // we then re-run EHLO over TLS via a transport built without expecting a
        // greeting (the server sends none after STARTTLS).
        let inner = with_timeout(SMTP_COMMAND_TIMEOUT, "smtp starttls", transport.starttls())
            .await?
            .context("SMTP STARTTLS")?;
        let tcp = match inner.into_inner() {
            crate::imap::Stream::Plain(tcp) => tcp,
            crate::imap::Stream::Tls(_) => {
                return Err(anyhow::anyhow!(
                    "STARTTLS requested on an already-TLS stream"
                ));
            }
        };
        let tls = crate::imap::upgrade_to_tls(host, tcp, creds.smtp_cert_pin.as_deref())
            .await
            .map_err(as_smtp_cert_error)?;
        let upgraded = crate::imap::Stream::Tls(Box::new(tls));
        transport = with_timeout(
            SMTP_COMMAND_TIMEOUT,
            "smtp ehlo",
            SmtpTransport::new(
                SmtpClient::new().without_greeting(),
                BufReader::new(upgraded),
            ),
        )
        .await?
        .context("smtp connect (post-STARTTLS)")?;
    }

    // Whether the server offers DSN, asked before AUTH: the greeting's own
    // EHLO answer is parsed by the library into the features it knows, and
    // DSN is not one of them, so the question is put again here. Only when a
    // delivery receipt is wanted; otherwise nothing changes on the wire.
    let dsn = if want_dsn {
        let reply = with_timeout(
            SMTP_COMMAND_TIMEOUT,
            "smtp ehlo",
            transport.get_mut().ehlo(async_smtp::extension::ClientId::default()),
        )
        .await?
        .context("smtp EHLO")?;
        offers_dsn(&reply.message)
    } else {
        false
    };

    let secret = if creds.is_oauth() {
        creds.access_token.clone().unwrap_or_default()
    } else {
        creds.password.clone()
    };
    let credentials = Credentials::new(creds.user.clone(), secret.clone());
    let mechanisms = if creds.is_oauth() {
        vec![Mechanism::Xoauth2]
    } else {
        vec![Mechanism::Plain, Mechanism::Login]
    };
    // AUTH explicitly instead of try_login: try_login silently skips auth when
    // the EHLO capabilities include none of our mechanisms, which would surface
    // later as a confusing RCPT/DATA rejection instead of an auth error. Try
    // each mechanism in order; only a command-level rejection (502/503/504 —
    // the server doesn't do AUTH at all) falls through to unauthenticated
    // submission, preserving relays that accept mail without login. An empty
    // secret means a deliberately unauthenticated relay; skip AUTH entirely.
    if !secret.is_empty() {
        let mut authed = false;
        let mut auth_unsupported = true;
        let mut last_err: Option<SmtpError> = None;
        for mechanism in &mechanisms {
            match with_timeout(
                SMTP_COMMAND_TIMEOUT,
                "smtp auth",
                transport.auth(*mechanism, &credentials),
            )
            .await?
            {
                Ok(_) => {
                    authed = true;
                    break;
                }
                Err(err) => {
                    let command_rejected = matches!(
                        &err,
                        SmtpError::Permanent(resp)
                            if resp.has_code(502) || resp.has_code(503) || resp.has_code(504)
                    );
                    if !command_rejected {
                        auth_unsupported = false;
                    }
                    last_err = Some(err);
                }
            }
        }
        if !authed {
            if !auth_unsupported {
                let err = last_err.expect("auth failed without an error");
                return Err(anyhow::Error::new(err).context("smtp auth"));
            }
            crate::mlog!(
                crate::log::Level::Warn,
                "mail.send",
                "SMTP server rejected AUTH as unsupported; submitting unauthenticated"
            );
        }
    }

    let dsn_sent = submit(&mut transport, from, recipients, raw, dsn).await?;
    let _ = with_timeout(Duration::from_secs(10), "smtp quit", transport.quit()).await;
    Ok(match (want_dsn, dsn_sent) {
        (false, _) => DeliveryReceipt::NotAsked,
        (true, true) => DeliveryReceipt::Requested,
        (true, false) => DeliveryReceipt::Unsupported,
    })
}

/// Whether an EHLO answer lists the DSN extension (RFC 3461 §4).
fn offers_dsn(lines: &[String]) -> bool {
    lines
        .iter()
        .any(|line| line.split_whitespace().next().is_some_and(|word| word.eq_ignore_ascii_case("DSN")))
}

/// The `MAIL FROM` parameter of a delivery receipt request (RFC 3461 §4.3):
/// a notice carries only the headers of the message back, not all of it.
fn dsn_mail_parameters() -> Vec<async_smtp::extension::MailParameter> {
    vec![async_smtp::extension::MailParameter::Other { keyword: "RET".to_string(), value: Some("HDRS".to_string()) }]
}

/// The `RCPT TO` parameters of a delivery receipt request (RFC 3461 §4.1,
/// §4.2): a notice when delivery to this recipient succeeds or fails, naming
/// the recipient as the sender wrote it.
fn dsn_rcpt_parameters(recipient: &str) -> Vec<async_smtp::extension::RcptParameter> {
    use async_smtp::extension::RcptParameter;
    vec![
        RcptParameter::Other { keyword: "NOTIFY".to_string(), value: Some("SUCCESS,FAILURE".to_string()) },
        RcptParameter::Other { keyword: "ORCPT".to_string(), value: Some(format!("rfc822;{recipient}")) },
    ]
}

/// A send whose outcome the server never reported.
///
/// The whole message was handed over and the connection failed before the
/// reply that would have accepted or refused it. The server may well have
/// queued it: RFC 5321 lets it accept a message it never got to acknowledge.
/// Sending again on the strength of this error is how a recipient gets two
/// copies, so it is marked rather than folded into an ordinary failure, and
/// the caller decides what to do with the doubt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UncertainSend;

impl std::fmt::Display for UncertainSend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the server did not say whether it accepted the message")
    }
}

impl std::error::Error for UncertainSend {}

/// Whether an error from [`send`] leaves the message's fate unknown.
///
/// Every other failure means the message did not go: the server refused it
/// or was never reached. Only this one may mean it did.
pub fn is_uncertain(err: &anyhow::Error) -> bool {
    // The marker is attached as context, which anyhow's own downcast walks
    // through; `chain()` would only show the context wrapper, not its type.
    err.downcast_ref::<UncertainSend>().is_some()
}

fn uncertain(err: anyhow::Error) -> anyhow::Error {
    err.context(UncertainSend)
}

/// The SMTP transaction proper, one phase at a time, so a failure can say
/// whether the message had left yet.
///
/// Up to and including the `DATA` command every refusal is definitive:
/// nothing of the message has been transmitted, and trying again is safe.
/// From the first byte of the message on, a lost connection or a missing
/// reply means the server may already hold it, which [`UncertainSend`]
/// marks; only an explicit negative reply to the end of data is a refusal.
///
/// The envelope and data phases are driven here rather than through the
/// library's one-shot `send`, which cannot report which phase failed.
///
/// Returns whether delivery status notifications were asked for: only when
/// `dsn` says the server offers them, and only on the path that can carry
/// envelope parameters.
async fn submit<S>(
    transport: &mut SmtpTransport<S>,
    from: &str,
    recipients: &[String],
    raw: &[u8],
    dsn: bool,
) -> Result<bool>
where
    S: tokio::io::AsyncBufRead + tokio::io::AsyncWrite + Unpin,
{
    let sender = EmailAddress::new(from.to_string()).context("from address")?;
    let mut envelope_addrs = Vec::new();
    for addr in recipients {
        envelope_addrs.push(EmailAddress::new(addr.clone()).context("recipient address")?);
    }
    // Validated as a whole before anything is said to the server: an
    // envelope the library would reject is not one to start a transaction on.
    let envelope = Envelope::new(Some(sender.clone()), envelope_addrs.clone()).context("envelope")?;

    // Messages are 7-bit on the wire (mail_builder encodes anything else),
    // so the body can go through the stream's command writer. A message that
    // is not valid UTF-8 cannot, and goes through the library's send instead;
    // its failures after the connection is up are all treated as uncertain,
    // because that path cannot say which phase they came from.
    let Some(data) = DataBody::new(raw) else {
        let sent = with_timeout(
            SMTP_DATA_TIMEOUT,
            "smtp send",
            transport.send(SendableEmail::new(envelope, raw.to_vec())),
        )
        .await;
        return match sent {
            Ok(Ok(_)) => Ok(false),
            Ok(Err(err)) if is_refusal(&err) => Err(anyhow::Error::new(err).context("smtp send")),
            Ok(Err(err)) => Err(uncertain(anyhow::Error::new(err).context("smtp send"))),
            Err(err) => Err(uncertain(err)),
        };
    };

    let stream = transport.get_mut();
    let mail_parameters = if dsn { dsn_mail_parameters() } else { vec![] };
    with_timeout(
        SMTP_COMMAND_TIMEOUT,
        "smtp mail from",
        stream.command(MailCommand::new(Some(sender), mail_parameters)),
    )
    .await?
    .context("smtp MAIL FROM")?;
    for (addr, plain) in envelope_addrs.into_iter().zip(recipients) {
        let rcpt_parameters = if dsn { dsn_rcpt_parameters(plain) } else { vec![] };
        with_timeout(
            SMTP_COMMAND_TIMEOUT,
            "smtp rcpt to",
            stream.command(RcptCommand::new(addr, rcpt_parameters)),
        )
        .await?
        .context("smtp RCPT TO")?;
    }
    with_timeout(SMTP_COMMAND_TIMEOUT, "smtp data", stream.command(DataCommand))
        .await?
        .context("smtp DATA")?;

    // From here the message is leaving. A write that fails part-way may
    // still have delivered the terminator from a kernel buffer; a reply that
    // never comes may follow an acceptance the server could not get out.
    match with_timeout(SMTP_DATA_TIMEOUT, "smtp send", stream.send_command(data)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(uncertain(anyhow::Error::new(err).context("smtp send"))),
        Err(err) => return Err(uncertain(err)),
    }
    match with_timeout(SMTP_DATA_TIMEOUT, "smtp send", stream.read_response()).await {
        Ok(Ok(_)) => Ok(dsn),
        Ok(Err(err)) if is_refusal(&err) => Err(anyhow::Error::new(err).context("smtp send")),
        Ok(Err(err)) => Err(uncertain(anyhow::Error::new(err).context("smtp send"))),
        Err(err) => Err(uncertain(err)),
    }
}

/// An explicit negative reply: the server answered, and the answer was no.
fn is_refusal(err: &SmtpError) -> bool {
    matches!(err, SmtpError::Transient(_) | SmtpError::Permanent(_))
}

/// The message as it goes on the wire after `DATA`: every line that begins
/// with a dot gets a second one (RFC 5321 §4.5.2), and the whole thing ends
/// with the lone dot that tells the server it has it all.
struct DataBody(String);

impl DataBody {
    /// `None` when the message is not valid UTF-8, which the command writer
    /// cannot carry; see [`submit`] for what happens then.
    fn new(raw: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(raw).ok()?;
        let body = text.strip_suffix("\r\n").unwrap_or(text);
        let mut out = String::with_capacity(body.len() + 8);
        for line in body.split("\r\n") {
            if line.starts_with('.') {
                out.push('.');
            }
            out.push_str(line);
            out.push_str("\r\n");
        }
        out.push_str(".\r\n");
        Some(Self(out))
    }
}

impl std::fmt::Display for DataBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Build one out-of-office auto-reply — deliberately much simpler than
/// `build_message`: plain text, no attachments, no Cc/Bcc, because that is
/// all an auto-reply is. Marked `Auto-Submitted: auto-replied` (RFC 3834) so
/// any *other* auto-responder that receives it knows not to answer back —
/// the same courtesy `oof::looks_automated` checks for on the way in.
fn build_oof_reply(sender_name: &str, from: &str, to: &str, subject: &str, body: &str, in_reply_to: &str) -> Result<Vec<u8>> {
    use mail_builder::headers::text::Text;

    let mut builder = MessageBuilder::new()
        .from((sender_name, from))
        .to(vec![("", to)])
        .subject(subject)
        .text_body(body)
        .header("Auto-Submitted", Text::new("auto-replied"));

    let in_reply_to_bare = bare_id(in_reply_to);
    if !in_reply_to_bare.is_empty() {
        builder = builder.in_reply_to(in_reply_to_bare.as_str());
        builder = builder.references(&[in_reply_to_bare.as_str()][..]);
    }
    builder.write_to_vec().context("build out-of-office reply")
}

/// Send one out-of-office auto-reply over SMTP. IMAP/SMTP accounts only —
/// an Exchange account configures the server's own Automatic Replies
/// instead (see `crate::oof`) and never calls this.
pub async fn send_oof_reply(
    creds: &Creds,
    from_addr: &str,
    sender_name: &str,
    to: &str,
    subject: &str,
    body: &str,
    in_reply_to: &str,
) -> Result<Vec<u8>> {
    let from = if from_addr.trim().is_empty() {
        creds.user.as_str()
    } else {
        from_addr.trim()
    };
    let raw = build_oof_reply(sender_name, from, to, subject, body, in_reply_to)?;
    let recipients = vec![bare_addr(to)];
    transport(creds, from, &recipients, &raw, false).await?;
    Ok(raw)
}

/// Send a report this app generated — a read receipt (ADR-0048) — over the
/// account's own SMTP server, to exactly the recipients given. Nothing is
/// filed in Sent, as for an out-of-office reply.
pub async fn send_report(creds: &Creds, from: &str, recipients: &[String], raw: &[u8]) -> Result<()> {
    if creds.is_graph() { return crate::graph::mail::unsupported(); }
    if creds.is_local() { return crate::archive::unsupported("send mail"); }
    let from = if from.trim().is_empty() { creds.user.as_str() } else { from.trim() };
    let recipients: Vec<String> = recipients.iter().map(|entry| bare_addr(entry)).collect();
    transport(creds, from, &recipients, raw, false).await?;
    Ok(())
}

/// Flatten to/cc/bcc header entries into the bare envelope address list,
/// dropping case-insensitive duplicates so no recipient gets two RCPT TOs.
fn envelope_recipients(to: &[String], cc: &[String], bcc: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in to.iter().chain(cc.iter()).chain(bcc.iter()) {
        let bare = bare_addr(entry);
        if seen.insert(bare.to_lowercase()) {
            out.push(bare);
        }
    }
    out
}

/// Extract the bare email address from a "Name <addr>" header entry, or return
/// the input when it's already a bare address. SMTP `RCPT TO` rejects the
/// display-name form, so all envelope addresses pass through this first.
fn bare_addr(entry: &str) -> String {
    let trimmed = entry.trim();
    if let Some(start) = trimmed.find('<')
        && let Some(end) = trimmed[start + 1..].find('>')
    {
        return trimmed[start + 1..start + 1 + end].trim().to_string();
    }
    trimmed.to_string()
}

/// Strip angle brackets and surrounding whitespace from a Message-ID token,
/// leaving a bare `id@host`. The MessageBuilder rewraps with `<...>`.
fn bare_id(token: &str) -> String {
    token
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_server_submission_asked_to_encrypt_is_encrypted_not_sent_in_the_clear() {
        use super::{Protection, build_submission};
        let certs = crate::crypto::pgp::certs_from_armoured(&[include_str!(
            "crypto/testdata/gnupg/fixture_secret.asc"
        )
        .to_string()]);
        let addresses: Vec<String> = certs
            .iter()
            .flat_map(|cert| cert.userids().filter_map(|u| u.userid().email().ok().flatten().map(|e| e.to_lowercase())))
            .collect();
        assert!(!addresses.is_empty());
        let protection = Protection::Pgp {
            what: crate::crypto::pgp::Protect { sign: false, encrypt: true },
            signing_key: None,
            passphrase: None,
            recipients: certs,
            recipient_addresses: addresses.clone(),
        };
        let raw = build_submission(
            "Ana", "ana@example.com", &addresses[0], "", "hidden@example.com", "Plan", "the secret body", "", &[], "",
            "", "", "<m@example.com>", Some(&protection), false,
        )
        .unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("-----BEGIN PGP MESSAGE-----"), "{text}");
        assert!(!text.contains("the secret body"), "{text}");
        // The server still reads the blind copy from the headers.
        assert!(text.contains("hidden@example.com"));

        let plain = build_submission(
            "Ana", "ana@example.com", "b@example.com", "", "", "Plan", "plain body", "", &[], "", "", "",
            "<m2@example.com>", None, false,
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&plain).contains("plain body"));
    }

    use super::{
        as_smtp_cert_error, bare_addr, bare_id, build_message, build_oof_reply, parse_addrs, split_name_addr,
    };

    /// A send and a sync fail the same way inside rustls; only the marker tells
    /// the UI which server to show and which pin to write. Without the re-tag a
    /// refused submission server would pin the IMAP server instead.
    #[test]
    fn certificate_failures_from_submission_carry_the_smtp_marker() {
        let refused = crate::tls::UntrustedCertificate::from_io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::Other(rustls::OtherError(
                std::sync::Arc::new(std::io::Error::other("CaUsedAsEndEntity")),
            ))),
        ));
        let tagged = as_smtp_cert_error(refused).to_string();
        assert!(
            tagged.starts_with(crate::tls::UNTRUSTED_SMTP_CERT_MARKER),
            "{tagged}"
        );
        assert!(tagged.contains("CaUsedAsEndEntity"), "{tagged}");

        // Anything else is passed through untouched.
        let offline = anyhow::anyhow!("tcp connect: connection refused");
        assert_eq!(
            as_smtp_cert_error(offline).to_string(),
            "tcp connect: connection refused"
        );
    }

    #[test]
    fn parse_addrs_splits_and_trims() {
        assert_eq!(
            parse_addrs("a@x.com, Bob <b@y.com> ,, c@z.com"),
            vec!["a@x.com", "Bob <b@y.com>", "c@z.com"]
        );
        assert!(parse_addrs("").is_empty());
    }

    #[test]
    fn parse_addrs_keeps_quoted_and_bracketed_commas() {
        assert_eq!(
            parse_addrs("\"Doe, Jane\" <j@x.com>, a@y.com"),
            vec!["\"Doe, Jane\" <j@x.com>", "a@y.com"]
        );
        // Unterminated quote: the rest of the string stays one entry rather
        // than producing bogus half-recipients.
        assert_eq!(
            parse_addrs("\"Doe, Jane <j@x.com>"),
            vec!["\"Doe, Jane <j@x.com>"]
        );
    }

    #[test]
    fn envelope_recipients_dedupes_case_insensitively() {
        let to = vec!["Alice <a@x.com>".to_string(), "b@y.com".to_string()];
        let cc = vec!["A@X.COM".to_string()];
        let bcc = vec!["b@y.com".to_string(), "c@z.com".to_string()];
        assert_eq!(
            super::envelope_recipients(&to, &cc, &bcc),
            vec!["a@x.com", "b@y.com", "c@z.com"]
        );
    }

    #[test]
    fn build_message_rejects_undecodable_attachment() {
        let atts = vec![super::AttachmentInput {
            filename: "broken.bin".into(),
            mime: "application/octet-stream".into(),
            data: "not!!valid@@base64".into(),
            inline_id: String::new(),
        }];
        let err = build_message(
            "Alice",
            "alice@x.com",
            "bob@y.com",
            "",
            "",
            false,
            "Subject",
            "body",
            "",
            &atts,
            "",
            "",
            "",
            "",
        )
        .expect_err("must fail instead of sending without the attachment");
        assert!(err.to_string().contains("broken.bin"), "{err:#}");
    }

    #[test]
    fn a_forwarded_original_is_attached_as_message_rfc822_without_base64() {
        let original = "From: Ana <ana@y.com>\r\nSubject: Plan\r\n\r\nSee you.\r\n";
        let atts = vec![super::AttachmentInput {
            filename: "Plan.eml".into(),
            mime: "message/rfc822".into(),
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, original),
            inline_id: String::new(),
        }];
        let raw = build_message("Bo", "bo@x.com", "cy@z.com", "", "", false, "Fwd: Plan", "", "", &atts, "", "", "", "")
            .expect("built");
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.contains("Content-Transfer-Encoding: 7bit"), "{text}");
        assert!(text.contains(original), "{text}");
        let parsed = mailparse::parse_mail(&raw).expect("parses");
        let part = parsed
            .subparts
            .iter()
            .find(|p| p.ctype.mimetype == "message/rfc822")
            .unwrap_or_else(|| panic!("{text}"));
        assert_eq!(part.get_body_raw().expect("body"), original.as_bytes());
        assert_eq!(part.get_content_disposition().params.get("filename").map(String::as_str), Some("Plan.eml"));
    }

    #[test]
    fn an_original_that_is_not_7bit_clean_is_still_attached() {
        let original = "Subject: Caf\u{e9}\r\n\r\nCaf\u{e9}\r\n";
        let atts = vec![super::AttachmentInput {
            filename: "Cafe.eml".into(),
            mime: "message/rfc822".into(),
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, original),
            inline_id: String::new(),
        }];
        let raw = build_message("Bo", "bo@x.com", "cy@z.com", "", "", false, "Fwd", "", "", &atts, "", "", "", "")
            .expect("built");
        assert!(raw.is_ascii(), "the submitted message stays 7-bit");
        let parsed = mailparse::parse_mail(&raw).expect("parses");
        let part = parsed.subparts.iter().find(|p| p.ctype.mimetype == "message/rfc822").expect("part");
        assert_eq!(part.get_body_raw().expect("body"), original.as_bytes());
    }

    #[test]
    fn seven_bit_detection_rejects_bare_newlines_and_long_lines() {
        assert!(super::is_7bit_message(b"a\r\nb\r\n"));
        assert!(!super::is_7bit_message(b"a\nb"));
        assert!(!super::is_7bit_message(b"a\rb"));
        assert!(!super::is_7bit_message("\u{e9}".as_bytes()));
        assert!(!super::is_7bit_message(&[b'x'; 999]));
        assert!(super::is_7bit_message(&[b'x'; 998]));
    }

    #[test]
    fn an_invitation_answer_is_sent_with_its_method_as_a_parameter() {
        let atts = vec![super::AttachmentInput {
            filename: "reply.ics".into(),
            mime: "text/calendar; method=REPLY; charset=utf-8".into(),
            data: "QkVHSU46VkNBTEVOREFS".into(),
            inline_id: String::new(),
        }];
        let raw = build_message("Bo", "bo@x.com", "ana@y.com", "", "", false, "Accepted: Planning", "Accepted.", "", &atts, "", "", "", "")
            .expect("built");
        let text = String::from_utf8_lossy(&raw).to_string();
        let parsed = mailparse::parse_mail(&raw).expect("parses");
        let part = parsed.subparts.iter().find(|p| p.ctype.mimetype == "text/calendar").unwrap_or_else(|| panic!("{text}"));
        assert_eq!(part.ctype.params.get("method").map(String::as_str), Some("REPLY"));
        assert_eq!(part.ctype.params.get("name").map(String::as_str), Some("reply.ics"));
    }

    #[test]
    fn an_attachments_content_type_always_carries_a_parameter() {
        // A bare, parameter-less Content-Type (nothing beyond the mime type
        // itself) is technically valid to send, but a real IMAP server
        // (confirmed against `maddy`, the integration-test server) reports
        // it back in BODYSTRUCTURE as `()` rather than the `NIL` RFC 3501
        // actually requires there — which every strict parser, including
        // this app's own IMAP client, rejects. Giving every attachment a
        // "name" parameter (mirroring its Content-Disposition filename, and
        // matching what most real-world mail clients already do) means this
        // app never emits the shape that breaks it, whatever the caller's
        // own mime type string looks like.
        use base64::Engine as _;
        let atts = vec![super::AttachmentInput {
            filename: "itest-note.txt".into(),
            mime: "text/plain".into(),
            data: base64::engine::general_purpose::STANDARD.encode(b"hello"),
            inline_id: String::new(),
        }];
        let raw = build_message(
            "Alice",
            "alice@x.com",
            "bob@y.com",
            "",
            "",
            false,
            "Subject",
            "body",
            "",
            &atts,
            "",
            "",
            "",
            "",
        )
        .expect("build_message");
        let text = String::from_utf8_lossy(&raw);
        assert!(
            text.contains("name=\"itest-note.txt\""),
            "attachment Content-Type missing its name parameter:\n{text}"
        );
    }

    #[test]
    fn build_message_addresses_quoted_comma_recipient() {
        let raw = build_message(
            "Alice",
            "alice@x.com",
            "\"Doe, Jane\" <j@x.com>",
            "",
            "",
            false,
            "Subject",
            "body",
            "",
            &[],
            "",
            "",
            "",
            "",
        )
        .expect("build_message");
        let raw = String::from_utf8(raw).expect("utf8");
        assert!(raw.contains("<j@x.com>"), "{raw}");
        // The display name must stay attached to the one recipient, not split
        // into a second bogus address.
        assert!(!raw.contains("<Doe>"), "{raw}");
    }

    #[test]
    fn split_name_addr_handles_named_quoted_and_bare() {
        assert_eq!(
            split_name_addr("Alice Example <a@x.com>"),
            ("Alice Example".to_string(), "a@x.com".to_string())
        );
        assert_eq!(
            split_name_addr("\"Quoted Name\" <a@x.com>"),
            ("Quoted Name".to_string(), "a@x.com".to_string())
        );
        assert_eq!(
            split_name_addr(" a@x.com "),
            (String::new(), "a@x.com".to_string())
        );
        assert_eq!(
            split_name_addr("\"Doe, Jane\" <j@x.com>"),
            ("Doe, Jane".to_string(), "j@x.com".to_string())
        );
        assert_eq!(
            split_name_addr("\"Ada \\\"Lovelace\\\"\" <a@x.com>"),
            ("Ada \"Lovelace\"".to_string(), "a@x.com".to_string())
        );
    }

    #[test]
    fn bare_addr_strips_display_name() {
        assert_eq!(bare_addr("Alice <a@x.com>"), "a@x.com");
        assert_eq!(bare_addr("a@x.com"), "a@x.com");
    }

    #[test]
    fn bare_id_strips_angle_brackets() {
        assert_eq!(bare_id("<id@host>"), "id@host");
        assert_eq!(bare_id(" id@host "), "id@host");
    }

    fn build(message_id: &str, bcc: &str, include_bcc: bool) -> String {
        let raw = build_message(
            "Alice",
            "alice@x.com",
            "bob@y.com",
            "",
            bcc,
            include_bcc,
            "Subject",
            "body",
            "",
            &[],
            "parent@x.com",
            "root@x.com parent@x.com",
            "",
            message_id,
        )
        .expect("build_message");
        String::from_utf8(raw).expect("utf8")
    }

    #[test]
    fn build_message_emits_single_bracketed_message_id() {
        // Bare and pre-bracketed ids must both come out as a single <id@host>.
        for input in ["itest@x.com", "<itest@x.com>"] {
            let raw = build(input, "", false);
            assert!(raw.contains("Message-ID: <itest@x.com>"), "raw: {raw}");
            assert!(!raw.contains("<<"), "double-bracketed Message-ID in: {raw}");
        }
    }

    #[test]
    fn build_message_threads_via_reply_headers() {
        let raw = build("", "", false);
        assert!(raw.contains("In-Reply-To: <parent@x.com>"), "raw: {raw}");
        assert!(
            raw.contains("References: <root@x.com> <parent@x.com>"),
            "raw: {raw}"
        );
    }

    #[test]
    fn oof_reply_is_marked_auto_submitted_and_threaded() {
        let raw = String::from_utf8(
            build_oof_reply("Alice", "alice@x.com", "bob@y.com", "Out of office", "I'm away.", "parent@x.com")
                .expect("build_oof_reply"),
        )
        .expect("utf8");
        assert!(raw.contains("Auto-Submitted: auto-replied"), "raw: {raw}");
        assert!(raw.contains("In-Reply-To: <parent@x.com>"), "raw: {raw}");
        assert!(raw.contains("References: <parent@x.com>"), "raw: {raw}");
        assert!(raw.contains("Subject: Out of office"), "raw: {raw}");
        assert!(raw.contains("bob@y.com"), "raw: {raw}");
    }

    #[test]
    fn oof_reply_with_no_message_id_to_thread_against_has_no_reply_headers() {
        let raw = String::from_utf8(
            build_oof_reply("Alice", "alice@x.com", "bob@y.com", "Out of office", "I'm away.", "").expect("build_oof_reply"),
        )
        .expect("utf8");
        assert!(!raw.contains("In-Reply-To:"), "raw: {raw}");
        assert!(!raw.contains("References:"), "raw: {raw}");
    }

    #[test]
    fn build_message_keeps_bcc_only_for_kept_copies() {
        let kept = build("", "secret@z.com", true);
        assert!(
            kept.contains("secret@z.com"),
            "kept copy must carry Bcc: {kept}"
        );
        let wire = build("", "secret@z.com", false);
        assert!(
            !wire.contains("secret@z.com"),
            "wire copy must not leak Bcc: {wire}"
        );
    }

    #[test]
    fn inline_image_send_parses_back_with_media_refs() {
        // Full send-side/receive-side roundtrip for composer inline images:
        // the built MIME's `cid:` refs must come back from parse_message with
        // every `cid:` rewritten to the served `/media/<key>` path, so a
        // message sent from Meron renders its inline images in Meron too.
        use base64::Engine as _;
        let atts = vec![
            super::AttachmentInput {
                filename: "pasted-image-1.png".into(),
                mime: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]),
                inline_id: "meron-image-1784002518563-a1b2c3d@meron".into(),
            },
            super::AttachmentInput {
                filename: "pasted-image-2.png".into(),
                mime: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode([9u8, 8, 7]),
                inline_id: "meron-image-1784002609378-x9y8z7w@meron".into(),
            },
        ];
        let html = r#"<p>one</p><img src="cid:meron-image-1784002518563-a1b2c3d@meron" alt="pasted-image-1.png"><p>two</p><img src="cid:meron-image-1784002609378-x9y8z7w@meron" alt="pasted-image-2.png"><p>bye</p>"#;
        let raw = build_message(
            "Alice",
            "alice@x.com",
            "bob@y.com",
            "",
            "",
            false,
            "Subject",
            "plain fallback",
            html,
            &atts,
            "",
            "",
            "",
            "",
        )
        .expect("build_message");

        let root =
            std::env::temp_dir().join(format!("meron-inline-roundtrip-{}", std::process::id()));
        let ctx = crate::parse::MediaCtx {
            root: root.clone(),
            account: "acct".into(),
            folder: "Sent".into(),
            uid: 1,
        };
        let msg = crate::parse::parse_message(&raw, Some(&ctx));
        let _ = std::fs::remove_dir_all(&root);

        let html_out = msg.body_html.expect("html kept");
        assert!(
            !html_out.contains("cid:"),
            "unrewritten cid ref: {html_out}"
        );
        assert!(html_out.contains("/media/acct/Sent/1/0.png"), "{html_out}");
        assert!(html_out.contains("/media/acct/Sent/1/1.png"), "{html_out}");
        assert_eq!(msg.attachments.len(), 2);
    }

    /// What a submission server says and does, from the client's point of
    /// view, once the message is on its way.
    #[derive(Clone, Copy)]
    enum AfterData {
        Accept,
        Refuse,
        HangUp,
    }

    /// Minimal submission server: greets, accepts EHLO, MAIL and RCPT (or
    /// refuses the recipient), takes the message after DATA and then does as
    /// told. Hands back what it was sent, so a test can look at the wire.
    async fn serve_submission(
        listener: tokio::net::TcpListener,
        refuse_recipient: bool,
        after_data: AfterData,
        transcript: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        offer_dsn: bool,
    ) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let Ok((sock, _)) = listener.accept().await else {
            return;
        };
        let (reader, mut writer) = sock.into_split();
        if writer.write_all(b"220 test ESMTP\r\n").await.is_err() {
            return;
        }
        let mut lines = tokio::io::BufReader::new(reader).lines();
        let mut in_data = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if in_data {
                transcript.lock().unwrap().push(line.clone());
                if line == "." {
                    in_data = false;
                    let reply: &[u8] = match after_data {
                        AfterData::Accept => b"250 2.0.0 queued as 1\r\n",
                        AfterData::Refuse => b"554 5.7.1 message refused by policy\r\n",
                        AfterData::HangUp => return,
                    };
                    if writer.write_all(reply).await.is_err() {
                        return;
                    }
                }
                continue;
            }
            transcript.lock().unwrap().push(line.clone());
            let verb = line.split(' ').next().unwrap_or_default().to_uppercase();
            let reply: &[u8] = match verb.as_str() {
                "EHLO" | "HELO" if offer_dsn => b"250-test\r\n250-DSN\r\n250 OK\r\n",
                "EHLO" | "HELO" => b"250-test\r\n250 OK\r\n",
                "MAIL" => b"250 2.1.0 OK\r\n",
                "RCPT" if refuse_recipient => b"550 5.1.1 no such user\r\n",
                "RCPT" => b"250 2.1.5 OK\r\n",
                "DATA" => {
                    in_data = true;
                    b"354 go ahead\r\n"
                }
                "QUIT" => b"221 bye\r\n",
                _ => b"250 OK\r\n",
            };
            if writer.write_all(reply).await.is_err() {
                return;
            }
        }
    }

    fn plain_creds(port: u16) -> crate::imap::Creds {
        crate::imap::Creds {
            host: String::new(),
            port: 0,
            user: "alice@test".to_string(),
            // No secret: the client skips AUTH, which the fake server does
            // not offer either.
            password: String::new(),
            tls: false,
            starttls: false,
            smtp_host: "127.0.0.1".to_string(),
            smtp_port: port,
            smtp_tls: false,
            smtp_starttls: false,
            auth_type: "password".to_string(),
            access_token: None,
            refresh_token: None,
            token_expires_at: 0,
            oauth_client_id: String::new(),
            oauth_client_secret: String::new(),
            oauth_token_url: String::new(),
            oauth_scope: String::new(),
            proxy: crate::proxy::ProxyChoice::Direct,
            cert_pin: None,
            smtp_cert_pin: None,
            ews_url: String::new(),
            delegate_account_id: String::new(),
            target_mailbox: String::new(),
        }
    }

    /// Runs one submission against the fake server and returns the result
    /// alongside everything the server received.
    async fn submit_against(
        refuse_recipient: bool,
        after_data: AfterData,
        raw: &[u8],
    ) -> (anyhow::Result<()>, Vec<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let transcript = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        tokio::spawn(serve_submission(listener, refuse_recipient, after_data, transcript.clone(), false));
        let result = super::transport(&plain_creds(port), "alice@test", &["bob@test".to_string()], raw, false).await.map(|_| ());
        let lines = transcript.lock().unwrap().clone();
        (result, lines)
    }

    const RAW: &[u8] = b"From: alice@test\r\nTo: bob@test\r\nSubject: hi\r\n\r\nhello\r\n.hidden dot\r\n";

    /// The whole message went and the connection died before the reply: the
    /// server may have it, so the error must say the outcome is unknown.
    #[tokio::test]
    async fn a_lost_connection_after_the_message_is_an_uncertain_send() {
        let (result, lines) = submit_against(false, AfterData::HangUp, RAW).await;
        let err = result.expect_err("no reply is not a success");
        assert!(super::is_uncertain(&err), "{err:#}");
        assert_eq!(lines.last().map(String::as_str), Some("."), "the terminator was transmitted: {lines:?}");
    }

    /// The server answered the end of data with a refusal: definitive, and
    /// safe to try again later.
    #[tokio::test]
    async fn a_refusal_after_the_message_is_not_uncertain() {
        let (result, _) = submit_against(false, AfterData::Refuse, RAW).await;
        let err = result.expect_err("a 554 is a failure");
        assert!(!super::is_uncertain(&err), "{err:#}");
        assert!(format!("{err:#}").contains("refused by policy"), "{err:#}");
    }

    /// A recipient refused before DATA: nothing of the message has left.
    #[tokio::test]
    async fn a_refused_recipient_is_not_uncertain_and_sends_no_data() {
        let (result, lines) = submit_against(true, AfterData::Accept, RAW).await;
        let err = result.expect_err("a 550 is a failure");
        assert!(!super::is_uncertain(&err), "{err:#}");
        assert!(format!("{err:#}").contains("no such user"), "{err:#}");
        assert!(!lines.iter().any(|line| line.eq_ignore_ascii_case("DATA")), "{lines:?}");
    }

    /// The accepted path: envelope, data, dot-stuffed body, terminator.
    #[tokio::test]
    async fn an_accepted_message_goes_dot_stuffed_and_terminated() {
        let (result, lines) = submit_against(false, AfterData::Accept, RAW).await;
        result.expect("accepted");
        let verbs: Vec<String> = lines
            .iter()
            .map(|line| line.split(' ').next().unwrap_or_default().to_uppercase())
            .collect();
        let position = |verb: &str| verbs.iter().position(|v| v == verb).unwrap_or_else(|| panic!("{verb} in {lines:?}"));
        assert!(position("MAIL") < position("RCPT") && position("RCPT") < position("DATA"));
        assert!(lines.contains(&"..hidden dot".to_string()), "a leading dot is doubled: {lines:?}");
        assert!(lines.contains(&"hello".to_string()));
        assert_eq!(lines.iter().filter(|line| *line == ".").count(), 1, "one terminator: {lines:?}");
    }

    /// One accepted submission asking for a delivery receipt, against a
    /// server that does or does not offer DSN.
    async fn submit_wanting_dsn(offer_dsn: bool) -> (super::DeliveryReceipt, Vec<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let transcript = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        tokio::spawn(serve_submission(listener, false, AfterData::Accept, transcript.clone(), offer_dsn));
        let receipt = super::transport(&plain_creds(port), "alice@test", &["bob@test".to_string()], RAW, true)
            .await
            .expect("accepted");
        let lines = transcript.lock().unwrap().clone();
        (receipt, lines)
    }

    /// A server that offers DSN is asked for success and failure notices,
    /// with only the headers returned (RFC 3461).
    #[tokio::test]
    async fn a_delivery_receipt_is_asked_for_in_the_envelope_when_the_server_offers_dsn() {
        let (receipt, lines) = submit_wanting_dsn(true).await;
        assert_eq!(receipt, super::DeliveryReceipt::Requested);
        let mail = lines.iter().find(|line| line.starts_with("MAIL FROM")).expect("MAIL FROM");
        assert!(mail.ends_with(" RET=HDRS"), "{mail}");
        let rcpt = lines.iter().find(|line| line.starts_with("RCPT TO")).expect("RCPT TO");
        assert!(rcpt.contains(" NOTIFY=SUCCESS,FAILURE"), "{rcpt}");
        assert!(rcpt.contains(" ORCPT=rfc822;bob@test"), "{rcpt}");
    }

    /// A server that does not offer DSN gets an ordinary envelope, and the
    /// caller is told no receipt was asked for.
    #[tokio::test]
    async fn without_dsn_the_message_goes_plain_and_says_so() {
        let (receipt, lines) = submit_wanting_dsn(false).await;
        assert_eq!(receipt, super::DeliveryReceipt::Unsupported);
        assert!(lines.iter().all(|line| !line.contains("NOTIFY=") && !line.contains("RET=")), "{lines:?}");
    }

    /// Not asking changes nothing on the wire: no extra EHLO, no parameters.
    #[tokio::test]
    async fn not_asking_for_a_delivery_receipt_changes_nothing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let transcript = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        tokio::spawn(serve_submission(listener, false, AfterData::Accept, transcript.clone(), true));
        let receipt = super::transport(&plain_creds(port), "alice@test", &["bob@test".to_string()], RAW, false)
            .await
            .expect("accepted");
        assert_eq!(receipt, super::DeliveryReceipt::NotAsked);
        let lines = transcript.lock().unwrap().clone();
        assert_eq!(lines.iter().filter(|line| line.starts_with("EHLO")).count(), 1, "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("NOTIFY=")), "{lines:?}");
    }

    #[test]
    fn dsn_is_read_from_the_ehlo_answer() {
        assert!(super::offers_dsn(&["test".into(), "PIPELINING".into(), "DSN".into()]));
        assert!(super::offers_dsn(&["dsn".into()]));
        assert!(!super::offers_dsn(&["test".into(), "DSNX".into(), "8BITMIME".into()]));
    }

    /// A read receipt is the sender's own address in
    /// `Disposition-Notification-To`, with a non-ASCII name encoded.
    #[test]
    fn a_requested_read_receipt_names_the_sender() {
        let raw = super::build_message(
            "Zoë", "zoe@example.org", "bob@example.com", "", "", false, "Hola", "body", "", &[], "", "", "", "",
        )
        .unwrap();
        let raw = super::with_read_receipt(raw, "Zoë", "zoe@example.org").unwrap();
        assert!(raw.is_ascii());
        let parsed = mailparse::parse_mail(&raw).unwrap();
        use mailparse::MailHeaderMap as _;
        let value = parsed.headers.get_first_value("Disposition-Notification-To").expect("header");
        assert!(value.contains("<zoe@example.org>") && value.contains("Zoë"), "{value}");
        assert_eq!(parsed.headers.get_first_value("Subject").as_deref(), Some("Hola"));
        // Exchange and Graph get it in the MIME they submit.
        let submitted = super::build_submission(
            "", "zoe@example.org", "bob@example.com", "", "", "Hola", "body", "", &[], "", "", "", "", None, true,
        )
        .unwrap();
        let parsed = mailparse::parse_mail(&submitted).unwrap();
        assert_eq!(
            parsed.headers.get_first_value("Disposition-Notification-To").as_deref(),
            Some("<zoe@example.org>")
        );
        let without = super::build_submission(
            "", "zoe@example.org", "bob@example.com", "", "", "Hola", "body", "", &[], "", "", "", "", None, false,
        )
        .unwrap();
        assert!(mailparse::parse_mail(&without).unwrap().headers.get_first_value("Disposition-Notification-To").is_none());
    }

    #[test]
    fn data_body_stuffs_dots_and_ends_with_a_lone_dot() {
        let body = super::DataBody::new(b"a\r\n.b\r\n..c\r\n").unwrap().0;
        assert_eq!(body, "a\r\n..b\r\n...c\r\n.\r\n");
        // A message without a final line ending still ends properly.
        assert_eq!(super::DataBody::new(b"a\r\n.b").unwrap().0, "a\r\n..b\r\n.\r\n");
        // Raw 8-bit bytes cannot go through the text writer.
        assert!(super::DataBody::new(b"caf\xe9").is_none());
    }

    #[test]
    fn the_uncertain_marker_survives_added_context() {
        let err = super::uncertain(anyhow::anyhow!("io: connection reset")).context("send for acct");
        assert!(super::is_uncertain(&err));
        assert!(!super::is_uncertain(&anyhow::anyhow!("smtp send: permanent: 554 no")));
    }
}
