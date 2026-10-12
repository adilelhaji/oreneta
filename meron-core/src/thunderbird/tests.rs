use super::*;

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn temp(name: &str) -> Dir {
    let dir = std::env::temp_dir().join(format!("oreneta-tb-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Dir(dir)
}

fn mail(subject: &str, status: Option<&str>) -> String {
    let status = status.map(|s| format!("X-Mozilla-Status: {s}\n")).unwrap_or_default();
    format!(
        "From - Mon Oct 05 09:00:00 2026\n{status}From: Ana <ana@x.test>\nTo: me@x.test\nSubject: {subject}\nMessage-ID: <{subject}@x.test>\nDate: Mon, 5 Oct 2026 09:00:00 +0000\n\nBody of {subject}\n>From here on it is still the body.\n\n"
    )
}

fn folder(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
    std::fs::write(dir.join(format!("{name}.msf")), "index").unwrap();
}

/// A profile laid out the way Thunderbird lays it out.
fn profile(root: &Path) {
    let local = root.join("Mail/Local Folders");
    std::fs::create_dir_all(local.join("Archives.sbd/2025.sbd")).unwrap();
    folder(&local, "Inbox", &(mail("one", Some("0001")) + &mail("gone", Some("0009")) + &mail("two", None)));
    folder(&local, "Unsent Messages", "");
    folder(&local, "Archives", &mail("archived", Some("0001")));
    folder(&local.join("Archives.sbd"), "2025", &mail("old", None));
    folder(&local.join("Archives.sbd/2025.sbd"), "Q4 v1.2", &mail("dotted", None));
    std::fs::write(local.join("msgFilterRules.dat"), "rules").unwrap();
    std::fs::write(local.join("popstate.dat"), "x").unwrap();
    std::fs::write(local.join("Trash.msf"), "orphan index").unwrap();
    let imap = root.join("ImapMail/imap.example.test");
    std::fs::create_dir_all(&imap).unwrap();
    folder(&imap, "INBOX", &mail("cached", None));
}

#[test]
fn a_profile_s_folders_are_found_with_their_levels_and_nothing_else() {
    let dir = temp("scan");
    profile(&dir.0);
    let found = scan(&dir.0).unwrap();
    let shown: Vec<(String, Vec<String>, bool)> =
        found.iter().map(|f| (f.account.clone(), f.path.clone(), f.imap_copy)).collect();
    assert_eq!(
        shown,
        [
            ("Local Folders".to_string(), vec!["Archives".to_string()], false),
            ("Local Folders".to_string(), vec!["Inbox".to_string()], false),
            ("Local Folders".to_string(), vec!["Archives".to_string(), "2025".to_string()], false),
            ("Local Folders".to_string(), vec!["Archives".into(), "2025".into(), "Q4 v1.2".into()], false),
            ("imap.example.test".to_string(), vec!["INBOX".to_string()], true),
        ]
    );
    // An empty folder, filter rules, POP state and an index without its
    // folder are not mail.
    assert!(!found.iter().any(|f| f.path.last().unwrap().contains("Unsent")));
    assert_eq!(found[3].id, "Mail/Local Folders/Archives.sbd/2025.sbd/Q4 v1.2");
}

#[test]
fn a_folder_chosen_by_hand_is_read_as_one_account() {
    let dir = temp("hand");
    std::fs::write(dir.0.join("Saved"), mail("kept", None)).unwrap();
    std::fs::write(dir.0.join("notes.txt"), "From someone, not mail").unwrap();
    let found = scan(&dir.0).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].path, ["Saved"]);
}

#[test]
fn a_folder_converted_from_outlook_by_readpst_is_offered_folder_by_folder() {
    // `readpst -o out/ Outlook.pst` writes one `<folder>.mbox` per folder,
    // plus calendars and contacts that are not mail.
    let dir = temp("readpst");
    let separator = "From \"ana@x.test\" Thu Jun  5 16:22:32 2014\nSubject: hi\n\nbody\n\n";
    std::fs::write(dir.0.join("Inbox.mbox"), separator).unwrap();
    std::fs::write(dir.0.join("Sent Items.mbox"), separator).unwrap();
    std::fs::write(dir.0.join("Calendar.calendar"), "BEGIN:VCALENDAR\nEND:VCALENDAR\n").unwrap();
    std::fs::write(dir.0.join("Contacts.contacts"), "BEGIN:VCARD\nEND:VCARD\n").unwrap();
    let found = scan(&dir.0).unwrap();
    let names: Vec<&str> = found.iter().map(|f| f.path[0].as_str()).collect();
    assert_eq!(names, ["Inbox.mbox", "Sent Items.mbox"]);
    let (kept, gone) = read_folder(&dir.0.join("Inbox.mbox")).unwrap();
    assert_eq!((kept.len(), gone), (1, 0));
}

#[test]
fn messages_deleted_in_thunderbird_are_left_out_and_counted() {
    let dir = temp("expunged");
    profile(&dir.0);
    let (kept, gone) = read_folder(&dir.0.join("Mail/Local Folders/Inbox")).unwrap();
    assert_eq!(gone, 1);
    let subjects: Vec<String> = kept
        .iter()
        .map(|m| String::from_utf8_lossy(m).lines().find(|l| l.starts_with("Subject:")).unwrap().to_string())
        .collect();
    assert_eq!(subjects, ["Subject: one", "Subject: two"]);
    assert!(!expunged(b"X-Mozilla-Status: 0001\n\nbody X-Mozilla-Status: 0008"));
    assert!(expunged(b"X-Mozilla-Status: 000b\r\n\r\nbody"));
    assert!(!expunged(b"X-Mozilla-Status: zz\n\n"));
}

#[test]
fn profiles_are_read_from_profiles_ini_relative_or_absolute() {
    let dir = temp("ini");
    let root = dir.0.join(".thunderbird");
    std::fs::create_dir_all(root.join("abc.default-release")).unwrap();
    let absolute = dir.0.join("elsewhere");
    std::fs::create_dir_all(&absolute).unwrap();
    std::fs::write(
        root.join("profiles.ini"),
        format!(
            "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\n\n[Profile1]\nName=old\nIsRelative=0\nPath={}\n\n[Profile2]\nName=missing\nIsRelative=1\nPath=gone\n",
            absolute.display()
        ),
    )
    .unwrap();
    let found = profiles(&profile_roots(&dir.0, None));
    let names: Vec<&str> = found.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["default-release", "old"]);
    assert!(found[0].path.ends_with("abc.default-release"));
}

#[test]
fn each_folder_goes_under_the_chosen_root_account_and_its_levels() {
    let folder = Folder {
        id: String::new(),
        account: "Local Folders".into(),
        path: vec!["Work/Ops".into(), "2025".into()],
        bytes: 1,
        imap_copy: false,
    };
    assert_eq!(target_folder("Thunderbird", &folder), "Thunderbird/Local Folders/Work-Ops/2025");
    assert_eq!(target_folder(" /Imported/ ", &folder), "Imported/Local Folders/Work-Ops/2025");
}
