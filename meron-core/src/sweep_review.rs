//! What a sweep was shown before it was agreed to.
//!
//! A sweep is the one action that reaches messages the reader is not looking
//! at, so it is previewed first and the preview is what gets confirmed: not
//! "everything from this sender older than the newest one" computed again at
//! confirmation, which by then may include mail nobody was shown, but the
//! exact messages that were on the screen. This registry keeps each preview
//! as a single-use review: confirmed once, bound to its account, folder and
//! the folder's UIDVALIDITY, and forgotten after a while.
//!
//! Reviews live in memory. A restart forgets them, which is the safe
//! direction: a preview from before the restart was of a mailbox that may
//! have changed since, and asking for it again costs one click.

use std::collections::HashMap;
use std::sync::Mutex;

/// How long a preview stays confirmable. Long enough to read a list of
/// subjects and decide; short enough that a stale tab cannot act on a
/// mailbox as it was an hour ago.
pub const REVIEW_TTL_SECONDS: i64 = 15 * 60;

/// How many previews are held at once. Beyond this the oldest is dropped;
/// a reader does not have sixty-four sweeps open.
pub const MAX_PENDING: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewedSweep {
    pub id: String,
    pub account: String,
    pub folder: String,
    /// The folder's UIDVALIDITY when the preview was taken, or zero when the
    /// store had none. UIDs only mean the same messages while it holds.
    pub uidvalidity: u32,
    /// Exactly what was shown, in the order it was shown.
    pub uids: Vec<u32>,
    pub issued_at: i64,
}

/// Why a review could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewError {
    /// Never issued, already used, or expired: there is no telling which,
    /// and the answer is the same — preview again.
    Unknown,
    /// Issued for another account. Never acted on.
    WrongAccount,
    /// The folder's UIDVALIDITY changed since the preview: the UIDs may now
    /// name different messages, so nothing is moved.
    FolderChanged { reviewed: u32, current: u32 },
}

impl std::fmt::Display for ReviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReviewError::Unknown => f.write_str(
                "this sweep was already done or its preview is no longer current; preview it again",
            ),
            ReviewError::WrongAccount => f.write_str("this sweep was previewed for another account"),
            ReviewError::FolderChanged { .. } => {
                f.write_str("the folder changed since the preview and its messages may differ; preview it again")
            }
        }
    }
}

impl std::error::Error for ReviewError {}

#[derive(Default)]
pub struct Registry {
    pending: Mutex<HashMap<String, ReviewedSweep>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a preview and hands back its id. Expired reviews are dropped
    /// on the way; so is the oldest when the registry is full.
    pub fn issue(&self, account: &str, folder: &str, uidvalidity: u32, uids: Vec<u32>, now: i64) -> String {
        let mut pending = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.retain(|_, review| now - review.issued_at < REVIEW_TTL_SECONDS);
        while pending.len() >= MAX_PENDING {
            let oldest = pending
                .values()
                .min_by_key(|review| review.issued_at)
                .map(|review| review.id.clone());
            match oldest {
                Some(id) => {
                    pending.remove(&id);
                }
                None => break,
            }
        }
        let id = format!("sweep-{}", uuid::Uuid::new_v4());
        pending.insert(
            id.clone(),
            ReviewedSweep {
                id: id.clone(),
                account: account.to_string(),
                folder: folder.to_string(),
                uidvalidity,
                uids,
                issued_at: now,
            },
        );
        id
    }

    /// Takes a review out for use. Single-use: a second call with the same id
    /// finds nothing, which is what stops a double confirmation from sweeping
    /// twice. A review for another account is refused and left in place.
    pub fn take(&self, id: &str, account: &str, now: i64) -> Result<ReviewedSweep, ReviewError> {
        let mut pending = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let review = pending.get(id).ok_or(ReviewError::Unknown)?;
        if now - review.issued_at >= REVIEW_TTL_SECONDS {
            pending.remove(id);
            return Err(ReviewError::Unknown);
        }
        if review.account != account {
            return Err(ReviewError::WrongAccount);
        }
        Ok(pending.remove(id).expect("present"))
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

/// Whether the reviewed UIDs still name the messages they named: the folder's
/// UIDVALIDITY must be what it was at preview time. A store that knew no
/// value then and none now is taken at its word; a value that appeared or
/// changed is not.
pub fn check_folder_unchanged(review: &ReviewedSweep, current_uidvalidity: Option<u32>) -> Result<(), ReviewError> {
    let current = current_uidvalidity.unwrap_or(0);
    if current == review.uidvalidity {
        Ok(())
    } else {
        Err(ReviewError::FolderChanged { reviewed: review.uidvalidity, current })
    }
}

/// What a confirmed sweep came to, item by item: the reviewed messages that
/// are gone from the folder, and the ones still there. Never a bare success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepOutcome {
    pub swept: Vec<u32>,
    pub unresolved: Vec<u32>,
}

impl SweepOutcome {
    /// Splits the reviewed set by what is still in the source folder after
    /// the move was attempted.
    pub fn from_remaining(reviewed: &[u32], remaining: &[u32]) -> Self {
        let mut swept = Vec::new();
        let mut unresolved = Vec::new();
        for uid in reviewed {
            if remaining.contains(uid) {
                unresolved.push(*uid);
            } else {
                swept.push(*uid);
            }
        }
        Self { swept, unresolved }
    }

    pub fn complete(&self) -> bool {
        self.unresolved.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_is_confirmable_once_and_only_for_its_account() {
        let registry = Registry::new();
        let id = registry.issue("acct", "INBOX", 42, vec![3, 2, 1], 1_000);
        assert!(id.starts_with("sweep-"));

        assert_eq!(registry.take(&id, "other", 1_001), Err(ReviewError::WrongAccount));
        // Refused, but not consumed: the right account can still use it.
        let review = registry.take(&id, "acct", 1_002).expect("issued for acct");
        assert_eq!(review.uids, vec![3, 2, 1], "exactly what was shown, in order");
        assert_eq!(review.uidvalidity, 42);
        assert_eq!(review.folder, "INBOX");

        // Acceptance: double confirmation does not silently repeat the operation.
        assert_eq!(registry.take(&id, "acct", 1_003), Err(ReviewError::Unknown));
        assert_eq!(registry.take("sweep-never-issued", "acct", 1_003), Err(ReviewError::Unknown));
    }

    #[test]
    fn a_preview_expires_and_the_registry_stays_bounded() {
        let registry = Registry::new();
        let id = registry.issue("acct", "INBOX", 1, vec![1], 1_000);
        assert_eq!(registry.take(&id, "acct", 1_000 + REVIEW_TTL_SECONDS), Err(ReviewError::Unknown));

        for i in 0..(MAX_PENDING + 10) {
            registry.issue("acct", "INBOX", 1, vec![i as u32], 2_000 + i as i64);
        }
        assert_eq!(registry.len(), MAX_PENDING);
        // Issuing later also sweeps out what has expired.
        registry.issue("acct", "INBOX", 1, vec![1], 2_000 + MAX_PENDING as i64 + 10 + REVIEW_TTL_SECONDS);
        assert_eq!(registry.len(), 1);
    }

    /// Acceptance: a stale UIDVALIDITY cannot target an unrelated message.
    #[test]
    fn a_changed_folder_refuses_the_reviewed_uids() {
        let review = ReviewedSweep {
            id: "sweep-1".into(),
            account: "acct".into(),
            folder: "INBOX".into(),
            uidvalidity: 42,
            uids: vec![1, 2],
            issued_at: 0,
        };
        assert_eq!(check_folder_unchanged(&review, Some(42)), Ok(()));
        assert_eq!(
            check_folder_unchanged(&review, Some(43)),
            Err(ReviewError::FolderChanged { reviewed: 42, current: 43 })
        );
        assert_eq!(
            check_folder_unchanged(&review, None),
            Err(ReviewError::FolderChanged { reviewed: 42, current: 0 })
        );
        let unknown = ReviewedSweep { uidvalidity: 0, ..review };
        assert_eq!(check_folder_unchanged(&unknown, None), Ok(()));
        assert!(check_folder_unchanged(&unknown, Some(7)).is_err());
    }

    /// Acceptance: a partial failure identifies completed and unresolved
    /// items and never displays total success.
    #[test]
    fn an_outcome_names_what_went_and_what_did_not() {
        let outcome = SweepOutcome::from_remaining(&[5, 4, 3], &[4, 9]);
        assert_eq!(outcome.swept, vec![5, 3]);
        assert_eq!(outcome.unresolved, vec![4]);
        assert!(!outcome.complete());
        assert!(SweepOutcome::from_remaining(&[5, 4], &[]).complete());
        assert_eq!(SweepOutcome::from_remaining(&[], &[1]).swept, Vec::<u32>::new());
    }

    #[test]
    fn errors_tell_the_reader_to_preview_again() {
        assert!(ReviewError::Unknown.to_string().contains("preview it again"));
        assert!(
            ReviewError::FolderChanged { reviewed: 1, current: 2 }
                .to_string()
                .contains("preview it again")
        );
    }
}
