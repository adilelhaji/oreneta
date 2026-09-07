use super::*;

#[test]
fn a_search_with_no_operators_is_the_search_it_always_was() {
    let query = parse("weekly report");
    assert_eq!(query.text, "weekly report");
    assert!(query.from.is_empty());
    assert!(query.flags.is_empty());
    assert!(!query.is_empty());
    assert!(parse("   ").is_empty());
}

#[test]
fn operators_are_read_into_their_own_fields() {
    let query = parse("from:ann to:team subject:invoice paid");
    assert_eq!(query.from, vec!["ann"]);
    assert_eq!(query.to, vec!["team"]);
    assert_eq!(query.subject, vec!["invoice"]);
    // What is left over is still the search.
    assert_eq!(query.text, "paid");
}

#[test]
fn an_operator_name_is_read_whatever_case_it_was_typed_in() {
    let query = parse("FROM:ann Is:UNREAD Has:Attachment");
    assert_eq!(query.from, vec!["ann"]);
    assert_eq!(query.flags, vec![Flag::Unread, Flag::HasAttachment]);
    assert!(query.text.is_empty());
}

#[test]
fn a_quoted_value_stays_whole() {
    let query = parse(r#"from:"Ann Example" subject:"weekly report" urgent"#);
    assert_eq!(query.from, vec!["Ann Example"]);
    assert_eq!(query.subject, vec!["weekly report"]);
    assert_eq!(query.text, "urgent");
}

#[test]
fn several_terms_for_one_field_mean_any_of_them() {
    // Someone who writes this means either sender. Reading it as "both" would
    // answer nothing, every time, for a query that looks perfectly sensible.
    let query = parse("from:ann from:bob");
    assert_eq!(query.from, vec!["ann", "bob"]);
}

#[test]
fn something_that_is_not_an_operator_stays_part_of_the_search() {
    // People paste URLs and Message-IDs into search boxes. A parser that
    // swallowed the unknown field would lose what they were looking for.
    let query = parse("https://example.com/a:b");
    assert_eq!(query.text, "https://example.com/a:b");
    assert!(query.from.is_empty());

    let mixed = parse("nonsense:value from:ann");
    assert_eq!(mixed.from, vec!["ann"]);
    assert_eq!(mixed.text, "nonsense:value");
}

#[test]
fn an_operator_with_nothing_after_it_asks_for_nothing() {
    // Mid-thought, not a search for everything from nobody.
    let query = parse("from: invoice");
    assert!(query.from.is_empty());
    assert_eq!(query.text, "invoice");
}

#[test]
fn dates_are_read_as_days_and_only_in_one_shape() {
    let query = parse("after:2026-01-01 before:2026-02-01");
    assert_eq!(query.after, Some(1_767_225_600));
    assert_eq!(query.before, Some(1_769_904_000));
    // `since` and `until` say the same thing.
    assert_eq!(parse("since:2026-01-01").after, query.after);
    assert_eq!(parse("until:2026-02-01").before, query.before);
}

#[test]
fn a_date_nobody_can_read_stays_visible_instead_of_vanishing() {
    // `03/04` is a different day for an American and a European, so it is not
    // guessed at. Keeping it as text means the reader gets no results and can
    // see why, rather than getting everything and wondering what happened.
    let query = parse("before:03/04/2026 invoice");
    assert_eq!(query.before, None);
    assert_eq!(query.text, "before:03/04/2026 invoice");

    assert_eq!(parse("after:2026-13-01").after, None);
    assert_eq!(parse("after:2026-01-99").after, None);
}

#[test]
fn a_label_makes_a_search_one_only_this_computer_can_answer() {
    let query = parse("label:Work invoice");
    assert_eq!(query.label.as_deref(), Some("Work"));
    assert_eq!(query.text, "invoice");
    // Labels live only here, so a server asked this would answer without the
    // label and quietly return the wrong set.
    assert!(query.needs_local_only());

    // Everything else is a question a server can answer.
    assert!(!parse("from:ann is:unread has:attachment after:2026-01-01").needs_local_only());
}

#[test]
fn what_was_understood_can_be_shown_back() {
    // A reader whose search found nothing needs to tell "no matches" apart
    // from "read differently than I meant".
    let shown = describe(&parse(r#"from:ann subject:"weekly report" is:unread label:Work rent"#));
    assert!(shown.contains(&"text:rent".to_string()), "{shown:?}");
    assert!(shown.contains(&"from:ann".to_string()), "{shown:?}");
    assert!(shown.contains(&"subject:weekly report".to_string()), "{shown:?}");
    assert!(shown.contains(&"is:unread".to_string()), "{shown:?}");
    assert!(shown.contains(&"label:Work".to_string()), "{shown:?}");
}

#[test]
fn read_and_unread_are_different_questions() {
    assert_eq!(parse("is:read").flags, vec![Flag::Read]);
    assert_eq!(parse("is:unread").flags, vec![Flag::Unread]);
    assert_eq!(parse("is:starred").flags, vec![Flag::Starred]);
    // An `is:` nobody knows is text, not a silently dropped filter.
    assert_eq!(parse("is:important").text, "is:important");
}
