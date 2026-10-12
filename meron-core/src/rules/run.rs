//! Running the rules on mail already in a folder, exactly as previewed (#50).
//!
//! The preview is what is confirmed: the messages it listed and the steps it
//! showed for each, not the rules evaluated again at confirmation over a
//! folder that may have changed. A run is single-use, bound to its account,
//! its folder's UIDVALIDITY and the rules as they were stored when it was
//! shown; any of those changing means preview again. Like a sweep's review,
//! it lives in memory: a restart forgets it, which is the safe direction.

use std::collections::HashMap;
use std::sync::Mutex;

use super::Planned;

pub const REVIEW_TTL_SECONDS: i64 = 15 * 60;
pub const MAX_PENDING: usize = 16;

#[derive(Debug, Clone)]
pub struct ReviewedMessage {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub steps: Vec<Planned>,
}

#[derive(Debug, Clone)]
pub struct ReviewedRun {
    pub id: String,
    pub account: String,
    pub folder: String,
    pub uidvalidity: u32,
    /// The stored rules when the preview was taken.
    pub rules_fingerprint: String,
    pub messages: Vec<ReviewedMessage>,
    pub issued_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Unknown,
    WrongAccount,
    FolderChanged,
    RulesChanged,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RunError::Unknown => "this run was already done or its preview is no longer current; preview it again",
            RunError::WrongAccount => "this run was previewed for another account",
            RunError::FolderChanged => "the folder changed since the preview and its messages may differ; preview it again",
            RunError::RulesChanged => "the rules changed since the preview; preview them again",
        })
    }
}

impl std::error::Error for RunError {}

/// A fingerprint of the stored rules, to tell whether they changed.
pub fn fingerprint(rules: &[super::Rule]) -> String {
    let text = serde_json::to_string(rules).unwrap_or_default();
    let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    digest.as_ref()[..12].iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Default)]
pub struct Registry {
    pending: Mutex<HashMap<String, ReviewedRun>>,
}

impl Registry {
    #[allow(clippy::too_many_arguments)]
    pub fn issue(
        &self,
        account: &str,
        folder: &str,
        uidvalidity: u32,
        rules_fingerprint: &str,
        messages: Vec<ReviewedMessage>,
        now: i64,
    ) -> String {
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        pending.retain(|_, run| now - run.issued_at < REVIEW_TTL_SECONDS);
        while pending.len() >= MAX_PENDING {
            let Some(oldest) = pending.values().min_by_key(|r| r.issued_at).map(|r| r.id.clone()) else { break };
            pending.remove(&oldest);
        }
        let id = format!("rules-{}", uuid::Uuid::new_v4());
        pending.insert(
            id.clone(),
            ReviewedRun {
                id: id.clone(),
                account: account.into(),
                folder: folder.into(),
                uidvalidity,
                rules_fingerprint: rules_fingerprint.into(),
                messages,
                issued_at: now,
            },
        );
        id
    }

    /// Takes a run out for use, once, if nothing it depends on changed.
    pub fn take(
        &self,
        id: &str,
        account: &str,
        current_uidvalidity: u32,
        current_rules: &str,
        now: i64,
    ) -> Result<ReviewedRun, RunError> {
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        let run = pending.get(id).ok_or(RunError::Unknown)?;
        if now - run.issued_at >= REVIEW_TTL_SECONDS {
            pending.remove(id);
            return Err(RunError::Unknown);
        }
        if run.account != account {
            return Err(RunError::WrongAccount);
        }
        // Spent either way: a changed folder or rule set needs a new preview.
        let run = pending.remove(id).expect("present");
        if run.uidvalidity != current_uidvalidity {
            return Err(RunError::FolderChanged);
        }
        if run.rules_fingerprint != current_rules {
            return Err(RunError::RulesChanged);
        }
        Ok(run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_with_one() -> (Registry, String) {
        let registry = Registry::default();
        let id = registry.issue("acct", "INBOX", 7, "f1", vec![], 100);
        (registry, id)
    }

    #[test]
    fn a_run_is_used_once_and_only_as_previewed() {
        let (registry, id) = registry_with_one();
        assert_eq!(registry.take(&id, "other", 7, "f1", 101).unwrap_err(), RunError::WrongAccount);
        assert!(registry.take(&id, "acct", 7, "f1", 101).is_ok());
        assert_eq!(registry.take(&id, "acct", 7, "f1", 102).unwrap_err(), RunError::Unknown, "once");

        let (registry, id) = registry_with_one();
        assert_eq!(registry.take(&id, "acct", 8, "f1", 101).unwrap_err(), RunError::FolderChanged);
        let (registry, id) = registry_with_one();
        assert_eq!(registry.take(&id, "acct", 7, "f2", 101).unwrap_err(), RunError::RulesChanged);
        let (registry, id) = registry_with_one();
        assert_eq!(registry.take(&id, "acct", 7, "f1", 100 + REVIEW_TTL_SECONDS).unwrap_err(), RunError::Unknown);
    }

    #[test]
    fn the_fingerprint_follows_the_rules() {
        let rule = |name: &str| super::super::Rule {
            id: "r".into(),
            account: String::new(),
            name: name.into(),
            enabled: true,
            match_mode: super::super::Match::All,
            conditions: vec![],
            actions: vec![],
        };
        assert_eq!(fingerprint(&[rule("a")]), fingerprint(&[rule("a")]));
        assert_ne!(fingerprint(&[rule("a")]), fingerprint(&[rule("b")]));
    }
}
