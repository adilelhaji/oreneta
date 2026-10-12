use super::*;

fn rule(id: &str, conditions: Vec<Condition>, actions: Vec<Action>) -> Rule {
    Rule {
        id: id.into(),
        account: String::new(),
        name: format!("Rule {id}"),
        enabled: true,
        match_mode: Match::All,
        conditions,
        actions,
    }
}

fn cond(field: Field, op: Op, value: &str) -> Condition {
    Condition { field, op, value: value.into() }
}

fn all_extensions() -> Vec<String> {
    vec!["fileinto".into(), "imap4flags".into()]
}

const NO_LABELS: &dyn Fn(&str) -> Option<String> = &|_| None;

#[test]
fn a_rule_becomes_one_block_with_flags_before_filing() {
    let rules = vec![rule(
        "r1",
        vec![cond(Field::From, Op::Contains, "shop.example"), cond(Field::Subject, Op::StartsWith, "Order *1")],
        vec![Action::MoveTo { folder: "Receipts".into() }, Action::MarkRead, Action::Stop],
    )];
    let plan = plan(&rules, "acct", &all_extensions(), NO_LABELS);
    assert_eq!(plan.included, vec!["r1"]);
    assert!(plan.left.is_empty());
    assert!(plan.script.contains("require [\"fileinto\", \"imap4flags\"];"), "{}", plan.script);
    assert!(plan.script.contains(
        "if allof (header :contains \"from\" \"shop.example\", header :matches \"subject\" \"Order \\\\*1*\") {\n    addflag \"\\\\Seen\";\n    fileinto \"Receipts\";\n    stop;\n}"
    ), "{}", plan.script);
}

#[test]
fn what_the_server_would_read_more_broadly_stays_here_whole() {
    let rules = vec![
        // "is" on an address compares the name too here.
        rule("is", vec![cond(Field::To, Op::Is, "ann@example.com")], vec![Action::Star]),
        // A needle spanning the name and the address.
        rule("span", vec![cond(Field::From, Op::Contains, "Ann <ann")], vec![Action::Star]),
        // A label not linked to a keyword exists only here.
        rule("label", vec![cond(Field::Subject, Op::Contains, "x")], vec![Action::AddLabel { label_id: "l1".into() }]),
        // And one that can go.
        rule("ok", vec![cond(Field::Recipient, Op::EndsWith, "@team.example")], vec![Action::Star]),
    ];
    let plan = plan(&rules, "acct", &all_extensions(), NO_LABELS);
    assert_eq!(plan.included, vec!["ok"]);
    let left: Vec<&str> = plan.left.iter().map(|l| l.id.as_str()).collect();
    assert_eq!(left, vec!["is", "span", "label"]);
    assert!(plan.left.iter().all(|l| !l.reasons.is_empty()));
    assert!(!plan.script.contains("ann@example.com"), "nothing of a rule left out reaches the script");
    assert!(plan.script.contains("address :all :matches [\"to\", \"cc\"] \"*@team.example\""));
}

#[test]
fn a_linked_label_becomes_its_keyword() {
    let rules = vec![rule("r", vec![cond(Field::Subject, Op::Contains, "x")], vec![Action::AddLabel { label_id: "l1".into() }])];
    let keywords = |id: &str| (id == "l1").then(|| "Work".to_string());
    let plan = plan(&rules, "acct", &all_extensions(), &keywords);
    assert!(plan.script.contains("addflag \"Work\";"), "{}", plan.script);
}

#[test]
fn a_server_without_an_extension_keeps_the_rules_that_need_it() {
    let rules = vec![
        rule("flag", vec![cond(Field::Subject, Op::Contains, "x")], vec![Action::Star]),
        rule("file", vec![cond(Field::Subject, Op::Contains, "y")], vec![Action::MoveTo { folder: "Y".into() }]),
    ];
    let plan = plan(&rules, "acct", &["fileinto".into()], NO_LABELS);
    assert_eq!(plan.included, vec!["file"]);
    assert_eq!(plan.left[0].id, "flag");
    assert!(!plan.script.contains("imap4flags"));
}

#[test]
fn only_enabled_rules_of_this_account_and_quoting_is_safe() {
    let mut other = rule("other", vec![cond(Field::Subject, Op::Contains, "a")], vec![Action::Star]);
    other.account = "elsewhere".into();
    let mut off = rule("off", vec![cond(Field::Subject, Op::Contains, "a")], vec![Action::Star]);
    off.enabled = false;
    let mut tricky = rule("q", vec![cond(Field::Subject, Op::Is, "say \"hi\" \\ now")], vec![Action::Stop]);
    tricky.name = "Line\nbreak".into();
    let plan = plan(&[other, off, tricky], "acct", &all_extensions(), NO_LABELS);
    assert_eq!(plan.included, vec!["q"]);
    assert!(plan.script.contains("header :is \"subject\" \"say \\\"hi\\\" \\\\ now\""), "{}", plan.script);
    assert!(plan.script.contains("# Line break\n"), "a name cannot end the comment early");
}

#[test]
fn not_contains_matches_when_no_addressee_carries_it() {
    let rules = vec![rule("n", vec![cond(Field::Recipient, Op::NotContains, "team.example")], vec![Action::Star])];
    let plan = plan(&rules, "acct", &all_extensions(), NO_LABELS);
    assert!(plan.script.contains("not header :contains [\"to\", \"cc\"] \"team.example\""));
}
