//! The full-profile archive (#171, ADR-0010, ADR-0017).
//!
//! One file holds everything in a profile that cannot be fetched again: the
//! whole store (mail cached or archived locally, drafts with their
//! attachments, contacts, tasks, notes, settings, send attempts) and the
//! pictures the person chose (account and board avatars, wallpapers).
//! Encryption is age with a passphrase (scrypt, then the STREAM
//! construction), so files of any size are written and read in one pass and
//! no cipher is composed here.
//!
//! Inside the encrypted stream: a magic line, then the entries, then the
//! manifest, then an end mark. The manifest comes last so each entry is
//! hashed while it is written; reading checks every entry against it. The
//! store inside is not this computer's: it is an export under a key made for
//! the archive and kept in the manifest, so the archive opens with its
//! passphrase alone, without the original keychain.
//!
//! What is left out is named in the manifest, never silently dropped.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};

use age::secrecy::SecretString;
use anyhow::{Context, Result, bail, ensure};
use ring::digest::{Context as Digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "oreneta-profile";
pub const VERSION: u32 = 1;
pub const EXTENSION: &str = "oreneta-profile";
const MAGIC: &[u8] = b"ORENETA-PROFILE 1\n";

/// scrypt cost written into new archives: N = 2^18 (256 MiB, about a second).
/// Fixed, so an archive made on a fast computer still opens on a slow one.
pub const WORK_FACTOR: u8 = 18;
/// The most an archive may ask for before its passphrase is checked: the
/// cost is read from the file, so it is bounded (N = 2^20, 1 GiB).
const MAX_WORK_FACTOR: u8 = 20;

pub const MAX_ENTRY_BYTES: u64 = 4 << 30;
pub const MAX_ENTRIES: usize = 200_000;
const MAX_PATH_BYTES: usize = 512;
const MAX_MANIFEST_BYTES: u32 = 64 << 20;

/// Where the store sits inside the archive.
pub const DB_ENTRY: &str = "db/meron.db";
/// Media folders the person filled; the rest of the media folder is a cache.
pub const KEPT_MEDIA: &[&str] = &["avatars", "wallpapers"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exclusion {
    pub what: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub created_at: i64,
    #[serde(default)]
    pub app_version: String,
    pub schema_version: i64,
    /// The key the store inside was exported under (64 hex characters).
    pub db_key: String,
    pub entries: Vec<Entry>,
    pub excluded: Vec<Exclusion>,
}

/// What the person is told about an archive; the store key stays inside.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub created_at: i64,
    pub app_version: String,
    pub schema_version: i64,
    pub entries: usize,
    pub bytes: u64,
    pub accounts: i64,
    pub messages: i64,
    pub excluded: Vec<Exclusion>,
}

pub fn exclusions() -> Vec<Exclusion> {
    let item = |what: &str, why: &str| Exclusion { what: what.into(), why: why.into() };
    vec![
        item("attachment cache", "downloaded again from the mail servers when opened"),
        item("passwords, sign-in grants and private keys", "kept in the system keychain; each account is reconnected after a restore"),
        item("window layout and open message tabs", "kept by the window; drafts themselves are in the store"),
        item("diagnostic log", "describes this computer, not the profile"),
    ]
}

fn random_key() -> Result<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| anyhow::anyhow!("no randomness for the archive key"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn quote(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// A consistent copy of the store under a new key: `sqlcipher_export` runs as
/// one statement, so it reads one snapshot even while sync keeps writing.
pub fn snapshot(conn: &Connection, dest: &Path, key: &str) -> Result<()> {
    let _ = std::fs::remove_file(dest);
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{}' AS profile_snapshot KEY \"x'{key}'\";",
        quote(dest)
    ))
    .context("open the snapshot")?;
    let exported = conn
        .execute_batch(&format!(
            "SELECT sqlcipher_export('profile_snapshot');
             PRAGMA profile_snapshot.user_version = {version};
             DELETE FROM profile_snapshot.account_secrets;"
        ))
        .context("copy the store");
    conn.execute_batch("DETACH DATABASE profile_snapshot;").context("close the snapshot")?;
    exported
}

/// Media files to keep, as (archive path, file on disk), in a stable order.
fn kept_media(media_root: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut found = Vec::new();
    for folder in KEPT_MEDIA {
        let mut stack = vec![media_root.join(folder)];
        while let Some(dir) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else { continue };
            for item in read {
                let item = item?;
                let kind = item.file_type()?;
                if kind.is_dir() {
                    stack.push(item.path());
                } else if kind.is_file() {
                    let relative = item.path().strip_prefix(media_root)?.to_path_buf();
                    let name = relative
                        .components()
                        .map(|part| part.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/");
                    found.push((format!("media/{name}"), item.path()));
                }
            }
        }
    }
    found.sort();
    Ok(found)
}

fn write_entry(out: &mut impl Write, path: &str, file: &Path) -> Result<Entry> {
    let mut input = File::open(file).with_context(|| format!("read {}", file.display()))?;
    let size = input.metadata()?.len();
    ensure!(size <= MAX_ENTRY_BYTES, "{path} is larger than an archive entry may be");
    out.write_all(b"E")?;
    out.write_all(&(path.len() as u16).to_be_bytes())?;
    out.write_all(path.as_bytes())?;
    out.write_all(&size.to_be_bytes())?;
    let mut digest = Digest::new(&SHA256);
    let mut buf = vec![0u8; 1 << 20];
    let mut left = size;
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = input.read(&mut buf[..want])?;
        ensure!(n > 0, "{} changed while it was being archived", file.display());
        digest.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        left -= n as u64;
    }
    Ok(Entry { path: path.into(), size, sha256: hex(digest.finish().as_ref()) })
}

pub struct ExportOptions<'a> {
    pub media_root: &'a Path,
    /// A private folder for the store snapshot, removed afterwards.
    pub work_dir: &'a Path,
    pub app_version: &'a str,
    pub now: i64,
    pub work_factor: u8,
}

/// Counts read from the store when it was copied.
#[derive(Debug, Clone, Copy, Default)]
pub struct Snapshot {
    pub schema_version: i64,
    pub accounts: i64,
    pub messages: i64,
}

/// Copies the store to `dest` under `key` and reports what it holds. The
/// caller holds the store only for this step, not while the file is packed.
pub fn take_snapshot(conn: &Connection, dest: &Path, key: &str) -> Result<Snapshot> {
    snapshot(conn, dest, key)?;
    Ok(Snapshot {
        schema_version: conn.query_row("PRAGMA user_version", [], |r| r.get(0))?,
        accounts: conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap_or(0),
        messages: conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap_or(0),
    })
}

/// Writes the archive to `dest`. It is written beside it first and renamed
/// into place when complete, so a failure leaves any earlier file whole.
pub fn export(conn: &Connection, dest: &Path, passphrase: &str, options: &ExportOptions) -> Result<Summary> {
    export_with(|path, key| take_snapshot(conn, path, key), dest, passphrase, options)
}

pub fn export_with(
    copy_store: impl FnOnce(&Path, &str) -> Result<Snapshot>,
    dest: &Path,
    passphrase: &str,
    options: &ExportOptions,
) -> Result<Summary> {
    ensure!(passphrase.chars().count() >= 8, "the passphrase needs at least 8 characters");
    std::fs::create_dir_all(options.work_dir)?;
    let snapshot_path = options.work_dir.join(format!("snapshot-{}.db", uuid::Uuid::new_v4()));
    let partial = dest.with_extension(format!("{EXTENSION}.part"));
    let result = (|| -> Result<Summary> {
        let db_key = random_key()?;
        let Snapshot { schema_version, accounts, messages } = copy_store(&snapshot_path, &db_key)?;

        let mut recipient = age::scrypt::Recipient::new(SecretString::from(passphrase.to_owned()));
        recipient.set_work_factor(options.work_factor);
        let encryptor = age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let file = File::create(&partial).with_context(|| format!("create {}", partial.display()))?;
        let mut stream = encryptor.wrap_output(BufWriter::new(file))?;
        stream.write_all(MAGIC)?;
        let mut entries = vec![write_entry(&mut stream, DB_ENTRY, &snapshot_path)?];
        for (path, file) in kept_media(options.media_root)? {
            entries.push(write_entry(&mut stream, &path, &file)?);
        }
        let manifest = Manifest {
            format: FORMAT.into(),
            version: VERSION,
            created_at: options.now,
            app_version: options.app_version.into(),
            schema_version,
            db_key,
            entries,
            excluded: exclusions(),
        };
        let json = serde_json::to_vec(&manifest)?;
        stream.write_all(b"M")?;
        stream.write_all(&(json.len() as u32).to_be_bytes())?;
        stream.write_all(&json)?;
        stream.write_all(b"Z")?;
        let file = stream.finish()?.into_inner().map_err(|error| error.into_error())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&partial, dest).with_context(|| format!("finish {}", dest.display()))?;
        Ok(Summary {
            created_at: manifest.created_at,
            app_version: manifest.app_version,
            schema_version,
            entries: manifest.entries.len(),
            bytes: manifest.entries.iter().map(|e| e.size).sum(),
            accounts,
            messages,
            excluded: manifest.excluded,
        })
    })();
    let _ = std::fs::remove_file(&snapshot_path);
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// An archive path is relative, has no `..`, no drive or root, and lives
/// under one of the two folders an archive may write.
fn safe_path(path: &str) -> Result<PathBuf> {
    ensure!(!path.is_empty() && path.len() <= MAX_PATH_BYTES, "an archive entry has an invalid name");
    ensure!(!path.contains('\\') && !path.contains(':') && !path.contains('\0'), "an archive entry has an invalid name: {path}");
    ensure!(path == DB_ENTRY || path.starts_with("media/"), "an archive entry is outside the profile: {path}");
    // Canonical names only: one spelling per file, so a repeat is caught.
    ensure!(
        path.split('/').all(|part| !part.is_empty() && part != "." && part != ".."),
        "an archive entry is outside the profile: {path}"
    );
    let relative = PathBuf::from(path);
    for part in relative.components() {
        match part {
            Component::Normal(name) if !name.is_empty() => {}
            _ => bail!("an archive entry is outside the profile: {path}"),
        }
    }
    Ok(relative)
}

fn read_exact_or(input: &mut impl Read, buf: &mut [u8], what: &str) -> Result<()> {
    input.read_exact(buf).with_context(|| format!("the archive is cut short ({what})"))
}

fn decrypt_error(error: age::DecryptError) -> anyhow::Error {
    match error {
        age::DecryptError::NoMatchingKeys
        | age::DecryptError::DecryptionFailed
        | age::DecryptError::KeyDecryptionFailed => {
            anyhow::anyhow!("wrong passphrase, or not an Oreneta profile archive")
        }
        age::DecryptError::ExcessiveWork { .. } => anyhow::anyhow!("this archive asks for more work than allowed"),
        other => anyhow::anyhow!("not a readable profile archive: {other}"),
    }
}

/// Unpacks and checks an archive into `staging`, an empty private folder.
/// Nothing outside it is touched. Returns the manifest once every entry
/// matches it and the store inside opens, passes SQLite's integrity check and
/// is not from a newer version than this one.
pub fn stage(archive: &Path, passphrase: &str, staging: &Path) -> Result<Manifest> {
    let file = File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let decryptor = age::Decryptor::new_buffered(BufReader::new(file)).map_err(decrypt_error)?;
    ensure!(decryptor.is_scrypt(), "not an Oreneta profile archive");
    let mut identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    identity.set_max_work_factor(MAX_WORK_FACTOR);
    let mut input = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(decrypt_error)?;

    let mut magic = vec![0u8; MAGIC.len()];
    input.read_exact(&mut magic).context("not an Oreneta profile archive")?;
    ensure!(magic == MAGIC, "not an Oreneta profile archive, or one from a newer version");

    std::fs::create_dir_all(staging)?;
    let mut seen = HashSet::new();
    let mut written: Vec<Entry> = Vec::new();
    let manifest: Manifest = loop {
        let mut tag = [0u8; 1];
        read_exact_or(&mut input, &mut tag, "entry")?;
        match tag[0] {
            b'E' => {
                ensure!(written.len() < MAX_ENTRIES, "the archive has too many entries");
                let mut len = [0u8; 2];
                read_exact_or(&mut input, &mut len, "name")?;
                let mut name = vec![0u8; u16::from_be_bytes(len) as usize];
                read_exact_or(&mut input, &mut name, "name")?;
                let path = String::from_utf8(name).context("an archive entry has an invalid name")?;
                let relative = safe_path(&path)?;
                ensure!(seen.insert(path.clone()), "the archive repeats {path}");
                let mut size = [0u8; 8];
                read_exact_or(&mut input, &mut size, "size")?;
                let size = u64::from_be_bytes(size);
                ensure!(size <= MAX_ENTRY_BYTES, "{path} is larger than an archive entry may be");
                let target = staging.join(&relative);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut out = BufWriter::new(File::create(&target)?);
                let mut digest = Digest::new(&SHA256);
                let mut buf = vec![0u8; 1 << 20];
                let mut left = size;
                while left > 0 {
                    let want = left.min(buf.len() as u64) as usize;
                    read_exact_or(&mut input, &mut buf[..want], &path)?;
                    digest.update(&buf[..want]);
                    out.write_all(&buf[..want])?;
                    left -= want as u64;
                }
                out.flush()?;
                written.push(Entry { path, size, sha256: hex(digest.finish().as_ref()) });
            }
            b'M' => {
                let mut len = [0u8; 4];
                read_exact_or(&mut input, &mut len, "manifest")?;
                let len = u32::from_be_bytes(len);
                ensure!(len <= MAX_MANIFEST_BYTES, "the archive manifest is too large");
                let mut json = vec![0u8; len as usize];
                read_exact_or(&mut input, &mut json, "manifest")?;
                break serde_json::from_slice(&json).context("the archive manifest is damaged")?;
            }
            _ => bail!("the archive is damaged"),
        }
    };
    let mut end = [0u8; 1];
    read_exact_or(&mut input, &mut end, "end")?;
    ensure!(end == *b"Z", "the archive is damaged");
    let mut rest = [0u8; 1];
    ensure!(input.read(&mut rest)? == 0, "the archive has data after its end");

    ensure!(manifest.format == FORMAT, "not an Oreneta profile archive");
    ensure!(manifest.version <= VERSION, "this archive was made by a newer version of Oreneta");
    ensure!(manifest.entries == written, "the archive does not match its own manifest");
    ensure!(
        manifest.db_key.len() == 64 && manifest.db_key.bytes().all(|b| b.is_ascii_hexdigit()),
        "the archive manifest is damaged"
    );
    ensure!(
        manifest.schema_version <= crate::store::SCHEMA_VERSION,
        "this archive was made by a newer version of Oreneta"
    );

    let db = Connection::open(staging.join(DB_ENTRY))?;
    db.execute_batch(&format!("PRAGMA key = \"x'{}'\";", manifest.db_key))?;
    let check: String = db
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .context("the store in the archive does not open")?;
    ensure!(check == "ok", "the store in the archive is damaged: {check}");
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(version == manifest.schema_version, "the archive does not match its own manifest");
    Ok(manifest)
}

/// What an archive holds, read from a staged copy.
pub fn summary(manifest: &Manifest, staging: &Path) -> Result<Summary> {
    let db = Connection::open(staging.join(DB_ENTRY))?;
    db.execute_batch(&format!("PRAGMA key = \"x'{}'\";", manifest.db_key))?;
    let accounts: i64 = db.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap_or(0);
    let messages: i64 = db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap_or(0);
    Ok(Summary {
        created_at: manifest.created_at,
        app_version: manifest.app_version.clone(),
        schema_version: manifest.schema_version,
        entries: manifest.entries.len(),
        bytes: manifest.entries.iter().map(|e| e.size).sum(),
        accounts,
        messages,
        excluded: manifest.excluded.clone(),
    })
}

/// Where a restore waits, checked and ready, inside the profile folder.
pub const STAGING_DIR: &str = "restore-staging";
pub const READY_DIR: &str = "ready";
pub const READY_FILE: &str = "READY.json";
pub const RESTORED_DB: &str = "meron.db";

/// Unpacks and checks an archive, then makes it ready to take the place of
/// the store in use (#172): the store is re-keyed to this computer's key
/// (`None` where the store is not encrypted), every account is paused so
/// nothing syncs until the person reconnects it, and scheduled sends are
/// held so none goes out on its own. The profile in use is not touched;
/// activating it is the bridge's step, with the core stopped.
pub fn prepare_restore(archive: &Path, passphrase: &str, profile_dir: &Path, machine_key: Option<&str>, now: i64) -> Result<Summary> {
    let root = profile_dir.join(STAGING_DIR);
    let work = root.join("work");
    let ready = root.join(READY_DIR);
    let _ = std::fs::remove_dir_all(&work);
    let _ = std::fs::remove_dir_all(&ready);
    let result = (|| -> Result<Summary> {
        let manifest = stage(archive, passphrase, &work)?;
        let described = summary(&manifest, &work)?;
        let restored = work.join(RESTORED_DB);
        {
            let source = Connection::open(work.join(DB_ENTRY))?;
            source.execute_batch(&format!("PRAGMA key = \"x'{}'\";", manifest.db_key))?;
            let key = match machine_key {
                Some(key) => format!("\"x'{key}'\""),
                None => "''".to_string(),
            };
            source.execute_batch(&format!(
                "ATTACH DATABASE '{}' AS restored KEY {key};
                 SELECT sqlcipher_export('restored');
                 PRAGMA restored.user_version = {};
                 DETACH DATABASE restored;",
                quote(&restored),
                manifest.schema_version
            ))?;
        }
        std::fs::remove_dir_all(work.join("db"))?;
        let conn = Connection::open(&restored)?;
        if let Some(key) = machine_key {
            conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
        }
        hold_restored(&conn)?;
        drop(conn);
        std::fs::write(
            work.join(READY_FILE),
            serde_json::to_vec(&serde_json::json!({ "prepared_at": now, "summary": &described }))?,
        )?;
        std::fs::rename(&work, &ready)?;
        Ok(described)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&work);
    }
    result
}

/// A restored profile does nothing on its own (ADR-0010): accounts stay
/// paused until reconnected, and no scheduled message is sent by itself.
pub fn hold_restored(conn: &Connection) -> Result<()> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM accounts")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in ids {
        crate::store::set_account_pref(conn, &id, "paused", true)?;
    }
    conn.execute(
        "UPDATE scheduled_sends SET attempts = ?1, last_error = ?2 WHERE attempts < ?1",
        rusqlite::params![
            crate::store::MAX_SEND_ATTEMPTS,
            "restored from a profile archive, so this was not sent on its own"
        ],
    )?;
    conn.execute("DELETE FROM account_secrets", [])?;
    Ok(())
}

#[cfg(test)]
mod tests;
