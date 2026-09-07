use super::*;

fn signals() -> Signals {
    Signals::default()
}

#[test]
fn what_the_reader_said_outranks_everything_the_app_worked_out() {
    // Nothing computed may quietly overrule a decision someone made in words.
    let demoted = verdict(Signals {
        written_to_sender: true,
        addressed_directly: true,
        sender_override: Some(false),
        ..signals()
    });
    assert!(!demoted.priority);
    assert_eq!(demoted.reasons, vec![Reason::YourChoice]);

    let promoted = verdict(Signals {
        automated_sender: true,
        sender_override: Some(true),
        ..signals()
    });
    assert!(promoted.priority);
    assert_eq!(promoted.reasons, vec![Reason::YourChoice]);
}

#[test]
fn someone_you_write_to_is_someone_worth_hearing_from() {
    let found = verdict(Signals {
        written_to_sender: true,
        ..signals()
    });
    assert!(found.priority);
    assert_eq!(found.reasons, vec![Reason::WrittenToSender]);
}

#[test]
fn mail_addressed_to_you_counts_and_mail_copied_to_you_does_not() {
    let direct = verdict(Signals {
        addressed_directly: true,
        ..signals()
    });
    assert!(direct.priority);
    assert_eq!(direct.reasons, vec![Reason::AddressedDirectly]);

    let copied = verdict(Signals {
        copied_in: true,
        ..signals()
    });
    assert!(!copied.priority);
    assert_eq!(copied.reasons, vec![Reason::OnlyCopiedIn]);
}

#[test]
fn a_correspondent_is_still_a_correspondent_from_a_no_reply_address() {
    // A ticketing system someone actually works through sends from an address
    // nobody reads. Demoting it because of the address would hide the work.
    let ticket = verdict(Signals {
        written_to_sender: true,
        automated_sender: true,
        ..signals()
    });
    assert!(ticket.priority);
    assert_eq!(ticket.reasons, vec![Reason::WrittenToSender]);
}

#[test]
fn an_automated_sender_nobody_knows_is_not_worth_interrupting_for() {
    let robot = verdict(Signals {
        automated_sender: true,
        ..signals()
    });
    assert!(!robot.priority);
    assert_eq!(robot.reasons, vec![Reason::AutomatedSender]);
}

#[test]
fn a_message_nothing_is_known_about_says_so() {
    // Not priority, and honest about why: the reader can see the app had
    // nothing to go on rather than being told it decided something.
    let unknown = verdict(signals());
    assert!(!unknown.priority);
    assert_eq!(unknown.reasons, vec![Reason::NothingKnown]);
}

#[test]
fn every_verdict_carries_a_reason() {
    // The whole point. A verdict with no reason is the thing this exists not
    // to be.
    for over in [None, Some(true), Some(false)] {
        for written in [false, true] {
            for direct in [false, true] {
                for copied in [false, true] {
                    for auto in [false, true] {
                        let result = verdict(Signals {
                            written_to_sender: written,
                            addressed_directly: direct,
                            copied_in: copied,
                            automated_sender: auto,
                            sender_override: over,
                        });
                        assert!(!result.reasons.is_empty(), "{result:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn addresses_nobody_reads_replies_at_are_recognised() {
    for addr in [
        "no-reply@example.com",
        "noreply@example.com",
        "NoReply@Example.com",
        "do-not-reply@example.com",
        "mailer-daemon@example.com",
        "postmaster@example.com",
        "bounces@example.com",
        "notifications@example.com",
        "noreply-account@example.com",
    ] {
        assert!(looks_automated(addr), "{addr}");
    }
}

#[test]
fn a_person_is_not_called_a_robot_for_looking_like_one() {
    // Being wrong in this direction hides someone's mail, which is the
    // failure that matters. The list stays conservative on purpose.
    for addr in [
        "ann@example.com",
        "replies@example.com",
        "reply@example.com",
        "info@example.com",
        "support@example.com",
        "noreplacement@example.com",
        "annette.noreen@example.com",
    ] {
        assert!(!looks_automated(addr), "{addr}");
    }
}
