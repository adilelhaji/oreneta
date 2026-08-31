use super::*;

fn message<'a>(from_name: &'a str, from_addr: &'a str, subject: &'a str) -> Subject<'a> {
    Subject {
        from_name,
        from_addr,
        subject,
        ..Default::default()
    }
}

fn rule(conditions: Vec<Condition>, actions: Vec<Action>) -> Rule {
    Rule {
        id: "r-1".into(),
        account: String::new(),
        name: "A rule".into(),
        enabled: true,
        match_mode: Match::All,
        conditions,
        actions,
    }
}

fn contains(field: Field, value: &str) -> Condition {
    Condition {
        field,
        op: Op::Contains,
        value: value.into(),
    }
}

#[test]
fn a_sender_is_matched_by_name_or_by_address() {
    let subject = message("Amazon Marketplace", "no-reply@amazon.co.uk", "Your order");

    // Someone writing a rule for "Amazon" means the sender, and does not know
    // or care which half of it carries the word.
    assert!(matches(&rule(vec![contains(Field::From, "amazon")], vec![Action::Star]), &subject));
    assert!(matches(&rule(vec![contains(Field::From, "Marketplace")], vec![Action::Star]), &subject));
    assert!(!matches(&rule(vec![contains(Field::From, "ebay")], vec![Action::Star]), &subject));
}

#[test]
fn matching_ignores_case_and_surrounding_space() {
    let subject = message("Hospital", "avisos@csdm.cat", "  Resultats  ");
    let spaced = Condition {
        field: Field::Subject,
        op: Op::Is,
        value: "  resultats  ".into(),
    };
    assert!(matches(&rule(vec![spaced], vec![Action::MarkRead]), &subject));
}

#[test]
fn a_condition_with_nothing_to_look_for_matches_nothing() {
    let subject = message("Anyone", "anyone@example.com", "Anything");
    let empty = Condition {
        field: Field::Subject,
        op: Op::Contains,
        value: "   ".into(),
    };
    // "Contains nothing" is true of every message. A half-written rule must
    // not quietly file the whole mailbox away.
    assert!(!matches(&rule(vec![empty.clone()], vec![Action::Star]), &subject));
    assert_eq!(validate(&rule(vec![empty], vec![Action::Star])), Err(Invalid::EmptyCondition));
}

#[test]
fn a_rule_with_no_conditions_matches_nothing() {
    let subject = message("Anyone", "anyone@example.com", "Anything");
    assert!(!matches(&rule(vec![], vec![Action::Star]), &subject));
}

#[test]
fn all_and_any_mean_what_they_say() {
    let subject = message("Team", "team@example.com", "Weekly report");
    let both = vec![contains(Field::From, "team"), contains(Field::Subject, "report")];
    let one_wrong = vec![contains(Field::From, "team"), contains(Field::Subject, "invoice")];

    assert!(matches(&rule(both.clone(), vec![Action::Star]), &subject));

    let mut all_but_one = rule(one_wrong.clone(), vec![Action::Star]);
    assert!(!matches(&all_but_one, &subject));
    all_but_one.match_mode = Match::Any;
    assert!(matches(&all_but_one, &subject));
}

#[test]
fn not_contains_is_true_only_when_no_addressee_carries_it() {
    let subject = Subject {
        from_name: "Sender",
        from_addr: "sender@example.com",
        to: vec!["me@example.com".into(), "team@example.com".into()],
        ..Default::default()
    };
    let not_team = Condition {
        field: Field::To,
        op: Op::NotContains,
        value: "team".into(),
    };
    // "Not addressed to the team" must not be satisfied by one of the two
    // recipients being somebody else.
    assert!(!matches(&rule(vec![not_team], vec![Action::Star]), &subject));

    let not_boss = Condition {
        field: Field::To,
        op: Op::NotContains,
        value: "boss".into(),
    };
    assert!(matches(&rule(vec![not_boss], vec![Action::Star]), &subject));
}

#[test]
fn recipient_looks_at_everyone_addressed() {
    let subject = Subject {
        from_name: "Sender",
        from_addr: "sender@example.com",
        to: vec!["me@example.com".into()],
        cc: vec!["list@example.com".into()],
        ..Default::default()
    };
    assert!(matches(&rule(vec![contains(Field::Recipient, "list")], vec![Action::Star]), &subject));
    assert!(!matches(&rule(vec![contains(Field::To, "list")], vec![Action::Star]), &subject));
}

#[test]
fn a_disabled_rule_does_nothing_and_a_foreign_account_is_skipped() {
    let subject = message("Team", "team@example.com", "Hi");

    let mut off = rule(vec![contains(Field::From, "team")], vec![Action::Star]);
    off.enabled = false;
    assert!(plan(&[off], "acct", &subject).is_empty());

    let mut elsewhere = rule(vec![contains(Field::From, "team")], vec![Action::Star]);
    elsewhere.account = "other".into();
    assert!(plan(&[elsewhere.clone()], "acct", &subject).is_empty());

    // An empty account means every account.
    let everywhere = rule(vec![contains(Field::From, "team")], vec![Action::Star]);
    assert_eq!(plan(&[everywhere], "acct", &subject).len(), 1);
}

#[test]
fn the_plan_keeps_the_order_the_rules_are_in() {
    let subject = message("Team", "team@example.com", "Weekly report");
    let mut first = rule(vec![contains(Field::From, "team")], vec![Action::MarkRead]);
    first.id = "r-first".into();
    let mut second = rule(
        vec![contains(Field::Subject, "report")],
        vec![Action::MoveTo { folder: "Reports".into() }],
    );
    second.id = "r-second".into();

    let planned = plan(&[first, second], "acct", &subject);
    assert_eq!(
        planned.iter().map(|p| p.rule_id.as_str()).collect::<Vec<_>>(),
        vec!["r-first", "r-second"]
    );
    assert_eq!(planned[1].action, Action::MoveTo { folder: "Reports".into() });
}

#[test]
fn stop_hides_the_message_from_every_later_rule() {
    let subject = message("Team", "team@example.com", "Weekly report");
    let mut leave_alone = rule(vec![contains(Field::From, "team")], vec![Action::Stop]);
    leave_alone.id = "r-stop".into();
    let mut file_away = rule(
        vec![contains(Field::Subject, "report")],
        vec![Action::MoveTo { folder: "Reports".into() }],
    );
    file_away.id = "r-move".into();

    assert!(plan(&[leave_alone, file_away], "acct", &subject).is_empty());
}

#[test]
fn stop_keeps_what_its_own_rule_did_before_it() {
    let subject = message("Team", "team@example.com", "Weekly report");
    let mark_then_stop = rule(
        vec![contains(Field::From, "team")],
        vec![Action::MarkRead, Action::Stop],
    );
    let later = rule(vec![contains(Field::Subject, "report")], vec![Action::Star]);

    let planned = plan(&[mark_then_stop, later], "acct", &subject);
    assert_eq!(planned.len(), 1);
    assert_eq!(planned[0].action, Action::MarkRead);
}

#[test]
fn a_rule_that_cannot_say_what_it_does_is_refused() {
    let good = rule(vec![contains(Field::From, "team")], vec![Action::Star]);
    assert_eq!(validate(&good), Ok(()));

    let mut nameless = good.clone();
    nameless.name = "  ".into();
    assert_eq!(validate(&nameless), Err(Invalid::NoName));

    let mut conditionless = good.clone();
    conditionless.conditions.clear();
    assert_eq!(validate(&conditionless), Err(Invalid::NoConditions));

    let mut actionless = good.clone();
    actionless.actions.clear();
    assert_eq!(validate(&actionless), Err(Invalid::NoActions));

    let mut nowhere = good.clone();
    nowhere.actions = vec![Action::MoveTo { folder: "  ".into() }];
    assert_eq!(validate(&nowhere), Err(Invalid::MoveWithoutFolder));

    // Doing nothing but leaving these alone is a real thing to want.
    let mut only_stop = good.clone();
    only_stop.actions = vec![Action::Stop];
    assert_eq!(validate(&only_stop), Ok(()));
}

#[test]
fn a_rule_survives_a_round_trip_through_storage() {
    let original = Rule {
        id: "r-1".into(),
        account: "me@example.com".into(),
        name: "Reports".into(),
        enabled: true,
        match_mode: Match::Any,
        conditions: vec![
            contains(Field::From, "team"),
            Condition {
                field: Field::Subject,
                op: Op::StartsWith,
                value: "[report]".into(),
            },
        ],
        actions: vec![Action::MoveTo { folder: "Reports".into() }, Action::MarkRead],
    };

    let stored = serde_json::to_string(&original).unwrap();
    let read_back: Rule = serde_json::from_str(&stored).unwrap();
    assert_eq!(read_back, original);
}
