use super::*;

fn conn() -> Arc<Mutex<Connection>> {
    let conn = crate::store::open_at(":memory:").unwrap();
    ensure_account(&conn, 1).unwrap();
    Arc::new(Mutex::new(conn))
}

fn mail(id: &str, subject: &str, extra: &str) -> Vec<u8> {
    format!(
        "From: Ana <ana@x.cat>\r\nTo: me@y.cat\r\nSubject: {subject}\r\nDate: Mon, 5 Oct 2026 09:00:00 +0000\r\nMessage-ID: <{id}>\r\n{extra}\r\nHello\r\nFrom the start of a line.\r\n"
    )
    .into_bytes()
}

fn media() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("oreneta-archive-test-{}", std::process::id()))
}

#[test]
fn an_mbox_splits_into_its_messages_and_unquotes_from_lines() {
    let mbox = b"From ana@x.cat Mon Oct  5 09:00:00 2026\nSubject: one\n\nbody\n>From here\n\nFrom bo@x.cat Mon Oct  5 10:00:00 2026\nSubject: two\n\nsecond\n";
    let messages = split_mbox(mbox);
    assert_eq!(messages.len(), 2);
    assert_eq!(String::from_utf8_lossy(&messages[0]), "Subject: one\n\nbody\nFrom here\n");
    assert!(String::from_utf8_lossy(&messages[1]).starts_with("Subject: two"));
    assert!(split_mbox(b"no separator at all").is_empty());
}

#[test]
fn an_import_stores_messages_as_synced_ones_once_and_skips_what_is_not_mail() {
    let db = conn();
    let conn = db.lock().unwrap();
    let first = import(
        &conn,
        DEFAULT_FOLDER,
        vec![mail("a@x", "Budget", ""), mail("b@x", "Re: Budget", "In-Reply-To: <a@x>\r\nReferences: <a@x>\r\n"), b"just text".to_vec()],
        &media(),
    )
    .unwrap();
    assert_eq!(first, ImportSummary { imported: 2, duplicates: 0, skipped: 1 });
    let again = import(&conn, DEFAULT_FOLDER, vec![mail("a@x", "Budget", "")], &media()).unwrap();
    assert_eq!(again.duplicates, 1, "importing the same file twice does not double it");

    let headers = crate::store::recent_headers(&conn, ACCOUNT, DEFAULT_FOLDER, 10).unwrap();
    assert_eq!(headers.len(), 2);
    assert!(headers.iter().all(|h| h.seen), "filed mail is read");
    let keys: HashSet<&str> = headers.iter().map(|h| h.thread_key.as_str()).collect();
    assert_eq!(keys.len(), 1, "the reply threads with the message it answers");
    let cached = crate::store::get_cached_message(&conn, ACCOUNT, DEFAULT_FOLDER, headers[0].uid).unwrap().unwrap();
    assert!(cached.body_html.is_some() || !cached.body.is_empty(), "the body is there without any server");
}

#[test]
fn the_archive_moves_copies_and_deletes_without_losing_the_original() {
    let db = conn();
    {
        let conn = db.lock().unwrap();
        import(&conn, DEFAULT_FOLDER, vec![mail("a@x", "Budget", "")], &media()).unwrap();
    }
    let mut session = LocalSession::new(db.clone(), ACCOUNT);
    let uid = *session.list_all_uids(DEFAULT_FOLDER).unwrap().iter().next().unwrap();
    session.create_folder("2025").unwrap();
    session.move_to_folder(DEFAULT_FOLDER, "2025", &[uid]).unwrap();
    assert!(session.list_all_uids(DEFAULT_FOLDER).unwrap().is_empty());
    let moved = *session.list_all_uids("2025").unwrap().iter().next().unwrap();
    let copy = session.raw_for_copy("2025", &[moved]).unwrap();
    assert_eq!(copy[0].raw, mail("a@x", "Budget", ""), "byte for byte");
    let media_ctx = parse::MediaCtx { root: media(), account: ACCOUNT.into(), folder: "2025".into(), uid: moved };
    assert_eq!(session.read_message("2025", moved, &media_ctx).unwrap().subject, "Budget");
    session.expunge("2025", &[moved]).unwrap();
    assert!(session.list_all_uids("2025").unwrap().is_empty());
    assert!(crate::store::recent_headers(&db.lock().unwrap(), ACCOUNT, "2025", 10).unwrap().is_empty());
}

#[test]
fn the_archive_has_a_trash_folder_for_deleting_into() {
    let db = conn();
    let session = LocalSession::new(db, ACCOUNT);
    let folders = session.list_folders().unwrap();
    assert!(folders.iter().any(|f| f.name == TRASH && f.special_use.as_deref() == Some("trash")));
}

/// Real exports are messy. Each case must either import with what can be
/// read or be left out and counted; none may stop the rest.
#[test]
fn a_corpus_of_awkward_messages_imports_what_it_can_and_counts_the_rest() {
    let db = conn();
    let conn = db.lock().unwrap();
    let latin1_subject: Vec<u8> = [b"From: a@x.cat\r\nSubject: Caf\xe9 y m\xe1s\r\nMessage-ID: <l1@x>\r\n\r\nhola\r\n".as_slice()].concat();
    let cases: Vec<Vec<u8>> = vec![
        // Encoded-word subject and an emoji in the body.
        b"From: =?UTF-8?Q?Jos=C3=A9?= <jose@x.cat>\r\nSubject: =?UTF-8?B?w4BydWxsYQ==?=\r\nMessage-ID: <u1@x>\r\n\r\nHola \xf0\x9f\x91\x8b\r\n".to_vec(),
        // Raw 8-bit Latin-1 in a header, no charset declared.
        latin1_subject,
        // Header folded oddly and a missing Date.
        b"From: b@x.cat\r\nSubject: a very\r\n  long\r\n\tsubject\r\nMessage-ID: <f1@x>\r\n\r\nbody\r\n".to_vec(),
        // A multipart message whose attachment is cut off mid-way.
        b"From: c@x.cat\r\nSubject: truncated\r\nMessage-ID: <t1@x>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"zz\"\r\n\r\n--zz\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--zz\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK".to_vec(),
        // LF-only line endings.
        b"From: d@x.cat\nSubject: unix\nMessage-ID: <n1@x>\n\nlf only\n".to_vec(),
        // No Message-ID at all: imported, never treated as a duplicate.
        b"From: e@x.cat\r\nSubject: anonymous\r\n\r\nno id\r\n".to_vec(),
        b"From: e@x.cat\r\nSubject: anonymous\r\n\r\nno id\r\n".to_vec(),
        // Not mail: a PDF renamed .eml, and an empty file.
        b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n".to_vec(),
        Vec::new(),
    ];
    let summary = import(&conn, DEFAULT_FOLDER, cases, &media()).unwrap();
    assert_eq!(summary, ImportSummary { imported: 7, duplicates: 0, skipped: 2 });
    let subjects: Vec<String> = crate::store::recent_headers(&conn, ACCOUNT, DEFAULT_FOLDER, 50)
        .unwrap()
        .into_iter()
        .map(|h| h.subject)
        .collect();
    assert!(subjects.iter().any(|s| s == "Àrulla"), "{subjects:?}");
    assert!(subjects.iter().any(|s| s.starts_with("Caf")), "a Latin-1 subject is read, not dropped: {subjects:?}");
    assert!(subjects.iter().any(|s| s.contains("long") && s.contains("subject")), "{subjects:?}");
}

#[test]
fn an_mbox_with_crlf_endings_splits_the_same() {
    let mbox = b"From a@x Mon Oct  5 09:00:00 2026\r\nSubject: one\r\n\r\nbody\r\n\r\nFrom b@x Mon Oct  5 10:00:00 2026\r\nSubject: two\r\n\r\nsecond\r\n";
    let messages = split_mbox(mbox);
    assert_eq!(messages.len(), 2);
    assert!(String::from_utf8_lossy(&messages[0]).ends_with("body\r\n"));
}

#[test]
fn an_exported_mbox_reads_back_to_the_same_messages() {
    let messages: Vec<Vec<u8>> = vec![
        b"From: a@example.com\nSubject: one\n\nFrom the start of a line\n>From already quoted\nend\n".to_vec(),
        b"From: b@example.com\r\nSubject: two\r\n\r\nCRLF body\r\n".to_vec(),
        b"Subject: three\n\nno trailing newline".to_vec(),
    ];
    let mut file = Vec::new();
    for raw in &messages {
        write_mbox_entry(&mut file, raw, 1_760_000_000).unwrap();
    }
    let text = String::from_utf8_lossy(&file);
    assert!(text.starts_with("From - Thu Oct  9 08:53:20 2025\n"));
    assert!(text.contains("\n>From the start of a line\n"));
    assert!(text.contains("\n>>From already quoted\n"));

    let back = split_mbox(&file);
    assert_eq!(back.len(), 3);
    assert_eq!(back[0], messages[0]);
    assert_eq!(back[1], messages[1]);
    // A message without a final newline gains one; nothing else changes.
    assert_eq!(back[2], b"Subject: three\n\nno trailing newline\n".to_vec());
}
