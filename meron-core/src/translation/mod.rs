//! Translation models (#106, ADR-0031).
//!
//! Translation itself runs in the app, in Bergamot's WebAssembly; this module
//! owns the models it needs. Which models exist, where they come from and what
//! each file must hash to is fixed in the registry shipped with the app, so a
//! download can only ever be one of those files, checked byte for byte. A
//! model is fetched only when the person asks for that language, after seeing
//! its size; once here it is used without the network.
//!
//! A download is written to a staging folder and moved into place only when
//! every file has the right size and hash, so an interrupted, cancelled or
//! damaged download leaves nothing that looks installed.

use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// Mozilla's production models (MPL-2.0), as published for Bergamot 0.3.3.
/// Only the models Firefox shipped as production quality are offered.
pub const BASE_URL: &str = "https://storage.googleapis.com/bergamot-models-sandbox/0.3.3/";
const REGISTRY: &str = include_str!("registry.json");

/// The language every model translates to or from: other pairs go through it.
pub const PIVOT: &str = "en";

/// Models may take this much disk in total unless the person allows more.
pub const DEFAULT_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelFile {
    /// What the file is to Bergamot: `model`, `lex`, `vocab`, `srcvocab`, `trgvocab`.
    pub part: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Pair {
    pub from: String,
    pub to: String,
    pub files: Vec<ModelFile>,
}

impl Pair {
    pub fn key(&self) -> String {
        format!("{}{}", self.from, self.to)
    }
    pub fn size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

pub fn registry() -> &'static [Pair] {
    static PAIRS: OnceLock<Vec<Pair>> = OnceLock::new();
    PAIRS.get_or_init(|| parse_registry(REGISTRY).expect("the bundled registry reads"))
}

fn parse_registry(text: &str) -> Result<Vec<Pair>> {
    let raw: BTreeMap<String, BTreeMap<String, serde_json::Value>> = serde_json::from_str(text)?;
    raw.into_iter()
        .map(|(key, parts)| {
            anyhow::ensure!(key.len() == 4 && key.is_ascii(), "pair {key}");
            let files = parts
                .into_iter()
                .map(|(part, file)| {
                    let name = file["name"].as_str().context("name")?.to_string();
                    let sha256 = file["expectedSha256Hash"].as_str().context("hash")?.to_string();
                    anyhow::ensure!(
                        !name.contains(['/', '\\']) && !name.starts_with('.'),
                        "file name {name}"
                    );
                    anyhow::ensure!(sha256.len() == 64, "hash of {name}");
                    Ok(ModelFile {
                        part,
                        name,
                        size: file["size"].as_u64().context("size")?,
                        sha256,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Pair {
                from: key[..2].to_string(),
                to: key[2..].to_string(),
                files,
            })
        })
        .collect()
}

pub fn pair(from: &str, to: &str) -> Option<&'static Pair> {
    registry().iter().find(|p| p.from == from && p.to == to)
}

/// Every language a model exists for, English included.
pub fn languages() -> Vec<String> {
    let mut all: Vec<String> = registry().iter().flat_map(|p| [p.from.clone(), p.to.clone()]).collect();
    all.sort();
    all.dedup();
    all
}

/// The models a translation needs, in order: one, or two through English.
pub fn route(from: &str, to: &str) -> Result<Vec<&'static Pair>, String> {
    if from == to {
        return Err(format!("{from} to {to}: nothing to translate"));
    }
    if let Some(direct) = pair(from, to) {
        return Ok(vec![direct]);
    }
    match (pair(from, PIVOT), pair(PIVOT, to)) {
        (Some(a), Some(b)) => Ok(vec![a, b]),
        _ => Err(format!("no model translates {from} to {to}")),
    }
}

/// Where models live: shared by every profile, like the app's own files.
pub fn models_dir() -> PathBuf {
    std::env::var_os("MERON_MODELS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::store::app_dir().join("translation-models"))
}

/// Installed means moved into place after every file checked out, and still
/// the size it was then.
pub fn installed(dir: &Path, pair: &Pair) -> bool {
    let root = dir.join(pair.key());
    pair.files.iter().all(|f| std::fs::metadata(root.join(&f.name)).is_ok_and(|m| m.len() == f.size))
}

#[derive(Debug, Clone, Serialize)]
pub struct PairStatus {
    #[serde(flatten)]
    pub pair: Pair,
    pub size: u64,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub pairs: Vec<PairStatus>,
    pub languages: Vec<String>,
    pub used: u64,
    pub quota: u64,
    pub source: &'static str,
}

pub fn status(dir: &Path, quota: u64) -> Status {
    let pairs: Vec<PairStatus> = registry()
        .iter()
        .map(|p| PairStatus {
            pair: p.clone(),
            size: p.size(),
            installed: installed(dir, p),
        })
        .collect();
    let used = pairs.iter().filter(|p| p.installed).map(|p| p.size).sum();
    Status {
        pairs,
        languages: languages(),
        used,
        quota,
        source: BASE_URL,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DownloadError {
    Unsupported,
    Cancelled,
    /// Installing would take models past the space allowed for them.
    Quota { needed: u64, allowed: u64 },
    /// The disk filled up while writing.
    DiskFull,
    /// A file came back a different size or with a different hash than the
    /// registry says: never used.
    Integrity { file: String },
    Network { message: String },
    Disk { message: String },
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => write!(f, "there is no such model"),
            Self::Cancelled => write!(f, "the download was cancelled"),
            Self::Quota { needed, allowed } => {
                write!(f, "models would need {needed} bytes; {allowed} are allowed")
            }
            Self::DiskFull => write!(f, "the disk is full"),
            Self::Integrity { file } => write!(f, "{file} did not match the published model"),
            Self::Network { message } => write!(f, "the model could not be fetched: {message}"),
            Self::Disk { message } => write!(f, "the model could not be saved: {message}"),
        }
    }
}

impl std::error::Error for DownloadError {}

fn disk_error(err: std::io::Error) -> DownloadError {
    match err.kind() {
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => DownloadError::DiskFull,
        _ => DownloadError::Disk {
            message: err.to_string(),
        },
    }
}

/// Where the bytes come from: the network in the app, memory in tests.
pub trait Source {
    fn open(&self, url: &str) -> std::result::Result<Box<dyn Read + Send>, String>;
}

/// Fetches through the app's proxy settings, like every other download.
pub struct Http;

impl Source for Http {
    fn open(&self, url: &str) -> std::result::Result<Box<dyn Read + Send>, String> {
        let agent = crate::proxy::agent().map_err(|e| e.to_string())?;
        let response = agent.get(url).call().map_err(|e| e.to_string())?;
        Ok(Box::new(response.into_body().into_reader()))
    }
}

const CHUNK: usize = 64 * 1024;

fn staging(dir: &Path, pair: &Pair) -> PathBuf {
    dir.join(format!(".{}.part", pair.key()))
}

/// Downloads a pair's files, checks each against the registry and only then
/// puts the model in place. `progress` is told the bytes done so far and the
/// total. A cancelled or failed download leaves no partial model behind.
pub fn download(
    dir: &Path,
    pair: &Pair,
    source: &dyn Source,
    cancel: &AtomicBool,
    quota: u64,
    progress: &mut dyn FnMut(u64, u64),
) -> std::result::Result<(), DownloadError> {
    let total = pair.size();
    let others: u64 = registry()
        .iter()
        .filter(|p| *p != pair && installed(dir, p))
        .map(Pair::size)
        .sum();
    if others + total > quota {
        return Err(DownloadError::Quota {
            needed: others + total,
            allowed: quota,
        });
    }
    let stage = staging(dir, pair);
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(disk_error)?;
    let result = fetch_all(&stage, pair, source, cancel, total, progress).and_then(|()| {
        let target = dir.join(pair.key());
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&stage, &target).map_err(disk_error)
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

fn fetch_all(
    stage: &Path,
    pair: &Pair,
    source: &dyn Source,
    cancel: &AtomicBool,
    total: u64,
    progress: &mut dyn FnMut(u64, u64),
) -> std::result::Result<(), DownloadError> {
    let mut done = 0u64;
    progress(done, total);
    for file in &pair.files {
        if cancel.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }
        let url = format!("{BASE_URL}{}/{}", pair.key(), file.name);
        let mut reader = source.open(&url).map_err(|message| DownloadError::Network { message })?;
        let mut out = std::fs::File::create(stage.join(&file.name)).map_err(disk_error)?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(DownloadError::Cancelled);
            }
            let n = reader.read(&mut buf).map_err(|e| DownloadError::Network {
                message: e.to_string(),
            })?;
            if n == 0 {
                break;
            }
            written += n as u64;
            // More than the registry says is never right; stop reading it.
            if written > file.size {
                return Err(DownloadError::Integrity {
                    file: file.name.clone(),
                });
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(disk_error)?;
            done += n as u64;
            progress(done, total);
        }
        out.sync_all().map_err(disk_error)?;
        let hash: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if written != file.size || hash != file.sha256 {
            return Err(DownloadError::Integrity {
                file: file.name.clone(),
            });
        }
    }
    Ok(())
}

pub fn remove(dir: &Path, pair: &Pair) -> Result<()> {
    let target = dir.join(pair.key());
    if target.exists() {
        std::fs::remove_dir_all(&target).with_context(|| format!("removing {}", pair.key()))?;
    }
    Ok(())
}

/// Removes what an interrupted download left, at startup.
pub fn clean_partial(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name.ends_with(".part") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests;
