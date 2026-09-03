//! Text the writer keeps because they write it often.
//!
//! Two shapes, told apart by where the text lands. A [`Kind::Snippet`] is a
//! paragraph dropped in at the cursor — the directions to the office, the
//! standard disclaimer at the foot of a quote. A [`Kind::Message`] is a whole
//! mail with its own subject, opened rather than inserted.
//!
//! One type rather than two, because they differ in how they are used and not
//! in what they are: someone who wrote a snippet and then wanted a subject on
//! it should change a field, not delete it and start again.
//!
//! Both bodies are carried. The composer works in rich text or in plain, and a
//! template that could only be pasted into one of them would be half a
//! feature; deriving one from the other at the moment of use would mean
//! guessing, so both are stored and the composer takes the one it needs.

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

/// Where a template's text lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Inserted where the cursor is, into a message being written.
    Snippet,
    /// Opened as a message of its own, subject and all.
    Message,
}

impl Kind {
    /// How the kind is spelled in the store and on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Snippet => "snippet",
            Kind::Message => "message",
        }
    }

    /// Reads a stored kind, treating anything unrecognised as a snippet.
    ///
    /// A row written by a later version naming a kind this one has never
    /// heard of still holds text somebody wrote. Refusing to show it would
    /// lose their work over a word; showing it as the more modest of the two
    /// shapes shows it and does less.
    pub fn parse(value: &str) -> Kind {
        match value {
            "message" => Kind::Message,
            _ => Kind::Snippet,
        }
    }
}

/// One piece of kept text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub kind: Kind,
    /// What it is called in the list. Not the subject: a template called
    /// "Decline politely" may have a subject of "Re: your proposal".
    pub name: String,
    pub subject: String,
    pub body_html: String,
    pub body_text: String,
}

/// What is missing from a template that cannot be saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    /// Nothing to call it by in the list.
    NeedsName,
    /// A snippet is its text; without one there is nothing to insert.
    NeedsBody,
    /// A message template with neither a subject nor a body does nothing.
    NeedsSubjectOrBody,
}

impl Problem {
    /// The problem in words, for a message a person may end up reading.
    ///
    /// The interface validates before it saves and says this in the reader's
    /// own language; this is what reaches them when something got past that —
    /// a script, a restored file, a version mismatch. Prose rather than the
    /// enum's name, because `NeedsSubjectOrBody` is not an explanation.
    pub fn describe(self) -> &'static str {
        match self {
            Problem::NeedsName => "a template needs a name",
            Problem::NeedsBody => "a snippet needs some text",
            Problem::NeedsSubjectOrBody => "a message template needs a subject or a body",
        }
    }
}

/// Whether the text of a template is empty in both forms it is kept in.
fn body_is_empty(template: &Template) -> bool {
    template.body_html.trim().is_empty() && template.body_text.trim().is_empty()
}

/// What is wrong with a template, or `None` when it can be saved.
///
/// Checked here rather than at the edge so that the composer, the settings
/// screen and the bridge all refuse the same things for the same reasons.
pub fn validate(template: &Template) -> Option<Problem> {
    if template.name.trim().is_empty() {
        return Some(Problem::NeedsName);
    }
    match template.kind {
        Kind::Snippet if body_is_empty(template) => Some(Problem::NeedsBody),
        Kind::Message if body_is_empty(template) && template.subject.trim().is_empty() => {
            Some(Problem::NeedsSubjectOrBody)
        }
        _ => None,
    }
}
