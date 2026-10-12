//! Scheduled profile backups (#173, ADR-0010, ADR-0037).
//!
//! Off until the person turns it on, chooses a folder and gives a password,
//! which stays in the system keychain. Each run writes a full-profile archive
//! (#171) and then opens it the way a check does; only an archive that
//! passes counts. What is promised:
//! - the newest verified backup is never deleted, whatever the retention
//!   limits say and however later runs fail;
//! - only files this schedule wrote and verified are ever deleted, and only
//!   while they are still the size they were written at; nothing else in
//!   the folder is touched, and the folder cannot be inside the profile;
//! - a manual and a scheduled backup never write at the same time;
//! - a run missed while the app was closed happens once, soon after it
//!   opens, and a failed run is tried again an hour later, not in a loop.

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS backup_schedule (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    folder TEXT NOT NULL DEFAULT '',
    every_hours INTEGER NOT NULL DEFAULT 24,
    keep INTEGER NOT NULL DEFAULT 7,
    max_bytes INTEGER,
    last_attempt INTEGER,
    last_success INTEGER,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS scheduled_backups (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0
);
";

/// The keychain entry holding the schedule's archive password.
pub const SECRET_KEY: &str = "__oreneta_backup_schedule__";
/// File names this schedule writes, and the only ones it ever removes.
pub const PREFIX: &str = "oreneta-scheduled-";
/// The full-profile archive's extension (#171).
const EXTENSION: &str = "oreneta-profile";
/// How long after a failed run the next one is tried.
pub const RETRY_SECONDS: i64 = 3600;
pub const MIN_HOURS: i64 = 6;
pub const MAX_HOURS: i64 = 24 * 30;
pub const MAX_KEEP: i64 = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Schedule {
    pub enabled: bool,
    pub folder: String,
    pub every_hours: i64,
    pub keep: i64,
    /// Total size the kept backups may use. The newest verified one is kept
    /// even when it alone is over.
    pub max_bytes: Option<u64>,
}

impl Default for Schedule {
    fn default() -> Self {
        Schedule { enabled: false, folder: String::new(), every_hours: 24, keep: 7, max_bytes: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Kept {
    pub path: String,
    pub created_at: i64,
    pub bytes: u64,
    pub verified: bool,
    /// False when the file is no longer where it was written.
    pub present: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub schedule: Schedule,
    pub last_attempt: Option<i64>,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
    pub next_run: Option<i64>,
    pub backups: Vec<Kept>,
}

/// Held while any profile archive is written, manual or scheduled.
static CAPTURE: Mutex<()> = Mutex::new(());

/// Taken by a manual backup; a scheduled run waits for its next turn.
pub fn capture_lock() -> Result<std::sync::MutexGuard<'static, ()>> {
    match CAPTURE.try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => {
            bail!("another backup is being written; try again when it finishes")
        }
    }
}

pub fn load(conn: &Connection) -> Result<Schedule> {
    Ok(conn
        .query_row(
            "SELECT enabled, folder, every_hours, keep, max_bytes FROM backup_schedule WHERE id = 1",
            [],
            |r| {
                Ok(Schedule {
                    enabled: r.get::<_, i64>(0)? != 0,
                    folder: r.get(1)?,
                    every_hours: r.get(2)?,
                    keep: r.get(3)?,
                    max_bytes: r.get::<_, Option<i64>>(4)?.map(|b| b.max(0) as u64),
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

/// Checks a folder for backups: an existing folder outside the profile.
pub fn check_folder(folder: &str, profile_dir: &Path) -> Result<PathBuf> {
    let path = PathBuf::from(folder.trim());
    ensure!(path.is_absolute(), "choose a folder for the backups");
    let folder = path.canonicalize().with_context(|| format!("the folder {} cannot be opened", path.display()))?;
    ensure!(folder.is_dir(), "{} is not a folder", folder.display());
    if let Ok(profile) = profile_dir.canonicalize() {
        ensure!(
            !folder.starts_with(&profile) && !profile.starts_with(&folder),
            "backups cannot be kept inside the profile they protect, or in a folder that holds it"
        );
    }
    Ok(folder)
}

pub fn save(conn: &Connection, schedule: &Schedule, profile_dir: &Path) -> Result<Schedule> {
    ensure!(
        (MIN_HOURS..=MAX_HOURS).contains(&schedule.every_hours),
        "backups run every {MIN_HOURS} hours at most and every 30 days at least"
    );
    ensure!((1..=MAX_KEEP).contains(&schedule.keep), "keep between 1 and {MAX_KEEP} backups");
    ensure!(schedule.max_bytes.is_none_or(|b| b > 0), "the space limit must be more than nothing");
    let mut schedule = schedule.clone();
    if schedule.enabled || !schedule.folder.trim().is_empty() {
        schedule.folder = check_folder(&schedule.folder, profile_dir)?.to_string_lossy().into_owned();
    }
    conn.execute(
        "INSERT INTO backup_schedule(id, enabled, folder, every_hours, keep, max_bytes) VALUES(1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET enabled = ?1, folder = ?2, every_hours = ?3, keep = ?4, max_bytes = ?5",
        params![
            schedule.enabled as i64,
            schedule.folder,
            schedule.every_hours,
            schedule.keep,
            schedule.max_bytes.map(|b| b as i64)
        ],
    )?;
    Ok(schedule)
}

fn times(conn: &Connection) -> Result<(Option<i64>, Option<i64>, Option<String>)> {
    Ok(conn
        .query_row("SELECT last_attempt, last_success, last_error FROM backup_schedule WHERE id = 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?
        .unwrap_or((None, None, None)))
}

/// When the next run is due, or None when the schedule is off.
pub fn next_run(schedule: &Schedule, last_attempt: Option<i64>, last_success: Option<i64>) -> Option<i64> {
    if !schedule.enabled || schedule.folder.is_empty() {
        return None;
    }
    let by_schedule = last_success.map_or(0, |t| t + schedule.every_hours * 3600);
    let failed_last = match (last_attempt, last_success) {
        (Some(attempt), Some(success)) => attempt > success,
        (Some(_), None) => true,
        _ => false,
    };
    let by_retry = if failed_last { last_attempt.unwrap_or(0) + RETRY_SECONDS } else { 0 };
    Some(by_schedule.max(by_retry))
}

pub fn records(conn: &Connection) -> Result<Vec<Kept>> {
    let mut stmt =
        conn.prepare("SELECT path, created_at, bytes, verified FROM scheduled_backups ORDER BY created_at DESC, path DESC")?;
    let rows = stmt.query_map([], |r| {
        let path: String = r.get(0)?;
        Ok(Kept {
            present: Path::new(&path).is_file(),
            path,
            created_at: r.get(1)?,
            bytes: r.get::<_, i64>(2)?.max(0) as u64,
            verified: r.get::<_, i64>(3)? != 0,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn status(conn: &Connection) -> Result<Status> {
    let schedule = load(conn)?;
    let (last_attempt, last_success, last_error) = times(conn)?;
    Ok(Status {
        next_run: next_run(&schedule, last_attempt, last_success),
        schedule,
        last_attempt,
        last_success,
        last_error,
        backups: records(conn)?,
    })
}

/// Which kept backups retention removes, oldest first. `kept` is newest
/// first. The newest verified backup is never among them.
pub fn plan_prune(kept: &[Kept], keep: i64, max_bytes: Option<u64>) -> Vec<String> {
    let verified: Vec<&Kept> = kept.iter().filter(|k| k.verified).collect();
    let mut remove = Vec::new();
    let mut total = 0u64;
    for (index, backup) in verified.iter().enumerate() {
        if index == 0 {
            total = backup.bytes;
            continue;
        }
        let over_count = index as i64 >= keep;
        let over_space = max_bytes.is_some_and(|max| total + backup.bytes > max);
        if over_count || over_space {
            remove.push(backup.path.clone());
        } else {
            total += backup.bytes;
        }
    }
    remove.reverse();
    remove
}

/// Removes a file this schedule wrote, only if it is still the size it was
/// written at; anything else is left where it is and forgotten.
fn remove_ours(conn: &Connection, kept: &Kept) -> Result<()> {
    let path = Path::new(&kept.path);
    let ours = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(PREFIX));
    if ours && std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == kept.bytes) {
        std::fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
    }
    conn.execute("DELETE FROM scheduled_backups WHERE path = ?1", params![kept.path])?;
    Ok(())
}

pub fn prune(conn: &Connection) -> Result<Vec<String>> {
    let schedule = load(conn)?;
    let kept = records(conn)?;
    let remove = plan_prune(&kept, schedule.keep, schedule.max_bytes);
    for path in &remove {
        if let Some(backup) = kept.iter().find(|k| &k.path == path) {
            remove_ours(conn, backup)?;
        }
    }
    Ok(remove)
}

/// At startup: an archive left unverified by a stop mid-run is not a
/// backup, and a half-written one of ours is removed.
pub fn recover(conn: &Connection) -> Result<()> {
    for backup in records(conn)?.into_iter().filter(|k| !k.verified) {
        remove_ours(conn, &backup)?;
    }
    let schedule = load(conn)?;
    if let Ok(read) = std::fs::read_dir(&schedule.folder) {
        for entry in read.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(PREFIX) && name.ends_with(".part") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// The archive name for a run at `now`, not already in the folder.
pub fn file_name(folder: &Path, now: i64) -> PathBuf {
    let stamp = chrono::DateTime::from_timestamp(now, 0)
        .map(|t| t.format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|| now.to_string());
    let mut candidate = folder.join(format!("{PREFIX}{stamp}.{EXTENSION}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = folder.join(format!("{PREFIX}{stamp}-{n}.{EXTENSION}"));
        n += 1;
    }
    candidate
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Outcome {
    pub path: String,
    pub bytes: u64,
    pub removed: Vec<String>,
}

/// One run, with the archive writing and checking given: `write` creates
/// the archive at the path, `verify` opens it whole. The store is locked
/// only for the bookkeeping, never while writing or checking.
pub fn run_with(
    db: &Mutex<Connection>,
    profile_dir: &Path,
    now: i64,
    write: impl FnOnce(&Path) -> Result<()>,
    verify: impl FnOnce(&Path) -> Result<()>,
) -> Result<Outcome> {
    let _guard = capture_lock()?;
    let schedule = load(&db.lock().unwrap())?;
    ensure!(!schedule.folder.is_empty(), "choose a folder for the backups");
    db.lock().unwrap().execute(
        "INSERT INTO backup_schedule(id, last_attempt) VALUES(1, ?1)
         ON CONFLICT(id) DO UPDATE SET last_attempt = ?1",
        params![now],
    )?;
    let result = (|| -> Result<Outcome> {
        let folder = check_folder(&schedule.folder, profile_dir)?;
        let dest = file_name(&folder, now);
        write(&dest)?;
        let bytes = std::fs::metadata(&dest)?.len();
        let path = dest.to_string_lossy().into_owned();
        db.lock().unwrap().execute(
            "INSERT OR REPLACE INTO scheduled_backups(path, created_at, bytes, verified) VALUES(?1, ?2, ?3, 0)",
            params![path, now, bytes as i64],
        )?;
        if let Err(error) = verify(&dest) {
            let conn = db.lock().unwrap();
            let unverified = Kept { path: path.clone(), created_at: now, bytes, verified: false, present: true };
            remove_ours(&conn, &unverified)?;
            return Err(error.context("the new backup did not pass its check, so it was removed"));
        }
        let conn = db.lock().unwrap();
        conn.execute("UPDATE scheduled_backups SET verified = 1 WHERE path = ?1", params![path])?;
        conn.execute("UPDATE backup_schedule SET last_success = ?1, last_error = NULL WHERE id = 1", params![now])?;
        let removed = prune(&conn)?;
        Ok(Outcome { path, bytes, removed })
    })();
    if let Err(error) = &result {
        db.lock().unwrap().execute(
            "UPDATE backup_schedule SET last_error = ?1 WHERE id = 1",
            params![format!("{error:#}")],
        )?;
    }
    result
}

/// One run with the real archive: written as #171 writes it, then opened
/// and checked in a private folder as a manual check does.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn run(
    db: &Mutex<Connection>,
    profile_dir: &Path,
    media_root: &Path,
    passphrase: &str,
    app_version: &str,
    now: i64,
    work_factor: u8,
) -> Result<Outcome> {
    ensure!(passphrase.chars().count() >= 8, "the backup password is missing; set it again in Settings");
    let work_dir = profile_dir.join("backup-work");
    run_with(
        db,
        profile_dir,
        now,
        |dest| {
            let options = crate::profile_archive::ExportOptions {
                media_root,
                work_dir: &work_dir,
                app_version,
                now,
                work_factor,
            };
            crate::profile_archive::export_with(
                |path, key| crate::profile_archive::take_snapshot(&db.lock().unwrap(), path, key),
                dest,
                passphrase,
                &options,
            )
            .map(|_| ())
        },
        |dest| {
            let staging = profile_dir
                .join(crate::profile_archive::STAGING_DIR)
                .join(uuid::Uuid::new_v4().to_string());
            let checked = crate::profile_archive::stage(dest, passphrase, &staging)
                .and_then(|manifest| crate::profile_archive::summary(&manifest, &staging));
            let _ = std::fs::remove_dir_all(&staging);
            checked.map(|_| ())
        },
    )
}

#[cfg(test)]
mod tests;
