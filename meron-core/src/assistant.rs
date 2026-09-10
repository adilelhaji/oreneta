//! Explicit assistant provider and context boundary.
//!
//! This module deliberately owns request validation and transport only. It
//! never discovers mailbox content, persists prompts/responses, or interprets
//! instructions found in a message as authorization for a mail mutation.

use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use url::Url;

pub const MAX_CONTEXT_ITEMS: usize = 8;
pub const MAX_ITEM_BYTES: usize = 64 * 1024;
pub const MAX_CONTEXT_BYTES: usize = 256 * 1024;
pub const MAX_ATTACHMENT_BYTES: usize = 128 * 1024;
pub const MAX_ATTACHMENT_BASE64_BYTES: usize = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;
pub const MAX_ATTACHMENTS_PER_ITEM: usize = 16;
pub const MAX_ATTACHMENT_NAME_BYTES: usize = 256;
pub const MAX_ATTACHMENT_MIME_BYTES: usize = 128;
pub const MAX_CONTEXT_FIELD_BYTES: usize = 8 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderMode {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderConfig {
    pub mode: ProviderMode,
    pub endpoint: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentContext {
    pub name: String,
    pub mime: String,
    pub size: usize,
    #[serde(default)]
    pub content_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextItem {
    pub message_id: String,
    pub account_id: String,
    #[serde(default)]
    pub sender: String,
    #[serde(default)]
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextManifestItem {
    pub message_id: String,
    pub account_id: String,
    pub sender: String,
    pub subject: String,
    pub body_bytes: usize,
    pub attachments: Vec<AttachmentManifestItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentManifestItem {
    pub name: String,
    pub mime: String,
    pub size: usize,
    pub content_selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextManifest {
    pub items: Vec<ContextManifestItem>,
    pub total_bytes: usize,
    pub untrusted_input: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedRequest {
    pub provider: ProviderConfig,
    pub action: String,
    pub manifest: ContextManifest,
    pub requires_confirmation: bool,
    pub will_transmit: bool,
    pub automatic_mail_actions: bool,
    pub preview_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteRequest {
    pub provider: ProviderConfig,
    pub action: String,
    pub context: Vec<ContextItem>,
    pub confirmed: bool,
    pub preview_token: String,
    #[serde(default)]
    pub authorization: Option<String>,
}

fn preview_token(
    provider: &ProviderConfig,
    action: &str,
    context: &[ContextItem],
) -> Result<String> {
    let canonical = serde_json::to_vec(&(provider, action, context))
        .context("assistant preview token input")?;
    let digest = Sha256::digest(canonical);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_action(action: &str) -> bool {
    matches!(action, "summary" | "draft" | "task_suggestion")
}

fn validate_endpoint(provider: &ProviderConfig) -> Result<Url> {
    ensure!(
        !provider.model.trim().is_empty(),
        "assistant model is required"
    );
    let url = Url::parse(provider.endpoint.trim()).context("assistant endpoint is invalid")?;
    let host = url.host_str().context("assistant endpoint has no host")?;
    match provider.mode {
        ProviderMode::Local => {
            ensure!(
                matches!(url.scheme(), "http" | "https"),
                "local assistant endpoint must use HTTP(S)"
            );
            ensure!(
                matches!(host, "localhost" | "127.0.0.1" | "::1"),
                "local assistant endpoint must be loopback"
            );
        }
        ProviderMode::Remote => {
            ensure!(
                url.scheme() == "https",
                "remote assistant endpoint must use HTTPS"
            );
        }
    }
    Ok(url)
}

pub fn manifest(context: &[ContextItem]) -> Result<ContextManifest> {
    ensure!(!context.is_empty(), "assistant context cannot be empty");
    ensure!(
        context.len() <= MAX_CONTEXT_ITEMS,
        "assistant context has too many messages"
    );
    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    let mut items = Vec::with_capacity(context.len());
    for item in context {
        ensure!(
            !item.message_id.trim().is_empty(),
            "assistant context message id is required"
        );
        ensure!(
            !item.account_id.trim().is_empty(),
            "assistant context account id is required"
        );
        ensure!(
            item.message_id.len() <= MAX_CONTEXT_FIELD_BYTES
                && item.account_id.len() <= MAX_CONTEXT_FIELD_BYTES
                && item.sender.len() <= MAX_CONTEXT_FIELD_BYTES
                && item.subject.len() <= MAX_CONTEXT_FIELD_BYTES,
            "assistant context metadata is too long"
        );
        ensure!(
            seen.insert((&item.account_id, &item.message_id)),
            "assistant context contains a duplicate message"
        );
        let body_bytes = item.body.len();
        ensure!(
            body_bytes <= MAX_ITEM_BYTES,
            "assistant message exceeds the context limit"
        );
        total_bytes = total_bytes
            .saturating_add(body_bytes)
            .saturating_add(item.message_id.len())
            .saturating_add(item.account_id.len())
            .saturating_add(item.sender.len())
            .saturating_add(item.subject.len());
        ensure!(
            item.attachments.len() <= MAX_ATTACHMENTS_PER_ITEM,
            "assistant message has too many attachments"
        );
        let mut attachments = Vec::with_capacity(item.attachments.len());
        for attachment in &item.attachments {
            ensure!(
                !attachment.name.trim().is_empty(),
                "assistant attachment name is required"
            );
            ensure!(
                attachment.name.len() <= MAX_ATTACHMENT_NAME_BYTES,
                "assistant attachment name is too long"
            );
            ensure!(
                attachment.mime.len() <= MAX_ATTACHMENT_MIME_BYTES,
                "assistant attachment MIME is too long"
            );
            ensure!(
                attachment.size <= MAX_ATTACHMENT_BYTES,
                "assistant attachment exceeds the context limit"
            );
            total_bytes = total_bytes
                .saturating_add(attachment.name.len())
                .saturating_add(attachment.mime.len());
            if let Some(content) = attachment.content_base64.as_deref() {
                ensure!(
                    content.len() <= MAX_ATTACHMENT_BASE64_BYTES,
                    "assistant attachment encoding is too long"
                );
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(content)
                    .context("assistant attachment is not valid base64")?;
                ensure!(
                    decoded.len() == attachment.size,
                    "assistant attachment size does not match its content"
                );
                total_bytes = total_bytes.saturating_add(attachment.size);
            }
            attachments.push(AttachmentManifestItem {
                name: attachment.name.clone(),
                mime: attachment.mime.clone(),
                size: attachment.size,
                content_selected: attachment.content_base64.is_some(),
            });
        }
        items.push(ContextManifestItem {
            message_id: item.message_id.clone(),
            account_id: item.account_id.clone(),
            sender: item.sender.clone(),
            subject: item.subject.clone(),
            body_bytes,
            attachments,
        });
    }
    ensure!(
        total_bytes <= MAX_CONTEXT_BYTES,
        "assistant context exceeds the total limit"
    );
    Ok(ContextManifest {
        items,
        total_bytes,
        untrusted_input: true,
    })
}

pub fn prepare(
    provider: ProviderConfig,
    action: &str,
    context: &[ContextItem],
) -> Result<PreparedRequest> {
    ensure!(valid_action(action), "unsupported assistant action");
    validate_endpoint(&provider)?;
    let manifest = manifest(context)?;
    let token = preview_token(&provider, action, context)?;
    Ok(PreparedRequest {
        will_transmit: provider.mode == ProviderMode::Remote,
        provider,
        action: action.to_string(),
        manifest,
        requires_confirmation: true,
        automatic_mail_actions: false,
        preview_token: token,
    })
}

pub fn execute(agent: &ureq::Agent, request: ExecuteRequest) -> Result<Value> {
    ensure!(
        request.confirmed,
        "assistant action requires explicit confirmation"
    );
    let prepared = prepare(request.provider.clone(), &request.action, &request.context)?;
    ensure!(
        request.preview_token == prepared.preview_token,
        "assistant preview is stale or does not match the request"
    );
    let endpoint = validate_endpoint(&request.provider)?;
    let payload = json!({
        "action": request.action,
        "model": request.provider.model,
        "context": request.context,
        "safety": { "untrusted_input": true, "automatic_mail_actions": false },
    });
    let mut call = agent
        .post(endpoint.as_str())
        .header("Content-Type", "application/json")
        .config()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .build();
    if let Some(token) = request
        .authorization
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        call = call.header("Authorization", &format!("Bearer {token}"));
    }
    let mut response = call
        .send(payload.to_string())
        .context("assistant provider request")?;
    let status = response.status();
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .context("read assistant provider response")?;
    ensure!(
        body.len() <= MAX_RESPONSE_BYTES,
        "assistant provider response is too large"
    );
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&body);
        bail!("assistant provider returned {}: {}", status, detail.trim());
    }
    Ok(json!({
        "prepared": prepared,
        "response": String::from_utf8_lossy(&body).to_string(),
        "persisted": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, account: &str) -> ContextItem {
        ContextItem {
            message_id: id.into(),
            account_id: account.into(),
            sender: "sender@example.test".into(),
            subject: "Subject".into(),
            body: "Untrusted body".into(),
            attachments: vec![],
        }
    }

    fn provider(mode: ProviderMode, endpoint: &str) -> ProviderConfig {
        ProviderConfig {
            mode,
            endpoint: endpoint.into(),
            model: "model".into(),
        }
    }

    #[test]
    fn preview_exposes_manifest_without_raw_body() {
        let prepared = prepare(
            provider(ProviderMode::Remote, "https://ai.example.test/v1"),
            "summary",
            &[item("m1", "a1")],
        )
        .unwrap();
        assert!(prepared.will_transmit);
        assert!(prepared.manifest.untrusted_input);
        assert!(
            !serde_json::to_string(&prepared)
                .unwrap()
                .contains("Untrusted body")
        );
    }

    #[test]
    fn local_provider_must_be_loopback_and_remote_must_be_https() {
        assert!(
            prepare(
                provider(ProviderMode::Local, "https://ai.example.test"),
                "summary",
                &[item("m1", "a1")]
            )
            .is_err()
        );
        assert!(
            prepare(
                provider(ProviderMode::Remote, "http://ai.example.test"),
                "summary",
                &[item("m1", "a1")]
            )
            .is_err()
        );
        assert!(
            prepare(
                provider(ProviderMode::Local, "http://127.0.0.1:11434/v1"),
                "summary",
                &[item("m1", "a1")]
            )
            .is_ok()
        );
    }

    #[test]
    fn context_is_bounded_account_scoped_and_rejects_duplicates() {
        let mut duplicate = item("m1", "a1");
        duplicate.body = "x".repeat(MAX_ITEM_BYTES + 1);
        assert!(manifest(&[duplicate]).is_err());
        assert!(manifest(&[item("m1", "a1"), item("m1", "a1")]).is_err());
        assert!(manifest(&[item("m1", "a1"), item("m1", "a2")]).is_ok());
    }

    #[test]
    fn only_reviewable_actions_are_allowed() {
        for action in ["summary", "draft", "task_suggestion"] {
            assert!(
                prepare(
                    provider(ProviderMode::Local, "http://localhost:11434/v1"),
                    action,
                    &[item("m1", "a1")]
                )
                .is_ok()
            );
        }
        assert!(
            prepare(
                provider(ProviderMode::Local, "http://localhost:11434/v1"),
                "send_mail",
                &[item("m1", "a1")]
            )
            .is_err()
        );
    }

    #[test]
    fn execution_requires_confirmation_before_transport() {
        let request = ExecuteRequest {
            provider: provider(ProviderMode::Remote, "https://ai.example.test/v1"),
            action: "summary".into(),
            context: vec![item("m1", "a1")],
            confirmed: false,
            preview_token: "invalid".into(),
            authorization: None,
        };
        let agent = ureq::Agent::new_with_defaults();
        let error = execute(&agent, request).unwrap_err().to_string();
        assert!(error.contains("explicit confirmation"));
    }

    #[test]
    fn execution_rejects_a_stale_preview_token() {
        let context = vec![item("m1", "a1")];
        let provider = provider(ProviderMode::Remote, "https://ai.example.test/v1");
        let request = ExecuteRequest {
            preview_token: "stale".into(),
            provider,
            action: "summary".into(),
            context,
            confirmed: true,
            authorization: None,
        };
        let agent = ureq::Agent::new_with_defaults();
        let error = execute(&agent, request).unwrap_err().to_string();
        assert!(error.contains("preview is stale"));
    }

    #[test]
    fn attachment_bytes_are_validated_against_the_declared_size() {
        let mut message = item("m1", "a1");
        message.attachments = vec![AttachmentContext {
            name: "note.txt".into(),
            mime: "text/plain".into(),
            size: 3,
            content_base64: Some("eA==".into()),
        }];
        assert!(manifest(&[message]).is_err());
    }

    #[test]
    fn attachment_metadata_and_count_are_bounded() {
        let mut message = item("m1", "a1");
        message.attachments = (0..=MAX_ATTACHMENTS_PER_ITEM)
            .map(|index| AttachmentContext {
                name: format!("file-{index}.txt"),
                mime: "text/plain".into(),
                size: 0,
                content_base64: None,
            })
            .collect();
        assert!(manifest(&[message]).is_err());

        let mut message = item("m2", "a1");
        message.attachments = vec![AttachmentContext {
            name: "x".repeat(MAX_ATTACHMENT_NAME_BYTES + 1),
            mime: "text/plain".into(),
            size: 0,
            content_base64: None,
        }];
        assert!(manifest(&[message]).is_err());
    }

    #[test]
    fn metadata_and_encoded_attachment_lengths_are_bounded() {
        let mut message = item("m1", "a1");
        message.subject = "s".repeat(MAX_CONTEXT_FIELD_BYTES + 1);
        assert!(manifest(&[message]).is_err());

        let mut message = item("m2", "a1");
        message.attachments = vec![AttachmentContext {
            name: "large.txt".into(),
            mime: "text/plain".into(),
            size: 1,
            content_base64: Some("A".repeat(MAX_ATTACHMENT_BASE64_BYTES + 1)),
        }];
        assert!(manifest(&[message]).is_err());
    }
}
