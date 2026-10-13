use super::groups::*;
use super::person::people_from_vcards;
use super::vcard::split_cards;

const V4_GROUP: &str = "BEGIN:VCARD\r\nVERSION:4.0\r\nKIND:group\r\nUID:g-1\r\nFN:Climbing\r\n\
MEMBER:urn:uuid:ana\r\nMEMBER:urn:uuid:marc\r\nMEMBER:mailto:club@example.com\r\n\
X-CUSTOM;X-PARAM=keep:something only one client reads\r\nCATEGORIES:sport,weekend\r\nEND:VCARD\r\n";

const APPLE_GROUP: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//Mac OS X 10.15//EN\r\n\
N:Family;;;;\r\nFN:Family\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nUID:g-2\r\n\
X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ana\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:lost-card\r\n\
REV:2020-01-01T00:00:00Z\r\nEND:VCARD\r\n";

fn group(card: &str) -> GroupCard {
    let cards = split_cards(card.as_bytes());
    group_from_properties(&cards[0]).expect("a group")
}

#[test]
fn a_vcard4_group_is_read_with_its_members() {
    let found = group(V4_GROUP);
    assert_eq!(found.uid, "g-1");
    assert_eq!(found.name, "Climbing");
    assert_eq!(found.style, GroupStyle::Vcard4);
    // A mailto: member is kept in the card but is not somebody here.
    assert_eq!(found.members, vec!["ana", "marc"]);
}

#[test]
fn an_apple_group_is_read_with_its_members() {
    let found = group(APPLE_GROUP);
    assert_eq!(found.uid, "g-2");
    assert_eq!(found.name, "Family");
    assert_eq!(found.style, GroupStyle::Apple);
    assert_eq!(found.members, vec!["ana", "lost-card"]);
}

#[test]
fn an_apple_group_with_only_n_is_named_by_it() {
    let card = APPLE_GROUP.replace("FN:Family\r\n", "");
    assert_eq!(group(&card).name, "Family");
}

#[test]
fn a_group_card_is_not_a_person() {
    let book = format!(
        "{V4_GROUP}{APPLE_GROUP}BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ana\r\nFN:Ana Prat\r\nEND:VCARD\r\n"
    );
    let people = people_from_vcards(book.as_bytes());
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].name, "Ana Prat");
    assert_eq!(groups_from_vcards(book.as_bytes()).len(), 2);
}

#[test]
fn member_values_are_read_by_urn_or_bare_uid() {
    assert_eq!(member_uid("urn:uuid:abc"), Some("abc".into()));
    assert_eq!(member_uid("URN:UUID:abc "), Some("abc".into()));
    assert_eq!(member_uid("abc-123"), Some("abc-123".into()));
    assert_eq!(member_uid("mailto:x@example.com"), None);
    assert_eq!(member_uid("urn:uuid:"), None);
    assert_eq!(member_uid(""), None);
}

#[test]
fn a_new_group_round_trips_in_both_styles() {
    let members = vec!["ana".to_string(), "marc".to_string()];
    for style in [GroupStyle::Vcard4, GroupStyle::Apple] {
        let card = new_group_card("Book club; Tuesdays", "g-9", &members, style);
        let read = group(&card);
        assert_eq!(read.uid, "g-9");
        assert_eq!(read.name, "Book club; Tuesdays");
        assert_eq!(read.members, members);
        assert_eq!(read.style, style);
        assert!(people_from_vcards(card.as_bytes()).is_empty());
    }
    let v4 = new_group_card("G", "g", &members, GroupStyle::Vcard4);
    assert!(v4.contains("VERSION:4.0\r\n") && v4.contains("KIND:group\r\n") && v4.contains("MEMBER:urn:uuid:ana\r\n"));
    let apple = new_group_card("G", "g", &members, GroupStyle::Apple);
    assert!(apple.contains("VERSION:3.0\r\n") && apple.contains("N:G;;;;\r\n"));
    assert!(apple.contains("X-ADDRESSBOOKSERVER-KIND:group\r\n"));
    assert!(apple.contains("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:marc\r\n"));
    assert!(!apple.contains("\r\nKIND:"));
}

#[test]
fn membership_changes_keep_every_other_line() {
    let patched = patch_group_card(V4_GROUP, "Climbing", &["jo".into()], &["marc".into()], 1_700_000_000).unwrap();
    let read = group(&patched);
    assert_eq!(read.members, vec!["ana", "jo"]);
    // Unknown fields, the unresolvable member and the KIND are untouched.
    for line in [
        "X-CUSTOM;X-PARAM=keep:something only one client reads",
        "CATEGORIES:sport,weekend",
        "MEMBER:mailto:club@example.com",
        "KIND:group",
        "FN:Climbing",
    ] {
        assert!(patched.contains(&format!("{line}\r\n")), "lost {line}:\n{patched}");
    }
    assert!(!patched.contains("urn:uuid:marc"));
    // Added the way the card writes its members.
    assert!(patched.contains("MEMBER:urn:uuid:jo\r\n"));
    assert!(!patched.contains("X-ADDRESSBOOKSERVER-MEMBER"));
}

#[test]
fn an_apple_group_is_changed_in_its_own_terms() {
    let patched = patch_group_card(APPLE_GROUP, "Family & friends", &["marc".into()], &[], 1_700_000_000).unwrap();
    let read = group(&patched);
    assert_eq!(read.name, "Family & friends");
    // A member whose card this app never saw stays a member.
    assert_eq!(read.members, vec!["ana", "lost-card", "marc"]);
    assert!(patched.contains("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:marc\r\n"));
    assert!(patched.contains("N:Family & friends;;;;\r\n"));
    assert!(patched.contains("PRODID:-//Apple Inc.//Mac OS X 10.15//EN\r\n"));
    assert!(patched.contains("REV:20231114T221320Z\r\n"));
    assert!(!patched.contains("2020-01-01"));
}

#[test]
fn an_unchanged_group_comes_back_as_it_was_apart_from_rev() {
    let patched = patch_group_card(V4_GROUP, "Climbing", &[], &[], 0).unwrap();
    assert_eq!(patched, V4_GROUP);
}

#[test]
fn a_card_that_is_not_a_group_is_not_patched_as_one() {
    let person = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ana\r\nFN:Ana\r\nEND:VCARD\r\n";
    assert!(patch_group_card(person, "X", &[], &[], 0).is_err());
}

#[test]
fn a_new_group_follows_the_book() {
    let v3 = vec!["3.0".to_string()];
    let v4 = vec!["3.0".to_string(), "4.0".to_string()];
    assert_eq!(style_for_book(&[], &v3), GroupStyle::Apple);
    assert_eq!(style_for_book(&[], &v4), GroupStyle::Vcard4);
    assert_eq!(style_for_book(&[], &[]), GroupStyle::Apple);
    // The book's own groups decide over its cards' version.
    assert_eq!(style_for_book(&[GroupStyle::Apple], &v4), GroupStyle::Apple);
    assert_eq!(style_for_book(&[GroupStyle::Vcard4], &v3), GroupStyle::Vcard4);
}
