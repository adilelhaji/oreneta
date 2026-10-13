use super::person::{people_from_vcards, EmailAddress, Person, PhoneNumber};
use super::vcard_write::{new_card, patch_card};

const APPLE: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//iPhone OS 17.0//EN\r\nN:Prat;Ana;;;\r\nFN:Ana Prat\r\nORG:Hospital de Mataró;\r\nitem1.EMAIL;type=INTERNET:ana@hospital.cat\r\nitem1.X-ABLabel:_$!<Work>!$_\r\nEMAIL;type=HOME:ana@casa.cat\r\nTEL;type=CELL:+34 600 000 000\r\nADR;type=HOME:;;Carrer Major 1;Mataró;;08301;Spain\r\nBDAY:1985-04-02\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD\r\n X-SOCIALPROFILE;type=linkedin:x-apple:anaprat\r\nREV:2024-01-01T00:00:00Z\r\nUID:3F2504E0-4F89-11D3-9A0C-0305E82C3301\r\nEND:VCARD\r\n";

fn edited(change: impl FnOnce(&mut Person)) -> (String, Person) {
    let mut person = people_from_vcards(APPLE.as_bytes()).remove(0);
    change(&mut person);
    let card = patch_card(APPLE, &person, 1_790_000_000).unwrap();
    (card.clone(), people_from_vcards(card.as_bytes()).remove(0))
}

#[test]
fn an_unchanged_card_keeps_every_line_but_the_revision() {
    let (card, _) = edited(|_| {});
    for line in ["ADR;type=HOME:;;Carrer Major 1;Mataró;;08301;Spain", "BDAY:1985-04-02", "N:Prat;Ana;;;", "item1.X-ABLabel:_$!<Work>!$_", "UID:3F2504E0-4F89-11D3-9A0C-0305E82C3301"] {
        assert!(card.contains(line), "kept: {line}\n{card}");
    }
    assert!(card.contains("REV:20260921T"), "{card}");
    assert!(card.replace("\r\n ", "").contains("PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAADX-SOCIALPROFILE"), "a folded line is kept whole");
}

#[test]
fn editing_the_note_and_adding_an_address_changes_only_those() {
    let (card, after) = edited(|person| {
        person.note = "Met at the congress; call first".into();
        person.emails.push(EmailAddress { addr: "ana@new.cat".into(), label: "work".into() });
    });
    assert_eq!(after.note, "Met at the congress; call first");
    assert!(card.contains("NOTE:Met at the congress\\; call first"));
    assert!(after.emails.iter().any(|e| e.addr == "ana@new.cat"));
    assert!(card.contains("N:Prat;Ana;;;"), "the structured name stays when the name did not change");
    assert!(card.contains("BDAY:1985-04-02"));
}

#[test]
fn removing_an_address_removes_its_label_and_nothing_else() {
    let (card, after) = edited(|person| person.emails.retain(|e| e.addr != "ana@hospital.cat"));
    assert!(!card.contains("ana@hospital.cat"));
    assert!(!card.contains("X-ABLabel"), "its label went with it");
    assert_eq!(after.emails.len(), 1);
    assert!(card.contains("ADR;type=HOME"));
}

#[test]
fn renaming_rewrites_fn_and_n_and_a_number_matches_whatever_its_spacing() {
    let (card, after) = edited(|person| {
        person.name = "Ana Prat i Soler".into();
        person.phones = vec![PhoneNumber { number: "+34600000000".into(), label: String::new() }];
    });
    assert_eq!(after.name, "Ana Prat i Soler");
    assert!(card.contains("N:;Ana Prat i Soler;;;"));
    assert!(card.contains("TEL;type=CELL:+34 600 000 000"), "same number, line kept as written");
}

#[test]
fn a_new_card_reads_back_as_the_person_it_was_made_from() {
    let person = Person {
        name: "Cy Dao, Jr.".into(),
        organisation: "Acme; Ltd".into(),
        note: "line one\nline two".into(),
        emails: vec![EmailAddress { addr: "cy@example.com".into(), label: "work".into() }],
        phones: vec![PhoneNumber { number: "+1 555 0100".into(), label: String::new() }],
        ..Default::default()
    };
    let card = new_card(&person, "uid-1");
    let back = people_from_vcards(card.as_bytes()).remove(0);
    assert_eq!((back.name.as_str(), back.organisation.as_str(), back.note.as_str()), ("Cy Dao, Jr.", "Acme; Ltd", "line one\nline two"));
    assert_eq!(back.uid, "uid-1");
    assert_eq!(back.emails[0].addr, "cy@example.com");
    assert!(card.lines().all(|line| line.len() <= 76), "folded");
}

#[test]
fn a_long_line_is_folded_without_splitting_a_character() {
    let person = Person { name: "Ñ".repeat(60), ..Default::default() };
    let card = new_card(&person, "u");
    let back = people_from_vcards(card.as_bytes()).remove(0);
    assert_eq!(back.name, "Ñ".repeat(60));
}

#[test]
fn an_exported_card_says_where_it_came_from_and_reads_back() {
    let person = Person { name: "Ana".into(), ..Default::default() };
    let card = super::vcard_write::export_card(&person, "u1", "carddav");
    assert!(card.contains("X-ORENETA-SOURCE:carddav\r\nEND:VCARD"), "{card}");
    assert_eq!(people_from_vcards(card.as_bytes())[0].name, "Ana");
}

#[test]
fn an_import_preview_counts_what_cannot_be_kept_and_refuses_what_is_not_vcard() {
    use super::vcard_import::{already_there, preview};
    let file = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana\r\nEMAIL:Ana@X.cat\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nTEL:123\r\nEND:VCARD\r\n";
    let found = preview(file.as_bytes()).unwrap();
    assert_eq!((found.people.len(), found.skipped), (1, 1));
    assert!(preview(b"just some text").is_err());
    assert!(preview(&vec![b' '; super::vcard_import::MAX_BYTES + 1]).is_err());
    let existing = vec![Person {
        name: "ana".into(),
        emails: vec![EmailAddress { addr: "ana@x.cat".into(), label: String::new() }],
        ..Default::default()
    }];
    assert!(already_there(&found.people[0], &existing));
    assert!(!already_there(&Person { name: "Ana".into(), ..Default::default() }, &existing));
}

#[test]
fn given_and_family_names_are_read_and_written_as_n() {
    let read = people_from_vcards(APPLE.as_bytes()).remove(0);
    assert_eq!((read.given.as_str(), read.family.as_str()), ("Ana", "Prat"));
    let person = Person { name: "Wang Fang".into(), given: "Fang".into(), family: "Wang".into(), ..Default::default() };
    let card = new_card(&person, "u-1");
    assert!(card.contains("N:Wang;Fang;;;\r\n"), "{card}");
    let back = people_from_vcards(card.as_bytes()).remove(0);
    assert_eq!((back.given.as_str(), back.family.as_str(), back.name.as_str()), ("Fang", "Wang", "Wang Fang"));
}

#[test]
fn changing_the_family_name_keeps_the_rest_of_n() {
    let card = APPLE.replace("N:Prat;Ana;;;", "N:Prat;Ana;Maria;Dr.;PhD");
    let mut person = people_from_vcards(card.as_bytes()).remove(0);
    person.family = "Prat i Soler".into();
    let patched = patch_card(&card, &person, 0).unwrap();
    assert!(patched.contains("N:Prat i Soler;Ana;Maria;Dr.;PhD\r\n"), "{patched}");
    assert!(patched.contains("FN:Ana Prat\r\n"), "the whole name was not changed");
}

#[test]
fn a_card_without_n_gets_one_when_its_parts_are_given() {
    let card = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:Kim Min-jun\r\nEND:VCARD\r\n";
    let mut person = people_from_vcards(card.as_bytes()).remove(0);
    person.given = "Min-jun".into();
    person.family = "Kim".into();
    let patched = patch_card(card, &person, 0).unwrap();
    assert!(patched.contains("N:Kim;Min-jun;;;\r\n"), "{patched}");
}
