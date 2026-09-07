//! Rules the reader writes, applied to mail as it arrives.
//!
//! Deciding what a rule would do is kept apart from doing it, and both are
//! kept apart from the sync that triggers them. That separation is the point:
//! a rule that files mail away is a rule that can lose mail, so what it
//! decides has to be inspectable — before it runs, by asking (`plan`), and
//! after it ran, by reading the log.
//!
//! Matching works from the message header alone: sender, recipients, subject.
//! Not the body — that would mean fetching every arrival's body before it
//! could be filed, turning every rule into a download.

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

/// The part of a message a condition looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    /// The sender, name and address together: a rule for "Amazon" should fire
    /// whether that word is in the display name or the address.
    From,
    To,
    Cc,
    /// Everyone addressed, To and Cc alike.
    Recipient,
    Subject,
}

/// How a condition compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Contains,
    NotContains,
    Is,
    StartsWith,
    EndsWith,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Condition {
    pub field: Field,
    pub op: Op,
    pub value: String,
}

/// Whether every condition must hold, or any one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Match {
    All,
    Any,
}

/// What a rule does to a message it matched.
///
/// There is no delete. A rule that silently destroys mail is the one mistake
/// this feature could make that the reader could not undo, and moving to the
/// account's Trash says the same thing while leaving the message recoverable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// File it in another folder, named as the server names it.
    MoveTo { folder: String },
    MarkRead,
    Star,
    /// Put one of the reader's labels on the conversation.
    ///
    /// Added, not set: a rule saying "also label this" must not quietly strip
    /// whatever the reader put on it by hand.
    #[serde(rename_all = "camelCase")]
    AddLabel { label_id: String },
    /// Stop here: later rules do not see this message.
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    /// Which account it applies to. Empty means every account.
    #[serde(default)]
    pub account: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default = "default_match")]
    pub match_mode: Match,
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
}

fn default_match() -> Match {
    Match::All
}

/// The parts of a message a rule can look at.
///
/// Its own type rather than the IMAP header, so the engine can be exercised
/// without one and so adding a field is a deliberate act.
#[derive(Debug, Clone, Default)]
pub struct Subject<'a> {
    pub from_name: &'a str,
    pub from_addr: &'a str,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: &'a str,
}

impl Subject<'_> {
    /// The text a field offers a condition, as one haystack per addressee.
    ///
    /// A list rather than a joined string: "is" on a recipient must mean one
    /// of the addressees is exactly that, not that the whole list is.
    fn haystacks(&self, field: Field) -> Vec<String> {
        match field {
            Field::From => vec![format!("{} {}", self.from_name, self.from_addr)],
            Field::To => self.to.clone(),
            Field::Cc => self.cc.clone(),
            Field::Recipient => self.to.iter().chain(self.cc.iter()).cloned().collect(),
            Field::Subject => vec![self.subject.to_string()],
        }
    }
}

/// Whether one condition holds.
///
/// An empty value never matches. "Contains nothing" would otherwise be true of
/// every message, and a half-written rule would quietly file the whole mailbox
/// away; saving such a rule is refused too (see `validate`), so this is the
/// second of two locks on the same door.
fn holds(condition: &Condition, subject: &Subject) -> bool {
    let needle = condition.value.trim().to_lowercase();
    if needle.is_empty() {
        return false;
    }
    let haystacks: Vec<String> = subject
        .haystacks(condition.field)
        .into_iter()
        .map(|text| text.to_lowercase())
        .collect();

    match condition.op {
        Op::Contains => haystacks.iter().any(|text| text.contains(&needle)),
        // True when *no* addressee carries it — "not from the team" must not be
        // satisfied by one of three recipients being someone else.
        Op::NotContains => !haystacks.iter().any(|text| text.contains(&needle)),
        Op::Is => haystacks.iter().any(|text| text.trim() == needle),
        Op::StartsWith => haystacks.iter().any(|text| text.trim_start().starts_with(&needle)),
        Op::EndsWith => haystacks.iter().any(|text| text.trim_end().ends_with(&needle)),
    }
}

/// Whether a rule matches a message.
///
/// A rule with no conditions matches nothing. An empty condition list reads as
/// "anything", and a rule that does something to every message is never what
/// someone meant to write and always what they regret.
pub fn matches(rule: &Rule, subject: &Subject) -> bool {
    if rule.conditions.is_empty() {
        return false;
    }
    match rule.match_mode {
        Match::All => rule.conditions.iter().all(|c| holds(c, subject)),
        Match::Any => rule.conditions.iter().any(|c| holds(c, subject)),
    }
}

/// One thing a run of the rules would do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub rule_id: String,
    pub rule_name: String,
    pub action: Action,
}

/// What the rules would do to a message, in order, without doing any of it.
///
/// The same function answers the dry run and drives the real one, so what the
/// reader is shown beforehand is what actually happens — a preview computed by
/// separate code is a preview that can lie.
pub fn plan(rules: &[Rule], account: &str, subject: &Subject) -> Vec<Planned> {
    let mut planned = Vec::new();
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        if !rule.account.is_empty() && rule.account != account {
            continue;
        }
        if !matches(rule, subject) {
            continue;
        }
        for action in &rule.actions {
            if matches!(action, Action::Stop) {
                return planned;
            }
            planned.push(Planned {
                rule_id: rule.id.clone(),
                rule_name: rule.name.clone(),
                action: action.clone(),
            });
        }
    }
    planned
}

/// Why a rule cannot be saved.
///
/// Refused at the boundary rather than tolerated and worked around later: a
/// rule that cannot say what it matches is a rule nobody can predict, and this
/// one files people's mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invalid {
    NoName,
    NoConditions,
    EmptyCondition,
    NoActions,
    /// A move with no destination would silently do nothing.
    MoveWithoutFolder,
    /// So would labelling with no label.
    LabelWithoutName,
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Invalid::NoName => "a rule needs a name",
            Invalid::NoConditions => "a rule needs at least one condition",
            Invalid::EmptyCondition => "a condition needs something to look for",
            Invalid::NoActions => "a rule needs at least one action",
            Invalid::MoveWithoutFolder => "a move needs a destination folder",
            Invalid::LabelWithoutName => "labelling needs a label",
        };
        f.write_str(text)
    }
}

pub fn validate(rule: &Rule) -> Result<(), Invalid> {
    if rule.name.trim().is_empty() {
        return Err(Invalid::NoName);
    }
    if rule.conditions.is_empty() {
        return Err(Invalid::NoConditions);
    }
    if rule.conditions.iter().any(|c| c.value.trim().is_empty()) {
        return Err(Invalid::EmptyCondition);
    }
    // A rule of nothing but Stop is allowed: "leave these alone" is a real
    // thing to want from a list of rules.
    if rule.actions.is_empty() {
        return Err(Invalid::NoActions);
    }
    if rule.actions.iter().any(|action| match action {
        Action::MoveTo { folder } => folder.trim().is_empty(),
        _ => false,
    }) {
        return Err(Invalid::MoveWithoutFolder);
    }
    if rule.actions.iter().any(|action| match action {
        Action::AddLabel { label_id } => label_id.trim().is_empty(),
        _ => false,
    }) {
        return Err(Invalid::LabelWithoutName);
    }
    Ok(())
}
