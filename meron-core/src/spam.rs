//! Whether a new arrival is spam the reader has already taught this app about.
//!
//! Same posture as `priority`: nothing here files a message on its own. A
//! wrong guess in that direction would bury mail nobody meant to hide, which
//! is the one failure this feature must not have — so it only ever offers a
//! reason and a one-click "move it" button, and the reader decides.
//!
//! Two signals, both things a person can check: has the reader confirmed
//! spam from this exact sender before, and does the subject contain words
//! that have recurred in spam-confirmed messages clearly more than in ones
//! said not to be. No opaque score, no body text (not every message has its
//! body fetched yet, and a signal that only sometimes exists is not one this
//! feature can be honest about).

use serde::Serialize;

#[cfg(test)]
mod tests;

/// A word has to have shown up in at least this many spam-confirmed messages
/// before it can be a reason on its own — one correction must never be
/// enough to brand a word for every message afterward.
pub const TRIGGER_MIN_COUNT: u32 = 3;

/// ...and it must have shown up at least this many times more often in
/// spam-confirmed messages than in ones the reader said were not spam,
/// against a floor of one so a word never confirmed as ham isn't divided by
/// zero into an infinite ratio.
pub const TRIGGER_MIN_RATIO: f64 = 3.0;

/// A sender needs a net lead of at least this many spam confirmations over
/// "not spam" ones before their history alone counts as a reason.
pub const SENDER_MIN_LEAD: u32 = 2;

/// What is known about one arrival, all of it already taught by the reader.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Signals {
    /// How many times the reader has confirmed spam from this exact sender.
    pub sender_spam_count: u32,
    /// How many times they said mail from this sender was not spam.
    pub sender_ham_count: u32,
    /// Subject words that have recurred in spam-confirmed messages clearly
    /// more than in ham-confirmed ones — see `TRIGGER_MIN_COUNT`/`_RATIO`.
    pub trigger_words: Vec<String>,
}

/// Why a message is flagged, in terms a person can check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    SenderMarkedBefore,
    TriggerWords,
    NothingKnown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub spam: bool,
    /// In the order they were applied; the first is the one that decided it.
    pub reasons: Vec<Reason>,
}

/// Whether an arrival looks like spam by what the reader has taught this
/// account, and why.
pub fn verdict(signals: &Signals) -> Verdict {
    let mut reasons = Vec::new();
    let sender_says_spam = signals
        .sender_spam_count
        .saturating_sub(signals.sender_ham_count)
        >= SENDER_MIN_LEAD;
    if sender_says_spam {
        reasons.push(Reason::SenderMarkedBefore);
    }
    if !signals.trigger_words.is_empty() {
        reasons.push(Reason::TriggerWords);
    }
    let spam = sender_says_spam || !signals.trigger_words.is_empty();
    if reasons.is_empty() {
        reasons.push(Reason::NothingKnown);
    }
    Verdict { spam, reasons }
}

/// Whether a stored trigger word's counts clear the bar to be a reason.
pub fn is_trigger(spam_count: u32, ham_count: u32) -> bool {
    spam_count >= TRIGGER_MIN_COUNT && f64::from(spam_count) >= TRIGGER_MIN_RATIO * f64::from(ham_count.max(1))
}

/// Splits a subject line into the distinct words worth counting.
///
/// Lowercased, alphanumeric runs only, each word once regardless of how many
/// times it repeats in the same subject — so one shouted subject cannot
/// outweigh three ordinary ones when the counts are added up later. Short
/// words are dropped: they are the ones likeliest to be ordinary language in
/// every locale this app is used in, not a real signal.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .map(|word| word.to_lowercase())
        .filter(|word| word.chars().count() >= 4)
        .collect();
    words.sort();
    words.dedup();
    words
}
