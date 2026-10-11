use super::*;
use crate::store;

const PASS: &str = "correct horse battery";

struct Fixture {
    dir: PathBuf,
    conn: Connection,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("oreneta-profile-archive-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("media/avatars/acct")).unwrap();
        std::fs::create_dir_all(dir.join("media/acct/INBOX/1")).unwrap();
        std::fs::write(dir.join("media/avatars/acct/me.png"), b"avatar bytes").unwrap();
        std::fs::write(dir.join("media/acct/INBOX/1/0.pdf"), b"cached attachment").unwrap();
        let conn = store::open_at(dir.join("live.db").to_str().unwrap()).unwrap();
        conn.execute(
            "INSERT INTO accounts(id, email, display_name, config) VALUES('a@x.cat', 'a@x.cat', 'A', '{}')",
            [],
        )
        .unwrap();
        crate::store::notes::create(
            &conn,
            &crate::store::notes::NoteFields { title: "Keep me".into(), html: "<p>note</p>".into(), ..Default::default() },
            1,
        )
        .unwrap();
        Fixture { dir, conn }
    }

    fn options(&self) -> ExportOptions<'_> {
        ExportOptions {
            media_root: Box::leak(self.dir.join("media").into_boxed_path()),
            work_dir: Box::leak(self.dir.join("work").into_boxed_path()),
            app_version: "0.0.0-test",
            now: 1_760_000_000,
            work_factor: 10,
        }
    }

    fn export(&self) -> PathBuf {
        let dest = self.dir.join("profile.oreneta-profile");
        export(&self.conn, &dest, PASS, &self.options()).unwrap();
        dest
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn an_archive_holds_the_store_and_chosen_pictures_and_opens_with_its_passphrase_alone() {
    let fixture = Fixture::new("roundtrip");
    let dest = fixture.dir.join("profile.oreneta-profile");
    let summary = export(&fixture.conn, &dest, PASS, &fixture.options()).unwrap();
    assert_eq!((summary.entries, summary.accounts), (2, 1));
    assert!(!fixture.dir.join("profile.oreneta-profile.part").exists());
    assert_eq!(std::fs::read_dir(fixture.dir.join("work")).unwrap().count(), 0, "the snapshot is removed");
    let raw = std::fs::read(&dest).unwrap();
    assert!(raw.starts_with(b"age-encryption.org/v1"));
    assert!(!raw.windows(7).any(|w| w == b"Keep me") && !raw.windows(12).any(|w| w == b"avatar bytes"));

    let staging = fixture.dir.join("staging");
    let manifest = stage(&dest, PASS, &staging).unwrap();
    assert_eq!(manifest.schema_version, store::SCHEMA_VERSION);
    let paths: Vec<_> = manifest.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec![DB_ENTRY, "media/avatars/acct/me.png"], "the attachment cache is left out");
    assert!(manifest.excluded.iter().any(|e| e.what == "attachment cache"));
    assert_eq!(std::fs::read(staging.join("media/avatars/acct/me.png")).unwrap(), b"avatar bytes");

    // The store inside is under the archive's own key, not this computer's.
    let restored = Connection::open(staging.join(DB_ENTRY)).unwrap();
    assert!(restored.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0)).is_err());
    restored.execute_batch(&format!("PRAGMA key = \"x'{}'\";", manifest.db_key)).unwrap();
    let title: String = restored.query_row("SELECT title FROM notes", [], |r| r.get(0)).unwrap();
    assert_eq!(title, "Keep me");
    let described = super::summary(&manifest, &staging).unwrap();
    assert_eq!((described.accounts, described.entries), (1, 2));
}

#[test]
fn a_wrong_passphrase_a_short_one_and_a_foreign_file_are_refused() {
    let fixture = Fixture::new("refusals");
    let dest = fixture.export();
    let error = stage(&dest, "not the passphrase", &fixture.dir.join("s1")).unwrap_err().to_string();
    assert!(error.contains("wrong passphrase"), "{error}");
    assert!(export(&fixture.conn, &fixture.dir.join("x"), "short", &fixture.options()).is_err());
    let foreign = fixture.dir.join("foreign");
    std::fs::write(&foreign, b"From a@b Mon\nnot an archive").unwrap();
    assert!(stage(&foreign, PASS, &fixture.dir.join("s2")).is_err());
}

#[test]
fn any_changed_or_missing_byte_is_caught() {
    let fixture = Fixture::new("tamper");
    let dest = fixture.export();
    let raw = std::fs::read(&dest).unwrap();
    let header_end = raw.windows(4).position(|w| w == b"\n---").unwrap();
    // Every 97th byte after the header, flipped, and the file cut at several lengths.
    for (n, at) in (header_end + 60..raw.len()).step_by(97).enumerate().take(40) {
        let mut bad = raw.clone();
        bad[at] ^= 0x01;
        let path = fixture.dir.join(format!("bad-{n}"));
        std::fs::write(&path, &bad).unwrap();
        assert!(stage(&path, PASS, &fixture.dir.join(format!("bs-{n}"))).is_err(), "flip at {at}");
    }
    for cut in [raw.len() - 1, raw.len() - 20, raw.len() / 2, header_end] {
        let path = fixture.dir.join(format!("cut-{cut}"));
        std::fs::write(&path, &raw[..cut]).unwrap();
        assert!(stage(&path, PASS, &fixture.dir.join(format!("cs-{cut}"))).is_err(), "cut at {cut}");
    }
}

/// Builds an archive by hand, for contents `export` never writes.
fn craft(dest: &Path, body: impl FnOnce(&mut dyn Write)) {
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(PASS.to_owned()));
    recipient.set_work_factor(10);
    let encryptor = age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient)).unwrap();
    let mut stream = encryptor.wrap_output(File::create(dest).unwrap()).unwrap();
    stream.write_all(MAGIC).unwrap();
    body(&mut stream);
    stream.finish().unwrap();
}

fn entry(out: &mut dyn Write, path: &str, bytes: &[u8]) {
    out.write_all(b"E").unwrap();
    out.write_all(&(path.len() as u16).to_be_bytes()).unwrap();
    out.write_all(path.as_bytes()).unwrap();
    out.write_all(&(bytes.len() as u64).to_be_bytes()).unwrap();
    out.write_all(bytes).unwrap();
}

#[test]
fn entries_cannot_reach_outside_the_staging_folder() {
    let fixture = Fixture::new("paths");
    for evil in ["../escape", "media/../../escape", "/etc/passwd", "C:/x", "media\\..\\x", "db/other.db", "media//x", "media/./x"] {
        let dest = fixture.dir.join("evil");
        craft(&dest, |out| entry(out, evil, b"x"));
        let staging = fixture.dir.join("evil-staging");
        let error = stage(&dest, PASS, &staging).unwrap_err().to_string();
        assert!(error.contains("outside the profile") || error.contains("invalid name"), "{evil}: {error}");
        assert!(!fixture.dir.join("escape").exists());
        let _ = std::fs::remove_dir_all(&staging);
    }
    let dest = fixture.dir.join("twice");
    craft(&dest, |out| {
        entry(out, "media/avatars/a", b"1");
        entry(out, "media/avatars/a", b"2");
    });
    assert!(stage(&dest, PASS, &fixture.dir.join("twice-staging")).unwrap_err().to_string().contains("repeats"));
}

#[test]
fn an_archive_from_a_newer_version_or_with_a_lying_manifest_is_refused() {
    let fixture = Fixture::new("versions");
    let good = fixture.export();
    let staged = fixture.dir.join("good");
    let manifest = stage(&good, PASS, &staged).unwrap();
    let db = std::fs::read(staged.join(DB_ENTRY)).unwrap();
    let digest = hex(ring::digest::digest(&SHA256, &db).as_ref());
    let write = |name: &str, manifest: &Manifest| {
        let dest = fixture.dir.join(name);
        let json = serde_json::to_vec(manifest).unwrap();
        craft(&dest, |out| {
            entry(out, DB_ENTRY, &db);
            out.write_all(b"M").unwrap();
            out.write_all(&(json.len() as u32).to_be_bytes()).unwrap();
            out.write_all(&json).unwrap();
            out.write_all(b"Z").unwrap();
        });
        stage(&dest, PASS, &fixture.dir.join(format!("{name}-staging")))
    };
    let mut honest = manifest.clone();
    honest.entries = vec![Entry { path: DB_ENTRY.into(), size: db.len() as u64, sha256: digest.clone() }];
    assert!(write("honest", &honest).is_ok());

    let mut newer = honest.clone();
    newer.version = VERSION + 1;
    assert!(write("newer-format", &newer).unwrap_err().to_string().contains("newer version"));
    let mut newer = honest.clone();
    newer.schema_version = store::SCHEMA_VERSION + 1;
    assert!(write("newer-schema", &newer).unwrap_err().to_string().contains("newer version"));
    let mut lying = honest.clone();
    lying.entries[0].sha256 = "0".repeat(64);
    assert!(write("lying", &lying).unwrap_err().to_string().contains("manifest"));
    let mut wrong_key = honest.clone();
    wrong_key.db_key = "1".repeat(64);
    assert!(write("wrong-key", &wrong_key).is_err());
}

#[test]
fn a_failed_export_keeps_the_previous_archive() {
    let fixture = Fixture::new("keep");
    let dest = fixture.export();
    let before = std::fs::read(&dest).unwrap();
    // An unwritable work folder makes the next export fail before it renames.
    let blocked = fixture.dir.join("blocked");
    std::fs::write(&blocked, b"a file, not a folder").unwrap();
    let options = ExportOptions { work_dir: Box::leak(blocked.into_boxed_path()), ..fixture.options() };
    assert!(export(&fixture.conn, &dest, PASS, &options).is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), before);
    assert!(!fixture.dir.join("profile.oreneta-profile.part").exists());
}

#[test]
fn a_restore_is_prepared_aside_rekeyed_and_held_until_the_person_reconnects() {
    let fixture = Fixture::new("prepare");
    fixture
        .conn
        .execute(
            "INSERT INTO scheduled_sends(id, account, due_at, subject, payload) VALUES('s1', 'a@x.cat', 9999999999, 'Later', '{}')",
            [],
        )
        .unwrap();
    fixture.conn.execute("INSERT INTO account_secrets(account_id, blob) VALUES('a@x.cat', 'pw')", []).unwrap();
    let archive = fixture.export();
    let profile = fixture.dir.join("profile");
    let machine = "ab".repeat(32);

    let wrong = prepare_restore(&archive, "wrong passphrase", &profile, Some(&machine), 5);
    assert!(wrong.is_err());
    assert!(!profile.join(STAGING_DIR).join(READY_DIR).exists(), "nothing is left ready after a failure");
    assert!(!profile.join(STAGING_DIR).join("work").exists());

    let summary = prepare_restore(&archive, PASS, &profile, Some(&machine), 5).unwrap();
    assert_eq!(summary.accounts, 1);
    let ready = profile.join(STAGING_DIR).join(READY_DIR);
    assert!(ready.join(READY_FILE).exists());
    assert!(!ready.join("db").exists(), "the copy under the archive key is gone");
    assert_eq!(std::fs::read(ready.join("media/avatars/acct/me.png")).unwrap(), b"avatar bytes");

    let restored = Connection::open(ready.join(RESTORED_DB)).unwrap();
    assert!(restored.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get::<_, i64>(0)).is_err(), "only this computer's key opens it");
    restored.execute_batch(&format!("PRAGMA key = \"x'{machine}'\";")).unwrap();
    assert!(crate::store::account_paused(&restored, "a@x.cat").unwrap(), "no sync until reconnected");
    let (attempts, error): (i64, String) = restored
        .query_row("SELECT attempts, last_error FROM scheduled_sends WHERE id = 's1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(attempts, crate::store::MAX_SEND_ATTEMPTS);
    assert!(error.contains("restored"));
    let secrets: i64 = restored.query_row("SELECT COUNT(*) FROM account_secrets", [], |r| r.get(0)).unwrap();
    assert_eq!(secrets, 0, "no stored password travels in an archive");
    let version: i64 = restored.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, crate::store::SCHEMA_VERSION);

    // Without a key on this computer the restored store is plain, like the one in use.
    let plain = prepare_restore(&archive, PASS, &profile, None, 6).unwrap();
    assert_eq!(plain.accounts, 1);
    let restored = Connection::open(ready.join(RESTORED_DB)).unwrap();
    assert_eq!(restored.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}
