use super::*;
use crate::imap::{MessageHeader, Recipient};
use crate::rules::{Field, Op};
use crate::store::{get_recent_page, upsert_messages, RecentFilter};

fn conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::run_migrations(&conn).unwrap();
    conn
}

fn category(id: &str, name: &str, conditions: Vec<Condition>) -> Category {
    Category { id: id.into(), name: name.into(), colour: "#2056dd".into(), match_mode: Match::Any, conditions }
}

fn cond(field: Field, op: Op, value: &str) -> Condition {
    Condition { field, op, value: value.into() }
}

fn header(uid: u32, from: &str, subject: &str, thread: &str, date: i64) -> MessageHeader {
    MessageHeader {
        uid,
        from_addr: from.into(),
        subject: subject.into(),
        thread_key: thread.into(),
        date,
        to: vec![Recipient { name: String::new(), addr: "me@example.com".into() }],
        ..Default::default()
    }
}

fn setup() -> Connection {
    let conn = conn();
    save(
        &conn,
        &[
            category("news", "Newsletters", vec![cond(Field::From, Op::EndsWith, "@news.example")]),
            category("bills", "Bills", vec![cond(Field::Subject, Op::Contains, "invoice")]),
            category("hand", "Kept by hand", vec![]),
        ],
    )
    .unwrap();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            header(1, "weekly@news.example", "This week", "t-1", 100),
            header(2, "shop@store.example", "Your invoice", "t-2", 200),
            header(3, "ann@example.com", "Lunch?", "t-3", 300),
            // A reply in t-3 from a newsletter address: the newest message of
            // the conversation decides, for every message of it.
            header(4, "digest@news.example", "Re: Lunch?", "t-3", 400),
            header(5, "bob@example.com", "Hello", "t-5", 500),
        ],
    )
    .unwrap();
    conn
}

fn uids(conn: &Connection, category: &str) -> Vec<u32> {
    let mut uids: Vec<u32> = get_recent_page(
        conn,
        "acct",
        "INBOX",
        50,
        None,
        RecentFilter { category: Some(category.into()), ..Default::default() },
    )
    .unwrap()
    .0
    .into_iter()
    .map(|h| h.uid)
    .collect();
    uids.sort();
    uids
}

#[test]
fn rules_place_conversations_in_order_and_the_rest_is_other() {
    let conn = setup();
    rejudge(&conn, "acct", true).unwrap();
    assert_eq!(uids(&conn, "news"), vec![1, 3, 4]);
    assert_eq!(uids(&conn, "bills"), vec![2]);
    assert_eq!(uids(&conn, ""), vec![5]);
    // Every message is somewhere: nothing is left out of all tabs.
    let all = get_recent_page(&conn, "acct", "INBOX", 50, None, RecentFilter::default()).unwrap().0.len();
    let placed = uids(&conn, "news").len() + uids(&conn, "bills").len() + uids(&conn, "hand").len() + uids(&conn, "").len();
    assert_eq!(all, placed);
}

#[test]
fn the_first_matching_category_wins_and_says_which_conditions_held() {
    let cats = vec![
        category("a", "A", vec![cond(Field::Subject, Op::Contains, "x"), cond(Field::Subject, Op::Contains, "y")]),
        category("b", "B", vec![cond(Field::Subject, Op::Contains, "y")]),
    ];
    let subject = Subject { subject: "y only", ..Default::default() };
    let verdict = judge(&cats, &Corrections::default(), "", &subject);
    assert_eq!(verdict, Verdict { category: "a".into(), reason: Reason::Conditions { held: vec![1] } });

    let mut all = cats.clone();
    all[0].match_mode = Match::All;
    let verdict = judge(&all, &Corrections::default(), "", &subject);
    assert_eq!(verdict.category, "b");
}

#[test]
fn corrections_outrank_rules_conversation_before_sender() {
    let cats = vec![category("a", "A", vec![cond(Field::Subject, Op::Contains, "x")]), category("b", "B", vec![])];
    let subject = Subject { subject: "x", ..Default::default() };
    let both = Corrections { conversation: Some("b"), sender: Some("") };
    assert_eq!(judge(&cats, &both, "S@X.example", &subject).reason, Reason::Conversation);
    let sender = Corrections { conversation: None, sender: Some("") };
    assert_eq!(
        judge(&cats, &sender, "S@X.example", &subject),
        Verdict { category: String::new(), reason: Reason::Sender { addr: "s@x.example".into() } }
    );
    // A correction naming a category since removed says nothing.
    let stale = Corrections { conversation: Some("gone"), sender: None };
    assert_eq!(judge(&cats, &stale, "", &subject).category, "a");
}

#[test]
fn a_category_without_conditions_takes_nothing_by_itself() {
    let cats = vec![category("hand", "Hand", vec![])];
    let verdict = judge(&cats, &Corrections::default(), "", &Subject { subject: "anything", ..Default::default() });
    assert_eq!(verdict, Verdict { category: String::new(), reason: Reason::NothingMatched });
}

#[test]
fn corrections_survive_a_resync_and_reopening() {
    let conn = setup();
    rejudge(&conn, "acct", true).unwrap();
    correct_conversation(&conn, "acct", "t-5", Some("hand")).unwrap();
    correct_sender(&conn, "acct", "Shop@Store.example", Some("")).unwrap();
    rejudge(&conn, "acct", true).unwrap();
    assert_eq!(uids(&conn, "hand"), vec![5]);
    assert_eq!(uids(&conn, ""), vec![2]);

    // The server hands the same mail again, and new mail in t-5 arrives.
    conn.execute("DELETE FROM messages", []).unwrap();
    upsert_messages(
        &conn,
        "acct",
        "INBOX",
        &[
            header(2, "shop@store.example", "Your invoice", "t-2", 200),
            header(5, "bob@example.com", "Hello", "t-5", 500),
            header(6, "bob@example.com", "Re: Hello", "t-5", 600),
        ],
    )
    .unwrap();
    rejudge(&conn, "acct", true).unwrap();
    assert_eq!(uids(&conn, "hand"), vec![5, 6]);
    assert_eq!(uids(&conn, ""), vec![2]);
    let why = reason(&conn, "acct", "INBOX", "t-2").unwrap().unwrap();
    assert_eq!(why.reason, Reason::Sender { addr: "shop@store.example".into() });

    // Handing them back to the rules.
    correct_conversation(&conn, "acct", "t-5", None).unwrap();
    correct_sender(&conn, "acct", "shop@store.example", None).unwrap();
    rejudge(&conn, "acct", true).unwrap();
    assert_eq!(uids(&conn, "bills"), vec![2]);
    assert_eq!(uids(&conn, "hand"), Vec::<u32>::new());
}

#[test]
fn corrections_are_per_account() {
    let conn = setup();
    upsert_messages(&conn, "other", "INBOX", &[header(5, "bob@example.com", "Hello", "t-5", 500)]).unwrap();
    correct_conversation(&conn, "acct", "t-5", Some("hand")).unwrap();
    rejudge(&conn, "acct", true).unwrap();
    rejudge(&conn, "other", true).unwrap();
    let other = reason(&conn, "other", "INBOX", "t-5").unwrap().unwrap();
    assert_eq!(other.reason, Reason::NothingMatched);
}

#[test]
fn removing_a_category_drops_its_corrections_and_rejudges() {
    let conn = setup();
    correct_conversation(&conn, "acct", "t-5", Some("hand")).unwrap();
    correct_conversation(&conn, "acct", "t-1", Some("")).unwrap();
    rejudge(&conn, "acct", true).unwrap();
    let kept: Vec<Category> = list(&conn).unwrap().into_iter().filter(|c| c.id != "hand").collect();
    save(&conn, &kept).unwrap();
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM category_threads", [], |r| r.get(0)).unwrap();
    // The correction to Other stays; the one to the removed category goes.
    assert_eq!(left, 1);
    rejudge(&conn, "acct", true).unwrap();
    assert_eq!(uids(&conn, ""), vec![1, 5]);
}

#[test]
fn assigning_to_an_unknown_category_is_refused() {
    let conn = setup();
    assert!(correct_conversation(&conn, "acct", "t-1", Some("nope")).is_err());
    assert!(correct_sender(&conn, "acct", "  ", Some("news")).is_err());
}

#[test]
fn counts_cover_every_conversation_and_say_what_is_kept_here() {
    let conn = setup();
    conn.execute("UPDATE messages SET seen = 1 WHERE uid IN (1, 2)", []).unwrap();
    let counts = counts(&conn, "acct", "INBOX").unwrap();
    let of = |id: &str| counts.counts.iter().find(|c| c.category == id).cloned();
    assert_eq!(of("news").map(|c| (c.conversations, c.unread)), Some((2, 1)));
    assert_eq!(of("bills").map(|c| (c.conversations, c.unread)), Some((1, 0)));
    assert_eq!(of("").map(|c| (c.conversations, c.unread)), Some((1, 1)));
    assert_eq!(counts.conversations, 4);
    assert_eq!(counts.messages, 5);
}

#[test]
fn validation_refuses_what_could_not_be_predicted() {
    let ok = category("a", "A", vec![]);
    assert_eq!(validate(&[ok.clone()]), Ok(()));
    assert_eq!(validate(&[category("a", " ", vec![])]), Err(Invalid::NoName));
    assert_eq!(validate(&[ok.clone(), category("b", "a", vec![])]), Err(Invalid::SameName("a".into())));
    assert_eq!(validate(&[ok.clone(), category("a", "B", vec![])]), Err(Invalid::SameId));
    assert_eq!(validate(&[category("a", "A", vec![cond(Field::From, Op::Contains, " ")])]), Err(Invalid::EmptyCondition));
    assert_eq!(validate(&[Category { colour: "blue".into(), ..ok.clone() }]), Err(Invalid::Colour));
    let many: Vec<Category> = (0..13).map(|i| category(&format!("c{i}"), &format!("C{i}"), vec![])).collect();
    assert_eq!(validate(&many), Err(Invalid::TooMany));
}

#[test]
fn account_removal_takes_the_corrections() {
    let conn = setup();
    conn.execute("INSERT INTO accounts(id, email) VALUES('acct', 'me@example.com')", []).unwrap();
    correct_conversation(&conn, "acct", "t-5", Some("hand")).unwrap();
    correct_sender(&conn, "acct", "bob@example.com", Some("hand")).unwrap();
    crate::store::delete_account(&conn, "acct").unwrap();
    for table in ["category_threads", "category_senders"] {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{table}");
    }
    // The categories themselves are the reader's, not the account's.
    assert_eq!(list(&conn).unwrap().len(), 3);
}
