use super::*;
use crate::store;

fn db() -> Connection {
    store::open_at(":memory:").unwrap()
}

fn fields(title: &str, html: &str, tags: &[&str]) -> NoteFields {
    NoteFields { title: title.into(), html: html.into(), tags: tags.iter().map(|t| t.to_string()).collect(), pinned: false }
}

#[test]
fn a_note_keeps_its_formatting_and_pictures_but_nothing_that_runs_or_reaches_out() {
    let html = r#"<h2>Plan</h2><p onclick="x()">Buy <b>milk</b> &amp; <a href="javascript:alert(1)">bread</a></p>
        <script>steal()</script><img src="data:image/png;base64,iVBORw0KGgo="><img src="https://tracker.example/p.gif">
        <a href="data:text/html,boom">x</a><a href="https://example.org">site</a><ul><li>one</li></ul>"#;
    let clean = clean_html(html);
    assert!(clean.contains("<h2>Plan</h2>") && clean.contains("<b>milk</b>") && clean.contains("<li>one</li>"));
    assert!(clean.contains(r#"src="data:image/png;base64,iVBORw0KGgo=""#));
    assert!(clean.contains(r#"href="https://example.org""#));
    for gone in ["onclick", "javascript:", "<script", "steal", "tracker.example", "data:text/html"] {
        assert!(!clean.contains(gone), "{gone} survived: {clean}");
    }
    assert_eq!(plain_text(&clean), "Plan Buy milk & bread x site one");
}

#[test]
fn notes_are_created_edited_from_their_revision_and_never_overwritten_silently() {
    let conn = db();
    let note = create(&conn, &fields(" Groceries ", "<p>milk</p>", &["home", "#Home", " shop "]), 100).unwrap();
    assert_eq!((note.title.as_str(), note.revision, note.text.as_str()), ("Groceries", 1, "milk"));
    assert_eq!(note.tags, vec!["home", "shop"], "tags are trimmed and kept once, whatever the case");

    let Write::Saved { note: edited } = update(&conn, &note.id, 1, &fields("Groceries", "<p>milk, eggs</p>", &["home"]), 200).unwrap() else {
        panic!("saved")
    };
    assert_eq!((edited.revision, edited.updated_at, edited.tags.clone()), (2, 200, vec!["home".to_string()]));

    // Another window still holds revision 1.
    let stale = update(&conn, &note.id, 1, &fields("Groceries", "<p>only bread</p>", &[]), 300).unwrap();
    let Write::Conflict { stored } = stale else { panic!("conflict") };
    assert_eq!(stored.text, "milk, eggs", "the stored version is handed back, untouched");
    assert_eq!(get(&conn, &note.id).unwrap().unwrap().revision, 2);
}

#[test]
fn empty_oversized_and_overtagged_notes_are_refused() {
    let conn = db();
    assert!(create(&conn, &fields("  ", "<p> </p><script>x</script>", &[]), 1).is_err());
    assert!(create(&conn, &fields("", r#"<img src="data:image/png;base64,AAAA">"#, &[]), 1).is_ok(), "a picture alone is a note");
    let huge = format!("<p>{}</p>", "a".repeat(MAX_BODY_BYTES));
    assert!(create(&conn, &fields("big", &huge, &[]), 1).is_err());
    let many: Vec<String> = (0..=MAX_TAGS).map(|i| format!("t{i}")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    assert!(create(&conn, &fields("tags", "", &refs), 1).is_err());
    assert!(create(&conn, &fields("tag", "", &[&"x".repeat(41)]), 1).is_err());
}

#[test]
fn search_tags_pins_and_the_trash() {
    let conn = db();
    let a = create(&conn, &fields("Trip to Girona", "<p>Book the train</p>", &["travel"]), 10).unwrap();
    let b = create(&conn, &fields("Recipes", "<p>Pa amb tomàquet, 100% oil</p>", &["food"]), 20).unwrap();
    let c = create(&conn, &fields("Train times", "<p>08:10</p>", &["travel"]), 30).unwrap();
    set_pinned(&conn, &a.id, true, 40).unwrap();

    let ids = |q: Query| list(&conn, &q).unwrap().into_iter().map(|n| n.id).collect::<Vec<_>>();
    assert_eq!(ids(Query::default()), vec![a.id.clone(), c.id.clone(), b.id.clone()], "pinned first, then newest");
    assert_eq!(ids(Query { search: "train".into(), ..Default::default() }), vec![a.id.clone(), c.id.clone()]);
    assert_eq!(ids(Query { search: "train girona".into(), ..Default::default() }), vec![a.id.clone()], "every word must match");
    assert_eq!(ids(Query { search: "100%".into(), ..Default::default() }), vec![b.id.clone()], "% is a character, not a wildcard");
    assert_eq!(ids(Query { search: "food".into(), ..Default::default() }), vec![b.id.clone()], "tags are searched");
    assert_eq!(ids(Query { tag: "TRAVEL".into(), ..Default::default() }), vec![a.id.clone(), c.id.clone()]);
    assert_eq!(tags(&conn).unwrap(), vec![("food".to_string(), 1), ("travel".to_string(), 2)]);

    trash(&conn, &c.id, 50).unwrap();
    assert_eq!(ids(Query::default()), vec![a.id.clone(), b.id.clone()]);
    assert_eq!(ids(Query { trash: true, ..Default::default() }), vec![c.id.clone()]);
    assert_eq!(tags(&conn).unwrap(), vec![("food".to_string(), 1), ("travel".to_string(), 1)]);
    assert!(matches!(update(&conn, &c.id, 2, &fields("x", "", &[]), 60).unwrap(), Write::Conflict { .. }), "a trashed note is restored, not edited");
    restore(&conn, &c.id).unwrap();
    assert_eq!(ids(Query::default()).len(), 3);

    assert!(purge(&conn, &b.id).is_err(), "only from the trash");
    trash(&conn, &b.id, 1_000).unwrap();
    purge(&conn, &b.id).unwrap();
    assert!(get(&conn, &b.id).unwrap().is_none());
    let orphan_tags: i64 = conn.query_row("SELECT COUNT(*) FROM note_tags WHERE note_id = ?1", params![b.id], |r| r.get(0)).unwrap();
    assert_eq!(orphan_tags, 0);
    assert!(matches!(update(&conn, &b.id, 1, &fields("x", "", &[]), 1).unwrap(), Write::Gone));

    trash(&conn, &a.id, 1_000).unwrap();
    assert_eq!(tidy_trash(&conn, 1_000 + TRASH_DAYS * 86_400 - 1).unwrap(), 0);
    assert_eq!(tidy_trash(&conn, 1_000 + TRASH_DAYS * 86_400 + 1).unwrap(), 1);
}
