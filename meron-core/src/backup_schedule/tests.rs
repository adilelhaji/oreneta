use super::*;
use crate::store;

const PASS: &str = "correct horse battery";
const DAY: i64 = 24 * 3600;
const T0: i64 = 1_760_000_000;

/// Runs share one capture lock across the process, so tests that run take
/// turns.
static SERIAL: Mutex<()> = Mutex::new(());

struct Fixture {
    root: PathBuf,
    profile: PathBuf,
    folder: PathBuf,
    db: Mutex<Connection>,
    _turn: std::sync::MutexGuard<'static, ()>,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let turn = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let root = std::env::temp_dir().join(format!("oreneta-backup-schedule-{name}-{}", uuid::Uuid::new_v4()));
        let profile = root.join("profile");
        let folder = root.join("backups");
        std::fs::create_dir_all(profile.join("media/avatars")).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        let conn = store::open_at(profile.join("live.db").to_str().unwrap()).unwrap();
        conn.execute(
            "INSERT INTO accounts(id, email, display_name, config) VALUES('a@x.cat', 'a@x.cat', 'A', '{}')",
            [],
        )
        .unwrap();
        let fixture = Fixture { root, profile, folder, db: Mutex::new(conn), _turn: turn };
        fixture.set(Schedule { enabled: true, folder: fixture.folder.to_string_lossy().into(), ..Default::default() });
        fixture
    }

    fn set(&self, schedule: Schedule) {
        save(&self.db.lock().unwrap(), &schedule, &self.profile).unwrap();
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap()
    }

    /// A run that writes `bytes` and passes its check.
    fn fake_run(&self, now: i64, bytes: usize) -> Result<Outcome> {
        run_with(&self.db, &self.profile, now, |dest| Ok(std::fs::write(dest, vec![b'x'; bytes])?), |_| Ok(()))
    }

    fn files(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.folder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn verified(&self) -> Vec<String> {
        records(&self.conn()).unwrap().into_iter().filter(|k| k.verified).map(|k| k.path).collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn kept(name: &str, at: i64, bytes: u64, verified: bool) -> Kept {
    Kept { path: name.into(), created_at: at, bytes, verified, present: true }
}

#[test]
fn off_by_default_and_due_once_after_a_missed_run_then_on_schedule() {
    let off = Schedule::default();
    assert!(!off.enabled);
    assert_eq!(next_run(&off, None, None), None);

    let on = Schedule { enabled: true, folder: "/b".into(), ..Default::default() };
    // Never run: due at once.
    assert_eq!(next_run(&on, None, None), Some(0));
    // Ran yesterday morning, app closed since: due now, once.
    assert_eq!(next_run(&on, Some(T0), Some(T0)), Some(T0 + DAY));
    // A failure is retried an hour later, not every tick.
    assert_eq!(next_run(&on, Some(T0 + 2 * DAY), Some(T0)), Some(T0 + 2 * DAY + RETRY_SECONDS));
    // A weekly schedule waits a week.
    let weekly = Schedule { every_hours: 168, ..on.clone() };
    assert_eq!(next_run(&weekly, Some(T0), Some(T0)), Some(T0 + 7 * DAY));
}

#[test]
fn settings_are_checked_and_the_folder_cannot_hold_or_be_inside_the_profile() {
    let f = Fixture::new("settings");
    let conn = f.conn();
    let base = Schedule { enabled: true, folder: f.folder.to_string_lossy().into(), ..Default::default() };
    assert!(save(&conn, &Schedule { every_hours: 1, ..base.clone() }, &f.profile).is_err());
    assert!(save(&conn, &Schedule { keep: 0, ..base.clone() }, &f.profile).is_err());
    assert!(save(&conn, &Schedule { keep: 31, ..base.clone() }, &f.profile).is_err());
    assert!(save(&conn, &Schedule { max_bytes: Some(0), ..base.clone() }, &f.profile).is_err());
    let inside = Schedule { folder: f.profile.join("media").to_string_lossy().into(), ..base.clone() };
    assert!(save(&conn, &inside, &f.profile).is_err());
    let holding = Schedule { folder: f.root.to_string_lossy().into(), ..base.clone() };
    assert!(save(&conn, &holding, &f.profile).is_err());
    let missing = Schedule { folder: f.root.join("nowhere").to_string_lossy().into(), ..base.clone() };
    assert!(save(&conn, &missing, &f.profile).is_err());
    assert!(save(&conn, &Schedule { folder: "relative".into(), ..base.clone() }, &f.profile).is_err());
    // A refused change leaves the saved schedule as it was.
    assert_eq!(load(&conn).unwrap().keep, 7);
    // Turned off, an empty folder is fine.
    assert!(save(&conn, &Schedule::default(), &f.profile).is_ok());
}

#[test]
fn retention_never_removes_the_newest_verified_backup() {
    let list = [
        kept("e", 5, 10, false),
        kept("d", 4, 10, true),
        kept("c", 3, 10, true),
        kept("b", 2, 10, true),
        kept("a", 1, 10, true),
    ];
    // Keep two: the two oldest go, oldest first; the unverified one is not
    // retention's to judge.
    assert_eq!(plan_prune(&list, 2, None), ["a", "b"]);
    // Keep one: only the newest verified stays.
    assert_eq!(plan_prune(&list, 1, None), ["a", "b", "c"]);
    // 25 bytes of room: the newest (10) and one more (20) fit.
    assert_eq!(plan_prune(&list, 30, Some(25)), ["a", "b"]);
    // A limit smaller than the newest backup still keeps it.
    assert_eq!(plan_prune(&list, 30, Some(1)), ["a", "b", "c"]);
    assert!(plan_prune(&[kept("only", 1, 99, true)], 1, Some(1)).is_empty());
    assert!(plan_prune(&[], 1, None).is_empty());
}

#[test]
fn a_real_scheduled_backup_is_written_checked_and_restorable() {
    let f = Fixture::new("real");
    let outcome = run(&f.db, &f.profile, &f.profile.join("media"), PASS, "0.0.0-test", T0, 10).unwrap();
    assert!(Path::new(&outcome.path).file_name().unwrap().to_string_lossy().starts_with(PREFIX));
    let staging = f.root.join("check");
    let manifest = crate::profile_archive::stage(Path::new(&outcome.path), PASS, &staging).unwrap();
    assert_eq!(crate::profile_archive::summary(&manifest, &staging).unwrap().accounts, 1);
    let status = status(&f.conn()).unwrap();
    assert_eq!(status.last_success, Some(T0));
    assert_eq!(status.last_error, None);
    assert_eq!(status.next_run, Some(T0 + DAY));
    assert!(status.backups[0].verified && status.backups[0].present);
    // Without its password, nothing runs.
    assert!(run(&f.db, &f.profile, &f.profile.join("media"), "", "0", T0 + DAY, 10).is_err());
}

#[test]
fn a_failed_or_interrupted_write_keeps_every_earlier_backup() {
    let f = Fixture::new("failed-write");
    f.fake_run(T0, 100).unwrap();
    let before = f.files();
    // Disk full partway: the archive writer removes its partial file and
    // reports; nothing earlier is touched.
    let error = run_with(
        &f.db,
        &f.profile,
        T0 + DAY,
        |_| Err(anyhow::anyhow!("No space left on device (os error 28)")),
        |_| Ok(()),
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("No space left"));
    assert_eq!(f.files(), before);
    let status = status(&f.conn()).unwrap();
    assert_eq!(status.last_success, Some(T0));
    assert!(status.last_error.unwrap().contains("No space left"));
    assert_eq!(status.next_run, Some(T0 + DAY + RETRY_SECONDS));
}

#[test]
fn a_new_backup_that_fails_its_check_is_removed_and_the_last_good_one_stays() {
    let f = Fixture::new("corrupt-newest");
    f.set(Schedule { enabled: true, folder: f.folder.to_string_lossy().into(), keep: 1, ..Default::default() });
    f.fake_run(T0, 100).unwrap();
    let good = f.verified();
    let error = run_with(
        &f.db,
        &f.profile,
        T0 + DAY,
        |dest| Ok(std::fs::write(dest, b"corrupt")?),
        |_| Err(anyhow::anyhow!("the archive is cut short")),
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("did not pass its check"));
    assert_eq!(f.verified(), good, "keep 1 still keeps the last verified backup");
    assert_eq!(f.files().len(), 1);
    assert!(Path::new(&good[0]).is_file());
}

#[test]
fn retention_removes_only_its_own_unchanged_files() {
    let f = Fixture::new("retention");
    f.set(Schedule { enabled: true, folder: f.folder.to_string_lossy().into(), keep: 2, ..Default::default() });
    std::fs::write(f.folder.join("my-notes.txt"), b"not a backup").unwrap();
    std::fs::write(f.folder.join("oreneta-profile-2026-10-01.oreneta-profile"), b"a manual backup").unwrap();
    for day in 0..3 {
        f.fake_run(T0 + day * DAY, 100).unwrap();
    }
    assert_eq!(f.verified().len(), 2);
    let files = f.files();
    assert!(files.contains(&"my-notes.txt".to_string()));
    assert!(files.contains(&"oreneta-profile-2026-10-01.oreneta-profile".to_string()));
    assert_eq!(files.iter().filter(|n| n.starts_with(PREFIX)).count(), 2);

    // A kept backup the person replaced with something else is forgotten,
    // never deleted.
    let oldest = f.verified().pop().unwrap();
    std::fs::write(&oldest, b"something the person put here").unwrap();
    f.fake_run(T0 + 3 * DAY, 100).unwrap();
    assert!(Path::new(&oldest).is_file());
    assert!(!f.verified().contains(&oldest));
}

#[test]
fn a_space_limit_keeps_the_newest_backup_even_when_it_alone_is_over() {
    let f = Fixture::new("space");
    f.set(Schedule {
        enabled: true,
        folder: f.folder.to_string_lossy().into(),
        keep: 30,
        max_bytes: Some(250),
        ..Default::default()
    });
    for day in 0..4 {
        f.fake_run(T0 + day * DAY, 100).unwrap();
    }
    assert_eq!(f.verified().len(), 2);
    f.fake_run(T0 + 4 * DAY, 400).unwrap();
    assert_eq!(f.verified().len(), 1);
    assert_eq!(f.files().len(), 1);
}

#[test]
fn a_manual_and_a_scheduled_backup_never_write_at_once() {
    let f = Fixture::new("concurrent");
    let manual = capture_lock().unwrap();
    let error = f.fake_run(T0, 10).unwrap_err();
    assert!(error.to_string().contains("another backup"));
    assert!(f.files().is_empty());
    drop(manual);
    f.fake_run(T0, 10).unwrap();
    let scheduled_running = capture_lock().unwrap();
    assert!(capture_lock().is_err());
    drop(scheduled_running);
}

#[test]
fn a_stop_mid_run_leaves_no_half_backup_counted_or_on_disk() {
    let f = Fixture::new("restart");
    f.fake_run(T0, 100).unwrap();
    // Stopped after writing, before the check: recorded, unverified.
    let unverified = f.folder.join(format!("{PREFIX}20991231-000000.oreneta-profile"));
    std::fs::write(&unverified, b"unchecked").unwrap();
    f.conn()
        .execute(
            "INSERT INTO scheduled_backups(path, created_at, bytes, verified) VALUES(?1, ?2, 9, 0)",
            params![unverified.to_string_lossy(), T0 + DAY],
        )
        .unwrap();
    // Stopped while writing: the writer's partial file.
    std::fs::write(f.folder.join(format!("{PREFIX}20991231-000001.oreneta-profile.part")), b"half").unwrap();
    std::fs::write(f.folder.join("someone-else.part"), b"theirs").unwrap();
    recover(&f.conn()).unwrap();
    assert!(!unverified.exists());
    let files = f.files();
    assert_eq!(files.iter().filter(|n| n.starts_with(PREFIX)).count(), 1);
    assert!(files.contains(&"someone-else.part".to_string()));
    assert_eq!(f.verified().len(), 1);
}

#[test]
fn two_runs_in_the_same_second_do_not_overwrite_each_other() {
    let f = Fixture::new("same-second");
    let a = f.fake_run(T0, 10).unwrap();
    let b = f.fake_run(T0, 10).unwrap();
    assert_ne!(a.path, b.path);
    assert_eq!(f.verified().len(), 2);
}

#[test]
fn a_restored_profile_does_not_start_backing_up_on_its_own() {
    let f = Fixture::new("restored");
    crate::profile_archive::hold_restored(&f.conn()).unwrap();
    assert!(!load(&f.conn()).unwrap().enabled);
}
