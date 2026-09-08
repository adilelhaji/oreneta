use super::*;

fn signals() -> Signals {
    Signals::default()
}

#[test]
fn nothing_taught_yet_is_not_spam() {
    let verdict = verdict(&signals());
    assert!(!verdict.spam);
    assert_eq!(verdict.reasons, vec![Reason::NothingKnown]);
}

#[test]
fn one_spam_correction_alone_is_not_enough_to_brand_a_sender() {
    // A single click must not be able to bury every future message from
    // someone the reader was simply annoyed with once.
    let verdict = verdict(&Signals {
        sender_spam_count: 1,
        ..signals()
    });
    assert!(!verdict.spam);
    assert_eq!(verdict.reasons, vec![Reason::NothingKnown]);
}

#[test]
fn a_clear_lead_of_spam_confirmations_over_the_sender_flags_it() {
    let verdict = verdict(&Signals {
        sender_spam_count: 2,
        ..signals()
    });
    assert!(verdict.spam);
    assert_eq!(verdict.reasons, vec![Reason::SenderMarkedBefore]);
}

#[test]
fn a_ham_correction_since_lifts_the_flag_again() {
    // The reader can take a decision back the same way they can take
    // priority overrides back: by correcting it, not by it staying stuck.
    let verdict = verdict(&Signals {
        sender_spam_count: 3,
        sender_ham_count: 2,
        ..signals()
    });
    assert!(!verdict.spam);
    assert_eq!(verdict.reasons, vec![Reason::NothingKnown]);
}

#[test]
fn trigger_words_flag_it_even_with_no_sender_history() {
    let verdict = verdict(&Signals {
        trigger_words: vec!["viagra".to_string()],
        ..signals()
    });
    assert!(verdict.spam);
    assert_eq!(verdict.reasons, vec![Reason::TriggerWords]);
}

#[test]
fn both_reasons_can_apply_at_once_sender_first() {
    let verdict = verdict(&Signals {
        sender_spam_count: 5,
        trigger_words: vec!["prize".to_string()],
        ..signals()
    });
    assert!(verdict.spam);
    assert_eq!(verdict.reasons, vec![Reason::SenderMarkedBefore, Reason::TriggerWords]);
}

#[test]
fn a_trigger_word_needs_both_enough_occurrences_and_a_clear_lead() {
    assert!(!is_trigger(2, 0)); // under the minimum count
    assert!(is_trigger(3, 1)); // 3x lead, exactly at the ratio
    assert!(is_trigger(3, 0)); // three confirmations, never seen as ham
    assert!(is_trigger(6, 2)); // 3x lead, exactly at the ratio
    assert!(!is_trigger(6, 3)); // only 2x lead: an ordinary word appearing everywhere
}

#[test]
fn tokenize_lowercases_drops_short_words_and_dedupes() {
    let words = tokenize("FREE Free money money! Prize, a to me.");
    // "money" appears twice, folded to one; "a"/"to"/"me" are too short to count.
    assert_eq!(words, vec!["free", "money", "prize"]);
}

#[test]
fn tokenize_splits_on_punctuation_and_accents_stay_as_letters() {
    let words = tokenize("¡Gánate un préstamo increíble!");
    assert_eq!(words, vec!["gánate", "increíble", "préstamo"]);
}

#[test]
fn tokenize_of_empty_text_is_empty() {
    assert!(tokenize("").is_empty());
    assert!(tokenize("   ").is_empty());
}
