//! Which arrivals are worth interrupting someone for.
//!
//! Outlook has Focused and Other, BlueMail has Clusters, and neither will tell
//! you why a message landed where it did. That is the part not copied here.
//! Every verdict carries its reasons, the reasons are things a person can
//! check ("you have written to them", "you are in To"), and disagreeing with
//! one is a decision the reader can record rather than a model they have to
//! argue with.
//!
//! Deliberately not a model at all. A handful of stated rules can be read,
//! explained and overruled; a score cannot, and a mailbox that hides mail for
//! reasons nobody can state is not one to put a clinic's post in.

use serde::Serialize;

#[cfg(test)]
mod tests;

/// What is known about one arrival, all of it from the message and the local
/// store — nothing is asked of a server and nothing is sent anywhere.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Signals {
    /// This account has sent mail to the sender before.
    pub written_to_sender: bool,
    /// One of the account's own addresses is in To, not only in Cc.
    pub addressed_directly: bool,
    /// Only in Cc — copied in, not asked.
    pub copied_in: bool,
    /// The sender's address is one nobody reads replies at.
    pub automated_sender: bool,
    /// The reader has said, in so many words, what this sender is.
    pub sender_override: Option<bool>,
}

/// Why a message is where it is, in terms a person can check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// The reader said so about this sender, which outranks everything.
    YourChoice,
    WrittenToSender,
    AddressedDirectly,
    OnlyCopiedIn,
    AutomatedSender,
    /// Nothing was known either way.
    NothingKnown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub priority: bool,
    /// In the order they were applied. The first is the one that decided it.
    pub reasons: Vec<Reason>,
}

/// Whether an address is one nobody reads replies at.
///
/// A conservative list of the local parts that say so outright. A sender is
/// not called automated for looking like a robot — being wrong in that
/// direction hides a person's mail, which is the failure that matters.
pub fn looks_automated(addr: &str) -> bool {
    let local = addr.split('@').next().unwrap_or("").to_ascii_lowercase();
    let flattened: String = local.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    matches!(
        flattened.as_str(),
        "noreply"
            | "donotreply"
            | "nlreply"
            | "notifications"
            | "notification"
            | "mailerdaemon"
            | "postmaster"
            | "bounce"
            | "bounces"
            | "automailer"
            | "autoreply"
    ) || flattened.starts_with("noreply")
        || flattened.starts_with("donotreply")
}

/// Whether an arrival belongs in front of someone, and why.
///
/// The order is the explanation. What the reader decided comes first, because
/// nothing the app works out should quietly overrule what they said. After
/// that: someone they correspond with, or mail addressed to them and not
/// merely copied to them.
pub fn verdict(signals: Signals) -> Verdict {
    if let Some(chosen) = signals.sender_override {
        return Verdict {
            priority: chosen,
            reasons: vec![Reason::YourChoice],
        };
    }

    let mut reasons = Vec::new();
    if signals.written_to_sender {
        reasons.push(Reason::WrittenToSender);
    }
    if signals.addressed_directly {
        reasons.push(Reason::AddressedDirectly);
    }
    // A correspondent is a correspondent even from a no-reply address — a
    // ticketing system someone actually works through is the obvious case —
    // so this only decides when nothing else spoke for the message.
    if signals.automated_sender && reasons.is_empty() {
        return Verdict {
            priority: false,
            reasons: vec![Reason::AutomatedSender],
        };
    }
    if signals.copied_in && !signals.addressed_directly {
        reasons.push(Reason::OnlyCopiedIn);
    }

    let priority = signals.written_to_sender || signals.addressed_directly;
    if reasons.is_empty() {
        reasons.push(Reason::NothingKnown);
    }
    Verdict { priority, reasons }
}
