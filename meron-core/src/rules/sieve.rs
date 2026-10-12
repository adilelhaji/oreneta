//! The reader's rules as a Sieve script (RFC 5228), to run on the server
//! (#94, ADR-0027).
//!
//! A rule goes to the server only if Sieve says exactly what it says here, or
//! something narrower in spacing corner cases; never something broader. A
//! rule with any part Sieve cannot say is left out whole, with the reason,
//! and keeps running here: half a rule on the server would be a different
//! rule.

use serde::Serialize;

use super::{Action, Condition, Field, Match, Op, Rule};

/// The script's name on the server. Only this script is ever written.
pub const SCRIPT_NAME: &str = "oreneta";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Left {
    pub id: String,
    pub name: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub script: String,
    /// Rules the script carries, in order.
    pub included: Vec<String>,
    /// Rules that stay here, and why.
    pub left: Vec<Left>,
}

/// A Sieve string: quoted, with `\` and `"` escaped.
fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// For `:matches`, where `*` and `?` are wildcards.
fn literal_pattern(text: &str) -> String {
    text.replace('\\', "\\\\").replace('*', "\\*").replace('?', "\\?")
}

fn headers(field: Field) -> &'static str {
    match field {
        Field::From => "\"from\"",
        Field::To => "\"to\"",
        Field::Cc => "\"cc\"",
        Field::Recipient => "[\"to\", \"cc\"]",
        Field::Subject => "\"subject\"",
    }
}

/// One condition as a Sieve test, or why it cannot be one.
fn test(condition: &Condition) -> Result<String, String> {
    let needle = condition.value.trim();
    if needle.is_empty() {
        return Err("a condition has nothing to look for".into());
    }
    let address_field = condition.field != Field::Subject;
    // Here an address is matched as "name address"; on the server the header
    // is "name <address>". The two agree for text within the name or within
    // the address, which is what has no spaces or brackets in it.
    if address_field && needle.contains(|c: char| c.is_whitespace() || c == '<' || c == '>') {
        return Err(format!("“{needle}” spans a name and an address, which the server reads differently"));
    }
    let h = headers(condition.field);
    Ok(match (condition.op, address_field) {
        (Op::Contains, _) => format!("header :contains {h} {}", quote(needle)),
        (Op::NotContains, _) => format!("not header :contains {h} {}", quote(needle)),
        (Op::Is, false) => format!("header :is {h} {}", quote(needle)),
        (Op::StartsWith, false) => format!("header :matches {h} {}", quote(&format!("{}*", literal_pattern(needle)))),
        (Op::EndsWith, false) => format!("header :matches {h} {}", quote(&format!("*{}", literal_pattern(needle)))),
        // An address is last in "name address", so ending with something is
        // the address ending with it.
        (Op::EndsWith, true) => {
            format!("address :all :matches {h} {}", quote(&format!("*{}", literal_pattern(needle))))
        }
        (Op::Is, true) | (Op::StartsWith, true) => {
            return Err(format!(
                "“{}” on an address compares the name too here, which the server cannot",
                match condition.op {
                    Op::Is => "is",
                    _ => "starts with",
                }
            ))
        }
    })
}

/// The Sieve form of a rule's actions, given the account's linked label
/// keywords, or why it has none.
fn actions(rule: &Rule, keywords: &dyn Fn(&str) -> Option<String>) -> Result<(Vec<String>, bool), String> {
    // Flags first: a message is filed with the flags set before `fileinto`.
    let mut flags = Vec::new();
    let mut file = Vec::new();
    let mut stop = false;
    for action in &rule.actions {
        match action {
            Action::MarkRead => flags.push("addflag \"\\\\Seen\";".to_string()),
            Action::Star => flags.push("addflag \"\\\\Flagged\";".to_string()),
            Action::AddLabel { label_id } => match keywords(label_id) {
                Some(keyword) if !keyword.is_empty() && !keyword.contains(|c: char| c.is_whitespace() || "(){%*\"\\]".contains(c)) => {
                    flags.push(format!("addflag {};", quote(&keyword)))
                }
                _ => return Err("labels exist only here unless linked to a keyword of this account".into()),
            },
            Action::MoveTo { folder } => file.push(format!("fileinto {};", quote(folder))),
            Action::Stop => stop = true,
        }
    }
    let uses_flags = !flags.is_empty();
    let mut out = flags;
    out.extend(file);
    if stop {
        out.push("stop;".into());
    }
    Ok((out, uses_flags))
}

/// Builds the script for one account from the rules in order: enabled rules
/// for this account or for every account. `extensions` are the ones the
/// server says it has.
pub fn plan(
    rules: &[Rule],
    account: &str,
    extensions: &[String],
    keywords: &dyn Fn(&str) -> Option<String>,
) -> Plan {
    let has = |name: &str| extensions.iter().any(|e| e.eq_ignore_ascii_case(name));
    let mut blocks = Vec::new();
    let mut included = Vec::new();
    let mut left = Vec::new();
    let mut need_flags = false;
    let mut need_fileinto = false;
    for rule in rules.iter().filter(|r| r.enabled && (r.account.is_empty() || r.account == account)) {
        let mut reasons = Vec::new();
        let tests: Vec<String> = rule
            .conditions
            .iter()
            .filter_map(|c| test(c).map_err(|e| reasons.push(e)).ok())
            .collect();
        if rule.conditions.is_empty() {
            reasons.push("a rule needs a condition".into());
        }
        let acts = actions(rule, keywords).map_err(|e| reasons.push(e)).ok();
        if let Some((acts, flags)) = &acts {
            if *flags && !has("imap4flags") {
                reasons.push("the server cannot set flags (no imap4flags)".into());
            }
            if acts.iter().any(|a| a.starts_with("fileinto")) && !has("fileinto") {
                reasons.push("the server cannot file into folders (no fileinto)".into());
            }
        }
        if !reasons.is_empty() {
            left.push(Left { id: rule.id.clone(), name: rule.name.clone(), reasons });
            continue;
        }
        let (acts, flags) = acts.expect("checked above");
        need_flags |= flags;
        need_fileinto |= acts.iter().any(|a| a.starts_with("fileinto"));
        let joined = match rule.match_mode {
            Match::All => format!("allof ({})", tests.join(", ")),
            Match::Any => format!("anyof ({})", tests.join(", ")),
        };
        let name = rule.name.replace(['\r', '\n'], " ");
        blocks.push(format!("# {name}\nif {joined} {{\n    {}\n}}", acts.join("\n    ")));
        included.push(rule.id.clone());
    }
    let mut require = Vec::new();
    if need_fileinto {
        require.push("\"fileinto\"");
    }
    if need_flags {
        require.push("\"imap4flags\"");
    }
    let mut script = String::from("# Written by Oreneta from its rules. Changes made here are not kept:\n# edit the rules in Oreneta instead.\n");
    if !require.is_empty() {
        script.push_str(&format!("require [{}];\n", require.join(", ")));
    }
    for block in blocks {
        script.push('\n');
        script.push_str(&block);
        script.push('\n');
    }
    Plan { script, included, left }
}

#[cfg(test)]
mod tests;
