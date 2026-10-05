//! Local recovery documents. No provider calls or send-queue side effects.
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::HashSet;

pub(super) const SCHEMA: &str = "
CREATE TABLE local_drafts (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
  document TEXT,
  updated_at INTEGER NOT NULL,
  CHECK((deleted = 1 AND document IS NULL) OR (deleted = 0 AND document IS NOT NULL))
);
CREATE INDEX local_drafts_account_idx ON local_drafts(account) WHERE deleted = 0;
";

const MIB: usize = 1024 * 1024;
const MAX_DOCUMENT: usize = 64 * MIB;
const MAX_BODY: usize = 8 * MIB;
const MAX_ATTACHMENTS: usize = 64;
const MAX_ATTACHMENT_BYTES: usize = 40 * MIB;
const MAX_ACTIVE: i64 = 256;
const MAX_REVISION: i64 = 9_007_199_254_740_991; // exact in JavaScript

fn identifier(value: &Value) -> Result<&str> {
    let id = value.as_str().context("invalid local draft identifier")?;
    ensure!(!id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "invalid local draft identifier");
    Ok(id)
}

fn text_field<'a>(value: &'a Value, field: &str, max: usize) -> Result<&'a str> {
    let text = value.get(field).and_then(Value::as_str).context("invalid local draft text field")?;
    ensure!(text.len() <= max, "local draft text exceeds limit");
    Ok(text)
}

fn validate(document: &Value) -> Result<String> {
    ensure!(document.get("version").and_then(Value::as_u64) == Some(1), "unsupported local draft version");
    let compose = &document["compose"];
    for field in ["accountId", "fromEmail", "to", "cc", "bcc", "replyTo", "subject", "inReplyTo", "references", "draftMessageId"] {
        text_field(compose, field, 64 * 1024)?;
    }
    for field in ["html", "text"] { text_field(compose, field, MAX_BODY)?; }
    for field in ["rich", "showCcBcc", "pgpSign", "pgpEncrypt"] {
        ensure!(compose.get(field).and_then(Value::as_bool).is_some(), "invalid local draft option");
    }
    let attachments = compose["attachments"].as_array().context("invalid local draft attachments")?;
    ensure!(attachments.len() <= MAX_ATTACHMENTS, "too many local draft attachments");
    let mut ids = HashSet::new();
    let mut bytes = 0usize;
    for attachment in attachments {
        let id = text_field(attachment, "id", 128)?;
        ensure!(!id.is_empty() && ids.insert(id), "invalid or duplicate local draft attachment identifier");
        ensure!(!text_field(attachment, "filename", 1024)?.is_empty(), "invalid local draft attachment filename");
        ensure!(!text_field(attachment, "mime", 256)?.is_empty(), "invalid local draft attachment MIME");
        if attachment.get("inlineId").is_some() { text_field(attachment, "inlineId", 1024)?; }
        let size = attachment["size"].as_u64().context("invalid local draft attachment size")?;
        ensure!(size <= MAX_ATTACHMENT_BYTES as u64, "local draft attachments exceed limit");
        bytes = bytes.checked_add(size as usize).context("local draft attachments exceed limit")?;
        ensure!(bytes <= MAX_ATTACHMENT_BYTES, "local draft attachments exceed limit");
        let encoded = text_field(attachment, "data", MAX_ATTACHMENT_BYTES.div_ceil(3) * 4)?;
        ensure!(encoded.len() == (size as usize).div_ceil(3) * 4, "local draft attachment size mismatch");
        let decoded = STANDARD.decode(encoded).map_err(|_| anyhow::anyhow!("invalid local draft attachment encoding"))?;
        ensure!(decoded.len() == size as usize, "local draft attachment size mismatch");
    }
    let serialized = serde_json::to_string(document)?;
    ensure!(serialized.len() <= MAX_DOCUMENT, "local draft document exceeds limit");
    Ok(serialized)
}

// FULL makes the acknowledgement stronger than the shared store's NORMAL mode.
// Restore even on rollback; if restoring fails, remaining at FULL is safe.
struct SyncMode<'a>(&'a Connection, i64);
impl Drop for SyncMode<'_> {
    fn drop(&mut self) { let _ = self.0.pragma_update(None, "synchronous", self.1); }
}

fn mutate(conn: &Connection, id: &str, expected: i64, document: Option<&Value>) -> Result<Value> {
    let serialized = document.map(validate).transpose()?;
    let original: i64 = conn.pragma_query_value(None, "synchronous", |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", 2)?;
    let _mode = SyncMode(conn, original);
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let current: Option<(i64, bool)> = tx.query_row("SELECT revision, deleted FROM local_drafts WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (revision, deleted) = current.unwrap_or((0, false));
    if expected != revision || deleted {
        return Ok(json!({"applied": false, "revision": revision, "deleted": deleted}));
    }
    ensure!(revision < MAX_REVISION, "local draft revision limit reached");
    if document.is_some() && current.is_none() {
        let active: i64 = tx.query_row("SELECT COUNT(*) FROM local_drafts WHERE deleted=0", [], |r| r.get(0))?;
        ensure!(active < MAX_ACTIVE, "local draft count limit reached");
    }
    let account = document.map(|d| d["compose"]["accountId"].as_str().unwrap()).unwrap_or("");
    tx.execute("INSERT INTO local_drafts(id, account, revision, deleted, document, updated_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(id) DO UPDATE SET account=excluded.account, revision=excluded.revision, deleted=excluded.deleted, document=excluded.document, updated_at=excluded.updated_at",
        params![id, account, revision + 1, document.is_none(), serialized, super::now_unix()])?;
    tx.commit()?;
    Ok(json!({"applied": true, "revision": revision + 1, "deleted": document.is_none()}))
}

/// Desktop protocol entry point. Errors describe only the failed constraint,
/// never document content, recipients, attachment bytes or credentials.
pub fn dispatch(conn: &Connection, method: &str, p: &Value) -> Result<Value> {
    match method {
        "localDrafts.save" | "localDrafts.delete" => {
            let id = identifier(&p["id"])?;
            let expected = p["expected_revision"].as_i64().context("missing local draft revision")?;
            ensure!((0..=MAX_REVISION).contains(&expected), "invalid local draft revision");
            let document = if method == "localDrafts.save" { Some(p.get("document").context("missing local draft document")?) } else { None };
            mutate(conn, id, expected, document)
        }
        "localDrafts.get" => {
            let id = identifier(&p["id"])?;
            let record: Option<(i64, bool, Option<String>)> = conn.query_row("SELECT revision, deleted, document FROM local_drafts WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
            let Some((revision, deleted, raw)) = record else { return Ok(json!({"draft": null})); };
            let document = if deleted { Value::Null } else {
                let raw = raw.context("missing local draft document")?;
                ensure!(raw.len() <= MAX_DOCUMENT, "local draft document exceeds limit");
                let document: Value = serde_json::from_str(&raw).map_err(|_| anyhow::anyhow!("invalid stored local draft document"))?;
                validate(&document)?;
                document
            };
            Ok(json!({"draft": {"id": id, "revision": revision, "deleted": deleted, "document": document}}))
        }
        "localDrafts.list" => {
            let account = match p.get("account_id") { None => None, Some(v) => Some(v.as_str().context("invalid local draft account filter")?) };
            let mut stmt = conn.prepare("SELECT id, account, revision, updated_at FROM local_drafts WHERE deleted=0 AND (?1 IS NULL OR account=?1) ORDER BY updated_at, id")?;
            let drafts = stmt.query_map([account], |r| Ok(json!({"id": r.get::<_, String>(0)?, "account_id": r.get::<_, String>(1)?, "revision": r.get::<_, i64>(2)?, "updated_at": r.get::<_, i64>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"drafts": drafts}))
        }
        _ => anyhow::bail!("unknown local draft command"),
    }
}

#[cfg(test)]
mod tests;
