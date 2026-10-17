//! OS keychain storage for per-account secrets (IMAP password + OAuth tokens).
//!
//! Secrets live in the platform keychain — Keychain on macOS, Credential Manager
//! on Windows, and the Secret Service (D-Bus, e.g. gnome-keyring) on native Linux.
//! Inside Flatpak, oo7 uses the Secret portal to encrypt an app-private keyring.
//! One entry per account holds a JSON blob; non-secret connection metadata (host,
//! port, user, ...) stays in SQLite.
//!
//! Entries are written under the `oreneta` service. Those still under the
//! inherited `meron` one are moved on first read and by a start-up sweep
//! ([`crate::secrets_migration`], ADR-0063).

use anyhow::{Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::imap::Creds;
use crate::secrets_migration::{CredentialStore, Migration};

// Reserved keychain "account" holding the SQLCipher key for the local store.
// The leading underscores keep it out of the real per-account id namespace.
const DB_KEY_ACCOUNT: &str = "__meron_db_key__";

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Secrets {
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

impl Secrets {
    /// Pull the secret-bearing fields out of a fully-populated `Creds`.
    pub fn from_creds(c: &Creds) -> Self {
        Secrets {
            password: c.password.clone(),
            access_token: c.access_token.clone().filter(|s| !s.is_empty()),
            refresh_token: c.refresh_token.clone().filter(|s| !s.is_empty()),
        }
    }

    /// Overlay these secrets onto a `Creds` loaded from the (secret-free) store.
    pub fn apply_to(&self, c: &mut Creds) {
        c.password = self.password.clone();
        c.access_token = self.access_token.clone();
        c.refresh_token = self.refresh_token.clone();
    }

    pub fn is_empty(&self) -> bool {
        self.password.is_empty()
            && self.access_token.as_deref().unwrap_or("").is_empty()
            && self.refresh_token.as_deref().unwrap_or("").is_empty()
    }
}

/// `MERON_KEYRING` escape hatches, all opt-in and none set in normal use:
///
///   * `off` — no keychain at all (tests/headless CI). Secrets are kept in
///     this process's memory, so anything that stores a secret and reads it
///     back within one run — a contact source syncing with its password, a
///     send signing with an imported key — works as it would with a keychain;
///     only cross-restart persistence is lost.
///   * `service` — force the D-Bus Secret Service even inside Flatpak, for
///     sandboxes that can reach the host service directly.
///   * `file` — force the local file keyring, skipping D-Bus entirely. The
///     supported workaround when a desktop has no working secret storage.
fn keyring_disabled() -> bool {
    std::env::var_os("MERON_KEYRING").is_some_and(|v| v == "off")
}

/// The stand-in keychain for `MERON_KEYRING=off`: the same blobs the real
/// backends would hold, for the life of the process and no longer.
fn off_mode_entries() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static ENTRIES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    ENTRIES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn off_mode_store(account: &str, blob: &str) {
    off_mode_entries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(account.to_string(), blob.to_string());
}

fn off_mode_load(account: &str) -> Option<String> {
    off_mode_entries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(account)
        .cloned()
}

fn off_mode_delete(account: &str) {
    off_mode_entries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(account);
}

// Linux talks to the keychain through `backend_*` below, which builds its own
// entries inside the timeout wrapper.
#[cfg(not(target_os = "linux"))]
fn entry(service: &str, account: &str) -> Result<Entry> {
    Entry::new(service, account)
        .with_context(|| format!("open {service} keychain entry for {account}"))
}

// ---- Windows blob chunking --------------------------------------------------
//
// Credential Manager caps one credential blob at CRED_MAX_CREDENTIAL_BLOB_SIZE
// (2560 bytes, i.e. 1280 UTF-16 units). A Microsoft OAuth pair alone is bigger
// than that — Google's fits, which is why only Outlook/Hotmail accounts failed
// to connect. Oversized blobs are therefore split across numbered companion
// entries, with the main entry holding a marker naming the chunk count. Blobs
// that fit are still written verbatim, so existing entries keep loading.
//
// An update writes its chunks under the *other* generation and only then swings
// the marker, so the generation the marker points at is never edited in place: a
// write that fails partway leaves the previous secrets intact and readable.

/// Chunk payload size, in UTF-16 units, kept under the 1280-unit platform cap.
const CHUNK_UTF16: usize = 1200;

/// Hard cap on chunks per generation — ~38K of secrets, far past the few
/// kilobytes an OAuth pair needs. Cleanup sweeps this whole range instead of
/// stopping at the first missing index, so a delete that failed earlier cannot
/// hide the chunks after it from every later sweep.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MAX_CHUNKS: usize = 32;

/// Prefix of the marker written to the main entry, followed by `<generation>:<count>`.
/// Real blobs are JSON objects, so they never start with this.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const CHUNKED_MARKER: &str = "meron-chunked:";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn chunk_account(account: &str, generation: u8, index: usize) -> String {
    format!("{account}--meron-g{generation}c{index}")
}

/// Read a main entry as a chunk marker: `Some((generation, count))`, or `None`
/// for a plain unchunked blob.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_marker(head: &str) -> Option<(u8, usize)> {
    let (generation, count) = head.strip_prefix(CHUNKED_MARKER)?.split_once(':')?;
    Some((generation.parse().ok()?, count.parse().ok()?))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn fits_in_credential(blob: &str) -> bool {
    blob.encode_utf16().count() <= CHUNK_UTF16
}

/// Split a blob into pieces that each fit one credential, cutting only on char
/// boundaries so no surrogate pair or multi-byte char is torn in half.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn split_blob(blob: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut units = 0;
    for (offset, ch) in blob.char_indices() {
        let width = ch.len_utf16();
        if units + width > CHUNK_UTF16 {
            chunks.push(&blob[start..offset]);
            start = offset;
            units = 0;
        }
        units += width;
    }
    if start < blob.len() {
        chunks.push(&blob[start..]);
    }
    chunks
}

#[cfg(target_os = "linux")]
fn keyring_forced_to(mode: &str) -> bool {
    std::env::var_os("MERON_KEYRING").is_some_and(|v| v == mode)
}

#[cfg(target_os = "linux")]
fn use_portal_keyring() -> bool {
    if keyring_forced_to("service") {
        return false;
    }
    flatpak_detected(
        std::env::var_os("FLATPAK_ID").as_deref(),
        std::path::Path::new("/.flatpak-info").exists(),
    )
}

/// Whether to go through [`crate::secrets_portal`] (Secret portal, or its local
/// file fallback) rather than the D-Bus Secret Service.
#[cfg(target_os = "linux")]
fn use_oo7_keyring() -> bool {
    use_portal_keyring()
        || keyring_forced_to("file")
        || crate::secrets_portal::local_forced()
        || (!keyring_forced_to("service") && crate::secrets_portal::local_keyring_exists())
}

#[cfg(target_os = "linux")]
fn flatpak_detected(flatpak_id: Option<&std::ffi::OsStr>, marker_exists: bool) -> bool {
    flatpak_id.is_some_and(|id| !id.is_empty()) || marker_exists
}

#[cfg(not(target_os = "linux"))]
fn use_portal_keyring() -> bool {
    false
}

/// The keychain name for an entry of this app profile (#99, ADR-0016). The
/// default profile keeps the names it always had; another profile's entries
/// carry its id, so two profiles with the same account never share secrets
/// or a store key.
fn scoped(account: &str) -> String {
    scoped_for(std::env::var("MERON_PROFILE").ok().as_deref(), account)
}

fn scoped_for(profile: Option<&str>, account: &str) -> String {
    match profile.map(str::trim) {
        None | Some("") | Some("default") => account.to_string(),
        Some(profile) => format!("profile:{profile}/{account}"),
    }
}

/// The platform keychain, as the migration sees it: one call per service.
struct Platform;

impl CredentialStore for Platform {
    fn read(&self, service: &'static str, key: &str) -> Result<Option<String>> {
        backend_load(service, key)
    }

    fn write(&self, service: &'static str, key: &str, blob: &str) -> Result<()> {
        backend_store(service, key, blob)
    }

    fn delete(&self, service: &'static str, key: &str) -> Result<()> {
        backend_delete(service, key)
    }
}

fn keyring_log(level: crate::log::Level, message: &str) {
    crate::mlog!(level, "keyring", "{message}");
}

/// Read a scoped entry, `oreneta` first and then `meron` (ADR-0063).
fn vault_load(key: &str) -> Result<Option<String>> {
    Migration::global().load(&Platform, &keyring_log, key)
}

/// Write a scoped entry under `oreneta`, retiring a `meron` copy it replaces.
fn vault_store(key: &str, blob: &str) -> Result<()> {
    Migration::global().store(&Platform, &keyring_log, key, blob)
}

/// Delete a scoped entry from both services.
fn vault_delete(key: &str) -> Result<()> {
    Migration::global().delete(&Platform, key)
}

/// Moves every entry this profile names from the `meron` service to
/// `oreneta` now, instead of on each one's first read, so entries a session
/// never reads move too (ADR-0063). `names` are unscoped, as the store keeps
/// them ([`crate::profile_purge::keychain_names`]). Failures are logged, with
/// counts and never values, and tried again on the next start.
pub fn migrate_legacy(names: &[String]) {
    if keyring_disabled() {
        return;
    }
    let keys: Vec<String> = names.iter().map(|name| scoped(name)).collect();
    Migration::global().migrate_all(&Platform, &keyring_log, &keys);
}

/// Store (or replace) an account's secrets in the OS keychain.
pub fn store(account: &str, secrets: &Secrets) -> Result<()> {
    let blob = serde_json::to_string(secrets)?;
    if keyring_disabled() {
        off_mode_store(account, &blob);
        return Ok(());
    }
    vault_store(&scoped(account), &blob)
}

/// Load an account's secrets, or defaults if no entry exists.
pub fn load(account: &str) -> Result<Secrets> {
    let blob = if keyring_disabled() {
        off_mode_load(account)
    } else {
        vault_load(&scoped(account))?
    };
    match blob {
        Some(blob) => Ok(serde_json::from_str(&blob).unwrap_or_default()),
        None => Ok(Secrets::default()),
    }
}

// Versioned Graph records must not be decoded as legacy IMAP Secrets. Reuse
// platform encryption/chunking but fail closed on unavailable/corrupt storage.
pub(crate) fn graph_record_load(key: &str) -> Result<Option<String>> {
    anyhow::ensure!(key.starts_with("__oreneta_graph_v1_"), "invalid Graph key");
    anyhow::ensure!(!keyring_disabled(), "Graph secure storage unavailable");
    vault_load(&scoped(key))
}
pub(crate) fn graph_record_store(key: &str, value: &str) -> Result<()> {
    anyhow::ensure!(key.starts_with("__oreneta_graph_v1_"), "invalid Graph key");
    anyhow::ensure!(!keyring_disabled(), "Graph secure storage unavailable");
    vault_store(&scoped(key), value)
}
pub(crate) fn graph_record_delete(key: &str) -> Result<()> {
    anyhow::ensure!(key.starts_with("__oreneta_graph_v1_"), "invalid Graph key");
    anyhow::ensure!(!keyring_disabled(), "Graph secure storage unavailable");
    vault_delete(&scoped(key))
}

// ---- Backends ---------------------------------------------------------------
//
// On Linux the keychain is a D-Bus service that may be absent (a Flatpak with
// no Secret portal backend, a Snap whose `password-manager-service` interface
// was never connected) and, when it is, may never answer. Every call is
// therefore bounded, and an unavailable service demotes the process to the
// local file keyring instead of failing every operation for the rest of the
// run. macOS and Windows keep the plain synchronous path.

#[cfg(target_os = "linux")]
fn backend_store(service: &'static str, account: &str, blob: &str) -> Result<()> {
    let owned_account = account.to_owned();
    let owned_blob = blob.to_owned();
    with_service_fallback(
        move || {
            service_call("write", move || {
                Entry::new(service, &owned_account)?.set_password(&owned_blob)
            })
        },
        || {
            crate::secrets_portal::store(service, account, blob)
                .with_context(|| format!("write {service} keyring entry for {account}"))
        },
    )
}

#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
fn backend_store(service: &'static str, account: &str, blob: &str) -> Result<()> {
    write_entry(service, account, blob)
}

#[cfg(target_os = "windows")]
fn backend_store(service: &'static str, account: &str, blob: &str) -> Result<()> {
    let live = read_entry(service, account)?.as_deref().and_then(parse_marker);
    if fits_in_credential(blob) {
        write_entry(service, account, blob)?;
        // Best-effort cleanup: the secrets are safely stored either way, and a
        // failure here only leaves an unreferenced entry behind.
        let _ = sweep_chunks(service, account);
        return Ok(());
    }
    // Never touch the generation the current marker points at, so the stored
    // secrets stay loadable until the marker itself is replaced.
    let generation = live.map_or(0, |(live, _)| live ^ 1);
    let chunks = split_blob(blob);
    anyhow::ensure!(
        chunks.len() <= MAX_CHUNKS,
        "secrets for {account} need {} keychain chunks, over the {MAX_CHUNKS} limit",
        chunks.len()
    );
    for (index, chunk) in chunks.iter().enumerate() {
        write_entry(service, &chunk_account(account, generation, index), chunk)?;
    }
    write_entry(
        service,
        account,
        &format!("{CHUNKED_MARKER}{generation}:{}", chunks.len()),
    )?;
    // Best-effort cleanup: the secrets are safely stored either way, and a
    // failure here only leaves an unreferenced entry behind.
    let _ = delete_chunks(service, account, generation ^ 1, 0..MAX_CHUNKS);
    let _ = delete_chunks(service, account, generation, chunks.len()..MAX_CHUNKS);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn write_entry(service: &str, account: &str, blob: &str) -> Result<()> {
    entry(service, account)?
        .set_password(blob)
        .with_context(|| format!("write {service} keychain entry for {account}"))
}

/// Delete a generation's chunk entries over `range` — a stale generation, or the
/// tail left behind when a value shrinks. Missing entries are fine; a real
/// failure does not stop the sweep, so one undeletable entry can never hide the
/// ones after it, and the first such error is returned once the range is done.
#[cfg(target_os = "windows")]
fn delete_chunks(
    service: &str,
    account: &str,
    generation: u8,
    range: std::ops::Range<usize>,
) -> Result<()> {
    let mut failure = None;
    for index in range {
        let name = chunk_account(account, generation, index);
        let deleted = entry(service, &name).and_then(|e| match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => {
                Err(e).with_context(|| format!("delete {service} keychain entry for {name}"))
            }
        });
        if let Err(e) = deleted {
            failure.get_or_insert(e);
        }
    }
    failure.map_or(Ok(()), Err)
}

/// Drop every chunk entry for an account, in either generation.
#[cfg(target_os = "windows")]
fn sweep_chunks(service: &str, account: &str) -> Result<()> {
    let zero = delete_chunks(service, account, 0, 0..MAX_CHUNKS);
    zero.and(delete_chunks(service, account, 1, 0..MAX_CHUNKS))
}

#[cfg(target_os = "linux")]
fn backend_load(service: &'static str, account: &str) -> Result<Option<String>> {
    let owned_account = account.to_owned();
    with_service_fallback(
        move || {
            service_call("read", move || {
                match Entry::new(service, &owned_account)?.get_password() {
                    Ok(blob) => Ok(Some(blob)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(error) => Err(error),
                }
            })
        },
        || {
            crate::secrets_portal::load(service, account)
                .with_context(|| format!("read {service} keyring entry for {account}"))
        },
    )
}

#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
fn backend_load(service: &'static str, account: &str) -> Result<Option<String>> {
    read_entry(service, account)
}

#[cfg(target_os = "windows")]
fn backend_load(service: &'static str, account: &str) -> Result<Option<String>> {
    let Some(head) = read_entry(service, account)? else {
        return Ok(None);
    };
    let Some((generation, count)) = parse_marker(&head) else {
        return Ok(Some(head));
    };
    let mut blob = String::new();
    for index in 0..count {
        let name = chunk_account(account, generation, index);
        let chunk = read_entry(service, &name)?
            .with_context(|| format!("missing {service} keychain chunk {index} for {account}"))?;
        blob.push_str(&chunk);
    }
    Ok(Some(blob))
}

#[cfg(not(target_os = "linux"))]
fn read_entry(service: &str, account: &str) -> Result<Option<String>> {
    match entry(service, account)?.get_password() {
        Ok(blob) => Ok(Some(blob)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {service} keychain entry for {account}")),
    }
}

#[cfg(target_os = "linux")]
fn backend_delete(service: &'static str, account: &str) -> Result<()> {
    let owned_account = account.to_owned();
    with_service_fallback(
        move || {
            service_call("delete", move || {
                match Entry::new(service, &owned_account)?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(error),
                }
            })
        },
        || {
            crate::secrets_portal::delete(service, account)
                .with_context(|| format!("delete {service} keyring entry for {account}"))
        },
    )
}

#[cfg(target_os = "windows")]
fn backend_delete(service: &'static str, account: &str) -> Result<()> {
    // Chunks first: while the marker survives, a failed sweep leaves an account
    // that still loads rather than one pointing at half-deleted secrets.
    sweep_chunks(service, account)?;
    delete_entry(service, account)
}

#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
fn backend_delete(service: &'static str, account: &str) -> Result<()> {
    delete_entry(service, account)
}

#[cfg(not(target_os = "linux"))]
fn delete_entry(service: &str, account: &str) -> Result<()> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).with_context(|| format!("delete {service} keychain entry for {account}")),
    }
}

/// A failed Secret Service call. `unavailable` separates "there is no usable
/// service here" — worth falling back for — from a real error such as an
/// ambiguous or oversized entry, which the local keyring would not fix.
#[cfg(target_os = "linux")]
struct ServiceFailure {
    error: anyhow::Error,
    unavailable: bool,
}

#[cfg(target_os = "linux")]
impl ServiceFailure {
    fn unavailable(message: String) -> Self {
        Self {
            error: anyhow::anyhow!(message),
            unavailable: true,
        }
    }

    fn from_keyring(what: &str, error: keyring::Error) -> Self {
        let unavailable = matches!(
            error,
            keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
        );
        Self {
            error: anyhow::Error::new(error).context(format!("Secret Service {what}")),
            unavailable,
        }
    }
}

/// Run one blocking Secret Service call on a throwaway thread, bounded by
/// [`SERVICE_TIMEOUT`]. The thread is abandoned on timeout rather than joined:
/// a wedged D-Bus call never returns, and the sticky demotion means we stop
/// issuing these calls after the first one gives up.
#[cfg(target_os = "linux")]
const SERVICE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "linux")]
fn service_call<T: Send + 'static>(
    what: &str,
    call: impl FnOnce() -> std::result::Result<T, keyring::Error> + Send + 'static,
) -> std::result::Result<T, ServiceFailure> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("meron-secret-service".into())
        .spawn(move || {
            let _ = sender.send(call());
        })
        .map_err(|error| ServiceFailure::unavailable(format!("spawn keychain thread: {error}")))?;
    match receiver.recv_timeout(SERVICE_TIMEOUT) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(ServiceFailure::from_keyring(what, error)),
        Err(_) => Err(ServiceFailure::unavailable(format!(
            "Secret Service {what} timed out after {}s",
            SERVICE_TIMEOUT.as_secs()
        ))),
    }
}

/// Try the Secret Service, falling back to the oo7 keyring (portal or local
/// file) when there is no usable service. Once demoted, later calls skip the
/// service entirely.
#[cfg(target_os = "linux")]
fn with_service_fallback<T>(
    service: impl FnOnce() -> std::result::Result<T, ServiceFailure>,
    local: impl FnOnce() -> Result<T>,
) -> Result<T> {
    if use_oo7_keyring() {
        return local();
    }
    match service() {
        Ok(value) => Ok(value),
        Err(failure) if failure.unavailable => {
            crate::secrets_portal::force_local(&format!("{:#}", failure.error));
            local()
        }
        Err(failure) => Err(failure.error),
    }
}

/// The SQLCipher key for the local store (64 hex chars = a raw 32-byte key),
/// created and persisted in the OS keychain on first use.
///
/// Returns `Ok(None)` when the keychain is disabled (`MERON_KEYRING=off`,
/// tests/headless), so the store falls back to plaintext exactly as before.
///
/// The key is read like any entry, `oreneta` first and then `meron`, and is
/// moved on that read (ADR-0063). A read error is returned, never taken for
/// a missing key: minting one then would lock the store out.
pub fn db_key() -> Result<Option<String>> {
    if keyring_disabled() {
        return Ok(None);
    }
    match vault_load(&scoped(DB_KEY_ACCOUNT)).context("read db key from keychain")? {
        Some(key) if is_hex_key(&key) => Ok(Some(key)),
        // Missing (first run) or a malformed entry: mint and persist a fresh key.
        Some(_) | None => {
            let key = generate_db_key();
            vault_store(&scoped(DB_KEY_ACCOUNT), &key).context("store db key in keychain")?;
            Ok(Some(key))
        }
    }
}

/// 32 random bytes (two v4 UUIDs' worth) rendered as 64 lowercase hex chars.
fn generate_db_key() -> String {
    use std::fmt::Write;
    let mut hex = String::with_capacity(64);
    for _ in 0..2 {
        for byte in uuid::Uuid::new_v4().as_bytes() {
            let _ = write!(hex, "{byte:02x}");
        }
    }
    hex
}

fn is_hex_key(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether secrets are kept in memory only (`MERON_KEYRING=off`).
pub fn keyring_off() -> bool {
    keyring_disabled()
}

/// Removes this profile's store key: the last step of deleting a profile,
/// after which its store cannot be read again.
pub fn delete_db_key() -> Result<()> {
    if keyring_disabled() {
        return Ok(());
    }
    vault_delete(&scoped(DB_KEY_ACCOUNT))
}

/// Remove an account's secrets from the keychain. A missing entry is not an error.
pub fn delete(account: &str) -> Result<()> {
    if keyring_disabled() {
        off_mode_delete(account);
        return Ok(());
    }
    vault_delete(&scoped(account))
}

#[cfg(test)]
mod profile_tests {
    use super::scoped_for;

    #[test]
    fn the_default_profile_keeps_its_names_and_others_are_kept_apart() {
        assert_eq!(scoped_for(None, "ana@x.cat"), "ana@x.cat");
        assert_eq!(scoped_for(Some("default"), "ana@x.cat"), "ana@x.cat");
        assert_eq!(scoped_for(Some(""), "__meron_db_key__"), "__meron_db_key__");
        assert_eq!(scoped_for(Some("work"), "ana@x.cat"), "profile:work/ana@x.cat");
        assert_ne!(scoped_for(Some("work"), "__meron_db_key__"), scoped_for(Some("home"), "__meron_db_key__"));
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::{
        CHUNK_UTF16, MAX_CHUNKS, chunk_account, fits_in_credential, parse_marker, split_blob,
    };

    #[test]
    fn markers_round_trip_and_plain_blobs_are_not_markers() {
        assert_eq!(parse_marker("meron-chunked:1:4"), Some((1, 4)));
        assert_eq!(parse_marker(r#"{"password":"hunter2"}"#), None);
        assert_eq!(parse_marker("meron-chunked:4"), None);
    }

    #[test]
    fn generations_use_distinct_entries() {
        assert_ne!(
            chunk_account("a@b.com", 0, 0),
            chunk_account("a@b.com", 1, 0)
        );
    }

    #[test]
    fn short_blobs_are_not_chunked() {
        let blob = r#"{"password":"hunter2"}"#;
        assert!(fits_in_credential(blob));
    }

    #[test]
    fn chunks_fit_and_rejoin() {
        // Roughly the size of a Microsoft access + refresh token pair.
        let blob = format!(r#"{{"access_token":"{}"}}"#, "a".repeat(4000));
        assert!(!fits_in_credential(&blob));
        let chunks = split_blob(&blob);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| fits_in_credential(c)));
        assert_eq!(chunks.concat(), blob);
    }

    #[test]
    fn chunk_limit_has_room_for_realistic_secrets() {
        // Far larger than any password plus OAuth pair we store.
        let blob = "a".repeat(20_000);
        assert!(split_blob(&blob).len() <= MAX_CHUNKS);
    }

    #[test]
    fn multi_byte_chars_are_not_split() {
        // Emoji are two UTF-16 units each, so an odd boundary would tear one.
        let blob = "😀".repeat(CHUNK_UTF16);
        let chunks = split_blob(&blob);
        assert!(chunks.iter().all(|c| fits_in_credential(c)));
        assert_eq!(chunks.concat(), blob);
    }
}

#[cfg(test)]
mod off_mode_tests {
    use super::{off_mode_delete, off_mode_load, off_mode_store};

    /// The stand-in keychain behaves like one for the life of the process:
    /// what is stored is read back, replaced on a second store, and gone
    /// after a delete. The environment switch itself is process-wide and is
    /// exercised by the integration suite, which runs with it set.
    #[test]
    fn keyring_off_entries_round_trip_within_the_process() {
        assert_eq!(off_mode_load("off-mode-test"), None);
        off_mode_store("off-mode-test", r#"{"password":"first"}"#);
        assert_eq!(off_mode_load("off-mode-test").as_deref(), Some(r#"{"password":"first"}"#));
        off_mode_store("off-mode-test", r#"{"password":"second"}"#);
        assert_eq!(off_mode_load("off-mode-test").as_deref(), Some(r#"{"password":"second"}"#));
        assert_eq!(off_mode_load("off-mode-other"), None, "entries are per account");
        off_mode_delete("off-mode-test");
        assert_eq!(off_mode_load("off-mode-test"), None);
        off_mode_delete("off-mode-test");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::flatpak_detected;
    use std::ffi::OsStr;

    #[test]
    fn flatpak_detection_does_not_match_native_linux() {
        assert!(!flatpak_detected(None, false));
        assert!(!flatpak_detected(Some(OsStr::new("")), false));
        assert!(flatpak_detected(
            Some(OsStr::new("jp.nonbili.meron")),
            false
        ));
        assert!(flatpak_detected(None, true));
    }
}
