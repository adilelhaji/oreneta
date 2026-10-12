//! Importing from Thunderbird (ADR-0041).
//!
//! Thunderbird keeps each folder as an mbox file with no extension, beside
//! its `.msf` index, and a folder's subfolders in `<name>.sbd/`. Local
//! Folders and POP accounts live under `Mail/`, copies of IMAP accounts
//! under `ImapMail/`. This finds them, reads them as mbox and hands them to
//! the local archive (ADR-0014), which skips what is already there.
//!
//! A message Thunderbird deleted but has not yet compacted away is still in
//! the file, marked `X-Mozilla-Status` 0x0008; it is left out, never brought
//! back. Nothing in the Thunderbird profile is changed.

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A Thunderbird profile found on this computer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Profile {
    pub name: String,
    pub path: String,
}

/// One Thunderbird folder file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Folder {
    /// Stable within one scan: the file's path relative to the scanned root.
    pub id: String,
    /// The Thunderbird account folder: "Local Folders", a server name...
    pub account: String,
    /// The folder's names from the account down, e.g. ["Inbox", "Work"].
    pub path: Vec<String>,
    pub bytes: u64,
    /// A copy Thunderbird keeps of an IMAP account; the mail is also on the
    /// server, and the copy may be partial.
    pub imap_copy: bool,
}

/// Where Thunderbird keeps its profiles list, for each platform.
pub fn profile_roots(home: &Path, appdata: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![
        home.join(".thunderbird"),
        home.join(".var/app/org.mozilla.Thunderbird/.thunderbird"),
        home.join("snap/thunderbird/common/.thunderbird"),
        home.join("Library/Thunderbird"),
    ];
    if let Some(appdata) = appdata {
        roots.insert(0, appdata.join("Thunderbird"));
    }
    roots
}

/// The profiles listed in each root's `profiles.ini` that exist on disk.
pub fn profiles(roots: &[PathBuf]) -> Vec<Profile> {
    let mut found = Vec::new();
    for root in roots {
        let Ok(ini) = std::fs::read_to_string(root.join("profiles.ini")) else { continue };
        let mut name = String::new();
        let mut path = String::new();
        let mut relative = true;
        let mut flush = |name: &mut String, path: &mut String, relative: bool| {
            if !path.is_empty() {
                let full = if relative { root.join(path.replace('\\', "/")) } else { PathBuf::from(&*path) };
                if full.is_dir() {
                    let shown = if name.is_empty() { path.clone() } else { name.clone() };
                    found.push(Profile { name: shown, path: full.to_string_lossy().into_owned() });
                }
            }
            name.clear();
            path.clear();
        };
        for line in ini.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                flush(&mut name, &mut path, relative);
                relative = true;
            } else if let Some(value) = line.strip_prefix("Name=") {
                name = value.to_string();
            } else if let Some(value) = line.strip_prefix("Path=") {
                path = value.to_string();
            } else if let Some(value) = line.strip_prefix("IsRelative=") {
                relative = value != "0";
            }
        }
        flush(&mut name, &mut path, relative);
    }
    found.dedup_by(|a, b| a.path == b.path);
    found
}

/// Files Thunderbird keeps beside its folders that are not mail.
fn not_mail(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || [".msf", ".dat", ".json", ".html", ".sqlite", ".log", ".mab", ".txt", ".js", ".sbd"]
            .iter()
            .any(|ext| lower.ends_with(ext))
        || matches!(name, "msgFilterRules" | "popstate" | "filterlog" | "junklog")
}

fn starts_like_mbox(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 5];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"From "
}

/// Every folder file under a profile, or under a folder the person chose
/// (an account's directory or a `.sbd`). Empty files are left out.
pub fn scan(root: &Path) -> Result<Vec<Folder>> {
    if !root.is_dir() {
        bail!("{} is not a folder", root.display());
    }
    let mut folders = Vec::new();
    let mut accounts: Vec<(PathBuf, String, bool)> = Vec::new();
    for (sub, imap) in [("Mail", false), ("ImapMail", true)] {
        let dir = root.join(sub);
        if let Ok(read) = std::fs::read_dir(&dir) {
            let mut names: Vec<_> = read.flatten().filter(|e| e.path().is_dir()).collect();
            names.sort_by_key(|e| e.file_name());
            for entry in names {
                accounts.push((entry.path(), entry.file_name().to_string_lossy().into_owned(), imap));
            }
        }
    }
    if accounts.is_empty() {
        // A folder chosen by hand: read it as one account.
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        accounts.push((root.to_path_buf(), name.trim_end_matches(".sbd").to_string(), false));
    }
    for (dir, account, imap) in accounts {
        walk(root, &dir, &account, imap, &mut Vec::new(), &mut folders)?;
    }
    Ok(folders)
}

fn walk(
    root: &Path,
    dir: &Path,
    account: &str,
    imap: bool,
    parents: &mut Vec<String>,
    out: &mut Vec<Folder>,
) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || not_mail(&name) || meta.len() == 0 {
            continue;
        }
        let indexed = dir.join(format!("{name}.msf")).exists();
        if !indexed && !starts_like_mbox(&path) {
            continue;
        }
        let mut names = parents.clone();
        names.push(name.clone());
        out.push(Folder {
            id: path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/"),
            account: account.to_string(),
            path: names,
            bytes: meta.len(),
            imap_copy: imap,
        });
    }
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(folder) = name.strip_suffix(".sbd") {
            if entry.path().is_dir() {
                parents.push(folder.to_string());
                walk(root, &entry.path(), account, imap, parents, out)?;
                parents.pop();
            }
        }
    }
    Ok(())
}

/// Whether Thunderbird marked a message deleted (0x0008) and has not yet
/// compacted the folder.
pub fn expunged(raw: &[u8]) -> bool {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").or_else(|| raw.windows(2).position(|w| w == b"\n\n"));
    let head = &raw[..end.unwrap_or(raw.len())];
    for line in head.split(|&b| b == b'\n') {
        let line = String::from_utf8_lossy(line);
        let line = line.trim_end();
        if let Some(value) = line.strip_prefix("X-Mozilla-Status:").map(str::trim) {
            if let Ok(flags) = u32::from_str_radix(value, 16) {
                return flags & 0x0008 != 0;
            }
        }
    }
    false
}

/// The messages kept in one folder file, and how many were deleted in
/// Thunderbird but still in the file.
pub fn read_folder(file: &Path) -> Result<(Vec<Vec<u8>>, usize)> {
    let size = std::fs::metadata(file).with_context(|| format!("read {}", file.display()))?.len();
    if size > crate::archive::MAX_FILE_BYTES {
        bail!("{} is larger than 1 GB; compact it in Thunderbird or split it first", file.display());
    }
    let bytes = std::fs::read(file).with_context(|| format!("read {}", file.display()))?;
    let (kept, gone): (Vec<_>, Vec<_>) = crate::archive::split_mbox(&bytes).into_iter().partition(|m| !expunged(m));
    Ok((kept, gone.len()))
}

/// The archive folder a Thunderbird folder goes to: under `root`, then the
/// Thunderbird account, then its folder names. `/` separates levels, so a
/// slash inside a name becomes a dash.
pub fn target_folder(root: &str, folder: &Folder) -> String {
    let mut parts = vec![root.trim().trim_matches('/').to_string(), folder.account.clone()];
    parts.extend(folder.path.iter().cloned());
    parts
        .into_iter()
        .map(|p| p.replace('/', "-").trim().to_string())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests;
