use super::*;

fn snippet() -> Template {
    Template {
        id: "t1".into(),
        kind: Kind::Snippet,
        name: "Directions".into(),
        subject: String::new(),
        body_html: "<p>Second floor.</p>".into(),
        body_text: "Second floor.".into(),
    }
}

fn message() -> Template {
    Template {
        id: "t2".into(),
        kind: Kind::Message,
        name: "Weekly report".into(),
        subject: "Report, week {n}".into(),
        body_html: String::new(),
        body_text: String::new(),
    }
}

#[test]
fn a_template_needs_something_to_call_it_by() {
    let mut template = snippet();
    template.name = "   ".into();
    assert_eq!(validate(&template), Some(Problem::NeedsName));
}

#[test]
fn a_snippet_without_text_is_nothing_to_insert() {
    let mut template = snippet();
    template.body_html = String::new();
    template.body_text = String::new();
    assert_eq!(validate(&template), Some(Problem::NeedsBody));
}

#[test]
fn a_snippet_kept_only_as_plain_text_is_still_a_snippet() {
    let mut template = snippet();
    template.body_html = String::new();
    assert_eq!(validate(&template), None);
}

#[test]
fn a_message_template_may_be_a_subject_alone() {
    assert_eq!(validate(&message()), None);
}

#[test]
fn a_message_template_may_be_a_body_alone() {
    let mut template = message();
    template.subject = String::new();
    template.body_text = "Here it is.".into();
    assert_eq!(validate(&template), None);
}

#[test]
fn a_message_template_that_is_neither_does_nothing() {
    let mut template = message();
    template.subject = "  ".into();
    assert_eq!(validate(&template), Some(Problem::NeedsSubjectOrBody));
}

#[test]
fn whitespace_is_not_a_body() {
    let mut template = snippet();
    template.body_html = "   \n ".into();
    template.body_text = "\t".into();
    assert_eq!(validate(&template), Some(Problem::NeedsBody));
}

#[test]
fn a_kind_written_by_a_later_version_still_shows_its_text() {
    assert_eq!(Kind::parse("something-new"), Kind::Snippet);
    assert_eq!(Kind::parse("message"), Kind::Message);
    assert_eq!(Kind::parse("snippet"), Kind::Snippet);
}

#[test]
fn a_kind_survives_a_round_trip_through_the_store() {
    for kind in [Kind::Snippet, Kind::Message] {
        assert_eq!(Kind::parse(kind.as_str()), kind);
    }
}

#[test]
fn every_problem_says_what_is_wrong_in_words() {
    for problem in [
        Problem::NeedsName,
        Problem::NeedsBody,
        Problem::NeedsSubjectOrBody,
    ] {
        let described = problem.describe();
        assert!(!described.is_empty());
        // Not the enum's own name: "NeedsSubjectOrBody" is not an explanation.
        assert!(described.chars().next().unwrap().is_lowercase());
    }
}
